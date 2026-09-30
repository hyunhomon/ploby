"""The Kiln client: stdlib only, the key read from .env and never printed.

Every call is metered to harness/runs/usage.jsonl by flow (the challenge asks for token
use per flow): tokens, cached and reasoning tokens, cost, latency and Kiln's
generation id, which is the evidence that a call reached the API. Responses are
cached by the exact request (harness/runs/cache/), so re-running a check that has not
changed costs nothing; a cache hit is logged as such and not counted as spent.

The organization shares 8 requests in flight and 60 a minute across the team,
so this client keeps to KILN_CONCURRENCY (4) and KILN_RPM (30) by default.

Money: the team shares one $100 budget. Before any call is made, three guards:
KILN_RUN_CAP_USD (0.50) for this process, KILN_BUDGET_USD (5) for everything logged
here, and KILN_KEY_STOP_USD (80) for the key's own spend (GET /key,
which is free). A guard that trips raises BudgetError; nothing is sent.
"""
import hashlib
import http.client
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://api.bricksum.com/v1'
MODEL = os.environ.get('KILN_MODEL', 'qwen3-32b')  # the organizers moved the challenge off gpt-oss-120b
ROOT = Path(__file__).resolve().parents[1]


def _runs_dir():
    """Writable meter/cache dir (repo harness/runs locally, /tmp on Vercel)."""
    if os.environ.get('KILN_RUNS_DIR'):
        return Path(os.environ['KILN_RUNS_DIR'])
    if os.environ.get('VERCEL'):
        return Path('/tmp/ploby-kiln')
    return ROOT / 'harness' / 'runs'


RUNS = _runs_dir()
CACHE = RUNS / 'cache'
USAGE = RUNS / 'usage.jsonl'


def _key():
    key = os.environ.get('KILN_API_KEY')
    if key:
        return key
    env_path = ROOT / '.env'
    if env_path.is_file():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            name, _, value = line.partition('=')
            if name.strip() in ('API_KEY', 'KILN_API_KEY'):
                return value.strip().strip('"\'')
    raise SystemExit('no API_KEY in .env')


_slots = threading.Semaphore(int(os.environ.get('KILN_CONCURRENCY', '4')))
_pace_lock = threading.Lock()
_starts = []
_log_lock = threading.Lock()
RPM = int(os.environ.get('KILN_RPM', '30'))


def _pace():
    """Wait until a request fits in the last minute's budget."""
    while True:
        with _pace_lock:
            now = time.monotonic()
            while _starts and now - _starts[0] > 60:
                _starts.pop(0)
            if len(_starts) < RPM:
                _starts.append(now)
                return
            wait = 60 - (now - _starts[0]) + 0.05
        time.sleep(wait)


def _request(method, path, body=None, timeout=100):
    data = None if body is None else json.dumps(body).encode('utf-8')
    # Cloudflare in front of the API refuses Python's default User-Agent (error 1010).
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        'Authorization': f'Bearer {_key()}', 'Content-Type': 'application/json', 'User-Agent': 'pcp/0.2'})
    for attempt in range(6):
        _pace()
        try:
            with _slots:
                began = time.perf_counter()
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    payload = json.loads(r.read())
                    return payload, dict(r.headers), (time.perf_counter() - began) * 1000
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors='replace')[:500]
            if e.code == 429 or e.code >= 500:
                reset = e.headers.get('x-ratelimit-reset')
                delay = float(reset) if reset else min(30, 2 ** attempt) * (0.5 + random.random())
                time.sleep(delay)
                continue
            raise RuntimeError(f'Kiln {e.code}: {text}') from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:  # a reset is retried
            time.sleep(min(30, 2 ** attempt) * (0.5 + random.random()))
            last = e
    raise RuntimeError(f'Kiln: gave up after retries ({last if "last" in dir() else "429/5xx"})')


def get(path):
    return _request('GET', path)[0]


class BudgetError(RuntimeError):
    pass


RUN_CAP = float(os.environ.get('KILN_RUN_CAP_USD', '0.50'))
LOCAL_CAP = float(os.environ.get('KILN_BUDGET_USD', '5'))
KEY_STOP = float(os.environ.get('KILN_KEY_STOP_USD', '80'))
_money = threading.Lock()
_run_spent = 0.0
_local_spent = None
_key_checked = False


def logged_spend():
    """What every real call logged here cost, from harness/runs/usage.jsonl."""
    if not USAGE.exists():
        return 0.0
    return sum(json.loads(line).get('cost_usd') or 0
               for line in USAGE.read_text(encoding='utf-8').splitlines() if line)


def key_spend():
    """The key's spend in USD as Kiln reports it (free: no inference)."""
    return float(get('/key').get('usage_usd') or 0)


