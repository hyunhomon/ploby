#!/usr/bin/env python3
"""Random projects against the chain mirror: python3 harness/fuzz.py [seeds] (no model, no network)

Each seed plays a random sequence of every action there is (deposits, requests, approvals and refusals, receipts,
objections, the resolver, deadlines passing, pause and resume, change orders, milestones, closing and refunds) on
one project, with readings from the fixed table of harness/check.py. Then the contract calls its log implies
(escrow/chain.py) go through the Python model of PlobyEscrow's rules (harness/check.py Escrow): every call must be
accepted, and the contract must end with exactly the engine's ledger, reservation by reservation. Exit 1 on any
seed that fails.
"""
import random
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'harness'))
import check as H  # noqa: E402
from escrow import chain  # noqa: E402
from escrow.core import Refused  # noqa: E402
from escrow.engine import Project  # noqa: E402
from escrow.store import Store  # noqa: E402

QUOTES = ['q-gabia', 'q-figma', 'q-coupang', 'q-adobe', 'q-adobe-10', 'q-aws-injection', 'q-vercel', 'q-vercel-2']
RECEIPTS = ['r-gabia', 'r-figma', 'r-figma-over', 'r-aws']


def fresh_doc(st, key, n):
    s = H.SAMPLES[key]
    return st.document(s['name'], s['text'] + f'\n(사본 {n})')['id']


