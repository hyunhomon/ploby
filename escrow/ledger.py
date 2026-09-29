"""SimEscrow: src/ExpenseEscrow.sol in memory, behind the chain interface MonadEscrow also has.

    name                                   'sim'
    address_of(who)                        '0x' + sha256("pcp-payee:<who>")[-40 hex]  (Monad: keccak256, same shape)
    create_project(pid, policy_hash, budget) / deposit(pid)                      client
    record_decision(pid, evidence, policy_hash, amount, decision, payee) / release(pid, evidence, payee, amount)   agent
    approve_hold(pid, evidence) / reject_hold(pid, evidence) / stop_project(pid)                          client
    -> tx {'tx': '0x..' | None, 'ok', 'error': None | the contract's error name, 'seconds'}
    project(pid) -> {'client', 'policy_hash', 'budget', 'deposited', 'spent', 'stopped'} | None
    events(pid)  -> [{'event', 'tx', 'block', 'args'}]   args by the Solidity parameter names
                    (projectId, evidenceHash, policyHash, amount, decision, timestamp, payee, client, budget, from);
                    hashes and addresses lowercase '0x' hex, amounts int
    explorer(tx) -> None

A call that would revert is not sent: nothing changes, and the tx says which error. Every method takes
sender= (default: the role the contract requires) so the role checks can be exercised. The contract's
limits are kept as they are: one policy hash per project, stop freezes everything, no withdraw. A decision
binds its payee (APPROVE and HOLD need one; BLOCK may name the payee it refused), and release pays only
that payee (PayeeMismatch otherwise) — but the agent still chooses the payee it records; the audit checks
it against the registry address of the logged vendor.
"""
import copy
import hashlib
import json
import time

APPROVE, HOLD, BLOCK = 1, 2, 3
ZERO = '0x' + '0' * 64


def payee_address(who):
    return '0x' + hashlib.sha256(f'pcp-payee:{who}'.encode()).hexdigest()[-40:]


class Revert(Exception):
    pass


