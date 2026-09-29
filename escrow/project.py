"""A SmartEscrow project: one policy, one hash-chained log, and a state folded from the log.

The log is the store. <workdir>/log.jsonl holds one {"i", "line", "head"}
per change; `line` is canonical JSON {"op", "at", ...} (at: the scenario clock, ms) and
head[i] = sha256(head[i-1] + "\\n" + line[i]) from 64 zeros. A change is applied to a copy of the
state first; only a change that applies is written. replay(workdir) folds the lines again, with no
chain and no clock, into the same state and state hash. Every line after open carries a numeric `at` no
earlier than the line before it (the fold refuses a clock that goes back).

Lines (op):
    open {project_id, chain}                 first line
    policy {doc, policy_hash}                a proposed policy (version n+1 names version n in `previous`)
    sign {party, policy_hash, signature}     acceptance; ACTIVE once client and contractor signed the
    deposit {amount}                         current hash and the deposit covers milestones + expense budget
    request {proposal, source, unreadable, decision {verdict, reason}}
                                             an expense; the fold re-derives the decision and refuses a line
                                             whose logged decision is not the rule's, whose category is not
                                             the registry's (category_of) or whose amount / fee is not a whole
                                             number of KRW. Its head is the decision's evidence hash, on chain
                                             and in the receipt
    hold {seq, approve, signature}           client answers a HOLD; settle {seq}: an APPROVE or approved HOLD
                                             is paid
    submit {mid, signature} / object {mid, why, signature}      milestone review
    accept {mid, signature} / silence {mid}  milestone paid: by the client, or by the review deadline
                                             passing with no objection (the pre-agreed result); evidence
    tick {}                                  anyone: time passed, nothing was due
    stop {why} / close {refund}              client pause (later requests BLOCK 'stopped'); close refunds
                                             deposited - paid - open reservations (off chain: no withdraw)
                                             and fixes those reservations as `owed`: once CLOSED, only an owed
                                             decision is settled and only an owed milestone is accepted, paid by
                                             silence or objected to; requests, HOLD answers and submissions are
                                             refused, so paid + refunded + open reservations == deposited
    tx {kind, ref, chain, tx, ok, error}     a chain call's result (kind: create deposit decision hold
                                             release stop; ref: the evidence hash). Evidence only: a chain
                                             result never changes a decision.

signature: policy.sign_act by the line's actor (policy.ACTORS: client for accept / object / hold, contractor for
submit) over act(project_id, op, ref, at), op hold:approve / hold:reject for a hold; the fold refuses a line
without it (HMAC demo keys, the stand-in for wallet signatures, as for the policy).

Verdicts from the PCP reason (pcp.mandate.decide): ok -> APPROVE 1 (reserves amount + fee);
over_order_limit or an unreadable reading -> HOLD 2; every other reason -> BLOCK 3 (an unreadable reading
that still breaks a BLOCK rule is BLOCK). Payees come from the registry (address_of(vendor id) or
address_of('contractor')), never from the document.
"""
import copy
import functools
import hashlib
import json
import math
import os
from pathlib import Path

from . import policy as pol
from .ledger import payee_address
from .pcp_bridge import domain as _load_domain, lang, mandate as core

GENESIS = '0' * 64
DAY = 86400000
APPROVE, HOLD, BLOCK = 1, 2, 3
CODES = {'APPROVE': APPROVE, 'HOLD': HOLD, 'BLOCK': BLOCK}
FIELDS = core.INPUTS['propose']
_MANDATES = {}
domain = functools.lru_cache(None)(_load_domain)


def category_of(merchant):
    """The registry's category for a merchant id; 'unknown' for a merchant the registry does not list."""
    r = domain().by_id.get(merchant)
    return r['category'] if r else 'unknown'


def whole(x):
    return isinstance(x, int) and not isinstance(x, bool)


def chain_step(head, line):
    """The next head: sha256(head + newline + line)."""
    return hashlib.sha256((head + '\n' + line).encode()).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def state_hash(state):
    return hashlib.sha256(canonical(state).encode()).hexdigest()


def mandate_of(module):
    h = lang.digest(module)
    if h not in _MANDATES:
        _MANDATES[h] = lang.Mandate(module)
    return _MANDATES[h]


class Refused(ValueError):
    """A change that cannot be applied: nothing is written."""


