"""An auditor's check that needs only the records: python3 -m escrow.audit <project id | log.jsonl> [--data var]
[--offline] [--json]

It does not ask the server anything. From the signed, hash-chained log it verifies every signature and the hash
chain, replays the log with the same open engine code (a line that no longer applies means the record was
edited), and reconstructs, for every payment, what authorized it: the policy version both parties signed, the
request and the document it rested on, each §6 rule with its result, who approved or which pre-agreed fallback
paid, and the payee. Every stop (BLOCK, and HOLDs that never became commitments) is listed with its rule.
Evidence files are checked against the hashes in the log when they are at hand (<data>/docs). Unless --offline,
the public chain is read (no keys): each tx the log names must carry the event its line implies, with that line's
log head, and the contract's balances must equal the replayed ledger.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from . import chain, policy as pol
from .core import Refused, won
from .engine import Project
from .expenses import LABEL, RULES

ROOT = Path(__file__).resolve().parents[1]
PAID_UNIT = {'PAID', 'RELEASED_BY_TIMEOUT'}
MANDATORY = {r for r, _, k in RULES if k == 'mandatory'}
HOW = {  # op -> how a payment was authorized
    'review_settlement': 'the client approved the receipt',
    'answer_request': 'the client approved the request',
    'resolve_expense': "the resolver's decision",
    'resolve_milestone': "the resolver's decision",
    'review_delivery': 'the client accepted the unit',
    'timeout': "the signed policy's fallback at a deadline",
    'submit_receipt': 'the committed cap (the excess waits for a change order)',
    'deposit': 'a change order both parties signed, once funded',
    'sign_policy': 'a change order both parties signed',
    'resume': 'a change order both parties signed, once resumed',
}


def load(target, data):
    path = Path(target)
    if path.is_dir():
        path = path / 'log.jsonl'
    if not path.exists():
        path = Path(data) / 'projects' / str(target) / 'log.jsonl'
    if not path.exists():
        raise SystemExit(f'no log for {target!r} (a project id under {data}/projects, or a log.jsonl path)')
    return path, [json.loads(t) for t in path.read_text(encoding='utf-8').splitlines() if t.strip()]


def doc_check(docs, doc, total=None):
    """The evidence file against the hash the log names: found, hash ok, and whether the total appears in it."""
    if not doc:
        return {'found': False}
    f = Path(docs) / f"{doc['id']}.json"
    if not f.exists():
        return {'found': False, 'id': doc['id']}
    text = json.loads(f.read_text(encoding='utf-8')).get('text', '')
    ok = hashlib.sha256(text.encode('utf-8')).hexdigest() == doc['id']
    amounts = {int(n.replace(',', '')) for n in re.findall(r'(\d[\d,]*)\s*원', text)}
    return {'found': True, 'id': doc['id'], 'hash_ok': ok, 'total_in_text': None if total is None else total in amounts}


def replay(pid, lines):
    """Apply every line again, noting what each one did to requests, payments and policies."""
    P, events, refused = Project(pid), [], None
    for n, line in enumerate(lines):
        before = {eid: (e['status'], e['paid']) for eid, e in P.expenses.items()}
        units = {u['id']: u['status'] for m in P.milestones.values() for u in m['units']}
        refunded, versions = P.refunded, {v['version']: v['status'] for v in P.versions}
        try:
            P.apply(line)
        except Refused as e:
            refused = {'line': n, 'op': line.get('op'), 'by': line.get('by'), 'error': str(e)}
            break
        i = len(P.log) - 1
        ev = {'line': i, 'op': line['op'], 'by': line['by'], 'at': line['at'], 'text': P.log[i]['text'],
              'params': line.get('params') or {}, 'inputs': line.get('inputs') or {}}
        for eid, e in P.expenses.items():
            s0, p0 = before.get(eid, (None, 0))
            if eid not in before:
                events.append({**ev, 'kind': 'request', 'ref': eid})
            if e['paid'] > p0:
                events.append({**ev, 'kind': 'paid', 'ref': eid, 'amount': e['paid'] - p0})
            elif s0 and e['status'] != s0:
                events.append({**ev, 'kind': 'status', 'ref': eid, 'from': s0, 'to': e['status']})
        for m in P.milestones.values():
            for u in m['units']:
                if u['status'] in PAID_UNIT and units.get(u['id']) not in PAID_UNIT:
                    events.append({**ev, 'kind': 'unit_paid', 'ref': m['id'], 'unit': u['id'], 'amount': u['amount'],
                                   'status': u['status']})
        if P.refunded > refunded:
            events.append({**ev, 'kind': 'refund', 'amount': P.refunded - refunded})
        for v in P.versions:
            if v['status'] == 'ACTIVE' and versions.get(v['version']) != 'ACTIVE':
                events.append({**ev, 'kind': 'policy_active', 'version': v['version'], 'hash': v['hash']})
    return P, events, refused


def expense_story(P, e, events, docs):
    """What authorized an expense's payments, from its request to each payment."""
    mine = [x for x in events if x.get('ref') == e['id']]
    req = next(x for x in mine if x['kind'] == 'request')
    v = P.version(e['version'])
    q = e['quote'] or {}
    d = e['decision'] or {}
    rules = [{'rule': r['rule'], 'label': LABEL.get(r['rule'], r['rule']), 'ok': r['ok'], 'detail': r['detail']}
             for r in d.get('rules') or []]
    approvals = [x for x in mine if x['op'] == 'answer_request' and x['params'].get('approve')]
    payments = [x for x in mine if x['kind'] == 'paid']
    contractor = v['doc']['contractorAddress']
    authorized = (d.get('result') == 'APPROVE' and all(r['ok'] for r in rules if r['rule'] in MANDATORY)) or bool(approvals)
    cap = (e['maximum'] or 0) + e['excess_paid']
    inside = (authorized and sum(x['amount'] for x in payments) <= cap
              and (e['settlement'] or {}).get('payee', contractor) == contractor)
    return {'ref': e['id'], 'kind': e['kind'], 'status': e['status'], 'paid': e['paid'], 'payee': contractor,
            'policy': {'version': v['version'], 'hash': v['hash']},
            'request': {'line': req['line'], 'op': req['op'], 'by': req['by'], 'via': req['params'].get('via'),
                        'document': q.get('document'), 'evidence': doc_check(docs, q.get('document'), q.get('total')),
                        'reading': {'vendor': e['vendor'], 'category': e['category'], 'amount': q.get('amount'),
                                    'fee': q.get('fee'), 'total': q.get('total')},
                        'onchain_before': req['inputs'].get('chain')},
            'decision': {'result': d.get('result'), 'reason': d.get('reason'), 'rules': rules},
            'client_approval': [{'line': x['line'], 'reason': x['params'].get('reason')} for x in approvals],
            'payments': [{'line': x['line'], 'op': x['op'], 'by': x['by'], 'amount': x['amount'],
                          'how': HOW.get(x['op'], x['op']), 'text': x['text']} for x in payments],
            'receipt': e['receipt'] and {'document': e['receipt']['document'], 'claimed': e['receipt']['claimed'],
                                         'evidence': doc_check(docs, e['receipt']['document'], e['receipt']['eligible'])},
            'cap': cap, 'inside': inside}



