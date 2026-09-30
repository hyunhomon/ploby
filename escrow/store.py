"""Where projects live: <root>/projects/<id>/log.jsonl (one line per change), <root>/docs/<sha256>.json (the
evidence text, off chain and out of the log: the log keeps its hash), <root>/clock.json (the demo clock's
offset). Loading a project replays its log; nothing else is stored.

An action goes: the keeper applies elapsed deadlines -> the inputs are prepared outside the lock (the model's
reading of a document, a change-order draft, the escrow contract's state) -> the line is signed by the acting
role's demo key, applied to a copy of the state, and only then appended. A refused line changes nothing.

With a rail (escrow/chain.py), every appended line's money change becomes contract calls, sent in order by one
worker; each result comes back as a relayer-signed 'chain' line. On start, calls the log implies but has no
result for are sent again (the contract refuses a call applied twice).
"""
import copy
import hashlib
import json
import os
import threading
import time
from pathlib import Path

from . import agent, ai, chain, policy as pol
from .core import Refused, raw
from .engine import Project

ACTIONS = {'sign_policy', 'deposit', 'cancel_project', 'pause', 'resume', 'begin_close', 'withdraw',
           'start_milestone', 'cancel_milestone', 'submit_delivery', 'review_delivery', 'resolve_milestone',
           'request_commitment', 'retroactive_request', 'answer_request', 'cancel_reservation', 'report_spend',
           'submit_receipt', 'supplement_evidence', 'review_settlement', 'escalate_settlement', 'resolve_expense',
           'draft_change_order', 'edit_change_order', 'propose_change_order', 'withdraw_change_order', 'run_timeouts'}
READS = {'request_commitment', 'retroactive_request', 'submit_receipt', 'supplement_evidence'}


def _read_json(path):
    """Read one of Ploby's persisted JSON files with a platform-independent encoding."""
    return json.loads(path.read_text(encoding='utf-8'))


def _write_json(path, value):
    """Write compact UTF-8 JSON; callers decide when an fsync is required."""
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


