"""The project policy: one document both parties accept, named by its hash.

    {version, project, parties {client, contractor, resolver},            addresses ('0x' + 40 hex)
     milestones [{id, title, amount, deliverables [], criteria [], review_days, silence: 'pay'}],
     expense {words, mandate, mandate_hash, readback [lines]},            mandate: a PCP module (lang.compile_fill)
     previous}                                                             the prior policy hash, or None

policy_hash(doc) = '0x' + sha256(canonical JSON: sort_keys, compact, ensure_ascii=False).
Acceptance is bilateral: client and contractor each sign the SAME policy hash. A signature here is
HMAC-SHA256(demo key, policy hash) — the stand-in for an EIP-712 wallet signature over the hash; the
demo keys are public and prove nothing outside the demo.

A party's action on a running project is signed the same way, over act(project_id, op, ref, at): the client
signs accept / object (ref: milestone id) and hold:approve / hold:reject (ref: decision seq), the contractor
signs submit (ref: milestone id). ACTORS names who signs each line; the project fold refuses a line without it.
"""
import hashlib
import hmac
import json

from .pcp_bridge import domain, lang, readback

SIGNERS = ('client', 'contractor')
ACTORS = {'submit': 'contractor', 'accept': 'client', 'object': 'client', 'hold': 'client'}
DEMO_KEYS = {p: f'smartescrow-demo-key:{p}'.encode() for p in ('client', 'contractor', 'resolver')}
DAY = 86400000

# The story: the client's words, and the mandate they compile to (hand-written, same fill the model is asked for).
WORDS = ('홈페이지 리뉴얼 경비는 AWS나 Vercel 호스팅, 가비아 도메인, Figma, Adobe Stock에서만 결제. '
         '총 50만원, 부가세 포함 한 건에 20만원 이하, 10월 31일까지.')
FILL = {'budget': '50만',
        'merchant_ok': 'm == "aws" || m == "vercel" || m == "gabia" || m == "figma" || m == "adobe-stock"',
        'category_ok': '1', 'window_ok': 'at <= day_end(2026, 10, 31)', 'order_ok': 'total <= 20만',
        'count_limit': '1000'}
ISSUED = int(lang.kst(2026, 10, 1, 10, 0))  # 2026-10-01 10:00 KST, the scenario's start
MILESTONES = [
    {'id': 'M1', 'title': '디자인 시안', 'amount': 1500000, 'deliverables': ['메인·서브 페이지 시안 (Figma)'],
     'criteria': ['시안 2종 제출', '의뢰인 피드백 1회 반영'], 'review_days': 3, 'silence': 'pay'},
    {'id': 'M2', 'title': '반응형 퍼블리싱', 'amount': 2500000, 'deliverables': ['반응형 웹사이트 배포'],
     'criteria': ['모바일·PC 레이아웃', '도메인 연결'], 'review_days': 3, 'silence': 'pay'},
]


def canonical(doc):
    return json.dumps(doc, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def policy_hash(doc):
    return '0x' + hashlib.sha256(canonical(doc)).hexdigest()


def readback_lines(module, now_ms):
    """What the mandate allows, in the sentences the client approves (found by asking it, not the model)."""
    return readback.text(readback.facts(lang.Mandate(module), domain(), now_ms), domain())


def make(project, parties, milestones, words, module, previous=None, version=1, now_ms=None):
    """A policy document. module: a compiled PCP mandate (its readback is computed here)."""
    return {'version': version, 'project': project, 'parties': dict(parties), 'milestones': [dict(m) for m in milestones],
            'expense': {'words': words, 'mandate': module, 'mandate_hash': lang.digest(module),
                        'readback': readback_lines(module, module.get('issued', 0) if now_ms is None else now_ms)},
            'previous': previous}


def demo(parties, fill=None):
    """The story's policy (cafe website renewal), with the given party addresses."""
    module = lang.compile_fill(fill or FILL, tz=lang.SEOUL, issued=ISSUED)
    return make('카페 홈페이지 리뉴얼', parties, MILESTONES, WORDS, module)


def problems(doc):
    """Why a document cannot be a policy ([] when it can)."""
    out = []
    for p in ('client', 'contractor', 'resolver'):
        a = doc.get('parties', {}).get(p)
        if not (isinstance(a, str) and a.startswith('0x') and len(a) == 42):
            out.append(f'parties.{p}: not an address')
    ids = [m.get('id') for m in doc.get('milestones', [])]
    if len(set(ids)) != len(ids):
        out.append('milestones: duplicate id')
    for m in doc.get('milestones', []):
        if not (isinstance(m.get('amount'), int) and m['amount'] > 0):
            out.append(f"milestone {m.get('id')}: amount must be a positive whole number")
        if m.get('silence') != 'pay' or not isinstance(m.get('review_days'), int) or m['review_days'] < 1:
            out.append(f"milestone {m.get('id')}: needs review_days >= 1 and silence 'pay'")
    e = doc.get('expense', {})
    try:
        if lang.digest(e['mandate']) != e.get('mandate_hash'):
            out.append('expense: mandate_hash is not the mandate\'s hash')
        lang.Mandate(e['mandate'])
    except (KeyError, TypeError, ValueError) as err:
        out.append(f'expense: not a mandate ({err})')
    return out


def milestone_total(doc):
    return sum(m['amount'] for m in doc['milestones'])


def expense_budget(doc):
    return int(lang.Mandate(doc['expense']['mandate']).budget)


def required_deposit(doc):
    """What the client must deposit before the project is active: every milestone plus the expense budget."""
    return milestone_total(doc) + expense_budget(doc)


def sign(party, h, key=None):
    """party's acceptance of policy hash h ('0x' + 64 hex)."""
    return '0x' + hmac.new(key or DEMO_KEYS[party], h.encode(), hashlib.sha256).hexdigest()


def verify(party, h, signature, key=None):
    return isinstance(signature, str) and hmac.compare_digest(sign(party, h, key), signature)


def act(project_id, op, ref, at):
    """The canonical string a party signs for one action: op submit / accept / object / hold:approve /
    hold:reject, ref the milestone id or decision seq, at the line's scenario time (ms)."""
    return canonical({'project_id': project_id, 'op': op, 'ref': ref, 'at': at}).decode()


def sign_act(party, project_id, op, ref, at, key=None):
    return sign(party, act(project_id, op, ref, at), key)


def verify_act(party, project_id, op, ref, at, signature, key=None):
    return verify(party, act(project_id, op, ref, at), signature, key)
