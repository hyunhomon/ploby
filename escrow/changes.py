"""Change orders (ADR 0002, 0009; PROJECT_OVERVIEW §2.4, §5.6): an out-of-scope request becomes a
non-binding draft (the model may draft it), then the next policy version, which activates only with both
signatures and creates obligations only once funded. Earlier commitments keep the version they pinned.

A change order may add one milestone (units non-empty), raise the expense budget, and pay an expense's
overage (covers_excess: EXCESS_AMOUNT is never paid without a bilateral change order, ADR 0005).

Statuses: DRAFT (editable, no effect) -> PROPOSED (a PROPOSED policy version) -> SIGNED (active version;
waiting for funds) -> FUNDED; or WITHDRAWN.
"""
from . import policy as pol
from .core import Refused, whole, won


def draft_of(d, excess=0):
    """A draft as entered or drafted -> its normal shape, or Refused."""
    if not isinstance(d, dict):
        raise Refused('변경 주문 초안 형식이 아닙니다', 'invalid')
    units = []
    for n, u in enumerate(d.get('units') or [], 1):
        title = str(u.get('title') or '').strip()
        criteria = [str(c).strip() for c in (u.get('criteria') or []) if str(c).strip()]
        amount = u.get('amount') or 0
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0 or amount != int(amount):
            raise Refused(f'납품 단위 {n}: 금액은 0 이상의 정수', 'invalid')
        units.append({'title': title, 'criteria': criteria, 'amount': int(amount)})
    delta = d.get('expense_budget_delta') or 0
    if isinstance(delta, bool) or not isinstance(delta, (int, float)) or delta < 0 or delta != int(delta):
        raise Refused('경비 예산 증액은 0 이상의 정수', 'invalid')
    return {'title': str(d.get('title') or '').strip()[:120], 'units': units,
            'amount': sum(u['amount'] for u in units), 'start_by': d.get('start_by') or None,
            'due_at': d.get('due_at') or None, 'grace_days': d.get('grace_days', 2),
            'note': str(d.get('note') or '')[:2000], 'expense_budget_delta': max(int(delta), int(excess)),
            'covers_excess': d.get('covers_excess')}