class Store:
    def __init__(self, root, reader=None, drafter=None, compiler=None, rail=None, planner=None):
        self.root = Path(root)
        (self.root / 'projects').mkdir(parents=True, exist_ok=True)
        (self.root / 'docs').mkdir(parents=True, exist_ok=True)
        self.reader = reader or ai.reading
        self.drafter = drafter or ai.draft_change
        self.compiler = compiler or ai.compile_policy
        self.planner = planner or agent.plan
        self.lock = threading.RLock()
        self.candidates = {}
        clock = self.root / 'clock.json'
        self.offset = _read_json(clock)['offset'] if clock.exists() else 0
        self.projects = {}
        for d in sorted((self.root / 'projects').iterdir()):
            if (d / 'log.jsonl').exists():
                self.projects[d.name] = self.replay(d.name)
        self.rail, self.worker = None, None
        if rail:
            self.start_chain(rail)

    def start_chain(self, rail):
        """Mirror every project on chain from now on, first sending what the logs imply but never got a result."""
        self.rail, self.worker = rail, chain.Worker(rail, self.chain_result)
        for pid in self.projects:
            self.worker.submit(self.unsent(pid))
        self.worker.start()

    # -- clock
    def now(self):
        return int(time.time() * 1000) + self.offset

    def advance(self, seconds=None, reset=False):
        with self.lock:
            self.offset = 0 if reset else self.offset + int(seconds) * 1000
            _write_json(self.root / 'clock.json', {'offset': self.offset})
            self.keeper()
            return {'now': self.now(), 'offset': self.offset}

    # -- the log
    def path(self, pid):
        return self.root / 'projects' / pid / 'log.jsonl'

    def replay(self, pid):
        """Rebuild a project from its log alone (the auditor's path): every line applied again, heads recomputed."""
        P = Project(pid)
        for text in self.path(pid).read_text(encoding='utf-8').splitlines():
            P.apply(json.loads(text))
        return P

    def commit(self, P, line):
        """Apply line to a copy; append it only if it applies. Returns the new state and the log sentence."""
        Q = copy.deepcopy(P)
        text = Q.apply(line)
        path = self.path(P.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8', newline='\n') as f:
            f.write(raw(line) + '\n')
            f.flush()
            os.fsync(f.fileno())
        self.projects[P.id] = Q
        if self.worker and line['op'] != 'chain':
            self.worker.submit(chain.calls(P.id, len(Q.log) - 1, Q.head, chain.money(P), chain.money(Q), Q))
        return Q, text

    # -- the chain
    def lines(self, pid):
        return [json.loads(t) for t in self.path(pid).read_text(encoding='utf-8').splitlines()]

    def unsent(self, pid):
        """The calls the log implies that have no result in it yet."""
        _, todo, done = chain.plan(pid, self.lines(pid), Project)
        return [c for c in todo if (c['line'], c['n']) not in done]

    def chain_result(self, c, r):
        params = {'line': c['line'], 'n': c['n'], 'call': c['call'], 'args': c['args'], 'tx': r.get('tx'),
                  'url': self.rail.tx_url(r.get('tx')), 'ok': bool(r['ok']), 'error': r['error'], 'block': r.get('block')}
        with self.lock:
            self.keeper(c['pid'])  # elapsed deadlines first, at their own times, so a late result never delays one
            P = self.get(c['pid'])
            self.commit(P, self.line('relayer', 'chain', params, {}, max(self.now(), P.at)))

    def onchain(self, pid):
        """What the contract says before a request is decided: its pause flag and available balance. Read only when
        no call of this project is still on its way (otherwise the engine's own state is the newer one)."""
        if not self.rail:
            return None
        with self.lock:
            head = self.get(pid).head
        waiting = len(self.worker.pending(pid))
        if waiting:
            return {'skipped': f'{waiting} calls pending'}
        try:
            p = self.rail.project(pid)
        except (RuntimeError, OSError, ValueError):
            return {'skipped': 'chain unreachable'}
        if p is None:
            return {'skipped': 'not opened'}
        return {'paused': p['paused'], 'available': p['available'], 'contract': self.rail.escrow, 'head': head}

    def chain_status(self, pid):
        if not self.rail:
            return {'enabled': False}
        P = self.get(pid)
        return {'enabled': True, 'network': 'Monad testnet', 'chain_id': self.rail.chain_id,
                'contract': self.rail.escrow, 'contract_url': self.rail.address_url(self.rail.escrow),
                'token': self.rail.token, 'pending': len(self.worker.pending(pid)),
                'sent': sum(1 for r in P.chain if r['tx']), 'refused': sum(1 for r in P.chain if not r['ok'])}

    def onchain_state(self, pid):
        """The contract's view of the project next to the engine's ledger (for the screen and the auditor)."""
        with self.lock:
            P = self.get(pid)
            ledger, status = P.ledger(), self.chain_status(pid)
        if not self.rail:
            return {'chain': status}
        p = self.rail.project(pid)
        mirror = {'funded': ledger['funded'], 'reserved': ledger['expense_reserved'] + ledger['milestone_reserved'],
                  'paid': ledger['released'], 'refunded': ledger['refunded'], 'available': ledger['available']}
        return {'chain': status, 'onchain': p, 'engine': mirror,
                'match': bool(p) and all(p[k] == v for k, v in mirror.items()) and not status['pending']}

    @staticmethod
    def line(by, op, params, inputs, at):
        line = {'op': op, 'at': at, 'by': by, 'params': params, 'inputs': inputs}
        if by in pol.SIGNED:
            line['sig'] = pol.sign(by, raw(line))
        return line

    def keeper(self, pid=None):
        """Apply every elapsed deadline, earliest first, each at its own time (permissionless)."""
        now = self.now()
        for P in [self.projects[pid]] if pid else list(self.projects.values()):
            while True:
                P = self.projects[P.id]
                due = P.due(now)
                if not due:
                    break
                at, target, kind, ref = due
                self.commit(P, self.line('keeper', 'timeout', {'deadline': at, 'target': target, 'kind': kind, 'ref': ref},
                                         {}, max(at, P.at)))

    # -- documents (the evidence store; the log keeps only their hashes)
    def document(self, name, text):
        text = str(text or '')
        if not text.strip():
            raise Refused('빈 문서입니다', 'invalid')
        if len(text) > 200_000:
            raise Refused('문서가 너무 깁니다 (텍스트 200KB 이내)', 'invalid')
        sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
        path = self.root / 'docs' / f'{sha}.json'
        if not path.exists():
            _write_json(path, {'id': sha, 'name': str(name or '문서')[:120], 'text': text})
        document = _read_json(path)
        return {'id': sha, 'name': document['name']}

    def doc_text(self, doc_id):
        path = self.root / 'docs' / f'{str(doc_id)}.json'
        if not str(doc_id).isalnum() or not path.exists():
            raise Refused('등록되지 않은 문서입니다 (먼저 업로드)', 'invalid')
        return _read_json(path)

    def manifest(self, pid, kind, docs, by, at, note=''):
        """The evidence manifest (ADR 0003): canonical list of the submitted files; its hash goes into the line."""
        m = {'schemaVersion': 'ploby.manifest/1', 'projectId': pid, 'kind': kind, 'submittedBy': pol.parties()[by]['address'],
             'submittedAt': at, 'files': [{'fileId': d['id'], 'sha256': d['id'], 'mediaType': 'text/plain',
                                           'sizeBytes': len(self.doc_text(d['id'])['text'].encode('utf-8')),
                                           'claimedAssuranceLevel': 'E1'} for d in docs],
             'requestTextSha256': hashlib.sha256(str(note).encode('utf-8')).hexdigest()}
        return '0x' + hashlib.sha256(pol.canonical(m)).hexdigest()

    # -- reads
    def get(self, pid):
        P = self.projects.get(pid)
        if P is None:
            raise Refused('프로젝트가 없습니다', 'invalid')
        return P

    def view(self, pid, role):
        with self.lock:
            self.keeper(pid)
            return {**self.get(pid).view(role, self.now()), 'chain': self.chain_status(pid)}

    def listing(self, role):
        with self.lock:
            self.keeper()
            return [P.summary(role, self.now()) for P in sorted(self.projects.values(), key=lambda P: -(P.created_at or 0))]

    # -- the expense rules from words (the model reads twice; the client picks a readback)
    def compile_rules(self, words):
        words = str(words or '').strip()
        if not words:
            raise Refused('규칙을 문장으로 적어 주세요', 'invalid')
        if not ai.enabled():
            raise Refused('Kiln 키가 없어 문장 규칙을 읽을 수 없습니다 — 양식으로 작성하세요', 'state')
        now = self.now()
        try:
            c = self.compiler(words, now)
        except (Exception, SystemExit) as e:
            raise Refused(f'판독 서비스 오류 ({type(e).__name__}) — 양식으로 작성하세요', 'state') from None
        cid = 'c' + hashlib.sha256(f'{words}:{now}'.encode('utf-8')).hexdigest()[:10]
        self.candidates[cid] = {'words': words, 'now': now - now % 60000, 'options': c['options']}
        return {'candidate': cid, 'agree': c['agree'], 'same': c['same'], 'problems': c['problems'],
                'differences': c['differences'], 'contrast': c['contrast'],
                'options': [{k: o[k] for k in ('source', 'ok', 'hash', 'readback', 'expressions', 'problems', 'error')}
                            for o in c['options']],
                'usage': ai.usage_of(c['calls'])}

    # -- writes
    def create(self, role, spec):
        if role != 'client':
            raise Refused('프로젝트는 클라이언트가 만듭니다', 'forbidden')
        with self.lock:
            now = self.now()
            pid = 'p' + hashlib.sha256(f"{pol.address('client')}:{pol.address('contractor')}:{now}:{len(self.projects)}"
                                       .encode('utf-8')).hexdigest()[:12]
            try:
                rules = spec.get('rules') or {}
                if rules.get('mode') == 'words':
                    c = self.candidates.get(rules.get('candidate'))
                    o = c and next((o for o in c['options'] if o['source'] == rules.get('pick') and o['ok']), None)
                    if not o:
                        raise Refused('고른 판독 결과가 없습니다 (다시 읽기)', 'invalid')
                    r = pol.rules_of(o['module'], 'words', c['words'], c['now'])
                else:
                    r = pol.rules_from_form(rules.get('form') or {}, now)
                ms = [pol.milestone(m, f'M{n}', now) for n, m in enumerate(spec.get('milestones') or [], 1)]
                if not ms:
                    raise Refused('마일스톤이 하나 이상 필요합니다', 'invalid')
                doc = pol.initial(pid, str(spec.get('name') or '').strip() or '새 프로젝트', r, ms, spec.get('periods'),
                                  spec.get('ends_at'), now, (rules.get('form') or {}).get('category_budgets')
                                  if rules.get('mode') != 'words' else spec.get('category_budgets'))
            except pol.PolicyError as e:
                raise Refused(str(e), 'invalid') from None
            P, _ = self.commit(Project(pid), self.line('client', 'create', {'doc': doc}, {}, now))
            return P.view(role, now)

    def act(self, pid, role, action, params):
        if role not in pol.ROLES:
            raise Refused('역할(as)이 필요합니다', 'forbidden')
        if action not in ACTIONS:
            raise Refused(f'알 수 없는 동작 {action}', 'invalid')
        with self.lock:
            self.keeper(pid)
            P = self.get(pid)
            if action == 'run_timeouts':
                return '경과한 기한을 모두 처리했습니다', P.view(role, self.now())
            context = {'name': P.name, 'milestones': [m['title'] for m in P.milestones.values()]}
        inputs = self.prepare(pid, role, action, params, context)  # may call the model: outside the lock
        with self.lock:
            self.keeper(pid)
            P = self.get(pid)
            now = max(self.now(), P.at)  # a demo clock set back never dates a line before the last one
            read = inputs.get('chain') or {}
            if 'head' in read and (read['head'] != P.head or self.worker.pending(pid)):
                inputs['chain'] = {'skipped': 'the project changed while the contract was read'}  # stale: engine only
            if action == 'sign_policy':
                inputs['signature'] = pol.sign(role, P.version(params.get('version'))['hash'])
            if 'manifest_docs' in inputs:
                inputs['manifest'] = self.manifest(pid, action, inputs.pop('manifest_docs'), role, now, params.get('note', ''))
            P, text = self.commit(P, self.line(role, action, clean(params), inputs, now))
            return text, {**P.view(role, now), 'chain': self.chain_status(pid)}

    def agent_run(self, pid, role, task, offer_ids):
        """The contractor's purchase agent (escrow/agent.py): plan once, then file the plan's first choices as
        requests; on a BLOCK try the need's next offer, on a HOLD wait, on a stopped project stop."""
        if role != 'contractor':
            raise Refused('구매 에이전트는 작업자가 맡깁니다', 'forbidden')
        task = str(task or '').strip()
        if not task:
            raise Refused('에이전트에게 맡길 일을 적어 주세요', 'invalid')
        ids = list(dict.fromkeys(offer_ids or []))
        if not ids or len(ids) > agent.MAX_OFFERS:
            raise Refused(f'견적(공급자 문서)을 1~{agent.MAX_OFFERS}개 고르세요', 'invalid')
        docs = [self.doc_text(x) for x in ids]
        with self.lock:
            self.keeper(pid)
            P = self.get(pid)
            P.state_is('ACTIVE', 'CLOSING')
            context = {'name': P.name, 'contractor': pol.NAMES['contractor']}
        found, meta = self.planner(task, [{'id': d['id'], 'name': d['name'], 'text': d['text']} for d in docs], context)
        if not found:
            raise Refused(f"에이전트가 계획을 세우지 못했습니다 ({'; '.join(meta.get('problems') or [])}) — 직접 요청하세요",
                          'state')
        with self.lock:
            self.keeper(pid)
            P = self.get(pid)
            offers = [{'id': d['id'], 'name': d['name']} for d in docs]
            P, _ = self.commit(P, self.line('contractor', 'agent_task', {'task': task, 'offers': offers},
                                            {'plan': found, 'ai': meta}, max(self.now(), P.at)))
            tid = P.agent_tasks[-1]['id']
        tried, stopped = [], None
        for need in found['needs']:
            for k, doc_id in enumerate(need['offers'], 1):
                via = {'task': tid, 'need': need['need'], 'why': need['why'], 'try': k}
                try:
                    self.act(pid, 'contractor', 'request_commitment', {'document': doc_id, 'via': via})
                except Refused as e:
                    tried.append({'need': need['need'], 'document': doc_id, 'refused': str(e)})
                    break
                e = next(e for e in reversed(list(self.get(pid).expenses.values())) if e.get('via') == via)
                d = e['decision'] or {}
                rule = d.get('reason') if d.get('result') == 'BLOCK' else None
                tried.append({'need': need['need'], 'document': doc_id, 'expense': e['id'], 'result': d.get('result'),
                              'rule': rule, 'status': e['status']})
                if rule == 'state':
                    stopped = '프로젝트가 멈춰 있어 에이전트가 중단했습니다'
                if d.get('result') != 'BLOCK' or stopped:
                    break
            if stopped:
                break
        with self.lock:
            view = {**self.get(pid).view(role, self.now()), 'chain': self.chain_status(pid)}
        return {'task': tid, 'plan': found, 'ai': meta, 'tried': tried, 'stopped': stopped}, view

    def prepare(self, pid, role, action, params, context):
        """The inputs a line carries: what came from outside the rules, fixed before the rules run."""
        if action in READS:
            doc_id = params.get('document')
            d = self.doc_text(doc_id)
            reading = self.reader(d['text'])
            out = {'reading': reading, 'document': {'id': d['id'], 'name': d['name']}, 'manifest_docs': [d]}
            if params.get('manual'):
                out['manual'] = params['manual']
            if action in ('request_commitment', 'retroactive_request') and self.rail:
                out['chain'] = self.onchain(pid)
            return out
        if action == 'submit_delivery':
            docs = [self.doc_text(x) for x in params.get('documents') or []]
            return {'documents': [{'id': d['id'], 'name': d['name']} for d in docs], 'manifest_docs': docs}
        if action == 'draft_change_order':
            text = str(params.get('text') or '').strip()
            if not text:
                raise Refused('범위 밖 요청 내용을 적어 주세요', 'invalid')
            if params.get('covers_excess'):  # an overage needs no drafting: the engine writes it from the expense
                return {'draft': {}, 'ai': {'ok': True, 'problems': [], 'usage': {}, 'model': None}}
            where = f"{context['name']} (현재 마일스톤: {', '.join(context['milestones']) or '없음'})"
            draft, meta = self.drafter(text, where, self.now())
            return {'draft': draft, 'ai': meta}
        return {}


def clean(params):
    """What of the request goes into the line: the params, never the acting role or bulky inputs."""
    return {k: v for k, v in (params or {}).items() if k not in ('as', 'action', 'lang')}
