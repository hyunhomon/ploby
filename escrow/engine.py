"""Ploby's engine: one project escrow = the rules (core, milestones, expenses, changes) + the keeper + the
role-scoped view the API returns (docs/api.md).

The keeper applies every elapsed deadline's pre-agreed fallback as its own log line (by 'keeper', at the
deadline's own time, earliest first), so a timeout never depends on who is online (PROJECT_OVERVIEW §5.5,
ADR 0005: timeouts are permissionless).
"""
from . import policy as pol
from .changes import Changes
from .core import Core, Refused, won
from .expenses import E_LIVE, KO_HOLD, Expenses
from .milestones import M_LIVE, Milestones
from .pcp_bridge import domain

M_CLOCK = {  # kind -> (label, owner, fallback)
    'start': ('착수 기한', 'contractor', '미사용 예약 만료 (EXPIRED_UNUSED), 가용 복귀'),
    'delivery': ('납기 + 유예기간', 'contractor', '미납 검토 (분쟁 해결)'),
    'unclaimed': ('제출 통지에 없는 단위 정리', 'contractor', '미납 처리, 가용 복귀'),
    'client_review': ('클라이언트 검수 기한', 'client', '제출 단위 자동 지급 (RELEASED_BY_TIMEOUT)'),
}
E_CLOCK = {
    'hold_review': ('HOLD 요청 응답 기한', 'client', '만료 — 약정이 생기지 않음'),
    'retro_review': ('사후 청구 응답 기한', 'client', '거절 — 침묵으로 지급되지 않음'),
    'reservation': ('예약 유효기간 (구매 보고)', 'contractor', '예약 만료, 가용 복귀'),
    'evidence': ('증빙 제출 기한', 'contractor', '증빙 결함 → 분쟁 해결'),
}
CHAIN_KO = {  # call -> what it did, in the log's words
    'open': lambda a: f"프로젝트 개설 (예산 {won(a.get('budget') or 0)}, 수취인 작업자 지갑 고정)",
    'fund': lambda a: f"클라이언트 예치 {won(a.get('amount') or 0)}",
    'accept': lambda a: f"클라이언트가 새 정책 해시 수락 (예산 {won(a.get('budget') or 0)})",
    'pause': lambda a: '새 약정 일시정지' if a.get('paused') else '새 약정 재개',
    'decide': lambda a: f"{a.get('ref')} {a.get('decision')} ({a.get('rule')}) {won(a.get('amount') or 0)}"
                        + (' 예약' if a.get('decision') == 'APPROVE' else ' 기록, 돈은 움직이지 않음'),
    'settle': lambda a: f"{a.get('ref')} 작업자에게 {won(a.get('pay') or 0)} 지급"
                        + (f", 예약 {won(a['returned'])} 반환" if a.get('returned') else ''),
    'refund': lambda a: f"클라이언트에게 {won(a.get('amount') or 0)} 환불",
}
RESOLVER_FALLBACK = {'CLIENT_REVIEW': '약정된 적격 금액 정산', 'POLICY_OR_SYSTEM_AMBIGUITY': '청구액과 약정 상한 중 작은 금액 정산',
                     'EVIDENCE_DEFECT': '거절, 예약 가용 복귀', 'INTEGRITY_RISK': '거절, 예약 가용 복귀'}