def milestone_story(P, m, events):
    v = P.version(m['version'])
    paid = [x for x in events if x['kind'] == 'unit_paid' and x['ref'] == m['id']]
    return {'ref': m['id'], 'title': m['title'], 'status': m['status'], 'amount': m['amount'],
            'policy': {'version': v['version'], 'hash': v['hash']}, 'payee': v['doc']['contractorAddress'],
            'payments': [{'line': x['line'], 'op': x['op'], 'by': x['by'], 'unit': x['unit'], 'amount': x['amount'],
                          'how': HOW.get(x['op'], x['op'])} for x in paid],
            'inside': sum(x['amount'] for x in paid) <= m['amount']}


def check_chain(pid, P, lines, rail):
    """Each logged tx against the chain, the contract's balances against the ledger, and what is still unsent."""
    _, todo, done = chain.plan(pid, lines, Project)
    contractor = (P.active or P.versions[0])['doc']['contractorAddress'].lower()
    checked, problems = [], []
    for c in todo:
        r = done.get((c['line'], c['n']))
        if r is None:
            problems.append(f"#{c['line']}.{c['n']} {c['call']}: no chain result in the log yet")
            continue
        if not r.get('tx'):
            if not r.get('ok'):
                problems.append(f"#{c['line']}.{c['n']} {c['call']}: the contract refused it ({r.get('error')})")
            continue
        receipt = rail.receipt(r['tx'])
        want = {'projectId': chain.b32(pid).lower(), 'logHead': chain.h32(P.log[c['line']]['head']).lower()}
        a = c['args']
        want.update({
            'open': lambda: {'contractor': a['contractor'].lower(), 'policyHash': a['policy'].lower(), 'budget': a['budget']},
            'fund': lambda: {'amount': a['amount']},
            'accept': lambda: {'policyHash': a['policy'].lower(), 'budget': a['budget']},
            'pause': lambda: {'paused': a['paused']},
            'decide': lambda: {'ref': chain.b32(a['ref']).lower(), 'decision': chain.DECISION[a['decision']],
                               'rule': chain.b32(a['rule']).lower(), 'amount': a['amount'], 'policyHash': a['policy'].lower()},
            'settle': lambda: {'ref': chain.b32(a['ref']).lower(), 'paid': a['pay'], 'returned': a['returned'],
                               'payee': contractor},
            'refund': lambda: {'amount': a['amount']},
        }[c['call']]())
        if not receipt or int(receipt['status'], 16) != 1:
            problems.append(f"#{c['line']}.{c['n']} {c['call']}: tx {r['tx']} has no successful receipt")
            continue
        found = [ev for ev in rail.events_of(receipt) if ev['event'] == chain.CALL_EVENT[c['call']]]
        match = any(all(str(ev['args'].get(k)).lower() == str(v).lower() for k, v in want.items()) for ev in found)
        if not match:
            problems.append(f"#{c['line']}.{c['n']} {c['call']}: tx {r['tx']} does not carry the event its line implies")
        checked.append({'line': c['line'], 'n': c['n'], 'call': c['call'], 'tx': r['tx'], 'ok': match,
                        'url': rail.tx_url(r['tx'])})
    onchain = rail.project(pid)
    L = P.ledger()
    engine = {'funded': L['funded'], 'reserved': L['expense_reserved'] + L['milestone_reserved'], 'paid': L['released'],
              'refunded': L['refunded']}
    same = bool(onchain) and all(onchain[k] == v for k, v in engine.items())
    if onchain and onchain['contractor'].lower() != contractor:
        problems.append('the contract pays a different contractor than the policy names')
    if onchain and not same:
        problems.append(f'the contract holds {({k: onchain[k] for k in engine})}, the ledger says {engine}')
    return {'contract': rail.escrow, 'contract_url': rail.address_url(rail.escrow), 'calls': checked,
            'onchain': onchain, 'engine': engine, 'balances_match': same if onchain else None, 'problems': problems}


