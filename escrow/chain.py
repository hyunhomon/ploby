"""Base Sepolia writes for the legacy ExpenseEscrow already deployed from this repo.

The Python engine still decides. This module only mirrors the moments that move demo
tokens: the project becomes ACTIVE (createProject + deposit), a request is BLOCK or HOLD
(recordDecision), the client accepts or rejects that HOLD, and a settlement pays the
contractor (release). Milestone payments stay off chain. The contract cannot change the
amount after recordDecision, so an APPROVE is recorded at settlement with the paid amount.

Reads `.env` the same way the Kiln client does. Missing chain settings leave the app
off chain. Transactions go through `cast` (Foundry), which is already used to deploy.
"""
import json
import re
import shutil
import subprocess
import threading
from pathlib import Path

BASE_UNITS = 1_000_000  # MockUSDC has 6 decimals; 1 policy unit (KRW) = 1 token
# One top-up for the client wallet. Later projects only createProject and deposit.
CUSHION = 50_000_000 * BASE_UNITS
MAX_UINT = 2 ** 256 - 1
EXPLORER = 'https://sepolia.basescan.org'
WALLET = '_wallet'
ADDR = re.compile(r'^0x[0-9a-fA-F]{40}$')
B32 = re.compile(r'^0x[0-9a-fA-F]{64}$')
KEYS = ('RPC_URL', 'CHAIN_ID', 'ESCROW_ADDRESS', 'USDC_ADDRESS', 'AGENT_PRIVATE_KEY', 'CLIENT_PRIVATE_KEY')


class ChainError(Exception):
    pass


def load_env(path):
    """Values already in the process win. The file fills the rest."""
    found = {}
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            text = line.strip()
            if not text or text.startswith('#') or '=' not in text:
                continue
            name, value = text.split('=', 1)
            value = value.strip().strip('"').strip("'")
            found[name.strip()] = value
    import os
    out = {}
    for name in KEYS:
        out[name] = os.environ.get(name) or found.get(name) or ''
    if not out['RPC_URL']:
        out['RPC_URL'] = 'https://sepolia.base.org'
    if not out['CHAIN_ID']:
        out['CHAIN_ID'] = '84532'
    return out


def to_base(amount):
    return int(amount) * BASE_UNITS


def next_step(expense, rec):
    """The next chain call for one expense, or None when the book already matches it."""
    rec = rec or {}
    if rec.get('releaseTx') or rec.get('rejectTx'):
        return None
    status = expense.get('status')
    decision = (expense.get('decision') or {}).get('result')
    paid = int(expense.get('paid') or 0)
    maximum = int(expense.get('maximum') or 0)
    recorded = bool(rec.get('recordTx'))
    code = rec.get('code')
    recorded_amount = rec.get('amount')

    if paid > 0:
        if not recorded:
            return {'op': 'record_release', 'code': 1, 'amount': paid}
        if recorded_amount != paid:
            return {'op': 'error', 'error': 'on-chain amount does not match the settlement'}
        if code == 2 and not rec.get('approveTx'):
            return {'op': 'approve_release', 'amount': paid}
        if code == 1 or code == 2:
            return {'op': 'release', 'amount': paid}
        return {'op': 'error', 'error': 'this decision cannot be released'}

    if status == 'BLOCKED' and not recorded:
        return {'op': 'record', 'code': 3, 'amount': maximum or 1}
    if status in ('HOLD_REVIEW', 'RETRO_REVIEW') and decision == 'HOLD' and not recorded:
        return {'op': 'record', 'code': 2, 'amount': maximum or 1}
    if status == 'REJECTED' and decision == 'HOLD':
        if not recorded:
            return {'op': 'record', 'code': 2, 'amount': maximum or 1}
        return {'op': 'reject'}
    if status == 'RESERVED' and decision == 'HOLD' and recorded and code == 2 and not rec.get('approveTx'):
        return {'op': 'approve'}
    return None


