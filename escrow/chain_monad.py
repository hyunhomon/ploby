"""ExpenseEscrow on Monad testnet (chain 10143), behind the same calls as ledger.SimEscrow.

Signing and sending go through Foundry's cast (keys are never
printed or logged, and a cast error is reduced to a name); every read is plain JSON-RPC. Client-side calls (createProject, mint+approve+deposit, approveHold,
rejectHold, stopProject) are signed by DEPLOYER_KEY, agent-side calls (recordDecision, release) by
RELAYER_KEY (the escrow's agent). Each call is estimated first: a call that would revert is never sent
and comes back {'ok': False, 'error': <custom error name>}; the estimate (+10%) is the gas limit. Each
sent call waits for its receipt, so the next call sees its state. Nonces are kept here per sender.

tx = {'tx': '0x..' | None, 'ok': bool, 'error': None | name, 'seconds': float, 'block': int | None}
"""
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOYMENT = ROOT / 'deployments' / 'monad-testnet.json'
CAST = str(Path.home() / '.foundry' / 'bin' / 'cast')
LOG_RANGE = 100  # the public RPC's eth_getLogs block-range limit
DECISION = '(bytes32,bytes32,bytes32,uint256,uint8,uint256)'
# name -> (indexed [(field, type)], data [(field, type)]); the order is the Solidity declaration's
EVENTS = {
    'ProjectCreated': ([('projectId', 'bytes32'), ('client', 'address')], [('policyHash', 'bytes32'), ('budget', 'uint256')]),
    'Deposited': ([('projectId', 'bytes32'), ('from', 'address')], [('amount', 'uint256')]),
    'DecisionRecorded': ([('projectId', 'bytes32'), ('evidenceHash', 'bytes32')],
                         [('payee', 'address'), ('policyHash', 'bytes32'), ('amount', 'uint256'), ('decision', 'uint8'),
                          ('timestamp', 'uint256')]),
    'HoldApproved': ([('projectId', 'bytes32'), ('evidenceHash', 'bytes32')], []),
    'HoldRejected': ([('projectId', 'bytes32'), ('evidenceHash', 'bytes32')], []),
    'PaymentReleased': ([('projectId', 'bytes32'), ('evidenceHash', 'bytes32'), ('payee', 'address')], [('amount', 'uint256')]),
    'ProjectStopped': ([('projectId', 'bytes32')], []),
}


def load_env():
    env = dict(os.environ)
    for line in (ROOT / '.env').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def word(value):
    """One ABI word: a 0x hex (address, bytes32) or an unsigned integer, left-padded."""
    return (value[2:].lower() if isinstance(value, str) else format(value, 'x')).rjust(64, '0')


def unword(w, kind):
    return '0x' + w[24:] if kind == 'address' else '0x' + w if kind == 'bytes32' else int(w, 16)