class Book:
    """The state: a pure fold over the log's lines."""

    def __init__(self):
        self.project_id = self.chain = self.doc = self.policy_hash = None
        self.status, self.signatures = 'EMPTY', {}
        self.deposited = self.paid = self.refunded = 0
        self.spent = self.reserved = self.approved = self.stopped = 0
        self.decisions, self.milestones, self.txs, self.evidence = [], [], [], {}
        self.at = self.owed = None

    @property
    def mandate(self):
        return mandate_of(self.doc['expense']['mandate'])

    def apply(self, ev, i, head):
        fn = getattr(self, 'on_' + str(ev.get('op')), None)
        if fn is None:
            raise Refused(f"unknown op {ev.get('op')!r}")
        at = ev.get('at')
        if ev.get('op') != 'open':
            if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
                raise Refused(f'at {at!r} is not a time')
            if self.at is not None and at < self.at:
                raise Refused(f'at {at} is before the last line\'s {self.at}: the clock does not go back')
        answer = fn(ev, i, '0x' + head) or {}
        self.at = ev.get('at', self.at)
        return answer

    # -- the rule
    def judge(self, p, at, unreadable):
        """(verdict, reason) for a proposal at `at`; changes nothing."""
        wf = isinstance(p, dict) and set(FIELDS) <= set(p) and core.well_formed(p)
        rule = (core.decide(self.mandate, p, at, self.spent, self.reserved, self.approved, self.stopped) if wf
                else 'stopped' if self.stopped else None)
        if rule not in (None, 'ok', 'over_order_limit'):
            return 'BLOCK', rule
        if unreadable or not wf:
            return 'HOLD', 'unreadable'
        return ('APPROVE', 'ok') if rule == 'ok' else ('HOLD', rule)

    def due(self, at):
        """Milestones whose review deadline passed with no objection (none while stopped)."""
        return [] if self.stopped else [m['id'] for m in self.milestones if m['status'] == 'in_review' and at > m['due_at']]

    def _need(self, *statuses):
        if self.status not in statuses:
            raise Refused(f'project is {self.status}, not {"/".join(statuses)}')

    def _payable_now(self, owed=None):
        """ACTIVE and not stopped; once CLOSED, only an obligation counted as an open reservation at close
        (owed: ('decisions', seq) or ('milestones', mid)), so paid + refunded never exceeds deposited."""
        self._need('ACTIVE', 'CLOSED')
        if self.stopped:
            raise Refused('project is stopped')
        if self.status == 'CLOSED' and (owed is None or owed[1] not in self.owed[owed[0]]):
            raise Refused('project is CLOSED: only what was reserved at close is paid')

    def _signed(self, ev, ref):
        """The line carries its actor's signature over act(project_id, op, ref, at)."""
        op, party = ev['op'], pol.ACTORS[ev['op']]
        if op == 'hold':
            if not isinstance(ev.get('approve'), bool):
                raise Refused('approve is true or false')
            op = 'hold:approve' if ev['approve'] else 'hold:reject'
        if not pol.verify_act(party, self.project_id, op, ref, ev['at'], ev.get('signature')):
            raise Refused(f"{op} {ref!r} needs the {party}'s signature over (project, {op}, {ref!r}, at)")

    def _decision(self, seq):
        if not isinstance(seq, int) or not 1 <= seq <= len(self.decisions):
            raise Refused(f'no decision {seq!r}')
        return self.decisions[seq - 1]

    def _milestone(self, mid):
        for m in self.milestones:
            if m['id'] == mid:
                return m
        raise Refused(f'no milestone {mid!r}')

    def _activate(self):
        signed = all(pol.verify(p, self.policy_hash, self.signatures.get(p)) for p in pol.SIGNERS)
        if self.status == 'PROPOSED' and signed and self.deposited >= pol.required_deposit(self.doc):
            self.status = 'ACTIVE'
            return {'activated': True}
        return {'activated': False}

    # -- lines
    def on_open(self, ev, i, h):
        if i != 0:
            raise Refused('open is the first line')
        self.project_id, self.chain = ev['project_id'], ev.get('chain')

    def on_policy(self, ev, i, h):
        self._need('EMPTY', 'PROPOSED')
        doc = ev['doc']
        bad = pol.problems(doc)
        if bad:
            raise Refused('; '.join(bad))
        if pol.policy_hash(doc) != ev['policy_hash']:
            raise Refused('policy_hash is not the document\'s hash')
        if doc.get('previous') != self.policy_hash:
            raise Refused(f'previous must be the policy it replaces ({self.policy_hash})')
        self.doc, self.policy_hash, self.signatures, self.status = doc, ev['policy_hash'], {}, 'PROPOSED'
        self.milestones = [{'id': m['id'], 'title': m['title'], 'amount': m['amount'], 'review_days': m['review_days'],
                            'status': 'open', 'submitted_at': None, 'due_at': None, 'paid_by': None, 'log_index': None,
                            'evidence': None, 'txs': {}} for m in doc['milestones']]
        return {'policy_hash': self.policy_hash}

    def on_sign(self, ev, i, h):
        self._need('PROPOSED')
        if ev['party'] not in pol.SIGNERS:
            raise Refused(f"{ev['party']!r} does not sign the policy")
        if ev['policy_hash'] != self.policy_hash or not pol.verify(ev['party'], self.policy_hash, ev['signature']):
            raise Refused(f"{ev['party']}'s signature is not over the current policy hash")
        self.signatures[ev['party']] = ev['signature']
        return self._activate()

    def on_deposit(self, ev, i, h):
        self._need('PROPOSED')
        if not (isinstance(ev['amount'], int) and ev['amount'] > 0):
            raise Refused('a deposit is a positive whole number')
        self.deposited += ev['amount']
        return self._activate()

    def on_request(self, ev, i, h):
        self._need('ACTIVE', 'STOPPED')
        p, at = ev['proposal'], ev['at']
        if isinstance(p, dict):
            bad = [k for k in ('amount', 'fee') if p.get(k) is not None and not whole(p[k])]
            if bad:
                raise Refused(f"{' and '.join(bad)} must be a whole number of KRW")
            if isinstance(p.get('merchant'), str) and p.get('category') != category_of(p['merchant']):
                raise Refused(f"category {p.get('category')!r} is not the registry's for {p['merchant']!r}")
        verdict, reason = self.judge(p, at, ev['unreadable'])
        if ev['decision'] != {'verdict': verdict, 'reason': reason}:
            raise Refused(f'the logged decision {ev["decision"]} is not the rule\'s ({verdict} {reason})')
        wf = isinstance(p, dict) and set(FIELDS) <= set(p) and core.well_formed(p)
        g = (lambda k, d=None: p.get(k, d)) if isinstance(p, dict) else (lambda k, d=None: d)
        total = g('amount', 0) + g('fee', 0) if wf else 0
        d = {'seq': len(self.decisions) + 1, 'at': at, 'log_index': i, 'evidence': h, 'vendor': g('merchant'),
             'category': g('category'), 'item': str(g('item', '')), 'amount': g('amount'), 'fee': g('fee'),
             'units': g('units'), 'total': total, 'source': ev['source'], 'verdict': verdict, 'code': CODES[verdict],
             'reason': reason, 'status': {'APPROVE': 'reserved', 'HOLD': 'held', 'BLOCK': 'blocked'}[verdict], 'txs': {}}
        if verdict == 'APPROVE':
            self.approved += 1
            self.reserved += total
        self.decisions.append(d)
        self.evidence[h] = ('decision', d['seq'])
        return {'seq': d['seq'], 'verdict': verdict, 'reason': reason, 'total': total}

    def on_hold(self, ev, i, h):
        self._payable_now()
        self._signed(ev, ev['seq'])
        d = self._decision(ev['seq'])
        if d['status'] != 'held':
            raise Refused(f"decision {d['seq']} is not a pending HOLD")
        if ev['approve']:
            if not d['total'] or d['total'] <= 0 or d['vendor'] is None:
                raise Refused('an unreadable reading with no amount cannot be approved; request it again')
            if self.spent + self.reserved + d['total'] > self.mandate.budget:
                raise Refused('over_budget')
            self.approved += 1
            self.reserved += d['total']
        d['status'] = 'approved' if ev['approve'] else 'rejected'
        return {'seq': d['seq'], 'status': d['status']}

    def on_settle(self, ev, i, h):
        self._payable_now(('decisions', ev['seq']))
        d = self._decision(ev['seq'])
        if d['status'] not in ('reserved', 'approved'):
            raise Refused(f"decision {d['seq']} is {d['status']}: only an APPROVE or an approved HOLD is paid")
        d['status'] = 'paid'
        self.reserved -= d['total']
        self.spent += d['total']
        self.paid += d['total']
        return {'seq': d['seq'], 'paid': d['total']}

    def on_submit(self, ev, i, h):
        self._payable_now()
        self._signed(ev, ev['mid'])
        m = self._milestone(ev['mid'])
        if m['status'] not in ('open', 'disputed'):
            raise Refused(f"milestone {m['id']} is {m['status']}")
        m.update(status='in_review', submitted_at=ev['at'], due_at=ev['at'] + m['review_days'] * DAY)
        return {'mid': m['id'], 'due_at': m['due_at']}

    def on_object(self, ev, i, h):
        self._payable_now(('milestones', ev['mid']))
        self._signed(ev, ev['mid'])
        m = self._milestone(ev['mid'])
        if m['status'] != 'in_review' or ev['at'] > m['due_at']:
            raise Refused(f"milestone {m['id']} is not in its review window")
        m.update(status='disputed', why=ev['why'])
        return {'mid': m['id'], 'status': 'disputed'}

    def _pay_milestone(self, ev, h, by):
        self._payable_now(('milestones', ev['mid']))
        m = self._milestone(ev['mid'])
        if m['status'] != 'in_review':
            raise Refused(f"milestone {m['id']} is {m['status']}, not in review")
        if by == 'silence' and not ev['at'] > m['due_at']:
            raise Refused(f"milestone {m['id']}'s review window is still open")
        m.update(status='paid', paid_by=by, log_index=None, evidence=h)
        self.paid += m['amount']
        self.evidence[h] = ('milestone', m['id'])
        return {'mid': m['id'], 'paid': m['amount'], 'by': by}

    def on_accept(self, ev, i, h):
        self._signed(ev, ev['mid'])
        r = self._pay_milestone(ev, h, 'client')
        self._milestone(ev['mid'])['log_index'] = i
        return r

    def on_silence(self, ev, i, h):
        r = self._pay_milestone(ev, h, 'silence')
        self._milestone(ev['mid'])['log_index'] = i
        return r

    def on_tick(self, ev, i, h):
        if self.due(ev['at']):
            raise Refused('milestones are due: pay them (silence lines)')
        return {'paid': []}

    def on_stop(self, ev, i, h):
        self._need('ACTIVE')
        self.status, self.stopped = 'STOPPED', 1
        return {'status': 'STOPPED'}

    def open_reservations(self):
        return self.reserved + sum(m['amount'] for m in self.milestones if m['status'] in ('in_review', 'disputed'))

    def on_close(self, ev, i, h):
        self._need('ACTIVE', 'STOPPED')
        refund = self.deposited - self.paid - self.open_reservations()
        if ev['refund'] != refund:
            raise Refused(f'the refund is {refund}')
        self.status, self.refunded = 'CLOSED', refund
        self.owed = {'decisions': [d['seq'] for d in self.decisions if d['status'] in ('reserved', 'approved')],
                     'milestones': [m['id'] for m in self.milestones if m['status'] in ('in_review', 'disputed')]}
        return {'refund': refund, 'owed': copy.deepcopy(self.owed)}

    def on_tx(self, ev, i, h):
        t = {'kind': ev['kind'], 'ref': ev['ref'], 'chain': ev['chain'], 'tx': ev['tx'], 'ok': ev['ok'],
             'error': ev['error'], 'log_index': i}
        self.txs.append(t)
        kind, key = self.evidence.get(ev['ref'], (None, None))
        target = self.decisions[key - 1] if kind == 'decision' else self._milestone(key) if kind == 'milestone' else None
        if target is not None:
            target['txs'][ev['kind']] = {'tx': ev['tx'], 'ok': ev['ok'], 'error': ev['error']}

    # -- what is read
    def view(self):
        budget = int(self.mandate.budget) if self.doc else 0
        held = self.open_reservations()
        return {'project_id': self.project_id, 'chain': self.chain, 'status': self.status,
                'version': self.doc['version'] if self.doc else None, 'policy_hash': self.policy_hash,
                'mandate_hash': self.doc['expense']['mandate_hash'] if self.doc else None,
                'signed': {p: pol.verify(p, self.policy_hash, self.signatures.get(p)) if self.policy_hash else False
                           for p in pol.SIGNERS},
                'required': pol.required_deposit(self.doc) if self.doc else None, 'deposited': self.deposited,
                'reserved': held, 'paid': self.paid, 'refunded': self.refunded,
                'available': self.deposited - self.paid - held - self.refunded,
                'expense': {'budget': budget, 'spent': self.spent, 'reserved': self.reserved,
                            'remaining': budget - self.spent - self.reserved, 'approved': self.approved},
                'stopped': bool(self.stopped), 'at': self.at, 'owed': copy.deepcopy(self.owed),
                'decisions': copy.deepcopy(self.decisions), 'milestones': copy.deepcopy(self.milestones),
                'txs': copy.deepcopy(self.txs)}