class Chain:
    def __init__(self, repo, data):
        self.repo = Path(repo)
        self.data = Path(data)
        self.book_path = self.data / 'chain.json'
        env = load_env(self.repo / '.env')
        self.rpc = env['RPC_URL']
        self.chain_id = env['CHAIN_ID']
        self.escrow = env['ESCROW_ADDRESS']
        self.usdc = env['USDC_ADDRESS']
        self.agent_key = env['AGENT_PRIVATE_KEY']
        self.client_key = env['CLIENT_PRIVATE_KEY']
        self.cast = shutil.which('cast')
        self.client = ''
        self.agent = ''
        self.reason = ''
        self._loader = None
        self._inflight = set()
        self._pending = set()
        self._guard = threading.Lock()
        self._send_lock = threading.RLock()
        self._book_lock = threading.RLock()
        ready = all(ADDR.match(v) for v in (self.escrow, self.usdc)) and self.chain_id == '84532'
        ready = ready and all(B32.match(v) for v in (self.agent_key, self.client_key))
        if not ready:
            self.enabled = False
            self.reason = 'chain settings are unset'
        elif not self.cast:
            self.enabled = False
            self.reason = 'cast (Foundry) is not installed'
        else:
            self.enabled = True
            try:
                self.client = self._cast('wallet', 'address', '--private-key', self.client_key).strip()
                self.agent = self._cast('wallet', 'address', '--private-key', self.agent_key).strip()
            except ChainError as e:
                self.enabled = False
                self.reason = str(e)
        self.book = self._read()
        if self.enabled:
            threading.Thread(target=self._prepare_wallet, name='ploby-chain-wallet', daemon=True).start()

    def bind(self, loader):
        """loader(project_id) -> a detached project, called off the store lock by the chain thread."""
        self._loader = loader

    def meta(self):
        return {'enabled': self.enabled, 'reason': self.reason, 'network': 'base-sepolia',
                'explorer': EXPLORER, 'escrow': self.escrow or None, 'usdc': self.usdc or None,
                'client': self.client or None, 'payeeWallet': self.agent or None}

    def public(self, pid):
        with self._guard:
            pending = pid in self._inflight
        with self._book_lock:
            entry = dict(self.book.get(pid) or {})
            raw_expenses = dict(entry.get('expenses') or {})
            wallet = dict(self.book.get(WALLET) or {})
        expenses = {}
        mint = self._tx(wallet.get('mintTx'))
        approve = self._tx(wallet.get('approveTx'))
        txs = [mint, approve, self._tx(entry.get('createTx')), self._tx(entry.get('depositTx'))]
        error = entry.get('error')
        for eid, rec in raw_expenses.items():
            expenses[eid] = {'status': rec.get('status'), 'error': rec.get('error'),
                             'recordTx': rec.get('recordTx'), 'approveTx': rec.get('approveTx'),
                             'rejectTx': rec.get('rejectTx'), 'releaseTx': rec.get('releaseTx'),
                             'amount': rec.get('amount'), 'code': rec.get('code')}
            txs.extend(self._tx(rec.get(name)) for name in ('recordTx', 'approveTx', 'rejectTx', 'releaseTx'))
            if rec.get('error') and not error:
                error = rec['error']
        status = entry.get('status') or ('waiting' if self.enabled else 'off')
        if pending:
            status = 'confirming'
        elif error:
            status = 'error'
        hashes = [tx for tx in txs if tx]
        return {**self.meta(), 'status': status, 'error': None if pending else error,
                'mintTx': mint, 'approveTx': approve,
                'createTx': entry.get('createTx'), 'depositTx': entry.get('depositTx'),
                'payee': entry.get('payee') or (self.agent or None), 'lastTx': hashes[-1] if hashes else None,
                'expenses': expenses}

    def schedule(self, pid):
        """Copy this project onto the chain without blocking the request that wrote the log."""
        if not self.enabled or not self._loader:
            return
        with self._guard:
            if pid in self._inflight:
                self._pending.add(pid)
                return
            self._inflight.add(pid)
        threading.Thread(target=self._worker, args=(pid,), name=f'ploby-chain-{pid}', daemon=True).start()

    def _worker(self, pid):
        try:
            while True:
                project = self._loader(pid)
                if project is not None:
                    try:
                        self.sync(project)
                    except Exception as e:
                        self.note_error(pid, f'{type(e).__name__}: {e}')
                with self._guard:
                    if pid not in self._pending:
                        self._inflight.discard(pid)
                        return
                    self._pending.discard(pid)
        except Exception:
            with self._guard:
                self._inflight.discard(pid)
                self._pending.discard(pid)

    def sync(self, project):
        if not self.enabled:
            return
        with self._send_lock:
            try:
                self._prepare_wallet()
                entry = self._entry(project.id)
                recorded = any(rec.get('recordTx') for rec in (entry.get('expenses') or {}).values())
                if not recorded and ADDR.match(self.agent):
                    entry['payee'] = self.agent
                    self._save()
                self._fund(project)
                entry = self.book.get(project.id) or {}
                if entry.get('status') == 'funded':
                    for expense in project.expenses.values():
                        self._expense(project, expense)
            except ChainError as e:
                entry = self._entry(project.id)
                entry['error'] = self._scrub(str(e))
                if entry.get('status') != 'funded':
                    entry['status'] = 'error'
                self._save()

    def note_error(self, pid, message):
        self._entry(pid)['error'] = self._scrub(message)
        self._entry(pid)['status'] = 'error'
        self._save()

    def _prepare_wallet(self):
        """Mint a cushion of MockUSDC and approve the escrow once. Later deposits skip both."""
        with self._send_lock:
            entry = self.book.setdefault(WALLET, {})
            if entry.get('ready'):
                return
            balance = self._erc20('balanceOf(address)(uint256)', self.client)
            allowance = self._erc20('allowance(address,address)(uint256)', self.client, self.escrow)
            if balance < CUSHION and not entry.get('mintTx'):
                entry['mintTx'] = self._send(self.agent_key, self.usdc, 'mint(address,uint256)',
                                              self.client, str(CUSHION - balance))
                self._save()
            if allowance < CUSHION and not entry.get('approveTx'):
                entry['approveTx'] = self._send(self.client_key, self.usdc, 'approve(address,uint256)',
                                                 self.escrow, str(MAX_UINT))
                self._save()
            entry['ready'] = True
            self._save()

    def _ensure(self, needed):
        """Top up only when this deposit is larger than the cushion already approved."""
        balance = self._erc20('balanceOf(address)(uint256)', self.client)
        allowance = self._erc20('allowance(address,address)(uint256)', self.client, self.escrow)
        if balance < needed:
            self._send(self.agent_key, self.usdc, 'mint(address,uint256)', self.client, str(needed - balance))
        if allowance < needed:
            self._send(self.client_key, self.usdc, 'approve(address,uint256)', self.escrow, str(MAX_UINT))

    def _fund(self, project):
        entry = self._entry(project.id)
        if entry.get('depositTx') or project.status not in ('ACTIVE', 'CLOSING', 'CLOSED'):
            return
        doc = project.doc
        if not doc:
            return
        policy_hash = (project.active or {}).get('hash') or ''
        if not B32.match(policy_hash) or not ADDR.match(self.agent):
            raise ChainError('policy hash or settlement payee is not usable on chain')
        budget = to_base(doc['projectBudget'])
        if budget <= 0:
            raise ChainError('project budget is zero')
        self._ensure(budget)
        pid_hash = self._keccak(project.id)
        # Pay the agent wallet, which the demo can open. A payee saved before deposit is replaced;
        # after deposit the recorded payee must stay, or release reverts PayeeMismatch.
        entry.update(projectId=pid_hash, policyHash=policy_hash, payee=self.agent, budget=doc['projectBudget'])
        self._step(entry, 'createTx', self.client_key, self.escrow, 'createProject(bytes32,bytes32,uint256)',
                   pid_hash, policy_hash, str(budget))
        self._step(entry, 'depositTx', self.client_key, self.escrow, 'deposit(bytes32)', pid_hash)
        entry['status'] = 'funded'
        entry['error'] = None
        self._save()

    def _expense(self, project, expense):
        entry = self._entry(project.id)
        rec = (entry.get('expenses') or {}).setdefault(expense['id'], {})
        payee = entry.get('payee') or '0x0000000000000000000000000000000000000000'
        evidence = rec.get('evidence') or self._keccak(f"{project.id}:{expense['id']}")
        rec['evidence'] = evidence
        for _ in range(4):
            step = next_step(expense, rec)
            if step is None:
                break
            if step['op'] == 'error':
                rec['status'] = 'error'
                rec['error'] = step['error']
                entry['error'] = step['error']
                self._save()
                break
            amount = to_base(step.get('amount') or 0)
            if step['op'] in ('record', 'record_release'):
                self._record(entry, rec, payee, evidence, step['code'], amount, step['amount'])
            if step['op'] == 'reject':
                rec['rejectTx'] = self._send(self.client_key, self.escrow, 'rejectHold(bytes32,bytes32)',
                                              entry['projectId'], evidence)
                rec['status'] = 'rejected'
            if step['op'] in ('approve', 'approve_release'):
                rec['approveTx'] = self._send(self.client_key, self.escrow, 'approveHold(bytes32,bytes32)',
                                               entry['projectId'], evidence)
                rec['status'] = 'approved'
            if step['op'] in ('release', 'record_release', 'approve_release'):
                rec['releaseTx'] = self._send(self.agent_key, self.escrow, 'release(bytes32,bytes32,address,uint256)',
                                               entry['projectId'], evidence, payee, str(to_base(step['amount'])))
                rec['status'] = 'released'
                rec['error'] = None
            self._save()

    def _record(self, entry, rec, payee, evidence, code, amount_base, amount):
        destination = payee if code != 3 else payee
        rec['recordTx'] = self._send(
            self.agent_key, self.escrow,
            'recordDecision((bytes32,bytes32,bytes32,uint256,uint8,uint256),address)',
            f"({entry['projectId']},{evidence},{entry['policyHash']},{amount_base},{code},0)",
            destination)
        rec.update(code=code, amount=amount, status='recorded', error=None)

    def _step(self, entry, field, key, to, sig, *args):
        if entry.get(field):
            return
        try:
            entry[field] = self._send(key, to, sig, *args)
        except ChainError as e:
            if field == 'createTx' and 'ProjectExists' in str(e):
                entry[field] = 'already-created'
            else:
                raise
        self._save()

    def _send(self, key, to, sig, *args):
        out = self._cast('send', '--json', '--rpc-url', self.rpc, '--private-key', key, to, sig, *args)
        try:
            data = json.loads(out)
        except json.JSONDecodeError as e:
            raise ChainError('cast did not return a receipt') from e
        tx = data.get('transactionHash') or data.get('hash')
        if not tx:
            raise ChainError('cast receipt has no transaction hash')
        return tx

    def _tx(self, value):
        return value if isinstance(value, str) and B32.match(value) else None

    def _erc20(self, sig, *args):
        out = self._cast('call', '--rpc-url', self.rpc, self.usdc, sig, *args).strip()
        token = out.split()[0] if out else '0'
        try:
            return int(token, 0)
        except ValueError as e:
            raise ChainError('could not read the token balance') from e

    def _keccak(self, text):
        return self._cast('keccak', text).strip()

    def _cast(self, *args):
        try:
            proc = subprocess.run([self.cast, *args], capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired as e:
            raise ChainError('cast timed out') from e
        if proc.returncode != 0:
            raise ChainError(self._scrub((proc.stderr or proc.stdout or 'cast failed').strip()))
        return proc.stdout

    def _scrub(self, text):
        for secret in (self.agent_key, self.client_key):
            if secret:
                text = text.replace(secret, '0x…')
        return text[-400:]

    def _entry(self, pid):
        return self.book.setdefault(pid, {'expenses': {}})

    def _read(self):
        if not self.book_path.exists():
            return {}
        try:
            data = json.loads(self.book_path.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self):
        self.book_path.parent.mkdir(parents=True, exist_ok=True)
        self.book_path.write_text(json.dumps(self.book, ensure_ascii=False), encoding='utf-8')


def _self_check():
    assert to_base(200) == 200_000_000
    assert next_step({'status': 'BLOCKED', 'maximum': 300, 'paid': 0}, {})['code'] == 3
    hold = {'status': 'HOLD_REVIEW', 'decision': {'result': 'HOLD'}, 'maximum': 200, 'paid': 0}
    assert next_step(hold, {})['code'] == 2
    assert next_step({'status': 'SETTLED', 'paid': 150, 'maximum': 200}, {})['op'] == 'record_release'
    recorded = {'recordTx': '0x1', 'code': 1, 'amount': 150}
    assert next_step({'status': 'SETTLED', 'paid': 150}, recorded)['op'] == 'release'
    assert next_step({'status': 'SETTLED', 'paid': 100}, recorded)['op'] == 'error'
    assert next_step({'status': 'REJECTED', 'decision': {'result': 'HOLD'}, 'maximum': 200, 'paid': 0},
                     {'recordTx': '0x1', 'code': 2, 'amount': 200})['op'] == 'reject'
    assert next_step({'status': 'RESERVED', 'decision': {'result': 'HOLD'}, 'paid': 0},
                     {'recordTx': '0x1', 'code': 2, 'amount': 200})['op'] == 'approve'
