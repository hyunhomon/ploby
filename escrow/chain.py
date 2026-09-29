"""Ploby's on-chain rail: PlobyEscrow + TestKRW on Monad testnet (deployments/monad-testnet.json, docs/chain.md).

The engine decides; the chain holds the money and enforces what the engine's operator key can never do (pay
anyone but the contractor fixed at opening, move more than the client funded, reserve while the client has
paused, decide under a policy the client did not accept). What goes on chain is derived from the log alone:
`calls(P0, P1)` compares the money of a project before and after one line and names the contract calls that
make the chain agree (open, fund, accept, pause from the client's wallet; decide, settle, refund from the
operator's). Every call carries the log head right after its line and its number in that line, so each event
names its exact line and the contract refuses a call applied twice.

A worker sends the calls in log order and writes each result back as a signed 'chain' line (by 'relayer'):
the tx hash sits in the log next to the line it anchors. A call the contract would refuse is never sent: its
estimate names the custom error, and that refusal is logged too. Keys come from .env and are never printed or
logged; a cast error is reduced to a name.
"""
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOYMENT = ROOT / 'deployments' / 'monad-testnet.json'
CAST = str(Path.home() / '.foundry' / 'bin' / 'cast')
PUBLIC_RPC = 'https://testnet-rpc.monad.xyz'
HELD = {'RESERVED', 'CLAIMED', 'DISPUTED'}  # milestone units whose amount is still reserved
PAID = {'PAID', 'RELEASED_BY_TIMEOUT'}
DECISION = {'APPROVE': 1, 'HOLD': 2, 'BLOCK': 3}
SIGNATURES = {
    'open': 'open(bytes32,address,bytes32,uint256,bytes32)',
    'fund': 'fund(bytes32,uint256,bytes32,uint8)',
    'accept': 'acceptPolicy(bytes32,bytes32,uint256,bytes32,uint8)',
    'pause': 'setPaused(bytes32,bool,bytes32,uint8)',
    'decide': 'decide(bytes32,bytes32,uint8,bytes32,uint256,bytes32,bytes32,uint8)',
    'settle': 'settle(bytes32,bytes32,uint256,uint256,bytes32,uint8)',
    'refund': 'refund(bytes32,uint256,bytes32,uint8)',
}
WHO = {'open': 'client', 'fund': 'client', 'accept': 'client', 'pause': 'client',
       'decide': 'operator', 'settle': 'operator', 'refund': 'operator'}
EVENTS = {  # name -> (indexed [(field, type)], data [(field, type)]), in the Solidity declaration's order
    'Opened': ([('projectId', 'bytes32'), ('client', 'address'), ('contractor', 'address')],
               [('policyHash', 'bytes32'), ('budget', 'uint256'), ('logHead', 'bytes32')]),
    'Funded': ([('projectId', 'bytes32')], [('amount', 'uint256'), ('funded', 'uint256'), ('logHead', 'bytes32')]),
    'PolicyAccepted': ([('projectId', 'bytes32')], [('policyHash', 'bytes32'), ('budget', 'uint256'), ('logHead', 'bytes32')]),
    'PauseSet': ([('projectId', 'bytes32')], [('paused', 'bool'), ('logHead', 'bytes32')]),
    'Decided': ([('projectId', 'bytes32'), ('ref', 'bytes32')],
                [('decision', 'uint8'), ('rule', 'bytes32'), ('amount', 'uint256'), ('policyHash', 'bytes32'),
                 ('logHead', 'bytes32')]),
    'Settled': ([('projectId', 'bytes32'), ('ref', 'bytes32'), ('payee', 'address')],
                [('paid', 'uint256'), ('returned', 'uint256'), ('logHead', 'bytes32')]),
    'Refunded': ([('projectId', 'bytes32'), ('client', 'address')], [('amount', 'uint256'), ('logHead', 'bytes32')]),
}
CALL_EVENT = {'open': 'Opened', 'fund': 'Funded', 'accept': 'PolicyAccepted', 'pause': 'PauseSet',
              'decide': 'Decided', 'settle': 'Settled', 'refund': 'Refunded'}