def audit(target, data=str(ROOT / 'var'), offline=False):
    path, lines = load(target, data)
    pid = path.parent.name
    docs = Path(data) / 'docs' if (Path(data) / 'docs').exists() else path.parent.parent.parent / 'docs'
    P, events, refused = replay(pid, lines)
    try:
        shown = str(path.resolve().relative_to(ROOT))
    except ValueError:
        shown = str(path)
    report = {'project': pid, 'name': P.name, 'log': shown, 'lines': len(lines), 'head': P.head,
              'replay': {'ok': refused is None, 'refused': refused, 'status': P.status, 'ledger': P.ledger()},
              'policies': [{'version': v['version'], 'hash': v['hash'], 'status': v['status'],
                            'signed': {r: s and s['at'] for r, s in v['signatures'].items()},
                            'readback': v['doc']['expenseRules']['readback']} for v in P.versions]}
    if refused:
        return report
    report['payments'] = [expense_story(P, e, events, docs) for e in P.expenses.values() if e['paid']] + \
                         [milestone_story(P, m, events) for m in P.milestones.values() if m['paid']]
    report['refunds'] = [{'line': x['line'], 'amount': x['amount'], 'by': x['by'], 'to': 'client'}
                         for x in events if x['kind'] == 'refund']
    report['stops'] = [{'ref': e['id'], 'result': (e['decision'] or {}).get('result'), 'status': e['status'],
                        'rule': chain.rule_of(e), 'label': LABEL.get(chain.rule_of(e), chain.rule_of(e)),
                        'line': next(x['line'] for x in events if x.get('ref') == e['id'] and x['kind'] == 'request'),
                        'via': next(x['params'].get('via') for x in events if x.get('ref') == e['id'] and x['kind'] == 'request'),
                        'amount': e['maximum']}
                       for e in P.expenses.values() if (e['decision'] or {}).get('result') in ('BLOCK', 'HOLD') and not e['paid']]
    if not offline and chain.deployment():
        try:
            report['chain'] = check_chain(pid, P, lines, chain.Rail(write=False))
        except (RuntimeError, OSError) as e:
            report['chain'] = {'error': f'chain unreachable ({type(e).__name__})'}
    report['verdict'] = {'records_consistent': refused is None and not (report.get('chain') or {}).get('problems'),
                         'payments': len(report['payments']),
                         'inside': sum(1 for p in report['payments'] if p['inside']), 'stops': len(report['stops'])}
    return report


def mark(ok):
    return '[ok]' if ok else '[!!]' if ok is False else '[--]'


