#!/usr/bin/env python3
"""Kiln usage per flow, from the local call log: API calls and cache hits, tokens, cost, latency and energy.

Run from the repository root:

    python3 harness/usage_report.py          plain text
    python3 harness/usage_report.py --md     Markdown (the tables in docs/efficiency.md)

It reads harness/runs/usage.jsonl, where pcp/kiln.py appends one line per chat completion (local, gitignored).
No network, no model call, nothing spent; standard library only.

A line, as pcp/kiln.py chat() writes it:
  cache_hit false  Kiln served the request. Tokens and cost_usd are Kiln's usage object (cached_tokens: the part of
                   prompt_tokens the provider's prefix cache served; reasoning_tokens: the part of completion_tokens
                   spent thinking); latency_ms is the client's clock around the HTTP round trip; generation_id is
                   Kiln's X-Neocloud-Generation-Id.
  cache_hit true   replayed from harness/runs/cache, keyed by the exact request: nothing was sent, nothing billed.
                   It names the replayed call (request digest, generation id), so the report can say what that
                   call cost when it was sent.

Groups:
  app    a stage the app calls (pcp/stages.py, pipeline.json: write, read, reread, quote, change, agent, and any
         stage added later)
  dev    the pipeline's development and evaluation runs from before it moved into this repository: flows no code
         here calls any more (RETIRED), and app stages run on the pipeline's benchmark domains (BENCH_DOMAINS, named
         in the tag, e.g. writer:shopping:0)
  other  any other flow name: shown, never dropped

Energy (each figure and its source: docs/efficiency.md):
  bound     cards x rated card power x measured latency: the whole model replica at full rated power for the whole
            round trip. An upper bound for the stated hardware: batching and network time only lower the true figure.
  estimate  per token, from a published measurement of Qwen3-32B FP8 on four RNGD cards: prefill energy for each
            prompt token the prefix cache did not serve, plus decode energy for each completion token, from the
            replica fully loaded (busy) to the request alone on it (alone). qwen3-32b only.
"""
import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / 'harness' / 'runs' / 'usage.jsonl'
DEFAULT_MODEL = 'qwen3-32b'

# Flows no code in this repository calls any more, and what each one was (from its tags and cached replies).
RETIRED = {
    'smoke': 'connectivity checks (a one-word reply)',
    'compile': 'the writer stage under its earlier name',
    'determinism': 'two compile requests, each sent five times at temperature 0, to see whether replies repeat',
    'propose': 'an earlier shopping agent calling tools (search, propose_purchase)',
    'check': 'a model asked whether a readback matched the words (code compares two readings now)',
    'plan': 'the earlier shopping agent: what to buy',
    'pick': 'the earlier shopping agent: which offer to take',
}
BENCH_DOMAINS = {'shopping', 'compute'}  # the pipeline's test domains; domains/ ships only escrow

# USD per 1M tokens (docs/kiln-notes.md, kiln.bricksum.com/models), used only when a line's cost_usd is missing or 0.
# qwen3-32b cached_input is inferred, not published: half the input price reproduces Kiln's reported cost on every
# logged call with cached tokens (the report checks this). deepseek reported no cached tokens: full price assumed.
PRICES = {
    'qwen3-32b': {'input': 0.08, 'cached_input': 0.04, 'output': 0.28},
    'deepseek-v4.1-flash': {'input': 4.00, 'cached_input': 4.00, 'output': 8.00},
}

# (cards per model replica, rated W per card, what). qwen3-32b: Kiln does not publish its hardware; assumed to be
# FuriosaAI's published build (Qwen3-32B-FP8, tensor parallel over 32 PEs = 4 RNGD cards) at the card's 180 W TDP.
# deepseek-v4.1-flash: Kiln's catalog says 8x AMD Instinct MI325X; AMD's datasheet gives 1,000 W maximum board power.
HARDWARE = {
    'qwen3-32b': (4, 180, '4 x FuriosaAI RNGD, 180 W TDP each'),
    'deepseek-v4.1-flash': (8, 1000, '8 x AMD Instinct MI325X, 1,000 W max board power each'),
}