class SimEscrow:
    name = 'sim'

    def __init__(self):
        self.projects, self.records, self.balances, self.log = {}, {}, {}, []
        self.block = self.nonce = 0
        self.agent, self.escrow = self.address_of('agent'), self.address_of('escrow')

    def address_of(self, who):
        return payee_address(who)

    def explorer(self, tx):
        return None

    # -- sending
    def _send(self, sender, call, args, body):
        t0 = time.time()
        saved = copy.deepcopy((self.projects, self.records, self.balances))
        try:
            emitted = body(self.address_of(sender) if not sender.startswith('0x') else sender)
        except Revert as e:
            self.projects, self.records, self.balances = saved
            return {'tx': None, 'ok': False, 'error': str(e), 'seconds': time.time() - t0}
        self.nonce += 1
        self.block += 1
        tx = '0x' + hashlib.sha256(json.dumps([self.nonce, sender, call, args]).encode()).hexdigest()
        self.log += [{'event': n, 'tx': tx, 'block': self.block, 'args': a} for n, a in emitted]
        return {'tx': tx, 'ok': True, 'error': None, 'seconds': time.time() - t0}

    def _project(self, pid):
        p = self.projects.get(pid)
        if p is None:
            raise Revert('ProjectNotFound')
        return p

    def _move(self, frm, to, amount):
        if self.balances.get(frm, 0) < amount:
            raise Revert('TransferFailed')
        self.balances[frm] = self.balances.get(frm, 0) - amount
        self.balances[to] = self.balances.get(to, 0) + amount

    # -- the contract
    def create_project(self, pid, policy_hash, budget, sender='client'):
        def body(me):
            if pid == ZERO or policy_hash == ZERO:
                raise Revert('ZeroHash')
            if budget <= 0:
                raise Revert('ZeroAmount')
            if pid in self.projects:
                raise Revert('ProjectExists')
            self.projects[pid] = {'client': me, 'policy_hash': policy_hash, 'budget': int(budget), 'deposited': 0,
                                  'spent': 0, 'stopped': False}
            return [('ProjectCreated', {'projectId': pid, 'client': me, 'policyHash': policy_hash, 'budget': int(budget)})]
        return self._send(sender, 'createProject', [pid, policy_hash, budget], body)

    def deposit(self, pid, sender='client'):
        """Mints the unfunded budget to the client (test token), approves and deposits it."""
        def body(me):
            p = self._project(pid)
            if me != p['client']:
                raise Revert('NotClient')
            if p['stopped']:
                raise Revert('ProjectIsStopped')
            amount = p['budget'] - p['deposited']
            if amount == 0:
                raise Revert('ZeroAmount')
            self.balances[me] = self.balances.get(me, 0) + amount
            p['deposited'] = p['budget']
            self._move(me, self.escrow, amount)
            return [('Deposited', {'projectId': pid, 'from': me, 'amount': amount})]
        return self._send(sender, 'deposit', [pid], body)

    def record_decision(self, pid, evidence_hash, policy_hash, amount, decision, payee=None, sender='agent'):
        def body(me):
            if me != self.agent:
                raise Revert('NotAgent')
            if pid == ZERO or evidence_hash == ZERO:
                raise Revert('ZeroHash')
            if amount <= 0:
                raise Revert('ZeroAmount')
            if decision not in (APPROVE, HOLD, BLOCK):
                raise Revert('BadDecision')
            to = (payee or '0x' + '0' * 40).lower()
            if decision != BLOCK and int(to, 16) == 0:
                raise Revert('ZeroAddress')
            p = self._project(pid)
            if p['stopped']:
                raise Revert('ProjectIsStopped')
            if policy_hash != p['policy_hash']:
                raise Revert('PolicyMismatch')
            if (pid, evidence_hash) in self.records:
                raise Revert('DuplicateDecision')
            ts = int(time.time())
            self.records[(pid, evidence_hash)] = {'amount': int(amount), 'decision': decision, 'payee': to,
                                                  'client_approved': False, 'rejected': False, 'released': False}
            return [('DecisionRecorded', {'projectId': pid, 'evidenceHash': evidence_hash, 'payee': to, 'policyHash': policy_hash,
                                          'amount': int(amount), 'decision': decision, 'timestamp': ts})]
        return self._send(sender, 'recordDecision', [pid, evidence_hash, policy_hash, amount, decision, payee], body)

    def _hold(self, pid, evidence_hash, approve, sender):
        def body(me):
            p = self._project(pid)
            if me != p['client']:
                raise Revert('NotClient')
            if p['stopped']:
                raise Revert('ProjectIsStopped')
            r = self.records.get((pid, evidence_hash))
            if r is None:
                raise Revert('DecisionNotFound')
            if r['decision'] != HOLD or r['rejected'] or r['client_approved'] or r['released']:
                raise Revert('HoldNotPending')
            r['client_approved' if approve else 'rejected'] = True
            return [('HoldApproved' if approve else 'HoldRejected', {'projectId': pid, 'evidenceHash': evidence_hash})]
        return self._send(sender, 'approveHold' if approve else 'rejectHold', [pid, evidence_hash], body)

    def approve_hold(self, pid, evidence_hash, sender='client'):
        return self._hold(pid, evidence_hash, True, sender)

    def reject_hold(self, pid, evidence_hash, sender='client'):
        return self._hold(pid, evidence_hash, False, sender)

    def release(self, pid, evidence_hash, payee, amount, sender='agent'):
        def body(me):
            if me != self.agent:
                raise Revert('NotAgent')
            p = self._project(pid)
            if p['stopped']:
                raise Revert('ProjectIsStopped')
            r = self.records.get((pid, evidence_hash))
            if r is None:
                raise Revert('DecisionNotFound')
            if r['released']:
                raise Revert('AlreadyReleased')
            if str(payee or '').lower() != r['payee']:
                raise Revert('PayeeMismatch')
            if not (r['decision'] == APPROVE or (r['decision'] == HOLD and r['client_approved'])):
                raise Revert('NotReleasable')
            if amount != r['amount']:
                raise Revert('AmountMismatch')
            if p['spent'] + amount > p['budget']:
                raise Revert('OverBudget')
            if p['spent'] + amount > p['deposited']:
                raise Revert('InsufficientDeposit')
            p['spent'] += amount
            r['released'] = True
            self._move(self.escrow, payee.lower(), amount)
            return [('PaymentReleased', {'projectId': pid, 'evidenceHash': evidence_hash, 'payee': payee.lower(),
                                         'amount': int(amount)})]
        return self._send(sender, 'release', [pid, evidence_hash, payee, amount], body)

    def stop_project(self, pid, sender='client'):
        def body(me):
            p = self._project(pid)
            if me != p['client']:
                raise Revert('NotClient')
            if p['stopped']:
                raise Revert('ProjectIsStopped')
            p['stopped'] = True
            return [('ProjectStopped', {'projectId': pid})]
        return self._send(sender, 'stopProject', [pid], body)

    # -- reading
    def project(self, pid):
        p = self.projects.get(pid)
        return dict(p) if p else None

    def events(self, pid):
        return [copy.deepcopy(e) for e in self.log if e['args'].get('projectId') == pid]