class Project(Core, Milestones, Expenses, Changes):
    # -- the keeper
    def clocks(self):
        if self.status in ('CLOSED', 'CANCELLED', 'DRAFT'):
            return []
        return sorted([(at, 'milestone', kind, ref) for at, kind, ref in self.milestone_clocks()] +
                      [(at, 'expense', kind, ref) for at, kind, ref in self.expense_clocks()])

    def due(self, now):
        c = self.clocks()
        return c[0] if c and c[0][0] <= now else None

    def op_timeout(self, line, p, i):
        self.need(line, 'keeper')
        clock = (p.get('deadline'), p.get('target'), p.get('kind'), p.get('ref'))
        if clock not in self.clocks() or clock[0] > line['at']:
            raise Refused('경과한 기한이 아닙니다', 'invalid')
        if p['target'] == 'milestone':
            return '타임아웃: ' + self.milestone_timeout(p['kind'], self.milestones[p['ref']])
        return '타임아웃: ' + self.expense_timeout(p['kind'], self.expenses[p['ref']], line['at'])

    # -- the chain (escrow/chain.py)
    def op_chain(self, line, p, i):
        """A contract call's result, written back by the relayer next to the log line it mirrors: the tx hash, or
        the contract's refusal (never sent). It moves no money here: the chain mirrors this ledger."""
        self.need(line, 'relayer')
        at, call, args = p.get('line'), p.get('call'), p.get('args') or {}
        if not isinstance(at, int) or not 0 <= at < len(self.log) or self.log[at]['op'] == 'chain':
            raise Refused('체인 결과가 가리키는 로그 줄이 없습니다', 'invalid')
        if call not in CHAIN_KO:
            raise Refused(f'알 수 없는 체인 호출 {call!r}', 'invalid')
        r = {'line': at, 'n': p.get('n'), 'call': call, 'args': args, 'tx': p.get('tx'), 'url': p.get('url'),
             'ok': bool(p.get('ok')), 'error': p.get('error'), 'block': p.get('block')}
        self.log[at].setdefault('chain', []).append(r)
        target = self.expenses.get(args.get('ref')) or self.milestones.get(args.get('ref'))
        if target is not None:
            target.setdefault('chain', []).append(r)
        self.chain.append(r)
        what = CHAIN_KO[call](args)
        if r['ok'] and r['tx']:
            return f"온체인 기록 (#{at}): {what} — tx {r['tx'][:10]}…{r['tx'][-6:]}"
        if r['ok']:
            return f"온체인 기록 (#{at}): {what} — 이미 체인에 있음"
        return f"온체인 거절 (#{at}): {what} — 컨트랙트가 거부 ({r['error']}), 전송하지 않음"

    # -- what a role sees
    def deadlines(self):
        out = []
        for at, target, kind, ref in self.clocks():
            if target == 'milestone':
                m = self.milestones[ref]
                if kind == 'resolver_review':
                    label, owner = '분쟁 해결 기한', 'resolver'
                    fb = '미납 단위 거절, 가용 복귀' if m['status'] == 'NON_DELIVERY' else '이의 단위 지급 (제출 완전, 결함 증명 없음)'
                else:
                    label, owner, fb = M_CLOCK[kind]
                out.append({'target': {'kind': 'milestone', 'id': ref}, 'label': f"{ref} {label}", 'at': at, 'owner': owner,
                            'fallback': fb})
            else:
                e = self.expenses[ref]
                if kind == 'evidence_submitted':
                    label, owner = '클라이언트 검토 기한', 'client'
                    fb = '자동 정산 (RELEASED_BY_TIMEOUT)' if e['hold_class'] == 'CLIENT_REVIEW' else '분쟁 해결로 이동 (ESCALATED_BY_TIMEOUT)'
                elif kind == 'resolver_review':
                    label, owner = '분쟁 해결 기한', 'resolver'
                    fb = RESOLVER_FALLBACK.get(e['hold_class'], '거절') if e['receipt'] else '거절, 예약 가용 복귀'
                else:
                    label, owner, fb = E_CLOCK[kind]
                out.append({'target': {'kind': 'expense', 'id': ref}, 'label': f"{ref} {label}", 'at': at, 'owner': owner,
                            'fallback': fb})
        return out

    def actions(self, role):
        out = []

        def act(action, label, target=None, deadline=None, fallback=None, needs=False):
            out.append({'action': action, 'target': target, 'label': label, 'deadline': deadline, 'fallback': fallback,
                        'needs_response': needs})
        s = self.status
        for v in self.versions:
            if v['status'] == 'PROPOSED' and role in pol.SIGNERS and not v['signatures'][role]:
                act('sign_policy', f"정책 v{v['version']} 검토 후 서명", {'kind': 'policy', 'id': v['version']}, needs=True)
        if role == 'client':
            if s in ('DRAFT', 'ACTIVE') and self.deposit_room() > 0:
                v1 = self.versions[0] if self.versions else None
                waiting = (s == 'DRAFT' and v1 and self.funded < v1['doc']['initialFunding']) or \
                          any(m['status'] == 'PLANNED' for m in self.milestones.values())
                act('deposit', '예치 (입금)', {'kind': 'project', 'id': self.id}, needs=bool(waiting))
            if s == 'DRAFT':
                act('cancel_project', '시작 전 프로젝트 취소', {'kind': 'project', 'id': self.id})
            if s == 'ACTIVE':
                act('resume' if self.paused else 'pause', '새 약정 재개' if self.paused else '새 약정 일시정지',
                    {'kind': 'project', 'id': self.id})
            if s in ('CLOSING', 'CANCELLED') and self.available > 0:
                act('withdraw', '예약되지 않은 잔액 환불', {'kind': 'project', 'id': self.id},
                    needs=s == 'CANCELLED' or not self.live())
        if role in pol.SIGNERS and s == 'ACTIVE':
            act('begin_close', '종료 시작 (CLOSING)', {'kind': 'project', 'id': self.id})
            act('draft_change_order', '범위 밖 요청 → 변경 주문 초안', None)
        if role == 'contractor' and s == 'ACTIVE' and not self.paused:
            act('request_commitment', '구매 전 약정 요청', None)
            act('retroactive_request', '사후 청구 (사전 약정 없음)', None)
        for m in self.milestones.values():
            t = {'kind': 'milestone', 'id': m['id']}
            if role == 'contractor' and m['status'] == 'FUNDED_AND_RESERVED':
                act('start_milestone', f"{m['id']} 착수", t, m['start_by'], M_CLOCK['start'][2], True)
            if role == 'contractor' and m['status'] in ('PLANNED', 'FUNDED_AND_RESERVED'):
                act('cancel_milestone', f"{m['id']} 착수 전 취소", t)
            if role == 'contractor' and m['status'] == 'IN_PROGRESS':
                act('submit_delivery', f"{m['id']} 제출 통지", t, m['grace_until'], M_CLOCK['delivery'][2], True)
            if role == 'client' and any(u['status'] == 'CLAIMED' for u in m['units']):
                act('review_delivery', f"{m['id']} 검수 (승인·이의)", t, m['review_deadline'], M_CLOCK['client_review'][2], True)
            if role == 'resolver' and (m['status'] == 'NON_DELIVERY' or any(u['status'] == 'DISPUTED' for u in m['units'])):
                fb = '미납 단위 거절' if m['status'] == 'NON_DELIVERY' else '이의 단위 지급'
                act('resolve_milestone', f"{m['id']} 분쟁 해결", t, m['resolver_deadline'], fb, True)
        for e in self.expenses.values():
            t, st, cls = {'kind': 'expense', 'id': e['id']}, e['status'], e['hold_class']
            if role == 'client' and st in ('HOLD_REVIEW', 'RETRO_REVIEW'):
                act('answer_request', f"{e['id']} {'사후 청구' if st == 'RETRO_REVIEW' else 'HOLD 요청'} 승인·거절", t,
                    e['review_deadline'], E_CLOCK[st.lower()][2], True)
            if role == 'contractor' and st == 'RESERVED':
                act('report_spend', f"{e['id']} 구매 보고", t, e['expires_at'], E_CLOCK['reservation'][2], True)
                act('cancel_reservation', f"{e['id']} 미사용 예약 취소", t)
            if role == 'contractor' and st == 'SPEND_REPORTED':
                act('submit_receipt', f"{e['id']} 영수증 제출 통지", t, e['evidence_deadline'], E_CLOCK['evidence'][2], True)
            if st == 'EVIDENCE_SUBMITTED' and role == 'client':
                if cls == 'CLIENT_REVIEW':
                    act('review_settlement', f"{e['id']} 정산 검토 (승인·이의)", t, e['review_deadline'], '자동 정산', True)
                else:
                    act('escalate_settlement', f"{e['id']} 분쟁 해결로 넘기기 ({KO_HOLD.get(cls, cls)})", t,
                        e['review_deadline'], '기한에 분쟁 해결로 이동')
            if role == 'contractor' and cls == 'EVIDENCE_DEFECT' and st in ('EVIDENCE_SUBMITTED', 'DISPUTED'):
                act('supplement_evidence', f"{e['id']} 증빙 보완", t, e['resolver_deadline'] or e['review_deadline'],
                    '보완 없으면 분쟁 해결자 침묵 시 거절', True)
            if role == 'resolver' and st == 'DISPUTED':
                fb = RESOLVER_FALLBACK.get(cls, '거절') if e['receipt'] else '거절'
                act('resolve_expense', f"{e['id']} 분쟁 해결 ({KO_HOLD.get(cls, cls)})", t, e['resolver_deadline'], fb, True)
            if role in pol.SIGNERS and s == 'ACTIVE' and st == 'PARTIALLY_SETTLED' and e['excess'] > e['excess_paid'] and \
                    not any(c['draft'].get('covers_excess') == e['id'] and c['status'] != 'WITHDRAWN'
                            for c in self.change_orders.values()):
                act('draft_change_order', f"{e['id']} 초과분 {won(e['excess'] - e['excess_paid'])} 변경 주문 초안", t)
            if role in pol.SIGNERS and s == 'ACTIVE' and st == 'BLOCKED' and e['out_of_scope']:
                act('draft_change_order', f"{e['id']} 범위 밖 → 변경 주문 초안", t)
        for co in self.change_orders.values():
            t = {'kind': 'change_order', 'id': co['id']}
            if role in pol.SIGNERS and co['status'] == 'DRAFT' and s == 'ACTIVE':
                act('edit_change_order', f"{co['id']} 초안 수정", t)
                act('propose_change_order', f"{co['id']} 새 정책 버전으로 제안", t)
            if role in pol.SIGNERS and co['status'] in ('DRAFT', 'PROPOSED'):
                act('withdraw_change_order', f"{co['id']} 철회", t)
        if self.clocks():
            act('run_timeouts', '경과한 기한 처리 (누구나 실행 가능)', None)
        return out

    def policy_view(self, v):
        d = v['doc']
        return {'version': v['version'], 'hash': v['hash'], 'previous_hash': d['previousPolicyHash'], 'status': v['status'],
                'kind': v['kind'], 'change_order_id': v['change_order_id'], 'signatures': v['signatures'],
                'summary': {'project_budget': d['projectBudget'], 'expense_budget': d['expenseBudget'],
                            'milestone_budget': d['milestoneBudget'], 'initial_funding': d['initialFunding'],
                            'starts_at': d['startsAt'], 'ends_at': d['endsAt'],
                            'client_review_seconds': d['clientReviewPeriodSeconds'],
                            'resolver_review_seconds': d['resolverReviewPeriodSeconds'],
                            'evidence_seconds': d['evidenceSubmissionPeriodSeconds'],
                            'reservation_seconds': d['reservationValiditySeconds'],
                            'payment_modes': d['allowedPaymentModes'], 'evidence': d.get('evidenceRequirements'),
                            'risk': d.get('riskRules')},
                'rules': pol.rules_summary(d['expenseRules']),
                'milestones': [{'id': m['id'], 'title': m['title'], 'amount': m['amount'], 'start_by': m['startBy'],
                                'due_at': m['deliveryDueAt'],
                                'grace_until': m['deliveryDueAt'] + m['deliveryGracePeriodSeconds'] * 1000,
                                'units': m['units']} for m in d['milestones']],
                'fallbacks': pol.FALLBACKS, 'doc': d}

    def expense_view(self, e):
        d = domain()
        return {**{k: v for k, v in e.items() if k not in ('requested_at',)},
                'vendor_name': d.name_of(e['vendor']) if e['vendor'] else None,
                'category_ko': d.category_name(e['category']) if e['category'] else None}

    def view(self, role, now):
        ps = pol.parties()
        return {'id': self.id, 'name': self.name, 'status': self.status, 'paused': self.paused, 'now': now,
                'created_at': self.created_at, 'viewer': ps[role], 'parties': ps,
                'policy': self.policy_view(self.active) if self.active else None,
                'proposals': [self.policy_view(v) for v in self.versions if v['status'] == 'PROPOSED'],
                'versions': [self.policy_view(v) for v in self.versions],
                'ledger': self.ledger(), 'milestones': list(self.milestones.values()),
                'expenses': [self.expense_view(e) for e in self.expenses.values()],
                'change_orders': list(self.change_orders.values()), 'actions': self.actions(role),
                'deadlines': self.deadlines(), 'log': self.log, 'head': self.head}

    def summary(self, role, now):
        todo = [a for a in self.actions(role) if a['needs_response']]
        return {'id': self.id, 'name': self.name, 'status': self.status, 'paused': self.paused, 'ledger': self.ledger(),
                'todo': len(todo), 'next_deadline': next((d for d in self.deadlines() if d['owner'] == role), None),
                'created_at': self.created_at}


__all__ = ['Project', 'Refused', 'M_LIVE', 'E_LIVE']