# Per-token energy for qwen3-32b, from Lablup and FuriosaAI's benchmark of Qwen3-32B FP8 on 4 RNGD cards
# (1,024 prompt / 1,024 output tokens, prefix caching off): Table 11 (4-card power), Table 12 (TTFT, TPOT).
PREFILL_J = 436 * 0.14 / 1024       # per prompt token not served by the prefix cache: 436 W x 0.14 s TTFT / 1,024
DECODE_ALONE_J = 436 * 0.0139       # per completion token, the request alone (concurrency 1): 436 W x 13.9 ms TPOT
DECODE_BUSY_J = 692 * 0.0992 / 256  # per completion token, replica full (concurrency 256): 692 W x 99.2 ms / 256
PER_TOKEN_MODELS = {'qwen3-32b'}


def load(path):
    """The log's lines as dicts, and how many lines were not one JSON object."""
    rows, bad = [], 0
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            row = None
        if isinstance(row, dict):
            rows.append(row)
        else:
            bad += 1
    return rows, bad


def app_stages():
    """The app's model stages in routing order: pcp/stages.py DEFAULTS, then any other stage pipeline.json names."""
    names = []
    try:
        sys.path.insert(0, str(ROOT))
        from pcp import stages
        names += list(stages.DEFAULTS)
    except Exception:  # the report still runs from pipeline.json alone
        pass
    try:
        names += [k for k in json.loads((ROOT / 'pipeline.json').read_text(encoding='utf-8')) if not k.startswith('_')]
    except (OSError, ValueError):
        pass
    return list(dict.fromkeys(names))


def bench_of(row):
    return BENCH_DOMAINS & set(str(row.get('tag') or '').split(':'))


def group_of(row, stages):
    flow = row.get('flow') or '?'
    if flow in stages:
        return 'dev' if bench_of(row) else 'app'
    return 'dev' if flow in RETIRED else 'other'


def num(row, key):
    v = row.get(key)
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def formula_cost(row):
    p = PRICES.get(row.get('model'))
    if p is None:
        return None
    cached = num(row, 'cached_tokens')
    return ((num(row, 'prompt_tokens') - cached) * p['input'] + cached * p['cached_input']
            + num(row, 'completion_tokens') * p['output']) / 1e6


def priced(row):
    """(USD, reported?) for an API call: Kiln's usage.cost, or the price list's when it is missing or 0."""
    cost = row.get('cost_usd')
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost > 0:
        return float(cost), True
    return formula_cost(row), False


def energy(row):
    """(bound Wh, estimate Wh busy, estimate Wh alone) for an API call; None where the model has no figure."""
    hw = HARDWARE.get(row.get('model'))
    bound = hw[0] * hw[1] * num(row, 'latency_ms') / 1000 / 3600 if hw else None
    if row.get('model') not in PER_TOKEN_MODELS:
        return bound, None, None
    prefill = PREFILL_J * max(num(row, 'prompt_tokens') - num(row, 'cached_tokens'), 0)
    out = num(row, 'completion_tokens')
    return bound, (prefill + DECODE_BUSY_J * out) / 3600, (prefill + DECODE_ALONE_J * out) / 3600


def blank():
    return {'calls': 0, 'hits': 0, 'prompt': 0, 'cached': 0, 'completion': 0, 'reasoning': 0, 'cost': 0.0,
            'unpriced': 0, 'latency': [], 'bound': 0.0, 'busy': 0.0, 'alone': 0.0, 'no_bound': 0, 'no_estimate': 0,
            'hit_cost': 0.0, 'hit_bound': 0.0, 'hit_busy': 0.0, 'hit_alone': 0.0, 'orphans': 0, 'first': None,
            'domains': set()}


def add(a, b):
    """Fold aggregate b into a (for totals)."""
    for k, v in b.items():
        if k == 'first':
            a[k] = v if a[k] is None else a[k] if v is None else min(a[k], v)
        elif k == 'domains':
            a[k] |= v
        else:
            a[k] = a[k] + v
    return a