# -- the log

def read_log(workdir):
    path = Path(workdir) / 'log.jsonl'
    if not path.exists():
        return []
    return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines() if s.strip()]


def verify_chain(entries):
    """(True, None), or (False, the first index whose head or number is wrong)."""
    head = GENESIS
    for n, e in enumerate(entries):
        head = chain_step(head, e.get('line', ''))
        if e.get('i') != n or e.get('head') != head:
            return False, n
    return True, None


def fold(entries):
    book = Book()
    for e in entries:
        book.apply(json.loads(e['line']), e['i'], e['head'])
    return book


def replay(workdir):
    """The state from the log alone: {'state', 'state_hash', 'log_head', 'lines', 'log_chain_ok'}."""
    entries = read_log(workdir)
    state = fold(entries).view()
    return {'state': state, 'state_hash': state_hash(state), 'log_head': entries[-1]['head'] if entries else GENESIS,
            'lines': len(entries), 'log_chain_ok': verify_chain(entries)[0]}


class Project:
    def __init__(self, workdir, chain=None, project_id=None):
        """Opens (replays) or starts the project in workdir. chain: an adapter (SimEscrow, MonadEscrow) or None."""
        self.dir = Path(workdir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.log_path, self.chain = self.dir / 'log.jsonl', chain
        entries = read_log(self.dir)
        ok, bad = verify_chain(entries)
        if not ok:
            raise ValueError(f'{self.log_path}: the hash chain breaks at line {bad}')
        self.book, self.n = fold(entries), len(entries)
        self.head = entries[-1]['head'] if entries else GENESIS
        if not entries:
            self._append({'op': 'open', 'at': None, 'project_id': project_id or '0x' + os.urandom(32).hex(),
                          'chain': chain.name if chain else None})
        self.project_id = self.book.project_id

    # -- writing
    def _append(self, ev):
        line = canonical(ev)
        head = chain_step(self.head, line)
        book = copy.deepcopy(self.book)
        answer = book.apply(json.loads(line), self.n, head)
        with open(self.log_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'i': self.n, 'line': line, 'head': head}, ensure_ascii=False) + '\n')
            f.flush()
            os.fsync(f.fileno())
        self.book, self.head, self.n = book, head, self.n + 1
        return {'log_index': self.n - 1, 'log_head': head, **answer}

    def _tx(self, out, at, kind, ref, call, *args):
        """Send one chain call (if there is a chain) and log its result as its own line."""
        if self.chain is None:
            return out
        r = call(*args)
        self._append({'op': 'tx', 'at': at, 'kind': kind, 'ref': ref, 'chain': self.chain.name, 'tx': r['tx'],
                      'ok': r['ok'], 'error': r['error']})
        out.setdefault('chain', {})[kind] = r
        return out

    def address_of(self, who):
        return self.chain.address_of(who) if self.chain else payee_address(who)

    def _activated(self, out, at):
        if out.get('activated') and self.chain:
            self._tx(out, at, 'create', None, self.chain.create_project, self.project_id, self.book.policy_hash,
                     self.book.deposited)
            self._tx(out, at, 'deposit', None, self.chain.deposit, self.project_id)
        return out

    # -- calls (each: the scenario time at_ms; returns a dict with log_index and log_head)
    def propose_policy(self, doc, at_ms, reading=None):
        """reading: how the mandate was read (the AI readings, which one the person chose); logged, not hashed."""
        ev = {'op': 'policy', 'at': at_ms, 'doc': doc, 'policy_hash': pol.policy_hash(doc)}
        return self._append({**ev, 'reading': reading} if reading is not None else ev)

    def sign(self, party, signature, at_ms):
        out = self._append({'op': 'sign', 'at': at_ms, 'party': party, 'policy_hash': self.book.policy_hash,
                            'signature': signature})
        return self._activated(out, at_ms)

    def deposit(self, amount, at_ms):
        return self._activated(self._append({'op': 'deposit', 'at': at_ms, 'amount': amount}), at_ms)

    def request_expense(self, proposal, source, at_ms, unreadable=False):
        """proposal {merchant, category, item, amount, fee, units} (category is set from the registry,
        category_of; a whole-valued float amount / fee is logged as an int, any other non-integer is Refused);
        source {digest, summary, ...}. unreadable: the AI reading could not be trusted -> HOLD."""
        p = dict(proposal) if isinstance(proposal, dict) else proposal
        if isinstance(p, dict):
            if isinstance(p.get('merchant'), str):
                p['category'] = category_of(p['merchant'])
            for k in ('amount', 'fee'):
                if isinstance(p.get(k), float) and p[k].is_integer():
                    p[k] = int(p[k])
        if self.book.status not in ('ACTIVE', 'STOPPED'):
            raise Refused(f'project is {self.book.status}')
        verdict, reason = self.book.judge(p, at_ms, unreadable)
        out = self._append({'op': 'request', 'at': at_ms, 'proposal': p, 'source': source, 'unreadable': bool(unreadable),
                            'decision': {'verdict': verdict, 'reason': reason}})
        ev = out['evidence_hash'] = '0x' + out['log_head']
        payee = self.address_of(p['merchant']) if p.get('merchant') else None  # bound on chain; a BLOCK names whom it refused
        return self._tx(out, at_ms, 'decision', ev, self.chain and self.chain.record_decision, self.project_id, ev,
                        self.book.policy_hash, int(round(out['total'])), CODES[verdict], payee)

    def request_ai_failed(self, source, at_ms, proposal=None):
        """The AI reading failed (unparseable, the two readings disagree): recorded as HOLD 'unreadable'."""
        return self.request_expense(proposal if proposal is not None else {}, source, at_ms, unreadable=True)

    def _sign(self, party, op, ref, at, keys):
        """party's signature over act(project_id, op, ref, at); keys {party: key}, default policy.DEMO_KEYS."""
        return pol.sign_act(party, self.book.project_id, op, ref, at, (keys or pol.DEMO_KEYS)[party])

    def hold(self, seq, approve, at_ms, keys=None):
        """The client answers a HOLD (signed by the client)."""
        approve = bool(approve)
        sig = self._sign('client', 'hold:approve' if approve else 'hold:reject', seq, at_ms, keys)
        out = self._append({'op': 'hold', 'at': at_ms, 'seq': seq, 'approve': approve, 'signature': sig})
        ev = self.book.decisions[seq - 1]['evidence']
        return self._tx(out, at_ms, 'hold', ev, self.chain and (self.chain.approve_hold if approve else self.chain.reject_hold),
                        self.project_id, ev)

    def settle(self, seq, at_ms):
        out = self._append({'op': 'settle', 'at': at_ms, 'seq': seq})
        d = self.book.decisions[seq - 1]
        out['payee'] = self.address_of(d['vendor'])
        return self._tx(out, at_ms, 'release', d['evidence'], self.chain and self.chain.release, self.project_id,
                        d['evidence'], out['payee'], int(round(d['total'])))

    def submit_milestone(self, mid, at_ms, keys=None):
        """The contractor submits a milestone for review (signed by the contractor)."""
        return self._append({'op': 'submit', 'at': at_ms, 'mid': mid,
                             'signature': self._sign('contractor', 'submit', mid, at_ms, keys)})

    def object_milestone(self, mid, why, at_ms, keys=None):
        """The client objects within the review window (signed by the client)."""
        return self._append({'op': 'object', 'at': at_ms, 'mid': mid, 'why': why,
                             'signature': self._sign('client', 'object', mid, at_ms, keys)})

    def _milestone_paid(self, out, at):
        m = next(m for m in self.book.milestones if m['id'] == out['mid'])
        out['payee'], out['evidence_hash'] = self.address_of('contractor'), m['evidence']
        if self.chain:
            self._tx(out, at, 'decision', m['evidence'], self.chain.record_decision, self.project_id, m['evidence'],
                     self.book.policy_hash, m['amount'], APPROVE, out['payee'])
            self._tx(out, at, 'release', m['evidence'], self.chain.release, self.project_id, m['evidence'], out['payee'],
                     m['amount'])
        return out

    def accept_milestone(self, mid, at_ms, keys=None):
        """The client accepts a milestone in review (signed by the client): it is paid."""
        return self._milestone_paid(self._append({'op': 'accept', 'at': at_ms, 'mid': mid,
                                                  'signature': self._sign('client', 'accept', mid, at_ms, keys)}), at_ms)

    def tick(self, at_ms):
        """Anyone: pays every milestone whose review deadline passed with no objection. {'paid': [...], ...}"""
        due = self.book.due(at_ms)
        if not due:
            return self._append({'op': 'tick', 'at': at_ms})
        outs = [self._milestone_paid(self._append({'op': 'silence', 'at': at_ms, 'mid': mid}), at_ms) for mid in due]
        return {**outs[-1], 'paid': due, 'lines': outs}

    def stop(self, at_ms, why=''):
        out = self._append({'op': 'stop', 'at': at_ms, 'why': why})
        return self._tx(out, at_ms, 'stop', None, self.chain and self.chain.stop_project, self.project_id)

    def close(self, at_ms):
        """Refund = deposited - paid - open reservations; off chain (the legacy contract has no withdraw)."""
        return self._append({'op': 'close', 'at': at_ms, 'refund': self.book.deposited - self.book.paid
                             - self.book.open_reservations(), 'onchain': 'none: ExpenseEscrow has no withdraw'})

    # -- reading
    def state(self):
        return self.book.view()

    def state_hash(self):
        return state_hash(self.state())

    def receipt(self, seq):
        """What was decided and paid for decision seq (int) or milestone id (str), and where it is recorded."""
        b = self.book
        if isinstance(seq, str):
            m = b._milestone(seq)
            vendor, total, verdict, reason = 'contractor', m['amount'], 'APPROVE', f"milestone {m['status']}" + (
                f" by {m['paid_by']}" if m['paid_by'] else '')
            status, index, evidence, txs = m['status'], m['log_index'], m['evidence'], m['txs']
        else:
            d = b._decision(seq)
            vendor, total, verdict, reason = d['vendor'], d['total'], d['verdict'], d['reason']
            status, index, evidence, txs = d['status'], d['log_index'], d['evidence'], d['txs']
        tx = {k: (txs.get(k) or {}).get('tx') for k in ('decision', 'release')}
        return {'project_id': self.project_id, 'policy_hash': b.policy_hash, 'mandate_hash': b.doc['expense']['mandate_hash'],
                'ref': seq, 'vendor': vendor,
                'vendor_name': domain().name_of(vendor) if vendor in domain().by_id else vendor,
                'payee': self.address_of(vendor) if vendor else None, 'total': total, 'verdict': verdict, 'reason': reason,
                'status': status, 'log_index': index, 'log_head': evidence and evidence[2:], 'evidence_hash': evidence,
                'decision_tx': tx['decision'],
                'payment_tx': tx['release'], 'chain': self.chain.name if self.chain else None,
                'explorer': {k: self.chain.explorer(v) for k, v in tx.items() if v} if self.chain else {}}

    def audit(self, chain=None):
        return audit(self.dir, chain or self.chain, self.state_hash())