def render(r):
    out = [f"Ploby audit — {r['project']} \"{r['name']}\"",
           f"records: {r['log']} ({r['lines']} lines), head {r['head'][:16]}…"]
    rp = r['replay']
    if not rp['ok']:
        out.append(f"{mark(False)} line #{rp['refused']['line']} ({rp['refused']['op']} by {rp['refused']['by']}) does not "
                   f"apply: {rp['refused']['error']} — the record was edited or is corrupt")
        return '\n'.join(out)
    L = rp['ledger']
    out.append(f"{mark(True)} every signature verifies (demo HMAC keys) and the hash chain recomputes to the head")
    out.append(f"{mark(True)} replaying the log alone rebuilds the state: {rp['status']}, funded {won(L['funded'])}, "
               f"reserved {won(L['expense_reserved'] + L['milestone_reserved'])}, paid {won(L['released'])}, "
               f"refunded {won(L['refunded'])}")
    for v in r['policies']:
        s = v['signed']
        out.append(f"policy v{v['version']} {v['hash'][:18]}… {v['status']}: signed by client {'✓' if s.get('client') else '✗'}, "
                   f"contractor {'✓' if s.get('contractor') else '✗'}")
    out.append('\npayments')
    for p in r['payments']:
        out.append(f"  {p['ref']} {won(p['paid'] if 'paid' in p else sum(x['amount'] for x in p['payments']))} → contractor "
                   f"{p['payee'][:10]}… under policy v{p['policy']['version']}: "
                   f"{'INSIDE what the client allowed' if p['inside'] else 'NOT shown to be inside what the client allowed'}")
        if 'request' in p:
            q, d = p['request'], p['decision']
            ev = q['evidence']
            via = f" via the purchase agent ({q['via'].get('need')})" if q.get('via') else ''
            out.append(f"     #{q['line']} {q['op']} by {q['by']}{via}; document "
                       f"{(q['document'] or {}).get('id', '—')[:12]}… "
                       + ('hash ok' if ev.get('hash_ok') else 'hash MISMATCH' if ev.get('found') else 'not at hand')
                       + (', total appears in it' if ev.get('total_in_text') else ''))
            rd = q['reading']
            out.append(f"     reading: {rd['vendor']} / {rd['category']} / {won(rd['amount'] or 0)} + fee {won(rd['fee'] or 0)}"
                       f" = {won(rd['total'] or 0)}")
            out.append('     rules: ' + '  '.join(f"{x['rule']} {'✓' if x['ok'] else '✗' if x['ok'] is False else '?'}"
                                                 for x in d['rules']) + f"  → {d['result']}")
            for a in p['client_approval']:
                out.append(f"     #{a['line']} the client approved it" + (f" ({a['reason']})" if a['reason'] else ''))
        for x in p['payments']:
            out.append(f"     #{x['line']} {x['op']} by {x['by']}: {won(x['amount'])} — {x['how']}")
    for x in r['refunds']:
        out.append(f"  refund #{x['line']}: {won(x['amount'])} → client (unreserved only)")
    out.append('\nstops (recorded, never silent)')
    for s in r['stops']:
        via = ' (purchase agent)' if s.get('via') else ''
        out.append(f"  {s['ref']} {s['result']} at #{s['line']}{via}: {s['label']} — {s['status']}")
    c = r.get('chain')
    if c:
        out.append('\nchain')
        if 'error' in c:
            out.append(f"  {mark(None)} {c['error']}")
        else:
            out.append(f"  contract {c['contract']} ({c['contract_url']})")
            for x in c['calls']:
                out.append(f"  {mark(x['ok'])} #{x['line']}.{x['n']} {x['call']:6} {x['url']}")
            out.append(f"  {mark(c['balances_match'])} the contract's funded/reserved/paid/refunded equal the replayed ledger")
            for problem in c['problems']:
                out.append(f"  {mark(False)} {problem}")
    v = r['verdict']
    out.append(f"\nverdict: {v['inside']} of {v['payments']} payments shown inside what the client allowed; "
               f"{v['stops']} stops recorded; records {'consistent' if v['records_consistent'] else 'NOT consistent'}")
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(prog='python3 -m escrow.audit', description=__doc__.split('\n\n')[0])
    ap.add_argument('target', help='a project id (under --data/projects) or a path to its log.jsonl')
    ap.add_argument('--data', default=str(ROOT / 'var'))
    ap.add_argument('--offline', action='store_true', help='do not read the chain')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    r = audit(a.target, a.data, a.offline)
    print(json.dumps(r, ensure_ascii=False, indent=2, default=str) if a.json else render(r))
    ok = r['replay']['ok'] and r.get('verdict', {}).get('records_consistent')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