class MonadEscrow:
    name = 'monad-testnet'

    def __init__(self, deployment=DEPLOYMENT):
        env = load_env()
        dep = json.loads(Path(deployment).read_text())
        self.rpc_url = env[dep.get('rpc_env', 'MONAD_RPC')]
        self.token, self.escrow = dep['token']['address'], dep['escrow']['address']
        self.deploy_block, self.explorer_base = dep['escrow'].get('block', 0), dep['explorer']
        self.roles = {'client': env['DEPLOYER_ADDRESS'], 'agent': env['RELAYER_ADDRESS']}
        self._keys = {env['DEPLOYER_ADDRESS'].lower(): env['DEPLOYER_KEY'], env['RELAYER_ADDRESS'].lower(): env['RELAYER_KEY']}
        self._env = dict(os.environ)
        errors = set()
        for sol in ('ExpenseEscrow.sol', 'MockUSDC.sol'):
            errors |= set(re.findall(r'error (\w+)\(\);', (ROOT / 'src' / sol).read_text()))
        self.errors = {self.keccak(f'{e}()')[:10]: e for e in sorted(errors)}
        self.topics = {self.keccak(f'{n}({",".join(t for _, t in ix + data)})'): n for n, (ix, data) in EVENTS.items()}
        self.fn_projects = self.keccak('projects(bytes32)')[:10]
        self.nonces, self.lock = {}, threading.Lock()
        self.payees, self.created, self.until, self.logs, self.times = {}, {}, {}, {}, {}

    # plumbing
    def _cast(self, *args, key=None):
        r = subprocess.run([CAST, *args, *(['--private-key', key] if key else [])], capture_output=True, text=True,
                           env=self._env)
        if r.returncode:
            raise RuntimeError(r.stderr.strip()[:400])
        return r.stdout.strip()

    def keccak(self, text):
        """keccak256 of the UTF-8 text, '0x' + 64 hex (sent as hex, so a text that starts with 0x is still text)."""
        return self._cast('keccak', '0x' + text.encode().hex())

    def _rpc(self, method, params, raw=False):
        """The result, or with raw the whole response (to read error data). A network error, HTTP 429 or a
        rate-limit JSON error is retried with backoff (0.5, 1, 2, 4, 8 s); anything else is returned/raised."""
        req = urllib.request.Request(self.rpc_url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                                                    'params': params}).encode(),
                                     headers={'Content-Type': 'application/json', 'User-Agent': 'smartescrow/0.1'})
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
            if err and (err.get('code') in (429, -32005, -32029) or re.search(r'rate|limit exceeded|too many',
                                                                              str(err.get('message', '')), re.I)):
                why = 'rate limited'
                continue
            if raw:
                return out
            if err:
                raise RuntimeError(f"{method}: {err.get('message')}")
            return out.get('result')
        raise RuntimeError(f'{method}: RPC {why}')

    def _error(self, err):
        data = str(err.get('data') or '') + ' ' + str(err.get('message') or '')
        for s in re.findall(r'0x[0-9a-fA-F]{8}', data):
            if s.lower() in self.errors:
                return self.errors[s.lower()]
        return 'reverted'

    def _send(self, sender, signature, *args, to=None):
        """Estimate, then send and wait for the receipt: a tx dict. A would-be revert is not sent."""
        began, to, s = time.perf_counter(), to or self.escrow, sender.lower()
        done = lambda tx=None, ok=False, error=None, block=None: {  # noqa: E731
            'tx': tx, 'ok': ok, 'error': error, 'seconds': round(time.perf_counter() - began, 3), 'block': block}
        data = self._cast('calldata', signature, *[str(a) for a in args])
        with self.lock:
            est = self._rpc('eth_estimateGas', [{'from': sender, 'to': to, 'data': data}], raw=True)
            if 'error' in est:
                return done(error=self._error(est['error']))
            if s not in self.nonces:
                self.nonces[s] = int(self._rpc('eth_getTransactionCount', [sender, 'latest']), 16)
            try:
                out = self._cast('send', to, data, '--rpc-url', self.rpc_url, '--nonce', str(self.nonces[s]),
                                 '--gas-limit', str(int(est['result'], 16) * 11 // 10), '--async', key=self._keys[s])
            except RuntimeError as e:
                self.nonces.pop(s, None)  # out of step or rejected: read it again next time
                return done(error='nonce' if 'nonce' in str(e).lower() else 'send_failed')
            self.nonces[s] += 1
            tx = re.search(r'0x[0-9a-fA-F]{64}', out).group(0)
            receipt = self._receipt(tx)
            ok = int(receipt['status'], 16) == 1
            return done(tx, ok, None if ok else 'reverted', int(receipt['blockNumber'], 16))

    def _receipt(self, tx, timeout=60):
        began = time.perf_counter()
        while time.perf_counter() - began < timeout:
            receipt = self._rpc('eth_getTransactionReceipt', [tx])
            if receipt:
                return receipt
            time.sleep(0.1)
        raise TimeoutError(f'{tx}: no receipt after {timeout}s')

    # identities
    def address_of(self, who):
        """'client' -> the deployer, 'agent' -> the relayer; 'contractor' or a registry id -> the receive-only
        payee address keccak256("pcp-payee:<id>")[12:] (nobody holds its key)."""
        if who in self.roles:
            return self.roles[who]
        if who not in self.payees:
            self.payees[who] = '0x' + self.keccak(f'pcp-payee:{who}')[-40:]
        return self.payees[who]

    def explorer(self, tx):
        return self.explorer_base + tx if tx else None

    # client side (DEPLOYER_KEY)
    def create_project(self, project_id, policy_hash, budget):
        tx = self._send(self.roles['client'], 'createProject(bytes32,bytes32,uint256)', project_id, policy_hash, budget)
        if tx['ok']:
            self.created[project_id.lower()] = tx['block']
        return tx

    def deposit(self, project_id):
        """Mint the unfunded remainder to the client (open-mint test token), approve the escrow, deposit.
        Returns the deposit tx, with 'txs' = every tx sent; stops at the first failure."""
        p, client = self.project(project_id), self.roles['client']
        if p is None:
            return {'tx': None, 'ok': False, 'error': 'ProjectNotFound', 'seconds': 0.0, 'block': None, 'txs': []}
        amount, txs = p['budget'] - p['deposited'], []
        for sig, args, to in (('mint(address,uint256)', (client, amount), self.token),
                              ('approve(address,uint256)', (self.escrow, amount), self.token),
                              ('deposit(bytes32)', (project_id,), self.escrow)):
            tx = self._send(client, sig, *args, to=to)
            txs.append(tx)
            if not tx['ok']:
                break
        return {**txs[-1], 'seconds': round(sum(t['seconds'] for t in txs), 3), 'txs': [t['tx'] for t in txs]}

    def approve_hold(self, project_id, evidence_hash):
        return self._send(self.roles['client'], 'approveHold(bytes32,bytes32)', project_id, evidence_hash)

    def reject_hold(self, project_id, evidence_hash):
        return self._send(self.roles['client'], 'rejectHold(bytes32,bytes32)', project_id, evidence_hash)

    def stop_project(self, project_id):
        return self._send(self.roles['client'], 'stopProject(bytes32)', project_id)

    # agent side (RELAYER_KEY)
    def record_decision(self, project_id, evidence_hash, policy_hash, amount, decision, payee=None):
        """decision 1 APPROVE / 2 HOLD / 3 BLOCK, bound to payee (the zero address only for a BLOCK); the
        contract stamps block.timestamp (0 is sent)."""
        return self._send(self.roles['agent'], f'recordDecision({DECISION},address)',
                          f'({project_id},{evidence_hash},{policy_hash},{int(amount)},{int(decision)},0)',
                          payee or '0x' + '0' * 40)

    def release(self, project_id, evidence_hash, payee_address, amount):
        return self._send(self.roles['agent'], 'release(bytes32,bytes32,address,uint256)',
                          project_id, evidence_hash, payee_address, int(amount))

    # reads
    def project(self, project_id):
        """{'client','policy_hash','budget','deposited','spent','stopped'} from the public getter; None if absent."""
        out = self._rpc('eth_call', [{'to': self.escrow, 'data': self.fn_projects + word(project_id)}, 'latest'])[2:]
        w = [out[i:i + 64] for i in range(0, len(out), 64)]
        if not int(w[6], 16):
            return None
        return {'client': unword(w[0], 'address'), 'policy_hash': unword(w[1], 'bytes32'), 'budget': int(w[2], 16),
                'deposited': int(w[3], 16), 'spent': int(w[4], 16), 'stopped': bool(int(w[5], 16))}

    def events(self, project_id, from_block=None, to_block=None):
        """Every escrow event of the project in [from_block, to_block], oldest first: [{'event','tx','block','args'}].
        eth_getLogs on the projectId topic, in 100-block windows. from_block: else the creation block (known if
        created here, or set in self.created) else the deploy block; to_block: else self.until (an audit sets it
        from the logged txs' receipts) else the chain head. Scanned windows are kept: a repeat call reads only new blocks."""
        pid = project_id.lower()
        start = from_block or self.created.get(pid) or self.deploy_block
        nxt, seen = self.logs.get(pid, (start, []))
        head = int(self._rpc('eth_blockNumber', []), 16)
        end = min(to_block or self.until.get(pid) or head, head)
        while nxt <= end:
            to = min(nxt + LOG_RANGE - 1, end)
            for log in self._rpc('eth_getLogs', [{'address': self.escrow, 'fromBlock': hex(nxt), 'toBlock': hex(to),
                                                  'topics': [None, '0x' + word(project_id)]}]):
                name = self.topics.get(log['topics'][0])
                if not name:
                    continue
                ix, fields = EVENTS[name]
                data = log['data'][2:]
                args = {f: unword(t[2:], k) for (f, k), t in zip(ix, log['topics'][1:])}
                args.update({f: unword(data[i * 64:(i + 1) * 64], k) for i, (f, k) in enumerate(fields)})
                seen.append({'event': name, 'tx': log['transactionHash'], 'block': int(log['blockNumber'], 16),
                             'args': args, 'log_index': int(log['logIndex'], 16)})
            nxt = to + 1
        self.logs[pid] = (nxt, seen)
        return [{k: e[k] for k in ('event', 'tx', 'block', 'args')} for e in sorted(seen, key=lambda e: (e['block'], e['log_index']))]

    def tx_block(self, tx):
        """(block number, status ok) of a mined tx from its receipt; (None, False) when the chain has no receipt."""
        r = self._rpc('eth_getTransactionReceipt', [tx])
        return (int(r['blockNumber'], 16), int(r['status'], 16) == 1) if r else (None, False)

    def block_time(self, block):
        """The block's timestamp in ms (real time, from the chain), cached."""
        if block not in self.times:
            self.times[block] = int(self._rpc('eth_getBlockByNumber', [hex(block), False])['timestamp'], 16) * 1000
        return self.times[block]

def smoke():
    """A throwaway project on testnet: create, deposit, APPROVE bound to gabia, releases refused before sending
    (AmountMismatch; PayeeMismatch to another address), release to gabia, BLOCK, its release refused
    (NotReleasable), stop, a decision refused (ProjectIsStopped). 8 txs sent (deposit is 3); the four refusals
    are never sent."""
    c = MonadEscrow()
    pid, policy = c.keccak(f'smoke-{time.time()}'), c.keccak('smoke-policy')
    ev1, ev2 = c.keccak(f'{pid}:e1'), c.keccak(f'{pid}:e2')
    steps = [('create_project', lambda: c.create_project(pid, policy, 100000), True),
             ('deposit', lambda: c.deposit(pid), True),
             ('record APPROVE 22000', lambda: c.record_decision(pid, ev1, policy, 22000, 1, c.address_of('gabia')), True),
             ('release to another', lambda: c.release(pid, ev1, c.address_of('fastpay-agency'), 22000), 'PayeeMismatch'),
             ('release wrong amount', lambda: c.release(pid, ev1, c.address_of('gabia'), 21999), 'AmountMismatch'),
             ('release -> gabia', lambda: c.release(pid, ev1, c.address_of('gabia'), 22000), True),
             ('record BLOCK 129000', lambda: c.record_decision(pid, ev2, policy, 129000, 3, c.address_of('coupang')), True),
             ('release the BLOCK', lambda: c.release(pid, ev2, c.address_of('coupang'), 129000), 'NotReleasable'),
             ('stop_project', lambda: c.stop_project(pid), True),
             ('record after stop', lambda: c.record_decision(pid, c.keccak(f'{pid}:e3'), policy, 33000, 1, c.address_of('vercel')),
              'ProjectIsStopped')]
    print(f'project {pid}\nescrow {c.escrow}  gabia payee {c.address_of("gabia")}')
    failed = 0
    for label, fn, want in steps:
        tx = fn()
        good = tx['ok'] if want is True else (not tx['ok'] and tx['error'] == want and tx['tx'] is None)
        failed += not good
        print(f"{'ok ' if good else 'BAD'} {label:22} {tx['seconds']:6.2f}s  {tx['error'] or ''}  {c.explorer(tx['tx']) or '(not sent)'}")
    print(json.dumps(c.project(pid)))
    for e in c.events(pid):
        print(e['block'], e['event'], e['tx'], json.dumps(e['args']))
    return failed


if __name__ == '__main__':
    raise SystemExit(smoke())
