#!/usr/bin/env python3
"""Offline checks of the engine against PROJECT_OVERVIEW.md (the first-class reference) and the product's success
criteria (docs/product-overview.md). No model and no network: readings come from a fixed table, the way a
replay takes them from the log. Run from the repository root:  python3 harness/check.py

Each check names the principle it holds. Exit 1 if any fails.
"""
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from escrow import policy as pol, server  # noqa: E402
from escrow.core import Refused, raw  # noqa: E402
from escrow.store import Store  # noqa: E402

SAMPLES = {s['id']: s for s in server.samples()}
SAMPLES['q-vercel-2'] = {'id': 'q-vercel-2', 'name': 'Vercel Pro 견적 (2)', 'kind': 'quote',
                         'text': SAMPLES['q-vercel']['text'].replace('2026', '2026 (재발행)', 1)}
TEXT = {s['text']: k for k, s in SAMPLES.items()}
FIX = {'q-gabia': ('gabia', 'domain', 22000, 2200), 'q-figma': ('figma', 'software', 90000, 9000),
       'q-coupang': ('coupang', 'general', 117273, 11727), 'q-adobe': ('adobe-stock', 'assets', 185000, 18500),
       'q-aws-injection': ('aws', 'hosting', 163637, 16363), 'q-vercel': ('vercel', 'hosting', 30000, 3000),
       'q-vercel-2': ('vercel', 'hosting', 30000, 3000),
       'r-gabia': ('gabia', 'domain', 22000, 2200), 'r-figma': ('figma', 'software', 90000, 9000),
       'r-figma-over': ('figma', 'software', 99000, 9900), 'r-aws': ('aws', 'hosting', 163637, 16363)}
DOWN = set()  # sample ids whose reading fails as if Kiln were unreachable
RESULTS = []
WORLDS = []  # every scenario's store, for the chain checks


def reader(text):
    k = TEXT.get(text)
    if k in DOWN:
        return {'ok': False, 'source': 'unavailable', 'proposal': None, 'fields': {}, 'problems': ['service down'],
                'model': None, 'usage': {}, 'generation_ids': []}
    if k in FIX:
        v, c, a, f = FIX[k]
        return {'ok': True, 'source': 'ai', 'proposal': {'merchant': v, 'category': c, 'item': k, 'amount': a, 'fee': f,
                                                          'units': 1},
                'fields': {}, 'problems': [], 'model': 'fixed', 'usage': {}, 'generation_ids': []}
    return {'ok': False, 'source': 'ai', 'proposal': None, 'fields': {}, 'problems': ['total_text is missing'],
            'model': 'fixed', 'usage': {}, 'generation_ids': []}


def drafter(text, context, now):
    return ({'title': '회원 로그인', 'units': [{'title': '로그인', 'criteria': ['이메일 로그인'], 'amount': 0}],
             'start_by': None, 'due_at': None, 'grace_days': 2, 'note': '', 'expense_budget_delta': 0},
            {'ok': True, 'problems': [], 'usage': {}})


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print(f"{'pass' if ok else 'FAIL'}  {name}" + (f'  ({detail})' if detail and not ok else ''))


def spec(start_by='2026-10-03'):
    return {'name': '카페 온담 홈페이지 리뉴얼',
            'rules': {'mode': 'form', 'form': {'vendors': ['aws', 'vercel', 'gabia', 'figma', 'adobe-stock'],
                                               'budget': 500000, 'max_per_purchase': 200000, 'until': '2026-10-31'}},
            'milestones': [{'title': '디자인 시안', 'start_by': start_by, 'due_at': '2026-10-10', 'grace_days': 2,
                            'units': [{'title': '메인 시안', 'criteria': ['데스크톱·모바일 시안 각 1종'], 'amount': 1000000},
                                      {'title': '서브 페이지 시안', 'criteria': ['메뉴·매장 안내 페이지'], 'amount': 500000}]},
                           {'title': '반응형 퍼블리싱', 'start_by': '2026-10-12', 'due_at': '2026-10-24', 'grace_days': 2,
                            'units': [{'title': '반응형 사이트', 'criteria': ['모바일·PC 레이아웃', '도메인 연결'],
                                       'amount': 2500000}]}],
            'ends_at': '2026-12-31'}