def run(seed, steps=120):
    rnd = random.Random(seed)
    tmp = tempfile.mkdtemp(prefix=f'fuzz{seed}-')
    st = Store(Path(tmp), reader=lambda text: H.reader(text.split('\n(사본')[0]), drafter=H.drafter)
    st.offset = int(time.mktime((2026, 10, 1, 10, 0, 0, 0, 0, -1)) * 1000) - int(time.time() * 1000)
    pid = st.create('client', H.spec())['id']
    n = 0
    tried = ok = 0
    for _ in range(steps):
        P = st.projects[pid]
        n += 1
        choice = rnd.randrange(22)
        try:
            tried += 1
            if choice == 0:
                st.act(pid, 'client', 'sign_policy', {'version': rnd.choice([v['version'] for v in P.versions])})
            elif choice == 1:
                st.act(pid, 'contractor', 'sign_policy', {'version': rnd.choice([v['version'] for v in P.versions])})
            elif choice == 2:
                need = P.funding_needed() or rnd.randint(1, max(1, P.deposit_room()))
                st.act(pid, 'client', 'deposit', {'amount': need})
            elif choice in (3, 4):
                st.act(pid, 'contractor', 'request_commitment', {'document': fresh_doc(st, rnd.choice(QUOTES), n)})
            elif choice == 5:
                st.act(pid, 'contractor', 'retroactive_request', {'document': fresh_doc(st, rnd.choice(QUOTES), n)})
            elif choice == 6:
                e = rnd.choice(list(P.expenses) or ['E1'])
                st.act(pid, 'client', 'answer_request', {'expense': e, 'approve': rnd.random() < 0.7, 'reason': 'x'})
            elif choice == 7:
                e = rnd.choice(list(P.expenses) or ['E1'])
                st.act(pid, 'contractor', 'report_spend', {'expense': e})
            elif choice == 8:
                e = rnd.choice(list(P.expenses) or ['E1'])
                mx = (P.expenses.get(e) or {}).get('maximum') or 1000
                st.act(pid, 'contractor', 'submit_receipt', {'expense': e, 'document': fresh_doc(st, rnd.choice(RECEIPTS), n),
                                                            'claimed': rnd.choice([mx, max(1, mx - 1000)])})
            elif choice == 9:
                e = rnd.choice(list(P.expenses) or ['E1'])
                st.act(pid, 'client', 'review_settlement', {'expense': e, 'approve': rnd.random() < 0.6, 'reason': '이의'})
            elif choice == 10:
                e = rnd.choice(list(P.expenses) or ['E1'])
                st.act(pid, 'resolver', 'resolve_expense', {'expense': e, 'accept': rnd.random() < 0.5, 'reason': '결정'})
            elif choice == 11:
                st.advance(rnd.choice([3600, 86400, 3 * 86400, 8 * 86400]))
                st.keeper(pid)
            elif choice == 12:
                st.act(pid, 'client', rnd.choice(['pause', 'resume']), {'reason': 'x'})
            elif choice == 13:
                e = next((x for x, v in P.expenses.items() if v['status'] == 'PARTIALLY_SETTLED'), None)
                if e and rnd.random() < 0.5:
                    st.act(pid, rnd.choice(['client', 'contractor']), 'draft_change_order', {'text': '초과분', 'covers_excess': e})
                else:
                    st.act(pid, rnd.choice(['client', 'contractor']), 'draft_change_order', {'text': '로그인 기능 추가'})
            elif choice == 14:
                c = rnd.choice(list(P.change_orders) or ['C1'])
                co = P.change_orders.get(c)
                if co and co['status'] == 'DRAFT' and not co['draft'].get('covers_excess'):
                    st.act(pid, 'contractor', 'edit_change_order', {'change_order': c, 'draft': {
                        'title': '로그인', 'units': [{'title': '로그인', 'criteria': ['이메일 로그인'], 'amount': rnd.choice([100000, 900000])}],
                        'start_by': '2026-11-20', 'due_at': '2026-11-30', 'grace_days': 2, 'expense_budget_delta': rnd.choice([0, 50000])}})
                st.act(pid, rnd.choice(['client', 'contractor']), 'propose_change_order', {'change_order': c})
            elif choice == 15:
                m = rnd.choice(list(P.milestones) or ['M1'])
                st.act(pid, 'contractor', 'start_milestone', {'milestone': m})
            elif choice == 16:
                m = P.milestones.get(rnd.choice(list(P.milestones) or ['M1']))
                if m:
                    units = [u['id'] for u in m['units'] if u['status'] == 'RESERVED']
                    st.act(pid, 'contractor', 'submit_delivery', {'milestone': m['id'], 'units': units[:rnd.randint(1, max(1, len(units)))]})
            elif choice == 17:
                m = P.milestones.get(rnd.choice(list(P.milestones) or ['M1']))
                if m:
                    claimed = [u for u in m['units'] if u['status'] == 'CLAIMED']
                    acc = [u['id'] for u in claimed if rnd.random() < 0.6]
                    obj = [{'unit': u['id'], 'criterion': u['criteria'][0], 'reason_code': 'NOT_MET', 'reason': 'x'}
                           for u in claimed if u['id'] not in acc]
                    st.act(pid, 'client', 'review_delivery', {'milestone': m['id'], 'accept': acc, 'object': obj})
            elif choice == 18:
                m = P.milestones.get(rnd.choice(list(P.milestones) or ['M1']))
                if m:
                    open_ = 'RESERVED' if m['status'] == 'NON_DELIVERY' else 'DISPUTED'
                    ds = [{'unit': u['id'], 'accept': rnd.random() < 0.5 and open_ == 'DISPUTED', 'reason': 'r'}
                          for u in m['units'] if u['status'] == open_]
                    st.act(pid, 'resolver', 'resolve_milestone', {'milestone': m['id'], 'decisions': ds})
            elif choice == 19:
                if rnd.random() < 0.15:
                    st.act(pid, rnd.choice(['client', 'contractor']), 'begin_close', {})
            elif choice == 20:
                st.act(pid, 'client', 'withdraw', {})
            elif choice == 21:
                e = rnd.choice(list(P.expenses) or ['E1'])
                st.act(pid, 'contractor', 'cancel_reservation', {'expense': e})
            ok += 1
        except Refused:
            pass
    model = H.Escrow()
    P, todo, _ = chain.plan(pid, st.lines(pid), Project)
    refused = []
    for c in todo:
        err = model.apply(c)
        if err:
            refused.append(f"#{c['line']}.{c['n']} {c['call']} {c['args']}: {err}")
    L = P.ledger()
    want = {'funded': L['funded'], 'reserved': L['expense_reserved'] + L['milestone_reserved'], 'paid': L['released'],
            'refunded': L['refunded']}
    p = model.p.get(pid)
    got = {k: p[k] for k in want} if p else None
    m = chain.money(P)
    refs = set(m['refs']) | {ref for (q, ref) in model.held if q == pid}
    held = {ref: m['refs'].get(ref, (0, 0))[0] for ref in refs}
    per_ref = {ref: model.held.get((pid, ref), 0) for ref in refs}
    same_policy = not p or p['policy'] == (m['active'] or m['policy']) and p['paused'] == P.paused
    bad = refused or (p and got != want) or (not p and L['funded']) or per_ref != held or not same_policy
    return bad, refused, got, want, ok, tried, len(todo), P.status, len(P.expenses), len(P.change_orders)


if __name__ == '__main__':
    fails = 0
    for seed in range(int(sys.argv[1]) if len(sys.argv) > 1 else 200):
        bad, refused, got, want, ok, tried, calls, status, ne, nc = run(seed)
        if bad:
            fails += 1
            print(f'seed {seed}: BAD status={status} calls={calls} expenses={ne} cos={nc}')
            for r in refused[:4]:
                print('   ', r)
            if got != want:
                print('    chain', got, 'ledger', want)
    print(f'{fails} of {seed + 1} random projects put the chain out of step with the ledger')
    sys.exit(1 if fails else 0)