# -- what the chain must do, from the log alone (no network)

def money(P):
    """The part of a project the chain mirrors."""
    v = P.active or (P.versions[0] if P.versions else None)
    refs, decided = {}, {}
    for m in P.milestones.values():
        refs[m['id']] = (sum(u['amount'] for u in m['units'] if u['status'] in HELD),
                         sum(u['amount'] for u in m['units'] if u['status'] in PAID))
    for e in P.expenses.values():
        refs[e['id']] = (e['reserved'], e['paid'])
        decided[e['id']] = (e['decision'] or {}).get('result')
    return {'policy': v and v['hash'], 'active': P.active and P.active['hash'],
            'budget': v['doc']['projectBudget'] if v else 0, 'contractor': v and v['doc']['contractorAddress'],
            'funded': P.funded, 'refunded': P.refunded, 'paused': P.paused, 'refs': refs, 'decided': decided}


def rule_of(e):
    """The rule a HOLD or BLOCK names on chain: the failed mandatory rule, else the first signal or evidence rule."""
    d = e['decision'] or {}
    if d.get('result') == 'BLOCK':
        return d.get('reason') or 'blocked'
    if d.get('reason') == 'retroactive':
        return 'retroactive'
    return next((r['rule'] for r in d.get('rules') or [] if r['ok'] is False), e.get('hold_class') or 'hold')


def calls(pid, i, head, m0, m1, P):
    """The contract calls that make the chain agree after log line i (head = the log head after it)."""
    out = []

    def add(call, **args):
        out.append({'pid': pid, 'line': i, 'n': len(out), 'head': head, 'call': call, 'args': args})
    if m1['funded'] > m0['funded']:
        if m0['funded'] == 0:  # the first deposit opens the project on chain, bound to the policy's contractor
            add('open', contractor=m1['contractor'], policy=m1['policy'], budget=m1['budget'])
        add('fund', amount=m1['funded'] - m0['funded'])
    if m0['active'] and m1['active'] and m1['active'] != m0['active']:  # a change order's version took effect
        add('accept', policy=m1['active'], budget=m1['budget'])
    if m1['paused'] != m0['paused']:
        add('pause', paused=m1['paused'])
    for ref, (r1, p1) in m1['refs'].items():
        r0, p0 = m0['refs'].get(ref, (0, 0))
        paid = p1 - p0
        need = r1 + paid - r0  # a payment always comes out of a reservation: reserve first what is missing
        e = P.expenses.get(ref)
        if need > 0:
            rule = ('milestone' if ref in P.milestones else 'all_rules_passed' if ref not in m0['refs']
                    else 'client_approved' if m0['decided'].get(ref) == 'HOLD' else 'change_order')
            add('decide', ref=ref, decision='APPROVE', rule=rule, amount=need, policy=m1['active'])
        elif e and ref not in m0['refs'] and m1['decided'].get(ref) in ('HOLD', 'BLOCK'):
            add('decide', ref=ref, decision=m1['decided'][ref], rule=rule_of(e), amount=e['maximum'] or 0,
                policy=m1['active'])
        back = r0 + max(need, 0) - paid - r1
        if paid > 0 or back > 0:
            add('settle', ref=ref, pay=paid, returned=back)
    if m1['refunded'] > m0['refunded']:
        add('refund', amount=m1['refunded'] - m0['refunded'])
    return out


def plan(pid, lines, Project):
    """Replay a log: (the project, every call its lines imply, the (line, n) the log already has results for)."""
    P, todo, done = Project(pid), [], {}
    for line in lines:
        m0 = money(P)
        P.apply(line)
        if line['op'] == 'chain':
            done[(line['params']['line'], line['params']['n'])] = line['params']
            continue
        todo += calls(P.id, len(P.log) - 1, P.head, m0, money(P), P)
    return P, todo, done


# -- ABI plumbing