def summarize(rows, stages):
    """{(group, flow, model): aggregate}. A cache hit is counted under the model of the call it replays."""
    sent = {}
    for r in rows:
        if not r.get('cache_hit') and r.get('request'):
            sent.setdefault(r['request'], r)
    out = defaultdict(blank)
    for r in rows:
        hit = bool(r.get('cache_hit'))
        source = sent.get(r.get('request')) if hit else r
        a = out[(group_of(r, stages), r.get('flow') or '?', (source or {}).get('model') or '?')]
        t = num(r, 't')
        if t > 0:
            a['first'] = t if a['first'] is None else min(a['first'], t)
        a['domains'] |= bench_of(r)
        if hit:
            a['hits'] += 1
            a['orphans'] += source is None
            if source is not None:
                bound, busy, alone = energy(source)
                a['hit_cost'] += priced(source)[0] or 0
                a['hit_bound'] += bound or 0
                a['hit_busy'] += busy or 0
                a['hit_alone'] += alone or 0
            continue
        a['calls'] += 1
        for k, field in (('prompt', 'prompt_tokens'), ('cached', 'cached_tokens'), ('completion', 'completion_tokens'),
                         ('reasoning', 'reasoning_tokens')):
            a[k] += int(num(r, field))
        cost, _ = priced(r)
        a['cost'] += cost or 0
        a['unpriced'] += cost is None
        a['latency'].append(num(r, 'latency_ms') / 1000)
        bound, busy, alone = energy(r)
        a['bound'] += bound or 0
        a['no_bound'] += bound is None
        a['busy'] += busy or 0
        a['alone'] += alone or 0
        a['no_estimate'] += busy is None
    return out


# -- formatting

def sig(v, digits=3):
    """v to `digits` significant digits, never in exponent form; '—' for None."""
    if v is None:
        return '—'
    if v == 0:
        return '0'
    decimals = max(digits - 1 - math.floor(math.log10(abs(v))), 0)
    return f'{v:,.{decimals}f}'


def share(part, whole):
    return f'{part:,} ({100 * part / whole:.0f}%)' if whole else f'{part:,}'


def percentile(values, p):
    """Nearest-rank percentile."""
    if not values:
        return None
    s = sorted(values)
    return s[max(math.ceil(p / 100 * len(s)) - 1, 0)]


def seconds(v):
    return '—' if v is None else f'{v:.1f}'


def energy_cells(a, per_call=False):
    """Energy bound and estimate (busy–alone) cells, total or per API call."""
    d = a['calls'] if per_call else 1
    if not a['calls']:
        return '—', '—'
    bound = sig(a['bound'] / d) if a['calls'] > a['no_bound'] else '—'
    est = f"{sig(a['busy'] / d)}–{sig(a['alone'] / d)}" if a['calls'] > a['no_estimate'] else '—'
    mark = '*' if 0 < a['no_estimate'] < a['calls'] else ''
    return bound, est + mark


def token_row(label, a):
    return [label, f"{a['calls']:,}", f"{a['hits']:,}", f"{a['prompt']:,}", share(a['cached'], a['prompt']),
            f"{a['completion']:,}", share(a['reasoning'], a['completion']),
            sig(a['cost']) + ('*' if a['unpriced'] else '')]


def energy_row(label, a):
    return [label, f"{a['calls']:,}", seconds(percentile(a['latency'], 50)), seconds(percentile(a['latency'], 95)),
            *energy_cells(a), *energy_cells(a, per_call=True)]


TOKEN_HEAD = ['Flow', 'API calls', 'Local cache hits', 'Prompt tokens', 'Provider-cached prompt (% of prompt)',
              'Completion tokens', 'Reasoning (% of completion)', 'Cost USD']
ENERGY_HEAD = ['Flow', 'API calls', 'Latency p50 s', 'Latency p95 s', 'Energy bound Wh', 'Estimate Wh (busy–alone)',
               'Bound per call Wh', 'Estimate per call Wh (busy–alone)']


def render(head, rows, md):
    """A table: Markdown (numbers right-aligned) or fixed-width text."""
    numeric = [all(r[i][:1].isdigit() or r[i][:1] in '—$' for r in rows) and i > 0 for i in range(len(head))]
    if md:
        lines = ['| ' + ' | '.join(head) + ' |', '|' + '|'.join('---:' if n else '---' for n in numeric) + '|']
        return '\n'.join(lines + ['| ' + ' | '.join(r) + ' |' for r in rows])
    widths = [max(len(str(x)) for x in col) for col in zip(head, *rows)]

    def line(r):
        return '  '.join(str(x).rjust(w) if n else str(x).ljust(w) for x, w, n in zip(r, widths, numeric)).rstrip()
    return '\n'.join([line(head), line(['-' * w for w in widths])] + [line(r) for r in rows])


def label(flow, model, group, domains):
    text = flow if model in (DEFAULT_MODEL, '?') else f'{flow} ({model})'
    return text + (f" [{', '.join(sorted(domains))}]" if group == 'dev' and domains and flow not in RETIRED else '')


def when(t):
    return datetime.fromtimestamp(t).astimezone().strftime('%Y-%m-%d %H:%M (UTC%z)')


