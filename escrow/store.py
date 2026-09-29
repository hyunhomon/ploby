"""Where projects live: <root>/projects/<id>/log.jsonl (one line per change), <root>/docs/<sha256>.json (the
evidence text, off chain and out of the log: the log keeps its hash), <root>/clock.json (the demo clock's
offset). Loading a project replays its log; nothing else is stored.

An action goes: the keeper applies elapsed deadlines -> the inputs are prepared outside the lock (the model's
reading of a document, a change-order draft) -> the line is signed by the acting role's demo key, applied to a
copy of the state, and only then appended. A refused line changes nothing.
"""
import copy
import hashlib
import json
import os
import threading
import time
from pathlib import Path

from . import ai, policy as pol
from .core import Refused, raw
from .engine import Project

ACTIONS = {'sign_policy', 'deposit', 'cancel_project', 'pause', 'resume', 'begin_close', 'withdraw',
           'start_milestone', 'cancel_milestone', 'submit_delivery', 'review_delivery', 'resolve_milestone',
           'request_commitment', 'retroactive_request', 'answer_request', 'cancel_reservation', 'report_spend',
           'submit_receipt', 'supplement_evidence', 'review_settlement', 'escalate_settlement', 'resolve_expense',
           'draft_change_order', 'edit_change_order', 'propose_change_order', 'withdraw_change_order', 'run_timeouts'}
READS = {'request_commitment', 'retroactive_request', 'submit_receipt', 'supplement_evidence'}


class Store:
    def __init__(self, root, reader=None, drafter=None, compiler=None):
        self.root = Path(root)
        (self.root / 'projects').mkdir(parents=True, exist_ok=True)
        (self.root / 'docs').mkdir(parents=True, exist_ok=True)
        self.reader = reader or ai.reading
        self.drafter = drafter or ai.draft_change
        self.compiler = compiler or ai.compile_policy
        self.lock = threading.RLock()
        self.candidates = {}
        clock = self.root / 'clock.json'
        self.offset = json.loads(clock.read_text())['offset'] if clock.exists() else 0
        self.projects = {}
        for d in sorted((self.root / 'projects').iterdir()):
            if (d / 'log.jsonl').exists():
                self.projects[d.name] = self.replay(d.name)

    # -- clock
    def now(self):
        return int(time.time() * 1000) + self.offset

    def advance(self, seconds=None, reset=False):
        with self.lock:
            self.offset = 0 if reset else self.offset + int(seconds) * 1000
            (self.root / 'clock.json').write_text(json.dumps({'offset': self.offset}))
            self.keeper()
            return {'now': self.now(), 'offset': self.offset}

    # -- the log
    def path(self, pid):
        return self.root / 'projects' / pid / 'log.jsonl'

    def replay(self, pid):
        """Rebuild a project from its log alone (the auditor's path): every line applied again, heads recomputed."""
        P = Project(pid)
        for n, text in enumerate(self.path(pid).read_text().splitlines()):
            P.apply(json.loads(text))
        return P

    def commit(self, P, line):
        """Apply line to a copy; append it only if it applies. Returns the new state and the log sentence."""
        Q = copy.deepcopy(P)
        text = Q.apply(line)
        path = self.path(P.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a') as f:
            f.write(raw(line) + '\n')
            f.flush()
            os.fsync(f.fileno())
        self.projects[P.id] = Q
        return Q, text

    @staticmethod
    def line(by, op, params, inputs, at):
        line = {'op': op, 'at': at, 'by': by, 'params': params, 'inputs': inputs}
        if by in pol.ROLES:
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
        sha = hashlib.sha256(text.encode()).hexdigest()
        path = self.root / 'docs' / f'{sha}.json'
        if not path.exists():
            path.write_text(json.dumps({'id': sha, 'name': str(name or '문서')[:120], 'text': text}, ensure_ascii=False))
        return {'id': sha, 'name': json.loads(path.read_text())['name']}

    def doc_text(self, doc_id):
        path = self.root / 'docs' / f'{str(doc_id)}.json'
        if not str(doc_id).isalnum() or not path.exists():
            raise Refused('등록되지 않은 문서입니다 (먼저 업로드)', 'invalid')
        return json.loads(path.read_text())

    def manifest(self, pid, kind, docs, by, at, note=''):
        """The evidence manifest (ADR 0003): canonical list of the submitted files; its hash goes into the line."""
        m = {'schemaVersion': 'ploby.manifest/1', 'projectId': pid, 'kind': kind, 'submittedBy': pol.parties()[by]['address'],
             'submittedAt': at, 'files': [{'fileId': d['id'], 'sha256': d['id'], 'mediaType': 'text/plain',
                                           'sizeBytes': len(self.doc_text(d['id'])['text'].encode()),
                                           'claimedAssuranceLevel': 'E1'} for d in docs],
             'requestTextSha256': hashlib.sha256(str(note).encode()).hexdigest()}
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
            return self.get(pid).view(role, self.now())

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
        cid = 'c' + hashlib.sha256(f'{words}:{now}'.encode()).hexdigest()[:10]
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
                                       .encode()).hexdigest()[:12]
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
            now = self.now()
            if action == 'sign_policy':
                inputs['signature'] = pol.sign(role, P.version(params.get('version'))['hash'])
            if 'manifest_docs' in inputs:
                inputs['manifest'] = self.manifest(pid, action, inputs.pop('manifest_docs'), role, now, params.get('note', ''))
            P, text = self.commit(P, self.line(role, action, clean(params), inputs, now))
            return text, P.view(role, now)

    def prepare(self, pid, role, action, params, context):
        """The inputs a line carries: what came from outside the rules, fixed before the rules run."""
        if action in READS:
            doc_id = params.get('document')
            d = self.doc_text(doc_id)
            reading = self.reader(d['text'])
            out = {'reading': reading, 'document': {'id': d['id'], 'name': d['name']}, 'manifest_docs': [d]}
            if params.get('manual'):
                out['manual'] = params['manual']
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
    return {k: v for k, v in (params or {}).items() if k not in ('as', 'action')}