def b32(text):
    """A short ASCII id ('p1a2b…', 'E3', 'per_purchase') as bytes32, readable on an explorer."""
    raw = str(text).encode('ascii')[:32]
    return '0x' + raw.hex().ljust(64, '0')


def unb32(word):
    return bytes.fromhex(word[2:] if word.startswith('0x') else word).rstrip(b'\0').decode('ascii', 'replace')


def h32(value):
    value = str(value)
    return value if value.startswith('0x') else '0x' + value


def word(value):
    return (value[2:].lower() if isinstance(value, str) else format(int(value), 'x')).rjust(64, '0')


def unword(w, kind):
    if kind == 'address':
        return '0x' + w[24:]
    if kind == 'bytes32':
        return '0x' + w
    if kind == 'bool':
        return bool(int(w, 16))
    return int(w, 16)


def load_env():
    env = dict(os.environ)
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                env.setdefault(k.strip(), v.strip())
    return env


def deployment():
    return json.loads(DEPLOYMENT.read_text(encoding='utf-8')) if DEPLOYMENT.exists() else None


def enabled():
    """Chain writes need the deployment, both keys and cast; PLOBY_CHAIN=off turns them off."""
    env, dep = load_env(), deployment()
    return bool(dep and dep.get('escrow', {}).get('contract') == 'PlobyEscrow' and env.get('PLOBY_CHAIN') != 'off'
                and env.get('DEPLOYER_KEY') and env.get('RELAYER_KEY') and Path(CAST).exists())


