"""A mandate's state and its rules, applied one log line at a time.

Log lines (the only way state changes; replaying the lines rebuilds the state exactly):

    module <hash>                         the mandate in force from the start
    replace <hash>                        a new mandate; the state carries over
    at <ms>                               the time the next events see
    deliver <input> <source> <n> {json}   a numbered message, applied once per (source, n)
    msg <input> {json}                    an unnumbered message (tests and tools)
    trim pay <n>                          forget payment messages up to n (the relay has them)
    note <text>                           evidence only (e.g. `note chain-base 4`); changes nothing

Inputs: propose {merchant, category, item, amount, fee, units}, stop {why}, resume {why},
settled {seq, tx, ok}. Every proposal becomes a decision whose reason is the first rule it
breaks (`decide`), or ok — which reserves the total and puts a payment message
{seq, merchant, total} in the outbox. `settled` for a paid decision moves its total from
reserved to spent (ok) or releases it (not ok), once.
"""
import copy
import hashlib
import json
import math

from . import lang

REASONS = ('stopped', 'invalid_amount', 'merchant_not_allowed', 'category_not_allowed', 'outside_window',
           'over_order_limit', 'over_budget', 'over_count')
INPUTS = {'propose': ('merchant', 'category', 'item', 'amount', 'fee', 'units'), 'stop': ('why',),
          'resume': ('why',), 'settled': ('seq', 'tx', 'ok')}


def decide(mandate, p, at, spent, reserved, approved, stopped):
    """The first rule proposal p breaks at time `at`, or 'ok'. The one place the order lives."""
    total = p['amount'] + p['fee']
    if stopped:
        return 'stopped'
    if p['amount'] < 0 or p['fee'] < 0:
        return 'invalid_amount'
    if not mandate.ok('merchant_ok', p['merchant']):
        return 'merchant_not_allowed'
    if not mandate.ok('category_ok', p['category']):
        return 'category_not_allowed'
    if not mandate.ok('window_ok', float(at)):
        return 'outside_window'
    if not mandate.ok('order_ok', total, float(p['units'])):
        return 'over_order_limit'
    if spent + reserved + total > mandate.budget:
        return 'over_budget'
    if approved >= mandate.count_limit:
        return 'over_count'
    return 'ok'


def well_formed(p):
    numbers = (p['amount'], p['fee'], p['units'])
    return (all(isinstance(x, (int, float)) and math.isfinite(x) for x in numbers) and p['units'] >= 0
            and p['units'] == int(p['units']) and isinstance(p['merchant'], str) and isinstance(p['category'], str))


class Rejected(Exception):
    """A message that cannot be applied (malformed, or a rule of the input): nothing changes."""


class State:
    def __init__(self, modules):
        """modules: hash -> module (dict), for `module` and `replace` lines."""
        self.modules = modules
        self.mandate = None
        self.now = 0
        self.proposals = self.approved = 0
        self.reserved = self.spent = 0.0
        self.stopped = 0
        self.decisions = []
        self.outbox, self.sent = [], 0
        self.heard = {}

    # -- lines
    def apply(self, line):
        """Apply one log line; its answer."""
        word, _, rest = line.partition(' ')
        if word in ('module', 'replace'):
            h = rest.strip().split('/')[-1].removesuffix('.json')  # a hash, or a path named by one
            if h not in self.modules:
                raise KeyError(f'no module {h}')
            self.mandate = lang.Mandate(self.modules[h])
            return {'replaced': True} if word == 'replace' else {'module': h}
        if word == 'note':
            return {'note': rest}
        if word == 'at':
            self.now = float(rest)
            return {'at': self.now}
        if word == 'trim':
            n = int(rest.split()[1])
            self.outbox = [m for m in self.outbox if m['seq'] > n]
            return {'trimmed': n}
        if word == 'msg':
            name, _, body = rest.partition(' ')
            return self.message(name, json.loads(body))
        if word == 'deliver':
            name, source, n, body = rest.split(' ', 3)
            n = int(n)
            if n <= self.heard.get(source, 0):
                return {'input': name, 'ok': True, 'fault': 'none', 'duplicate': True}
            answer = self.message(name, json.loads(body))
            self.heard[source] = n  # heard even when refused: delivered, and refused
            return answer
        raise ValueError(f'unknown line {word!r}')

    def message(self, name, body):
        fields = INPUTS.get(name)
        if fields is None or set(body) != set(fields):
            return {'input': name, 'ok': False, 'fault': 'fields'}
        before = (self.proposals, self.approved, self.reserved, self.spent, self.stopped)
        try:
            getattr(self, 'on_' + name)(body)
            return {'input': name, 'ok': True, 'fault': 'none'}
        except Rejected as e:
            self.proposals, self.approved, self.reserved, self.spent, self.stopped = before
            return {'input': name, 'ok': False, 'fault': str(e)}

    # -- inputs
    def would(self, p, at=None):
        """What a proposal would be decided now, changing nothing (for negotiation)."""
        if not well_formed(p):
            return 'invalid'
        return decide(self.mandate, p, self.now if at is None else at, self.spent, self.reserved, self.approved,
                      self.stopped)

    def on_propose(self, p):
        if not well_formed(p):
            raise Rejected('encoding')
        reason = self.would(p)
        total = p['amount'] + p['fee']
        self.proposals += 1
        self.decisions.append({'seq': self.proposals, 'at': self.now, 'merchant': p['merchant'],
                               'category': p['category'], 'item': str(p['item']), 'amount': float(p['amount']),
                               'fee': float(p['fee']), 'units': float(p['units']), 'reason': reason, 'tx': '',
                               'settled': 0})
        if reason == 'ok':
            self.approved += 1
            self.reserved += total
            self.sent += 1
            self.outbox.append({'output': 'pay', 'seq': self.sent,
                                'body': {'seq': self.proposals, 'merchant': p['merchant'], 'total': total}})

    def on_stop(self, _):
        self.stopped = 1

    def on_resume(self, _):
        self.stopped = 0

    def on_settled(self, s):
        seq = s['seq']
        if not isinstance(seq, int) or not 1 <= seq <= len(self.decisions):
            raise Rejected('not_found')
        d = self.decisions[seq - 1]
        if d['reason'] != 'ok' or d['settled'] != 0:
            raise Rejected('limit')
        self.reserved -= d['amount'] + d['fee']
        if s['ok']:
            self.spent += d['amount'] + d['fee']
        d['settled'] = 1 if s['ok'] else 2
        d['tx'] = str(s['tx'])

    # -- what is read
    def views(self):
        return {'budget_total': self.mandate.budget, 'count_max': self.mandate.count_limit,
                'remaining': self.mandate.budget - self.spent - self.reserved,
                'refused': sum(d['reason'] != 'ok' for d in self.decisions),
                'ledger': [{'seq': d['seq'], 'merchant': d['merchant'], 'total': d['amount'] + d['fee'],
                            'reason': d['reason'], 'tx': d['tx']} for d in self.decisions]}

    def snapshot(self):
        """States and views (the auditor's state hash is over this)."""
        return {'states': {'proposals': self.proposals, 'approved': self.approved, 'reserved': self.reserved,
                           'spent': self.spent, 'stopped': self.stopped,
                           'decisions': copy.deepcopy(self.decisions)},
                'views': self.views()}


def state_hash(snapshot):
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