def _guard():
    global _local_spent, _key_checked
    with _money:
        if _local_spent is None:
            _local_spent = logged_spend()
        if _run_spent >= RUN_CAP:
            raise BudgetError(f'this run spent ${_run_spent:.4f} of its ${RUN_CAP} (KILN_RUN_CAP_USD)')
        if _local_spent >= LOCAL_CAP:
            raise BudgetError(f'logged calls have spent ${_local_spent:.4f} of its ${LOCAL_CAP} (KILN_BUDGET_USD)')
        check_key = not _key_checked
        _key_checked = True
    if check_key:
        used = key_spend()
        if used >= KEY_STOP:
            raise BudgetError(f'the key has spent ${used:.2f}; stopping at ${KEY_STOP} (KILN_KEY_STOP_USD)')


def _spent(cost):
    global _run_spent, _local_spent
    with _money:
        _run_spent += cost or 0
        _local_spent = (_local_spent or 0) + (cost or 0)


def _digest(messages, sample, params, model=None):
    body = {'model': model or MODEL, 'messages': messages, **params}
    encoded = json.dumps([body, sample], sort_keys=True, ensure_ascii=False).encode('utf-8')
    return body, hashlib.sha256(encoded).hexdigest()


def is_cached(messages, sample=0, model=None, **params):
    return (CACHE / f'{_digest(messages, sample, params, model)[1]}.json').exists()


def mean_cost(flow, default=0.0005, model=None):
    """The average cost of a real call for flow on this model, from the log (for estimates)."""
    rows = [json.loads(line) for line in USAGE.read_text(encoding='utf-8').splitlines()] if USAGE.exists() else []
    costs = [r['cost_usd'] for r in rows if not r['cache_hit'] and r.get('flow') == flow
             and r.get('model') == (model or MODEL) and r.get('cost_usd')]
    return sum(costs) / len(costs) if costs else default


def spend_report():
    return (f'spend: this run ${_run_spent:.4f} · logged total ${logged_spend():.4f} · '
            f'key total ${key_spend():.4f} (team budget $100)')


def _log(record):
    try:
        RUNS.mkdir(parents=True, exist_ok=True)
        with _log_lock, USAGE.open('a', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
    except OSError:
        pass  # meter log is optional when the filesystem is read-only


def thinking(model, on):
    """How to switch a model's reasoning: (text appended to the last user message, request params).
    qwen3 reads /think and /no_think in the message; deepseek takes a chat-template switch."""
    if (model or MODEL).startswith('qwen3'):
        return (' /think' if on else ' /no_think'), {}
    return '', {'chat_template_kwargs': {'thinking': bool(on)}}


def chat(messages, flow, *, model=None, cache=True, sample=0, tag=None, **params):
    """One chat completion. flow names the pipeline stage it serves (write, read, plan, ...).
    model: the served model (default KILN_MODEL, qwen3-32b). sample distinguishes repeated
    draws of the same request (a different cache entry, the same request). Returns a dict:
    content, tool_calls, finish, usage, latency_ms, generation_id, cached."""
    body, digest = _digest(messages, sample, params, model)
    path = CACHE / f'{digest}.json'
    if cache and path.exists():
        out = json.loads(path.read_text(encoding='utf-8'))
        out['cached'], out['stage'] = True, flow
        _log({'t': time.time(), 'flow': flow, 'tag': tag, 'request': digest[:16], 'cache_hit': True,
              'generation_id': out['generation_id']})
        return out
    _guard()
    payload, headers, latency = _request('POST', '/chat/completions', body)
    choice = payload['choices'][0]
    usage = payload.get('usage', {})
    _spent(usage.get('cost'))
    out = {
        'content': choice['message'].get('content') or '',
        # The model's reasoning, apart from the answer (the answer lands here now and then).
        'reasoning': choice['message'].get('reasoning') or choice['message'].get('reasoning_content') or '',
        'tool_calls': choice['message'].get('tool_calls') or [],
        'finish': choice.get('finish_reason'),
        'usage': usage,
        'latency_ms': round(latency, 1),
        'generation_id': headers.get('X-Neocloud-Generation-Id') or headers.get('x-neocloud-generation-id'),
        'model': payload.get('model'),
        'cached': False,
        'stage': flow,
    }
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass
    _log({'t': time.time(), 'flow': flow, 'tag': tag, 'request': digest[:16], 'cache_hit': False,
          'model': out['model'], 'finish': out['finish'], 'latency_ms': out['latency_ms'],
          'prompt_tokens': usage.get('prompt_tokens'), 'completion_tokens': usage.get('completion_tokens'),
          'cached_tokens': (usage.get('prompt_tokens_details') or {}).get('cached_tokens'),
          'reasoning_tokens': (usage.get('completion_tokens_details') or {}).get('reasoning_tokens'),
          'cost_usd': usage.get('cost'), 'generation_id': out['generation_id'],
          'params': {k: v for k, v in params.items() if k != 'tools'}})
    return out


if __name__ == '__main__':
    print('models:', [m.get('id') for m in get('/models').get('data', [])])
    info = get('/key')
    print('key:', {k: info.get(k) for k in ('status', 'spend_limit_usd', 'usage_usd', 'expires_at')})
    print(spend_report())