def report(path, md):
    rows, bad = load(path)
    stages = app_stages()
    table = summarize(rows, stages)
    out = []
    say = out.append
    heading = (lambda text: say(f'\n### {text}\n')) if md else (lambda text: say(f'\n== {text}\n'))

    api = [r for r in rows if not r.get('cache_hit')]
    times = [num(r, 't') for r in rows if num(r, 't') > 0]
    code = (lambda s: f'`{s}`') if md else (lambda s: s)
    span = f', {when(min(times))} to {when(max(times))}' if times else ''
    try:
        shown = path.relative_to(ROOT)
    except ValueError:
        shown = path
    say(f"Source: {code(shown)}, {len(rows):,} lines "
        f"({len(api):,} API calls, {len(rows) - len(api):,} local cache hits){span}. "
        f"Generated by {code('python3 harness/usage_report.py' + (' --md' if md else ''))}.")

    groups = defaultdict(list)
    for (group, flow, model), a in table.items():
        groups[group].append((flow, model, a))

    # the app: every stage in routing order, including stages not called yet
    app = {(flow, model): a for flow, model, a in groups['app']}
    app_rows = []
    for stage in stages:
        found = [(m, a) for (f, m), a in app.items() if f == stage]
        for model, a in sorted(found, key=lambda x: x[0] != DEFAULT_MODEL) or [(DEFAULT_MODEL, blank())]:
            app_rows.append((label(stage, model, 'app', ()), a))
    heading('Ploby app flows')
    say(render(TOKEN_HEAD, [token_row(n, a) for n, a in app_rows], md))
    say('')
    say(render(ENERGY_HEAD, [energy_row(n, a) for n, a in app_rows], md))

    dev = sorted(groups['dev'], key=lambda x: (x[2]['first'] or 0, x[0], x[1]))
    dev_rows = [(label(f, m, 'dev', a['domains']), a) for f, m, a in dev]
    if dev_rows:
        heading('Earlier pipeline development and evaluation flows')
        say(render(TOKEN_HEAD, [token_row(n, a) for n, a in dev_rows], md))
        say('')
        say(render(ENERGY_HEAD, [energy_row(n, a) for n, a in dev_rows], md))
        say('')
        seen = {f for f, _, _ in dev}
        bench = sorted({f for f, _, a in dev if f not in RETIRED})
        domains = sorted(set().union(*(a['domains'] for _, _, a in dev)))
        bullet = '- ' if md else '  '
        for flow in [f for f in RETIRED if f in seen]:
            say(f'{bullet}{code(flow)}: {RETIRED[flow]}')
        if bench:
            say(f"{bullet}{', '.join(code(f) for f in bench)} [{', '.join(domains)}]: the app's stages run on the "
                f"pipeline's benchmark domains")

    other = sorted(groups['other'], key=lambda x: (x[0], x[1]))
    if other:
        heading('Other flows (not a stage in pcp/stages.py, not a known earlier flow)')
        other_rows = [(label(f, m, 'other', ()), a) for f, m, a in other]
        say(render(TOKEN_HEAD, [token_row(n, a) for n, a in other_rows], md))
        say('')
        say(render(ENERGY_HEAD, [energy_row(n, a) for n, a in other_rows], md))

    totals = {g: blank() for g in ('app', 'dev', 'other')}
    for (group, _, _), a in table.items():
        add(totals[group], a)
    everything = blank()
    for a in totals.values():
        add(everything, a)
    names = {'app': 'Ploby app flows', 'dev': 'Development and evaluation', 'other': 'Other flows'}
    total_rows = [(names[g], totals[g]) for g in ('app', 'dev', 'other') if totals[g]['calls'] or totals[g]['hits']]
    total_rows.append(('All flows', everything))
    heading('Totals')
    head = ['Group', 'API calls', 'Local cache hits', 'Prompt tokens', 'Provider-cached prompt', 'Completion tokens',
            'Reasoning', 'Cost USD', 'Energy bound Wh', 'Estimate Wh (busy–alone)']
    say(render(head, [token_row(n, a) + list(energy_cells(a)) for n, a in total_rows], md))

    heading('Local cache replays (harness/runs/cache)')
    say('A replay sends nothing and costs nothing. The table gives what the replayed requests cost when they were '
        'first sent, which is what sending them again would have cost at the same usage.')
    say('')
    head = ['Group', 'Replays', 'Their cost when sent, USD', 'Their energy bound, Wh', 'Their estimate, Wh (busy–alone)']
    say(render(head, [[n, f"{a['hits']:,}", sig(a['hit_cost']), sig(a['hit_bound']),
                       f"{sig(a['hit_busy'])}–{sig(a['hit_alone'])}"]
                      for n, a in total_rows if a['hits'] or n == 'All flows'], md))
    if everything['orphans']:
        say(f"\n{everything['orphans']:,} replay(s) name a request with no API line in this log: not in the sums above.")

    heading('Notes')
    bullet = '- ' if md else '  '
    say(f'{bullet}A row is one flow on one model; a local cache hit counts under the model of the call it replays. '
        f'Reasoning tokens are part of completion tokens, provider-cached tokens part of prompt tokens. Latency is '
        f'the client-measured round trip (network and queueing included).')
    reported = [r for r in api if priced(r)[1]]
    computed = [r for r in api if not priced(r)[1] and priced(r)[0] is not None]
    unpriced = len(api) - len(reported) - len(computed)
    say(f"{bullet}Cost: Kiln's reported usage.cost on {len(reported):,} of {len(api):,} API calls"
        + (f'; computed from tokens and the price list (PRICES) on {len(computed):,}' if computed else '')
        + (f'; no price for {unpriced:,} (a cost marked * leaves them out)' if unpriced else '') + '.')
    test = [r for r in reported if r.get('model') == DEFAULT_MODEL and num(r, 'cached_tokens') > 0]
    match = [r for r in test if abs(formula_cost(r) - r['cost_usd']) <= 1e-9 + 1e-6 * r['cost_usd']]
    if test:
        p = PRICES[DEFAULT_MODEL]
        say(f"{bullet}Kiln's cost equals (uncached prompt x ${p['input']} + cached prompt x ${p['cached_input']} + "
            f"completion x ${p['output']}) per 1M tokens on {len(match):,} of {len(test):,} {DEFAULT_MODEL} calls with "
            f"cached tokens" + (': cached input is billed at half the input price (inferred from the bills; not '
                                'published).' if len(match) == len(test) else '.'))
    silent = sorted({r.get('model') or '?' for r in api if r.get('cached_tokens') is None})
    if silent:
        say(f"{bullet}No cached-token count is reported on calls to {', '.join(silent)}: their provider-cached "
            f"share reads 0.")
    say(f"{bullet}Energy bound = cards x rated power x latency ("
        + '; '.join(f'{m}: {hw[2]}' for m, hw in HARDWARE.items()) + ').')
    partial = any(0 < a['no_estimate'] < a['calls'] for a in (*table.values(), *totals.values(), everything))
    say(f'{bullet}Energy estimate ({DEFAULT_MODEL} only): {PREFILL_J:.3f} J per prompt token the provider cache did '
        f'not serve + {DECODE_BUSY_J:.3f} J (busy) to {DECODE_ALONE_J:.2f} J (alone) per completion token.'
        + (' An estimate marked * leaves out calls on other models.' if partial else ''))
    no_id = defaultdict(int)
    for r in api:
        if not r.get('generation_id'):
            no_id[r.get('flow') or '?'] += 1
    if no_id:
        say(f"{bullet}API lines without a Kiln generation id (not written by pcp/kiln.py; counted as logged): "
            + ', '.join(f'{f} {n}' for f, n in sorted(no_id.items())) + '.')
    empty = defaultdict(int)
    for r in api:
        if num(r, 'completion_tokens') == 0:
            empty[r.get('flow') or '?'] += 1
    if empty:
        say(f"{bullet}API calls reported with 0 completion tokens (counted as reported): "
            + ', '.join(f'{f} {n}' for f, n in sorted(empty.items())) + '.')
    if bad:
        say(f'{bullet}{bad} line(s) were not JSON objects and were skipped.')
    return '\n'.join(out).strip() + '\n'


def main():
    p = argparse.ArgumentParser(prog='python3 harness/usage_report.py', description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--md', action='store_true', help='print Markdown tables')
    p.add_argument('--log', type=Path, default=LOG, help='the usage log (default: harness/runs/usage.jsonl)')
    a = p.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if not a.log.exists():
        sys.exit(f'no usage log at {a.log} (pcp/kiln.py writes it on the first Kiln call)')
    sys.stdout.write(report(a.log.resolve(), a.md))


if __name__ == '__main__':
    main()