class World:
    def __init__(self, tmp, name, caps=None):
        self.st = Store(Path(tmp) / name, reader=reader, drafter=drafter)
        self.st.offset = int(time.mktime((2026, 10, 1, 10, 0, 0, 0, 0, -1)) * 1000) - int(time.time() * 1000)
        sp = spec()
        if caps:
            sp['rules']['form']['category_budgets'] = caps
        self.pid = self.st.create('client', sp)['id']
        WORLDS.append(self)

    def act(self, role, action, **p):
        return self.st.act(self.pid, role, action, p)

    def refused(self, role, action, **p):
        try:
            self.act(role, action, **p)
            return None
        except Refused as e:
            return e.code

    def doc(self, k):
        return self.st.document(SAMPLES[k]['name'], SAMPLES[k]['text'])['id']

    @property
    def P(self):
        return self.st.projects[self.pid]

    def e(self, eid):
        return self.P.expenses[eid]

    def activate(self):
        self.act('client', 'sign_policy', version=1)
        self.act('contractor', 'sign_policy', version=1)
        self.act('client', 'deposit', amount=4500000)

    def days(self, n):
        self.st.advance(int(n * 86400))
        self.st.keeper(self.pid)


def conserved(P):
    """ADR 0004: available = funded - reserved - released - refunded, never negative."""
    return P.available >= 0 and P.funded == P.expense_reserved + P.milestone_reserved + P.released + P.refunded + P.available


