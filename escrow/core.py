"""The project's state and its ledger, changed only by applying log lines.

A line is {op, at, by, params, inputs, sig}. `by` is a role (client / contractor / resolver), 'keeper'
(a deadline's pre-agreed fallback) or 'relayer' (a chain result written back, escrow/chain.py). A party's line carries its demo signature over the rest of the line.
`inputs` holds what came from outside the rules (the model's readings, a signature over a policy hash), so
a replay never calls a model. Each op_<name> method validates and changes the state, and returns the
Korean sentence the log shows.

Ledger (ADR 0004): funded, expense_reserved, milestone_reserved, expense_released, milestone_released,
refunded; available = funded - reserved - released - refunded. Money is whole KRW.
"""
import hashlib
import json

from . import policy as pol
from .pcp_bridge import lang

ZERO = '0' * 64


class Refused(Exception):
    def __init__(self, message, code='state'):
        super().__init__(message)
        self.code = code


def won(n):
    return f'{int(n):,}원'


def step(head, raw):
    return hashlib.sha256((head + '\n' + raw).encode('utf-8')).hexdigest()


def whole(v, what, minimum=1):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or v < minimum:
        raise Refused(f'{what}: {minimum} 이상의 정수여야 합니다', 'invalid')
    return int(v)


def raw(line):
    return json.dumps(line, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


class Core:
    def __init__(self, pid):
        self.id, self.name, self.status, self.paused, self.created_at = pid, '', 'DRAFT', False, None
        self.versions = []  # {version, hash, doc, status, kind, change_order_id, signatures}
        self.funded = self.expense_reserved = self.milestone_reserved = 0
        self.expense_released = self.milestone_released = self.refunded = 0
        self.milestones, self.expenses, self.change_orders = {}, {}, {}
        self.documents = {}  # document id -> the expense that used it (a document backs one request)
        self.log, self.head, self.at, self.seq = [], ZERO, 0, {'E': 0, 'C': 0}
        self.chain = []  # results of the contract calls that mirror this log (op_chain)

    # -- policy
    def version(self, n):
        v = next((v for v in self.versions if v['version'] == n), None)
        if v is None:
            raise Refused(f'정책 v{n}이 없습니다', 'invalid')
        return v

    @property
    def active(self):
        return next((v for v in self.versions if v['status'] == 'ACTIVE'), None)

    @property
    def doc(self):
        a = self.active or (self.versions[0] if self.versions else None)
        return a['doc'] if a else None

    def mandate(self):
        return lang.Mandate(self.doc['expenseRules']['mandate'])

    def period(self, key, version=None):
        doc = self.version(version)['doc'] if version else self.doc
        return doc[key] * 1000

    # -- ledger
    @property
    def released(self):
        return self.expense_released + self.milestone_released

    @property
    def available(self):
        return self.funded - self.expense_reserved - self.milestone_reserved - self.released - self.refunded

    def expense_capacity(self):
        return self.doc['expenseBudget'] - self.expense_reserved - self.expense_released

    def milestone_capacity(self):
        return self.doc['milestoneBudget'] - self.milestone_reserved - self.milestone_released

    def deposit_room(self):
        if not self.doc or self.status not in ('DRAFT', 'ACTIVE'):
            return 0
        return max(self.doc['projectBudget'] - self.funded, 0)

    def funding_needed(self):
        """What a deposit must add for everything signed to be funded: v1's initial funding in DRAFT; signed
        change-order milestones and covered overages waiting for money in ACTIVE."""
        if self.status == 'DRAFT' and self.versions:
            return max(self.versions[0]['doc']['initialFunding'] - self.funded, 0)
        if self.status != 'ACTIVE':
            return 0
        want = sum(m['amount'] for m in self.milestones.values() if m['status'] == 'PLANNED')
        for co in self.change_orders.values():
            eid = co['draft'].get('covers_excess')
            if co['status'] == 'SIGNED' and eid:
                want += self.expenses[eid]['excess'] - self.expenses[eid]['excess_paid']
        return min(max(want - self.available, 0), self.deposit_room())

    def ledger(self):
        d = self.doc or {}
        return {'budget': d.get('projectBudget', 0), 'expense_budget': d.get('expenseBudget', 0),
                'milestone_budget': d.get('milestoneBudget', 0), 'funded': self.funded,
                'expense_reserved': self.expense_reserved, 'milestone_reserved': self.milestone_reserved,
                'expense_released': self.expense_released, 'milestone_released': self.milestone_released,
                'released': self.released, 'refunded': self.refunded, 'migrated_out': 0, 'available': self.available,
                'expense_capacity': self.expense_capacity() if d else 0,
                'milestone_capacity': self.milestone_capacity() if d else 0, 'deposit_room': self.deposit_room(),
                'funding_needed': self.funding_needed()}

    # -- lines
    def apply(self, line):
        at, by = line.get('at'), line.get('by')
        if isinstance(at, bool) or not isinstance(at, int) or at < self.at:
            raise Refused('로그 시간은 거꾸로 갈 수 없습니다', 'invalid')
        if by in pol.SIGNED:
            body = {k: v for k, v in line.items() if k != 'sig'}
            if not pol.verify(by, raw(body), line.get('sig')):
                raise Refused(f'{pol.NAMES.get(by, by)}의 서명이 맞지 않습니다', 'forbidden')
        elif by != 'keeper':
            raise Refused(f'알 수 없는 행위자 {by!r}', 'forbidden')
        fn = getattr(self, 'op_' + str(line.get('op')), None)
        if fn is None:
            raise Refused(f"알 수 없는 동작 {line.get('op')!r}", 'invalid')
        self.at = at
        text = fn(line, line.get('params') or {}, line.get('inputs') or {})
        self.maybe_close()
        self.head = step(self.head, raw(line))
        self.log.append({'i': len(self.log), 'at': at, 'by': by, 'op': line['op'], 'text': text, 'head': self.head})
        return text

    def need(self, line, *roles):
        if line['by'] not in roles:
            raise Refused('이 역할은 이 동작을 할 수 없습니다', 'forbidden')

    def state_is(self, *states):
        if self.status not in states:
            raise Refused(f'프로젝트가 {self.status} 상태라 할 수 없습니다', 'state')

    def open_for_new(self):
        """New commitments: ACTIVE and not paused (ADR 0004)."""
        if self.status != 'ACTIVE':
            raise Refused('진행 중(ACTIVE)인 프로젝트에서만 새 약정을 만들 수 있습니다', 'state')
        if self.paused:
            raise Refused('클라이언트가 새 약정을 일시정지했습니다', 'state')

    # -- project ops
    def op_create(self, line, p, i):
        self.need(line, 'client')
        if self.versions:
            raise Refused('이미 만들어진 프로젝트입니다')
        doc = p.get('doc') or {}
        if doc.get('projectId') != self.id or doc.get('version') != 1:
            raise Refused('정책 문서가 이 프로젝트의 v1이 아닙니다', 'invalid')
        self.name, self.created_at = doc['projectName'], line['at']
        self.versions.append({'version': 1, 'hash': pol.policy_hash(doc), 'doc': doc, 'status': 'PROPOSED',
                              'kind': 'initial', 'change_order_id': None,
                              'signatures': {'client': None, 'contractor': None}})
        return f"클라이언트가 프로젝트와 정책 v1 초안을 만들었습니다 (총 {won(doc['projectBudget'])})"

    def op_sign_policy(self, line, p, i):
        self.need(line, *pol.SIGNERS)
        self.state_is('DRAFT', 'ACTIVE')
        v = self.version(p.get('version'))
        if v['status'] != 'PROPOSED':
            raise Refused(f"정책 v{v['version']}은 서명을 받는 중이 아닙니다")
        who = line['by']
        if v['signatures'][who]:
            raise Refused('이미 서명했습니다')
        if not pol.verify(who, v['hash'], i.get('signature')):
            raise Refused('정책 해시 서명이 맞지 않습니다', 'forbidden')
        v['signatures'][who] = {'sig': i['signature'], 'at': line['at']}
        text = f"{pol.ROLE_KO[who]}가 정책 v{v['version']}에 서명했습니다 ({v['hash'][:12]}…)"
        if all(v['signatures'].values()):
            text += self.activate_version(v)
        return text

    def activate_version(self, v):
        if self.active:
            self.active['status'] = 'SUPERSEDED'
        v['status'] = 'ACTIVE'
        text = f" — 두 당사자 서명 완료, 정책 v{v['version']} 발효"
        if v['kind'] == 'change_order':
            return text + self.after_change(v)
        return text + self.try_activate()

    def try_activate(self):
        """DRAFT -> ACTIVE once v1 is signed by both and the initial funding is in; every milestone is reserved."""
        v1 = self.versions[0] if self.versions else None
        if self.status != 'DRAFT' or not v1 or v1['status'] != 'ACTIVE' or self.funded < v1['doc']['initialFunding']:
            return ''
        self.status = 'ACTIVE'
        for m in v1['doc']['milestones']:
            self.milestones[m['id']] = self.new_milestone(m, 1)
        return ' — 양측 서명과 초기 자금이 모두 충족되어 프로젝트가 ACTIVE가 됐습니다' + self.reserve_planned()

    def op_deposit(self, line, p, i):
        self.need(line, 'client')
        self.state_is('DRAFT', 'ACTIVE')
        amount = whole(p.get('amount'), 'amount')
        if amount > self.deposit_room():
            raise Refused(f'정책 예산을 넘는 예치는 할 수 없습니다 (가능 {won(self.deposit_room())})', 'invalid')
        self.funded += amount
        return f'클라이언트가 {won(amount)}을 예치했습니다' + self.try_activate() + self.fund_changes()

    def op_cancel_project(self, line, p, i):
        self.need(line, 'client')
        self.state_is('DRAFT')
        self.status = 'CANCELLED'
        for v in self.versions:
            if v['status'] == 'PROPOSED':
                v['status'] = 'WITHDRAWN'
        return f'클라이언트가 시작 전(DRAFT) 프로젝트를 취소했습니다 (예치금 {won(self.available)} 환불 가능)'

    def op_pause(self, line, p, i):
        self.need(line, 'client')
        self.state_is('ACTIVE')
        if self.paused:
            raise Refused('이미 일시정지 상태입니다')
        self.paused = True
        return f"클라이언트가 새 약정을 일시정지했습니다 ({p.get('reason') or '사유 없음'}) — 기존 약정의 제출·검수·정산은 그대로"

    def op_resume(self, line, p, i):
        self.need(line, 'client')
        self.state_is('ACTIVE')
        if not self.paused:
            raise Refused('일시정지 상태가 아닙니다')
        self.paused = False
        return f"클라이언트가 새 약정을 재개했습니다 ({p.get('reason') or '사유 없음'})" + self.fund_changes()

    def op_begin_close(self, line, p, i):
        self.need(line, 'client', 'contractor')
        self.state_is('ACTIVE')
        self.status = 'CLOSING'
        for co in self.change_orders.values():  # nothing new may be committed while closing
            if co['status'] in ('DRAFT', 'PROPOSED'):
                self.withdraw_change(co)
        for m in self.milestones.values():
            if m['status'] == 'PLANNED':
                m['status'] = 'CANCELLED'
                for u in m['units']:
                    u['status'] = 'RETURNED'
        return f"{pol.ROLE_KO[line['by']]}가 종료를 시작했습니다 (CLOSING) — 새 약정 불가, 기존 약정·분쟁은 끝까지 진행"

    def op_withdraw(self, line, p, i):
        self.need(line, 'client')
        self.state_is('CLOSING', 'CANCELLED')
        amount = self.available if p.get('amount') in (None, '') else whole(p['amount'], 'amount')
        if amount < 1 or amount > self.available:
            raise Refused(f'환불 가능한 금액은 {won(self.available)}입니다', 'invalid')
        self.refunded += amount
        return f'클라이언트가 예약되지 않은 {won(amount)}을 환불받았습니다'

    def live(self):
        from .milestones import M_LIVE
        from .expenses import E_LIVE
        return [m for m in self.milestones.values() if m['status'] in M_LIVE] + \
               [e for e in self.expenses.values() if e['status'] in E_LIVE]

    def maybe_close(self):
        if self.status == 'CLOSING' and not self.live() and self.available == 0:
            self.status = 'CLOSED'
