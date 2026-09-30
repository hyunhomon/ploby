#!/usr/bin/env python3
"""Matched cold/cache benchmark on eight declared demo fixtures, not a general accuracy claim.

python3 harness/benchmark_submission.py --output evidence/benchmark.json
python3 harness/benchmark_submission.py --verify evidence/benchmark.json  # offline decision replay
"""
import argparse
import hashlib
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from escrow import ai
from harness.check import SAMPLES, World
from harness.usage_report import energy
from pcp import stages

CASES = [('q-gabia', 'APPROVE'), ('q-figma', 'APPROVE'), ('q-vercel', 'APPROVE'),
         ('q-adobe', 'BLOCK'), ('q-adobe-10', 'APPROVE'), ('q-coupang', 'BLOCK'),
         ('r-gabia', 'APPROVE'), ('r-blurry', 'HOLD')]


def decide(document, reading):
    # Same policy, funded ledger and date for both arms. Each case gets a fresh project, so prior reservations
    # cannot confound the comparison. No transaction is sent in this benchmark.
    with tempfile.TemporaryDirectory(prefix='ploby-benchmark-') as tmp:
        w = World(tmp, 'case')
        w.activate()
        w.st.reader = lambda _: reading
        d = w.st.document(document['name'], document['text'])['id']
        w.act('contractor', 'request_commitment', document=d)
        result = w.e('E1')['decision']
        return {k: result.get(k) for k in ('result', 'reason', 'rules')}


def call_metrics(c):
    u = c.get('usage') or {}
    return {'flow': 'quote', 'model': c.get('model'), 'generation_id': c.get('generation_id'),
            'cache_hit': bool(c.get('cached')), 'prompt_tokens': u.get('prompt_tokens', 0),
            'completion_tokens': u.get('completion_tokens', 0),
            'cached_tokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0),
            'cost_usd': u.get('cost'), 'latency_ms': c.get('latency_ms')}


def summarize(rows):
    live = [c for r in rows for c in r['calls'] if not c['cache_hit']]
    bounds = [energy(c) for c in live]
    return {'cases': len(rows), 'correct': sum(r['correct'] for r in rows),
            'false_approvals': sum(r['observed']['result'] == 'APPROVE' and r['expected'] != 'APPROVE' for r in rows),
            'api_calls': len(live), 'cache_hits': sum(c['cache_hit'] for r in rows for c in r['calls']),
            'sent_prompt_tokens': sum(c['prompt_tokens'] for c in live),
            'sent_completion_tokens': sum(c['completion_tokens'] for c in live),
            'cost_usd': sum(c['cost_usd'] or 0 for c in live),
            'wall_seconds': sum(r['wall_seconds'] for r in rows),
            'median_wall_seconds': statistics.median(r['wall_seconds'] for r in rows),
            'assumed_accelerator_bound_wh': sum(b[0] or 0 for b in bounds),
            'assumed_accelerator_estimate_wh': [sum(b[i] or 0 for b in bounds) for i in (1, 2)]}


def run():
    sample = f'submission-{time.time_ns()}'
    result = {'schema': 'ploby.benchmark/1', 'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'model': stages.stage('quote')['model'], 'sample': sample,
              'scope': 'Eight declared application fixtures; fresh project per case; fixed policy and date. '
                       'Cold means no local response cache. Provider prefix caching may still apply. '
                       'Warm immediately replays the identical requests. No claim about unseen documents.',
              'energy_scope': 'Assumptions from docs/efficiency.md, accelerator inference only. '
                              'No Kiln power telemetry; excludes client, storage, networking and chain energy.',
              'policy': {'vendors': ['aws', 'vercel', 'gabia', 'figma', 'adobe-stock'],
                         'per_purchase_including_fees': 200000, 'expense_budget': 500000,
                         'date': '2026-10-01', 'until': '2026-10-31'},
              'phases': {}}
    for phase in ('cold', 'warm'):
        rows = []
        for key, expected in CASES:
            document = {k: SAMPLES[key][k] for k in ('name', 'text')}
            started = time.perf_counter()
            raw = ai.read_quote(document['text'], sample=sample)
            elapsed = time.perf_counter() - started
            reading = {k: raw[k] for k in ('ok', 'proposal', 'fields', 'problems')}
            reading.update(source='ai', model=result['model'], usage=ai.usage_of(raw['calls']),
                           generation_ids=[c.get('generation_id') for c in raw['calls']])
            observed = decide(document, reading)
            rows.append({'id': key, 'document': document,
                         'sha256': hashlib.sha256(document['text'].encode()).hexdigest(),
                         'expected': expected, 'observed': observed, 'correct': observed['result'] == expected,
                         'reading': reading, 'wall_seconds': elapsed, 'calls': [call_metrics(c) for c in raw['calls']]})
            print(f'{phase:4} {key:12} expected {expected:7} observed {observed["result"]:7} {elapsed:.3f}s', flush=True)
        result['phases'][phase] = {'summary': summarize(rows), 'cases': rows}
    return result


def verify(report):
    for phase, data in report['phases'].items():
        for case in data['cases']:
            assert hashlib.sha256(case['document']['text'].encode()).hexdigest() == case['sha256']
            observed = decide(case['document'], case['reading'])
            assert observed == case['observed'], f'{phase}/{case["id"]}: decision differs'
            assert case['correct'] == (observed['result'] == case['expected'])
        assert summarize(data['cases']) == data['summary'], f'{phase}: summary differs'
    cold, warm = (report['phases'][p] for p in ('cold', 'warm'))
    assert cold['summary']['api_calls'] >= len(CASES), 'cold arm did not call Kiln for every case'
    assert warm['summary']['api_calls'] == 0, 'warm arm was not fully cached'
    for a, b in zip(cold['cases'], warm['cases']):
        assert (a['id'], a['sha256'], a['observed']) == (b['id'], b['sha256'], b['observed'])
    print('PASS: fixture hashes, recorded decisions, summaries and matched cache arms reproduce offline.')
    print(json.dumps({p: d['summary'] for p, d in report['phases'].items()}, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path, default=ROOT / 'evidence' / 'benchmark.json')
    ap.add_argument('--verify', type=Path)
    args = ap.parse_args()
    if args.verify:
        verify(json.loads(args.verify.read_text()))
        return
    report = run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    verify(report)


if __name__ == '__main__':
    main()