def run(tmp):
    # -- bilateral activation (overview §5.1, §8.1; product success: neither party changes policy alone)
    w = World(tmp, 'a')
    check('DRAFT: nothing can be committed before both signatures and the initial funding',
          w.P.status == 'DRAFT' and w.refused('contractor', 'request_commitment', document=w.doc('q-gabia')) == 'state')
    w.act('client', 'sign_policy', version=1)
    w.act('client', 'deposit', amount=4500000)
    check('one signature + full funding is still DRAFT (the contractor must sign the same hash)', w.P.status == 'DRAFT')
    check('the contractor cannot start a milestone that is not reserved', w.refused('contractor', 'start_milestone', milestone='M1') is not None)
    w.act('contractor', 'sign_policy', version=1)
    check('both signatures + initial funding -> ACTIVE, every milestone FUNDED_AND_RESERVED before work starts',
          w.P.status == 'ACTIVE' and all(m['status'] == 'FUNDED_AND_RESERVED' for m in w.P.milestones.values())
          and w.P.milestone_reserved == 4000000)
    check('a deposit above the signed budget is refused', w.refused('client', 'deposit', amount=1) == 'invalid')
    check('roles are enforced: the client cannot request a commitment, the contractor cannot pause',
          w.refused('client', 'request_commitment', document=w.doc('q-gabia')) is not None
          and w.refused('contractor', 'pause', reason='x') == 'forbidden')

    # -- expenses: decision order, BLOCK / HOLD / APPROVE (overview §6)
    w.act('contractor', 'request_commitment', document=w.doc('q-gabia'))
    e1 = w.e('E1')
    check('APPROVE reserves the maximum before spending (Reserve -> Spend -> Settle)',
          e1['status'] == 'RESERVED' and e1['reserved'] == 24200 and w.P.expense_reserved == 24200)
    check('the payee is the contractor wallet in the policy, never a document field',
          e1['payee'] == pol.address('contractor') and e1['payment_mode'] == 'REIMBURSEMENT')
    w.act('contractor', 'request_commitment', document=w.doc('q-coupang'))
    w.act('contractor', 'request_commitment', document=w.doc('q-adobe'))
    check('a vendor not on the list is BLOCK and marked OUT_OF_SCOPE',
          w.e('E2')['status'] == 'BLOCKED' and w.e('E2')['decision']['reason'] == 'vendor' and w.e('E2')['out_of_scope'])
    check('over the per-purchase limit once VAT is added is BLOCK', w.e('E3')['decision']['reason'] == 'per_purchase')
    w.act('contractor', 'request_commitment', document=w.doc('q-aws-injection'))
    e4 = w.e('E4')
    check('a risk signal (price anomaly) is HOLD, never BLOCK or APPROVE; no money is reserved',
          e4['status'] == 'HOLD_REVIEW' and e4['decision']['result'] == 'HOLD' and e4['reserved'] == 0)
    w.act('contractor', 'request_commitment', document=w.doc('q-gabia'))
    check('the same document again would allocate one invoice over 100%: BLOCK',
          w.e('E5')['decision']['reason'] == 'allocation')
    DOWN.add('q-vercel')
    w.act('contractor', 'request_commitment', document=w.doc('q-vercel'))
    check('a model or service failure is HOLD, never an automatic approval (overview §8.3)',
          w.e('E6')['status'] == 'HOLD_REVIEW' and w.e('E6')['hold_class'] == 'POLICY_OR_SYSTEM_AMBIGUITY'
          and w.e('E6')['reserved'] == 0)
    DOWN.discard('q-vercel')
    check('a held request with an unknown amount cannot be approved blind',
          w.refused('client', 'answer_request', expense='E6', approve=True) == 'invalid')

    # -- settle: client review, silence pays; claimed amount capped (ADR 0005)
    w.act('contractor', 'report_spend', expense='E1')
    check('the claimed amount cannot exceed the commitment cap',
          w.refused('contractor', 'submit_receipt', expense='E1', document=w.doc('r-gabia'), claimed=24201) == 'invalid')
    w.act('contractor', 'submit_receipt', expense='E1', document=w.doc('r-gabia'), claimed=24200)
    check('a clean receipt waits for the client (CLIENT_REVIEW) and a deadline', w.e('E1')['status'] == 'EVIDENCE_SUBMITTED'
          and w.e('E1')['hold_class'] == 'CLIENT_REVIEW' and w.e('E1')['review_deadline'])
    w.act('contractor', 'request_commitment', document=w.doc('q-figma'))
    w.act('contractor', 'report_spend', expense='E7')
    w.act('contractor', 'submit_receipt', expense='E7', document=w.doc('r-figma-over'), claimed=99000)
    e7 = w.e('E7')
    check('an overage pays the committed cap now and leaves the excess unpaid (EXCESS_AMOUNT)',
          e7['status'] == 'PARTIALLY_SETTLED' and e7['paid'] == 99000 and e7['excess'] == 9900
          and e7['settlement']['payee'] == pol.address('contractor'))
    w.days(3.2)
    check('client silence on a clean receipt settles it at the deadline (RELEASED_BY_TIMEOUT)',
          w.e('E1')['status'] == 'SETTLED' and w.e('E1')['timeout'] == 'RELEASED_BY_TIMEOUT' and w.e('E1')['paid'] == 24200)
    check('a held request the client never answered expires: no commitment was ever made',
          w.e('E4')['status'] == 'EXPIRED' and w.e('E4')['paid'] == 0)
    check('money is conserved (funded = reserved + released + refunded + available)', conserved(w.P), str(w.P.ledger()))

    # -- evidence defect: client cannot waive; supplement cures without moving clocks (ADR 0001, 0005)
    w.act('contractor', 'request_commitment', document=w.doc('q-vercel-2'))
    w.act('contractor', 'report_spend', expense='E8')
    w.act('contractor', 'submit_receipt', expense='E8', document=w.doc('r-blurry'), claimed=33000)
    e8 = w.e('E8')
    deadline = e8['review_deadline']
    check('an unreadable receipt is EVIDENCE_DEFECT and the client cannot approve it',
          e8['hold_class'] == 'EVIDENCE_DEFECT' and w.refused('client', 'review_settlement', expense='E8', approve=True) is not None)
    check('a supplement cannot raise the claim or move the deadline, and a bad one keeps the defect',
          (w.act('contractor', 'supplement_evidence', expense='E8', document=w.doc('r-aws')) or True)
          and w.e('E8')['hold_class'] == 'EVIDENCE_DEFECT' and w.e('E8')['review_deadline'] == deadline)
    w.days(3.2)
    check('at the client deadline a defect escalates to the resolver (ESCALATED_BY_TIMEOUT)',
          w.e('E8')['status'] == 'DISPUTED' and w.e('E8')['timeout'] == 'ESCALATED_BY_TIMEOUT')
    w.days(7.2)
    check('resolver silence on EVIDENCE_DEFECT rejects and returns the reservation',
          w.e('E8')['status'] == 'REJECTED' and w.e('E8')['reserved'] == 0 and w.e('E8')['paid'] == 0)

    # -- milestones: objection is not rejection; resolver silence pays complete claims (ADR 0009)
    w2 = World(tmp, 'b')
    w2.activate()
    w2.act('contractor', 'start_milestone', milestone='M1')
    w2.act('contractor', 'submit_delivery', milestone='M1', units=['M1-U1', 'M1-U2'], note='시안', documents=[w2.doc('d-m1')])
    check('the client may object only with a predefined acceptance criterion',
          w2.refused('client', 'review_delivery', milestone='M1', accept=[],
                     object=[{'unit': 'M1-U2', 'criterion': '새 기준', 'reason_code': 'NOT_MET', 'reason': 'x'}]) == 'invalid')
    w2.act('client', 'review_delivery', milestone='M1', accept=['M1-U1'],
           object=[{'unit': 'M1-U2', 'criterion': '메뉴·매장 안내 페이지', 'reason_code': 'MISSING', 'reason': '매장 안내 없음'}])
    m1 = w2.P.milestones['M1']
    check('acceptance pays the accepted unit now; the objected unit goes to the resolver, still reserved',
          m1['units'][0]['status'] == 'PAID' and m1['units'][1]['status'] == 'DISPUTED' and w2.P.milestone_released == 1000000)
    w2.act('resolver', 'resolve_milestone', milestone='M1', decisions=[{'unit': 'M1-U2', 'accept': False, 'reason': '누락 확인'}])
    check('the resolver decides only the disputed unit, within its fixed amount',
          w2.P.milestones['M1']['status'] == 'PARTIAL' and w2.P.milestones['M1']['returned'] == 500000)
    w2.act('contractor', 'start_milestone', milestone='M2')
    w2.act('contractor', 'submit_delivery', milestone='M2', units=['M2-U1'], note='퍼블리싱', documents=[w2.doc('d-m2')])
    w2.days(3.2)
    check('client silence after a delivery pays the submitted units (RELEASED_BY_TIMEOUT)',
          w2.P.milestones['M2']['units'][0]['status'] == 'RELEASED_BY_TIMEOUT' and w2.P.milestones['M2']['status'] == 'PAID')

    # -- change orders: out of scope is no obligation until signed and funded (overview §2.4, §5.6)
    before = w2.P.ledger()
    w2.act('client', 'draft_change_order', text='회원 로그인 기능도 추가해 주세요')
    check('a change-order draft has no financial effect', w2.P.ledger() == before and w2.P.change_orders['C1']['status'] == 'DRAFT')
    check('an unpriced draft cannot be proposed (the contractor prices the work)',
          w2.refused('contractor', 'propose_change_order', change_order='C1') == 'invalid')
    w2.act('contractor', 'edit_change_order', change_order='C1',
           draft={'title': '회원 로그인', 'units': [{'title': '로그인', 'criteria': ['이메일 로그인'], 'amount': 1500000}],
                  'start_by': '2026-10-20', 'due_at': '2026-11-15', 'grace_days': 2})
    w2.act('contractor', 'propose_change_order', change_order='C1')
    w2.act('contractor', 'sign_policy', version=2)
    check('one signature does not activate the new version', w2.P.active['version'] == 1)
    w2.act('client', 'sign_policy', version=2)
    m3 = w2.P.milestones.get('M3')
    check('signed but not funded: the new milestone is PLANNED and cannot be started',
          m3 and m3['status'] == 'PLANNED' and w2.refused('contractor', 'start_milestone', milestone='M3') is not None)
    need = w2.P.funding_needed()
    check('the deposit it needs is what the available balance lacks', need == 1500000 - w2.P.available, str(need))
    w2.act('client', 'deposit', amount=need + 100000)
    check('once funded the new milestone is reserved; earlier commitments keep their pinned version',
          w2.P.milestones['M3']['status'] == 'FUNDED_AND_RESERVED' and w2.P.milestones['M1']['version'] == 1
          and w2.P.change_orders['C1']['status'] == 'FUNDED')

    # -- pause and close (ADR 0004; overview §5.9, §10)
    w2.act('client', 'pause', reason='점검')
    check('pause stops new commitments', w2.refused('contractor', 'request_commitment', document=w2.doc('q-figma')) is None
          and w2.P.expenses['E1']['decision']['reason'] == 'state')
    w2.act('client', 'resume', reason='재개')
    w2.act('contractor', 'request_commitment', document=w2.doc('q-gabia'))
    w2.act('client', 'begin_close')
    check('closing refuses new commitments but keeps existing reservations',
          w2.refused('contractor', 'draft_change_order', text='x') is not None and w2.P.expenses['E2']['status'] == 'RESERVED')
    avail = w2.P.available
    w2.act('client', 'withdraw')
    check('the client withdraws only unreserved funds', w2.P.refunded == avail and w2.P.expense_reserved == 24200
          and w2.P.milestone_reserved == 1500000 and conserved(w2.P))
    w2.act('contractor', 'report_spend', expense='E2')
    w2.act('contractor', 'submit_receipt', expense='E2', document=w2.doc('r-gabia'), claimed=24200)
    w2.act('client', 'review_settlement', expense='E2', approve=True)
    w2.act('contractor', 'cancel_milestone', milestone='M3')
    w2.act('client', 'withdraw')
    check('CLOSED only once no obligation is live and nothing is left to refund',
          w2.P.status == 'CLOSED' and w2.P.available == 0 and conserved(w2.P), str(w2.P.ledger()))

    # -- the record (overview §9): replay, tampering, no document text in the log
    for world in (w, w2):
        R = world.st.replay(world.pid)
        check(f'replaying the log alone rebuilds the same state ({world.pid[:6]})',
              R.head == world.P.head and R.ledger() == world.P.ledger()
              and json.dumps(R.view('client', 0), sort_keys=True, default=str) ==
              json.dumps(world.P.view('client', 0), sort_keys=True, default=str))
    log = w.st.path(w.pid).read_text(encoding='utf-8')
    check('the log keeps document hashes, never document text', all(SAMPLES[k]['text'][:40] not in log for k in SAMPLES))
    lines = log.splitlines()
    forged = json.loads(lines[5])
    forged['params'] = {**forged['params'], 'amount': 1} if 'amount' in forged.get('params', {}) else {**forged['params'], 'x': 1}
    from escrow.engine import Project
    P = Project(w.pid)
    for text in lines[:5]:
        P.apply(json.loads(text))
    try:
        P.apply(forged)
        check('an edited line is refused (its signature no longer matches)', False)
    except Refused as e:
        check('an edited line is refused (its signature no longer matches)', e.code == 'forbidden')
    back = json.loads(lines[-1])
    back['at'] = 0
    back['sig'] = pol.sign(back['by'], raw({k: v for k, v in back.items() if k != 'sig'})) if back['by'] in pol.ROLES else None
    try:
        w.st.replay(w.pid).apply(back)
        check('a line dated before the last one is refused', False)
    except Refused:
        check('a line dated before the last one is refused', True)

    # -- retroactive: silence never pays (ADR 0005)
    w3 = World(tmp, 'c')
    w3.activate()
    w3.act('contractor', 'retroactive_request', document=w3.doc('q-figma'))
    w3.days(3.2)
    check('a retroactive request the client ignores is rejected, not paid',
          w3.P.expenses['E1']['status'] == 'REJECTED' and w3.P.expense_released == 0)
    w3.act('contractor', 'retroactive_request', document=w3.doc('q-vercel'))
    w3.act('client', 'answer_request', expense='E2', approve=True)
    check('an approved retroactive request settles at once, within the budget',
          w3.P.expenses['E2']['status'] == 'SETTLED' and w3.P.expense_released == 33000 and conserved(w3.P))
    w3.days(3)
    check('an unstarted milestone past start_by expires and returns its reservation (EXPIRED_UNUSED)',
          w3.P.milestones['M1']['status'] == 'EXPIRED_UNUSED' and w3.P.milestone_reserved == 2500000)