# -- the audit: log + policy (in the log) + chain events, nothing else

def audit(workdir, chain=None, live_state_hash=None):
    """{log_chain_ok, bad_line, replay_error, replay_state_hash, live_state_hash, match, onchain [...], missing [...],
    all_ok}. A log that stops folding (a line the rules refuse) is replayed up to that line.
    onchain: per chain event, whether a log line backs it (evidence hash == that line's head, policy hash,
    amount, decision, and for PaymentReleased the payee == address_of(the logged vendor)); missing: logged
    successful txs or paid decisions the chain does not show."""
    entries = read_log(workdir)
    chain_ok, bad = verify_chain(entries)
    book, error = Book(), None
    for e in entries:  # as far as the log folds; the chain events are still checked against it
        try:
            book.apply(json.loads(e['line']), e['i'], e['head'])
        except (Refused, KeyError, TypeError, ValueError) as err:
            error = f"line {e.get('i')}: {type(err).__name__}: {err}"
            break
    replay_hash = None if error else state_hash(book.view())
    out = {'log_chain_ok': chain_ok, 'bad_line': bad, 'replay_error': error, 'replay_state_hash': replay_hash,
           'live_state_hash': live_state_hash,
           'match': replay_hash is not None and (live_state_hash is None or live_state_hash == replay_hash),
           'onchain': [], 'missing': []}
    if chain is not None and book.project_id:
        heads = {'0x' + e['head']: e['i'] for e in entries}
        events = chain.events(book.project_id)
        logged_tx = {t['tx'] for t in book.txs if t['ok']}
        out['onchain'] = [check_event(e, book, heads, logged_tx, chain.address_of) for e in events]
        seen = {e['tx'] for e in events}
        released = {e['args'].get('evidenceHash') for e in events if e['event'] == 'PaymentReleased'}
        out['missing'] += [f'logged tx {t} ({t_kind}) is not on chain' for t, t_kind in
                           ((t['tx'], t['kind']) for t in book.txs if t['ok']) if t not in seen]
        paid = [d['evidence'] for d in book.decisions if d['status'] == 'paid'] + [
            m['evidence'] for m in book.milestones if m['status'] == 'paid']
        out['missing'] += [f'paid {ev} has no PaymentReleased' for ev in paid if ev not in released]
    out['all_ok'] = (chain_ok and error is None and out['match'] and all(c['ok'] for c in out['onchain']) and not out['missing'])
    return out