class Changes:
    def change(self, cid):
        co = self.change_orders.get(cid)
        if co is None:
            raise Refused(f'변경 주문 {cid}이 없습니다', 'invalid')
        return co

    def open_excess(self, eid):
        e = self.expense(eid)
        left = e['excess'] - e['excess_paid']
        if e['status'] != 'PARTIALLY_SETTLED' or left <= 0:
            raise Refused(f'{eid}에는 변경 주문으로 정산할 초과분이 없습니다', 'invalid')
        if any(c['draft'].get('covers_excess') == eid and c['status'] not in ('WITHDRAWN',) for c in self.change_orders.values()):
            raise Refused(f'{eid} 초과분은 이미 다른 변경 주문이 다루고 있습니다')
        return e, left

    def op_draft_change_order(self, line, p, i):
        self.need(line, 'client', 'contractor')
        self.state_is('ACTIVE')
        text = str(p.get('text') or '').strip()
        if not text:
            raise Refused('범위 밖 요청 내용을 적어 주세요', 'invalid')
        excess = 0
        if p.get('covers_excess'):  # an overage: more expense budget only, no milestone
            e, excess = self.open_excess(p['covers_excess'])
            draft = draft_of({'title': f"{e['id']} 초과분 정산", 'units': [], 'covers_excess': e['id'],
                              'note': f"{e['id']} 실제 비용이 약정 상한을 {won(excess)} 넘음 (EXCESS_AMOUNT)"}, excess)
        else:
            draft = draft_of({**(i.get('draft') or {}), 'covers_excess': None})
        self.seq['C'] += 1
        cid = f"C{self.seq['C']}"
        self.change_orders[cid] = {'id': cid, 'status': 'DRAFT', 'by': line['by'], 'text': text[:2000], 'draft': draft,
                                   'policy_version': None, 'milestone': None, 'excess_paid': 0,
                                   'ai': i.get('ai') or {'ok': False, 'problems': ['AI 초안 없음'], 'usage': {}},
                                   'at': line['at']}
        what = f"초과분 {won(excess)} 정산" if excess else (draft['title'] or '범위 밖 요청')
        return (f"{pol.ROLE_KO[line['by']]}가 변경 주문 초안 {cid}을(를) 만들었습니다 ({what}) — "
                f"양측 서명과 입금 전까지 효력 없음")

    def op_edit_change_order(self, line, p, i):
        self.need(line, 'client', 'contractor')
        co = self.change(p.get('change_order'))
        if co['status'] != 'DRAFT':
            raise Refused('초안 상태에서만 고칠 수 있습니다')
        excess = 0
        if co['draft'].get('covers_excess'):
            e = self.expense(co['draft']['covers_excess'])
            excess = e['excess'] - e['excess_paid']
        co['draft'] = draft_of({**(p.get('draft') or {}), 'covers_excess': co['draft'].get('covers_excess')}, excess)
        return f"{pol.ROLE_KO[line['by']]}가 변경 주문 초안 {co['id']}을(를) 고쳤습니다 (마일스톤 {won(co['draft']['amount'])}, 경비 예산 +{won(co['draft']['expense_budget_delta'])})"

    def op_propose_change_order(self, line, p, i):
        self.need(line, 'client', 'contractor')
        self.state_is('ACTIVE')
        co = self.change(p.get('change_order'))
        if co['status'] != 'DRAFT':
            raise Refused('초안만 새 정책 버전으로 제안할 수 있습니다')
        if any(v['status'] == 'PROPOSED' for v in self.versions):
            raise Refused('서명을 기다리는 다른 정책 버전이 있습니다')
        d, active = co['draft'], self.active
        milestone = None
        if d['units']:
            if any(u['amount'] < 1 or not u['title'] or not u['criteria'] for u in d['units']):
                raise Refused('모든 납품 단위에 제목, 인수 기준, 금액이 있어야 합니다 (가격은 작업자가 정함)', 'invalid')
            mid = f"M{len(active['doc']['milestones']) + 1}"
            try:
                milestone = pol.milestone({'title': d['title'], 'units': d['units'], 'start_by': d['start_by'],
                                           'due_at': d['due_at'], 'grace_days': d['grace_days']}, mid, line['at'])
            except pol.PolicyError as err:
                raise Refused(str(err), 'invalid') from None
        elif not d['expense_budget_delta']:
            raise Refused('마일스톤도 경비 예산 증액도 없는 변경 주문입니다', 'invalid')
        doc = pol.amended(active['doc'], active['hash'], milestone, d['expense_budget_delta'], line['at'])
        v = {'version': doc['version'], 'hash': pol.policy_hash(doc), 'doc': doc, 'status': 'PROPOSED',
             'kind': 'change_order', 'change_order_id': co['id'], 'signatures': {'client': None, 'contractor': None}}
        self.versions.append(v)
        co['status'], co['policy_version'], co['milestone'] = 'PROPOSED', v['version'], milestone and milestone['id']
        return (f"변경 주문 {co['id']} → 정책 v{v['version']} 제안 ({v['hash'][:12]}…) — 양측 서명과 추가 입금 뒤에만 발효"
                f" (추가 {won(doc['projectBudget'] - active['doc']['projectBudget'])})")

    def op_withdraw_change_order(self, line, p, i):
        self.need(line, 'client', 'contractor')
        co = self.change(p.get('change_order'))
        if co['status'] not in ('DRAFT', 'PROPOSED'):
            raise Refused('서명 전 변경 주문만 철회할 수 있습니다')
        self.withdraw_change(co)
        return f"{pol.ROLE_KO[line['by']]}가 변경 주문 {co['id']}을(를) 철회했습니다"

    def withdraw_change(self, co):
        if co['status'] == 'PROPOSED':
            self.version(co['policy_version'])['status'] = 'WITHDRAWN'
        co['status'] = 'WITHDRAWN'

    def after_change(self, v):
        """A change order's version is active: its milestone becomes PLANNED; fund what the money covers."""
        co = self.change_orders[v['change_order_id']]
        co['status'] = 'SIGNED'
        for m in v['doc']['milestones']:
            if m['id'] not in self.milestones:
                self.milestones[m['id']] = self.new_milestone(m, v['version'])
        return self.fund_changes()

    def fund_changes(self):
        """Reserve signed milestones and pay covered overages as far as available funds reach (not while paused)."""
        text = self.reserve_planned()
        if self.status != 'ACTIVE' or self.paused:
            return text
        for co in self.change_orders.values():
            eid = co['draft'].get('covers_excess')
            if co['status'] not in ('SIGNED', 'FUNDED') or not eid:
                continue
            e = self.expenses[eid]
            left = e['excess'] - e['excess_paid']
            if 0 < left <= min(self.available, self.expense_capacity()):
                self.expense_released += left
                e['excess_paid'] += left
                e['paid'] += left
                e['settlement'] = {**(e['settlement'] or {}), 'amount': e['paid'], 'at': self.at}
                co['excess_paid'] = left
                if e['excess_paid'] >= e['excess']:
                    e['status'] = 'SETTLED'
                text += f" — 변경 주문 {co['id']}로 {eid} 초과분 {won(left)} 정산"
        for co in self.change_orders.values():
            if co['status'] == 'SIGNED':
                m_ok = not co['milestone'] or self.milestones[co['milestone']]['status'] != 'PLANNED'
                eid = co['draft'].get('covers_excess')
                x_ok = not eid or self.expenses[eid]['excess_paid'] >= self.expenses[eid]['excess']
                if m_ok and x_ok:
                    co['status'] = 'FUNDED'
        return text