def categories(tmp):
    w = World(tmp, 'd', caps={'hosting': 40000})
    w.activate()
    w.act('contractor', 'request_commitment', document=w.doc('q-vercel'))
    w.act('contractor', 'request_commitment', document=w.doc('q-vercel-2'))
    check('a category budget (ADR 0002 categoryBudgets) blocks the request that would exceed it',
          w.P.expenses['E1']['status'] == 'RESERVED' and w.P.expenses['E2']['decision']['reason'] == 'category_budget')


class Escrow:
    """src/PlobyEscrow.sol's rules in Python: every call a scenario's log implies must pass them."""

    def __init__(self):
        self.p, self.held, self.applied = {}, {}, set()

    def apply(self, c):
        a, pid, call = c['args'], c['pid'], c['call']
        if call == 'open':
            if pid in self.p:
                return 'ProjectExists'
            self.p[pid] = {'contractor': a['contractor'], 'policy': a['policy'], 'budget': a['budget'], 'funded': 0,
                           'reserved': 0, 'paid': 0, 'refunded': 0, 'paused': False}
            return None
        p, key = self.p.get(pid), (pid, c['head'], c['n'])
        if p is None:
            return 'NoProject'
        if key in self.applied:
            return 'AlreadyApplied'
        avail = p['funded'] - p['reserved'] - p['paid'] - p['refunded']
        if call == 'fund':
            if p['funded'] + a['amount'] > p['budget']:
                return 'OverBudget'
            p['funded'] += a['amount']
        elif call == 'accept':
            if a['budget'] < p['funded']:
                return 'OverBudget'
            p['policy'], p['budget'] = a['policy'], a['budget']
        elif call == 'pause':
            p['paused'] = a['paused']
        elif call == 'decide':
            if a['policy'] != p['policy']:
                return 'PolicyMismatch'
            if a['decision'] == 'APPROVE':
                if p['paused']:
                    return 'ProjectPaused'
                if a['amount'] > avail or a['amount'] < 1:
                    return 'InsufficientFunds'
                p['reserved'] += a['amount']
                self.held[(pid, a['ref'])] = self.held.get((pid, a['ref']), 0) + a['amount']
        elif call == 'settle':
            h = self.held.get((pid, a['ref']), 0)
            if a['pay'] + a['returned'] == 0 or a['pay'] + a['returned'] > h:
                return 'OverReserved'
            self.held[(pid, a['ref'])] = h - a['pay'] - a['returned']
            p['reserved'] -= a['pay'] + a['returned']
            p['paid'] += a['pay']
        elif call == 'refund':
            if a['amount'] > avail or a['amount'] < 1:
                return 'InsufficientFunds'
            p['refunded'] += a['amount']
        self.applied.add(key)
        return None