def check_event(e, book, heads, logged_tx, address_of):
    a, name = e['args'], e['event']
    r = {'event': name, 'tx': e['tx'], 'block': e.get('block'), 'log_index': None, 'ok': False, 'why': ''}

    def fail(why):
        r['why'] = why
        return r

    if e['tx'] not in logged_tx:
        return fail('no log line records this tx')
    if name == 'ProjectCreated':
        if a.get('policyHash') != book.policy_hash or a.get('budget') != book.deposited:
            return fail('policy hash or budget differs from the log')
    elif name == 'Deposited':
        if a.get('amount') != book.deposited:
            return fail('amount differs from the logged deposit')
    elif name == 'ProjectStopped':
        if not book.stopped:
            return fail('the log has no stop')
    elif name in ('DecisionRecorded', 'PaymentReleased', 'HoldApproved', 'HoldRejected'):
        ev = a.get('evidenceHash')
        if ev not in heads:
            return fail('no log line has this evidence hash as its head')
        r['log_index'] = heads[ev]
        kind, key = book.evidence.get(ev, (None, None))
        if kind is None:
            return fail('the evidence line is not a decision or a milestone payment')
        if kind == 'decision':
            d = book.decisions[key - 1]
            vendor, total, code, status = d['vendor'], d['total'], d['code'], d['status']
        else:
            m = next(m for m in book.milestones if m['id'] == key)
            vendor, total, code, status = 'contractor', m['amount'], APPROVE, m['status']
        if name == 'DecisionRecorded' and (a.get('policyHash') != book.policy_hash or a.get('amount') != int(round(total))
                                           or a.get('decision') != code):
            return fail('policy hash, amount or decision differs from the log')
        if name == 'DecisionRecorded' and 'payee' in a and str(a['payee']).lower() != (
                address_of(vendor) if vendor else '0x' + '0' * 40).lower():
            return fail(f'recorded payee is not address_of({vendor})')
        if name == 'PaymentReleased':
            if status != 'paid' or a.get('amount') != int(round(total)):
                return fail('the log has no payment of this amount for this evidence')
            if str(a.get('payee', '')).lower() != address_of(vendor).lower():
                return fail(f'payee is not address_of({vendor})')
        if name == 'HoldApproved' and (code != HOLD or status not in ('approved', 'paid')):
            return fail('the log has no approved HOLD here')
        if name == 'HoldRejected' and (code != HOLD or status != 'rejected'):
            return fail('the log has no rejected HOLD here')
    else:
        return fail('unknown event')
    r['ok'] = True
    return r