class Rail:
    """Reads need only an RPC (the public one by default: an auditor has no keys); writes need .env keys."""

    def __init__(self, write=True):
        env, dep = load_env(), deployment()
        if not dep:
            raise RuntimeError('deployments/monad-testnet.json is missing (python3 script/deploy_ploby.py)')
        self.dep, self.rpc_url = dep, env.get(dep.get('rpc_env', 'MONAD_RPC')) or PUBLIC_RPC
        self.escrow, self.token = dep['escrow']['address'], dep['token']['address']
        self.explorer_base, self.chain_id = dep['explorer'], dep['chain_id']
        self.roles = dict(dep['roles'])
        self._keys = {}
        if write:
            self._keys = {'client': env['DEPLOYER_KEY'], 'operator': env['RELAYER_KEY']}
        self._env = {k: v for k, v in os.environ.items() if not k.endswith('_KEY')}
        self.nonces, self.lock = {}, threading.Lock()
        errors = set()
        for sol in ('PlobyEscrow.sol', 'TestKRW.sol'):
            errors |= set(re.findall(r'error (\w+)\(\);', (ROOT / 'src' / sol).read_text(encoding='utf-8')))
        self.errors = {self.keccak(f'{e}()')[:10]: e for e in sorted(errors)}
        self.topics = {self.keccak(f'{n}({",".join(t for _, t in ix + data)})'): n for n, (ix, data) in EVENTS.items()}
        self.fn = {name: self.keccak(sig)[:10] for name, sig in
                   {'projects': 'projects(bytes32)', 'available': 'available(bytes32)',
                    'reservedFor': 'reservedFor(bytes32,bytes32)', 'balanceOf': 'balanceOf(address)'}.items()}

    def tx_url(self, tx):
        return f'{self.explorer_base}tx/{tx}' if tx else None

    def address_url(self, address):
        return f'{self.explorer_base}address/{address}'

    # plumbing
    def _cast(self, *args, key=None):
        r = subprocess.run([CAST, *args, *(['--private-key', key] if key else [])], capture_output=True, text=True,
                           env=self._env)
        if r.returncode:
            raise RuntimeError(re.sub(r'0x[0-9a-fA-F]{64}', '0x…', r.stderr.strip())[:300])
        return r.stdout.strip()

    def keccak(self, text):
        return self._cast('keccak', '0x' + text.encode('utf-8').hex())

    def _rpc(self, method, params, raw=False):
        """The result (or with raw the whole response); network errors and rate limits retried with backoff."""
        req = urllib.request.Request(self.rpc_url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                                                    'params': params}).encode(),
                                     headers={'Content-Type': 'application/json', 'User-Agent': 'ploby/1'})
        why = 'unreachable'
        for attempt in range(6):
            if attempt:
                time.sleep(0.5 * 2 ** (attempt - 1))
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    out = json.loads(r.read())
            except urllib.error.HTTPError as e:
                why = f'HTTP {e.code}'
                if e.code == 429 or e.code >= 500:
                    continue
                raise RuntimeError(f'{method}: {why}') from None
            except (OSError, ValueError):
                continue
            err = out.get('error') or {}
            if err and (err.get('code') in (429, -32005, -32029) or
                        re.search(r'rate|limit exceeded|too many', str(err.get('message', '')), re.I)):
                why = 'rate limited'
                continue
            if raw:
                return out
            if err:
                raise RuntimeError(f"{method}: {err.get('message')}")
            return out.get('result')
        raise RuntimeError(f'{method}: RPC {why}')

    def _error(self, err):
        data = f"{err.get('data') or ''} {err.get('message') or ''}"
        for s in re.findall(r'0x[0-9a-fA-F]{8}', data):
            if s.lower() in self.errors:
                return self.errors[s.lower()]
        return 'reverted'

    def _send(self, who, to, data):
        """Estimate, then send and wait for the receipt. A call the contract would refuse is not sent."""
        began, sender = time.perf_counter(), self.roles[who]

        def done(tx=None, ok=False, error=None, block=None):
            return {'tx': tx, 'ok': ok, 'error': error, 'block': block, 'seconds': round(time.perf_counter() - began, 2)}
        with self.lock:
            est = self._rpc('eth_estimateGas', [{'from': sender, 'to': to, 'data': data}], raw=True)
            if 'error' in est:
                return done(error=self._error(est['error']))
            if who not in self.nonces:
                self.nonces[who] = int(self._rpc('eth_getTransactionCount', [sender, 'pending']), 16)
            try:
                out = self._cast('send', to, data, '--rpc-url', self.rpc_url, '--nonce', str(self.nonces[who]),
                                 '--gas-limit', str(int(est['result'], 16) * 12 // 10), '--async', key=self._keys[who])
            except RuntimeError as e:
                self.nonces.pop(who, None)
                return done(error='nonce' if 'nonce' in str(e).lower() else 'send_failed')
            self.nonces[who] += 1
            tx = re.search(r'0x[0-9a-fA-F]{64}', out).group(0)
            receipt = self.receipt(tx, wait=90)
            if not receipt:
                return done(tx, error='no_receipt')
            ok = int(receipt['status'], 16) == 1
            return done(tx, ok, None if ok else 'reverted', int(receipt['blockNumber'], 16))

    def receipt(self, tx, wait=0):
        began = time.perf_counter()
        while True:
            r = self._rpc('eth_getTransactionReceipt', [tx])
            if r or time.perf_counter() - began >= wait:
                return r
            time.sleep(0.4)

    # the calls
    def calldata(self, c):
        a, pid, head, n = c['args'], b32(c['pid']), h32(c['head']), str(c['n'])
        values = {
            'open': [pid, a.get('contractor'), h32(a.get('policy') or ''), a.get('budget'), head],
            'fund': [pid, a.get('amount'), head, n],
            'accept': [pid, h32(a.get('policy') or ''), a.get('budget'), head, n],
            'pause': [pid, 'true' if a.get('paused') else 'false', head, n],
            'decide': [pid, b32(a.get('ref')), DECISION.get(a.get('decision'), 0), b32(a.get('rule')), a.get('amount'),
                       h32(a.get('policy') or ''), head, n],
            'settle': [pid, b32(a.get('ref')), a.get('pay'), a.get('returned'), head, n],
            'refund': [pid, a.get('amount'), head, n],
        }[c['call']]
        return self._cast('calldata', SIGNATURES[c['call']], *[str(v) for v in values])

    def send(self, c):
        try:
            return self._send(WHO[c['call']], self.escrow, self.calldata(c))
        except (RuntimeError, TimeoutError, KeyError) as e:
            return {'tx': None, 'ok': False, 'error': 'rpc' if 'RPC' in str(e) or 'HTTP' in str(e) else 'failed',
                    'block': None, 'seconds': 0}

    # reads
    def _call(self, data):
        return self._rpc('eth_call', [{'to': self.escrow, 'data': data}, 'latest'])[2:]

    def project(self, pid):
        """The on-chain project (None if never opened)."""
        out = self._call(self.fn['projects'] + word(b32(pid)))
        w = [out[i:i + 64] for i in range(0, len(out), 64)]
        client = unword(w[0], 'address')
        if int(client, 16) == 0:
            return None
        return {'client': client, 'contractor': unword(w[1], 'address'), 'policy_hash': unword(w[2], 'bytes32'),
                'budget': int(w[3], 16), 'funded': int(w[4], 16), 'reserved': int(w[5], 16), 'paid': int(w[6], 16),
                'refunded': int(w[7], 16), 'paused': bool(int(w[8], 16)), 'log_head': unword(w[9], 'bytes32'),
                'available': int(self._call(self.fn['available'] + word(b32(pid))), 16)}

    def reserved_for(self, pid, ref):
        return int(self._call(self.fn['reservedFor'] + word(b32(pid)) + word(b32(ref))), 16)

    def balance(self, address):
        out = self._rpc('eth_call', [{'to': self.token, 'data': self.fn['balanceOf'] + word(address)}, 'latest'])
        return int(out, 16)

    def events_of(self, receipt):
        """The escrow events in a receipt: [{'event', 'args', 'log_index'}]."""
        out = []
        for log in receipt.get('logs') or []:
            name = self.topics.get(log['topics'][0]) if log.get('topics') else None
            if not name or log['address'].lower() != self.escrow.lower():
                continue
            ix, fields = EVENTS[name]
            data = log['data'][2:]
            args = {f: unword(t[2:], k) for (f, k), t in zip(ix, log['topics'][1:])}
            args.update({f: unword(data[i * 64:(i + 1) * 64], k) for i, (f, k) in enumerate(fields)})
            out.append({'event': name, 'args': args, 'log_index': int(log['logIndex'], 16)})
        return out

    def gas(self, who):
        return int(self._rpc('eth_getBalance', [self.roles[who], 'latest']), 16) / 1e18


class Worker(threading.Thread):
    """Sends the calls one by one, in log order, and hands each result to `record(call, result)`."""

    def __init__(self, rail, record):
        super().__init__(daemon=True, name='ploby-chain')
        self.rail, self.record = rail, record
        self.queue, self.cv, self.busy = deque(), threading.Condition(), None

    def submit(self, calls):
        with self.cv:
            self.queue.extend(calls)
            self.cv.notify()

    def pending(self, pid=None):
        with self.cv:
            items = list(self.queue) + ([self.busy] if self.busy else [])
        return [c for c in items if pid is None or c['pid'] == pid]

    def run(self):
        sent = 0
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                self.busy = c = self.queue.popleft()
            result = self.rail.send(c)
            if result['error'] in ('rpc', 'no_receipt', 'nonce', 'send_failed'):  # transient: once more
                time.sleep(2)
                result = self.rail.send(c)
            try:
                self.record(c, result)
            except Exception as e:  # never kill the worker: the call stays pending until the next start
                print(f'chain: could not log {c["call"]} for line {c["line"]}: {type(e).__name__}', flush=True)
            with self.cv:
                self.busy = None
            sent += 1
            if sent % 20 == 0:
                self.top_up()

    def top_up(self):
        """Keep the operator's gas above 0.3 MON from the client wallet (testnet MON only)."""
        try:
            if self.rail.gas('operator') < 0.3:
                self.rail._cast('send', self.rail.roles['operator'], '--value', '1ether', '--rpc-url',
                                self.rail.rpc_url, key=self.rail._keys['client'])
                self.rail.nonces.pop('client', None)
        except RuntimeError:
            pass