class StubRail:
    escrow, chain_id = '0x' + '00' * 20, 10143

    def tx_url(self, tx):
        return f'https://testnet.monadvision.com/tx/{tx}' if tx else None


def onchain(tmp):
    """The chain mirror (escrow/chain.py, src/PlobyEscrow.sol), from every scenario above; no network."""
    from escrow import chain
    from escrow.engine import Project
    refused, mismatched, every = [], [], []
    for world in WORLDS:  # one contract per scenario (their project ids may coincide)
        model = Escrow()
        P, todo, _ = chain.plan(world.pid, world.st.lines(world.pid), Project)
        for c in todo:
            err = model.apply(c)
            if err:
                refused.append(f"{world.pid[:6]} #{c['line']} {c['call']} {c['args'].get('ref', '')}: {err}")
        every += todo
        p, L = model.p.get(world.pid), P.ledger()
        want = {'funded': L['funded'], 'reserved': L['expense_reserved'] + L['milestone_reserved'], 'paid': L['released'],
                'refunded': L['refunded']}
        if (p and {k: p[k] for k in want} != want) or (not p and L['funded']):
            mismatched.append(f"{world.pid[:6]} {p} != {want}")
        held = {ref: r for ref, (r, _) in chain.money(P)['refs'].items() if r}
        if {ref: model.held.get((world.pid, ref), 0) for ref in held} != held:
            mismatched.append(f"{world.pid[:6]} per-ref reservations differ")
    check('every money change in every scenario is a contract call PlobyEscrow accepts (its rules, in Python)',
          not refused and every, '; '.join(refused[:3]))
    check('after those calls the contract holds exactly the engine ledger (funded, reserved per ref, paid, refunded)',
          not mismatched, '; '.join(mismatched[:2]))
    kinds = {(c['call'], c['args'].get('decision')) for c in every}
    check('a stop is recorded on chain, never silent: BLOCK and HOLD decisions and the client pause are calls',
          {('decide', 'BLOCK'), ('decide', 'HOLD'), ('pause', None)} <= kinds, str(sorted(kinds, key=str)))
    opens = [c for c in every if c['call'] == 'open']
    check('the contract is opened with the signed policy hash and can pay only the contractor fixed in it',
          opens and all(c['args']['contractor'] == pol.address('contractor') and c['args']['policy'].startswith('0x')
                        for c in opens))
    w = WORLDS[0]
    c = next(c for c in chain.plan(w.pid, w.st.lines(w.pid), Project)[1] if c['call'] == 'decide')
    before, tx = w.P.ledger(), '0x' + 'ab' * 32
    w.st.rail = StubRail()
    w.st.chain_result(c, {'tx': tx, 'ok': True, 'error': None, 'block': 1})
    R = w.st.replay(w.pid)
    check("a relayer's chain line names its log line, replays, and moves no money",
          R.head == w.P.head and R.ledger() == before and R.log[c['line']]['chain'][0]['tx'] == tx
          and (c['line'], c['n']) in chain.plan(w.pid, w.st.lines(w.pid), Project)[2])
    w5 = World(tmp, 'e')
    w5.activate()
    prop = {'merchant': 'gabia', 'category': 'domain', 'item': 'x', 'amount': 22000, 'fee': 2200, 'units': 1}
    paused = w5.P.evaluate(prop, True, None, w5.P.at, {'paused': True})[1]
    poor = w5.P.evaluate(prop, True, None, w5.P.at, {'paused': False, 'available': 1000})[1]
    check('a pause or a shortfall the contract shows stops a request even if the engine missed it (state, funds)',
          paused and paused['rule'] == 'state' and poor and poor['rule'] == 'funds')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    began = time.perf_counter()
    tmp = tempfile.mkdtemp(prefix='ploby-check-')
    try:
        run(tmp)
        categories(tmp)
        onchain(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)} checks passed" + (f', {len(failed)} FAILED' if failed else '') +
          f' in {time.perf_counter() - began:.1f} s')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
