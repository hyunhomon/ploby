"""The project policy (ADR 0002): one immutable, versioned document both parties sign, named by its hash.

    {schemaVersion, protocolVersion, projectId, version, previousPolicyHash,
     clientAddress, contractorAddress, resolverAddress, settlementAsset, settlementAssetDecimals,
     projectBudget, expenseBudget, milestoneBudget, initialFunding,           integers, KRW (1 token unit = 1 KRW)
     defaultPaymentMode, allowedPaymentModes,                                  REIMBURSEMENT in the MVP
     expenseRules {source 'form'|'words', words, mandate, mandateHash, readback},   a PCP mandate
     startsAt, endsAt,                                                         ms
     clientReviewPeriodSeconds, resolverReviewPeriodSeconds, evidenceSubmissionPeriodSeconds,
     reservationValiditySeconds,
     milestones [{id, title, amount, startBy, deliveryDueAt, deliveryGracePeriodSeconds,
                  units [{id, title, criteria [str], amount}],
                  clientTimeoutFallback, resolverTimeoutFallback}],
     createdAt}

policy_hash(doc) = '0x' + sha256 of canonical JSON (sorted keys, compact, UTF-8). The target is keccak256
over RFC 8785 bytes (ADR 0002); sha256 keeps this standard-library only and is labelled as such.

Signatures are HMAC-SHA256 with per-role demo keys: the stand-in for EIP-712 wallet signatures. A policy
signature covers the policy hash; an action signature covers the canonical action line.
"""
import datetime as dt
import hashlib
import hmac
import json

from .pcp_bridge import domain, form as forms, lang, readback

ROLES = ('client', 'contractor', 'resolver')
SIGNERS = ('client', 'contractor')
SIGNED = ROLES + ('relayer',)  # the relayer signs the chain results it writes back (escrow/chain.py)
NAMES = {'client': '카페 온담', 'contractor': '한결웹스튜디오', 'resolver': 'Ploby 분쟁 해결자',
         'relayer': 'Ploby 체인 릴레이어'}
ROLE_KO = {'client': '클라이언트', 'contractor': '작업자', 'resolver': '분쟁 해결자'}
DEMO_KEYS = {r: f'ploby-demo-key:{r}'.encode('utf-8') for r in SIGNED}
KST = dt.timezone(dt.timedelta(hours=9))
HOUR, DAY = 3600, 86400
DEFAULT_PERIODS = {'client_review_hours': 72, 'resolver_review_days': 7, 'evidence_days': 7, 'reservation_days': 7}
BOUNDS = {'client_review_hours': (24, 168), 'resolver_review_days': (1, 14), 'evidence_days': (1, 30),
          'reservation_days': (1, 30)}  # ADR 0002 safety bounds (reservation: the demo's choice)


class PolicyError(ValueError):
    pass


def address(role):
    return '0x' + hashlib.sha256(f'ploby-demo:{role}'.encode('utf-8')).hexdigest()[:40]


def parties():
    return {r: {'role': r, 'name': NAMES[r], 'address': address(r)} for r in ROLES}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def policy_hash(doc):
    return '0x' + hashlib.sha256(canonical(doc)).hexdigest()


def sign(role, message):
    """role's demo signature over a policy hash or a canonical action string."""
    return '0x' + hmac.new(DEMO_KEYS[role], str(message).encode('utf-8'), hashlib.sha256).hexdigest()


def verify(role, message, signature):
    return isinstance(signature, str) and hmac.compare_digest(sign(role, message), signature)


# -- dates

def day_end(text, what='date'):
    """'YYYY-MM-DD' (KST) -> the last millisecond of that day."""
    try:
        d = dt.date.fromisoformat(str(text))
    except ValueError:
        raise PolicyError(f'{what}: {text!r} is not YYYY-MM-DD') from None
    return int(dt.datetime(d.year, d.month, d.day, 23, 59, 59, 999000, tzinfo=KST).timestamp() * 1000)


def kst_date(ms):
    return dt.datetime.fromtimestamp(ms / 1000, KST).date().isoformat()


def whole(value, what, minimum=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or value < minimum:
        raise PolicyError(f'{what}: {value!r} is not a whole number of at least {minimum}')
    return int(value)


# -- expense rules (a PCP mandate)

def rules_from_form(f, now_ms):
    """{vendors [id], budget, max_per_purchase, until 'YYYY-MM-DD'} -> expense rules with a compiled mandate."""
    d = domain()
    vendors = f.get('vendors') or []
    if not vendors or any(v not in d.by_id for v in vendors):
        raise PolicyError(f'rules.vendors: choose known vendors ({", ".join(d.ids)})')
    budget = whole(f.get('budget'), 'rules.budget')
    slots = {'budget': str(budget), 'counterparties': {'only': list(dict.fromkeys(vendors))}}
    if f.get('max_per_purchase') not in (None, '', 0):
        slots['one_purchase'] = {'at_most': str(whole(f['max_per_purchase'], 'rules.max_per_purchase')), 'per': 'purchase'}
    if f.get('until'):
        day_end(f['until'], 'rules.until')
        slots['until'] = f['until']
    try:
        module = lang.compile_fill(forms.to_fill(slots), lang.SEOUL, now_ms)
    except (forms.FormError, lang.LangError) as e:
        raise PolicyError(f'rules: {e}') from None
    return rules_of(module, 'form', None, now_ms)


def category_budgets(value):
    """{category id: amount} -> the policy's per-category caps (ADR 0002 categoryBudgets), or PolicyError."""
    d, out = domain(), {}
    for c, amount in (value or {}).items():
        if c not in d.categories:
            raise PolicyError(f'category_budgets: 알 수 없는 카테고리 {c!r}')
        if amount not in (None, '', 0):
            out[c] = whole(amount, f'category_budgets.{c}')
    return out


def rules_of(module, source, words, now_ms):
    m = lang.Mandate(module)
    return {'source': source, 'words': words, 'mandate': module, 'mandateHash': lang.digest(module),
            'readback': readback.text(readback.facts(m, domain(), now_ms), domain())}


_SUMMARIES = {}


def rules_summary(rules):
    """What the view shows beside the readback: the expressions, the vendors allowed, the per-purchase cap
    (probed from the mandate, not taken from any form), cached by mandate hash."""
    key = rules['mandateHash']
    if key not in _SUMMARIES:
        m = lang.Mandate(rules['mandate'])
        d = domain()
        vendors = [v for v in d.ids if m.ok('merchant_ok', v) and m.ok('category_ok', d.by_id[v]['category'])]
        one = readback.order_limits(m)[0].get(1)
        cap = one and one.get('max')
        until = next((int(x) for x in [readback.facts(m, d, rules['mandate'].get('issued') or 0)['intervals'][-1][1]]
                      if x is not None), None) if vendors else None
        _SUMMARIES[key] = {'source': rules['source'], 'words': rules['words'], 'readback': rules['readback'],
                           'expressions': dict(rules['mandate']['source']), 'mandate_hash': key, 'vendors': vendors,
                           'max_per_purchase': int(cap) if cap is not None else None, 'budget': int(m.budget),
                           'until': until}
    return _SUMMARIES[key]


# -- milestones

def milestone(spec, mid, now_ms):
    """A milestone as entered -> the policy's milestone (ADR 0009): amount = the sum of its units."""
    title = str(spec.get('title') or '').strip()
    if not title:
        raise PolicyError(f'{mid}: a title is needed')
    units = []
    for i, u in enumerate(spec.get('units') or [], 1):
        ut = str(u.get('title') or '').strip()
        criteria = [str(c).strip() for c in (u.get('criteria') or []) if str(c).strip()]
        if not ut or not criteria:
            raise PolicyError(f'{mid} unit {i}: needs a title and at least one acceptance criterion')
        units.append({'id': f'{mid}-U{i}', 'title': ut, 'criteria': criteria, 'amount': whole(u.get('amount'), f'{mid} unit {i} amount')})
    if not units:
        raise PolicyError(f'{mid}: at least one deliverable unit')
    start_by, due = day_end(spec.get('start_by'), f'{mid}.start_by'), day_end(spec.get('due_at'), f'{mid}.due_at')
    if not now_ms < start_by <= due:
        raise PolicyError(f'{mid}: start_by must be in the future and not after due_at')
    grace = whole(spec.get('grace_days', 2), f'{mid}.grace_days', 0)
    return {'id': mid, 'title': title, 'amount': sum(u['amount'] for u in units), 'startBy': start_by,
            'deliveryDueAt': due, 'deliveryGracePeriodSeconds': grace * DAY, 'units': units,
            'clientTimeoutFallback': 'RELEASE_VERIFIED_ELIGIBLE_UNITS',
            'resolverTimeoutFallback': 'RELEASE_COMPLETE_CLAIMS_UNLESS_DEFECT_ATTESTED'}


def periods_of(p):
    p = {**DEFAULT_PERIODS, **(p or {})}
    out = {}
    for k, (lo, hi) in BOUNDS.items():
        v = whole(p.get(k), f'periods.{k}')
        if not lo <= v <= hi:
            raise PolicyError(f'periods.{k}: {v} is outside {lo}..{hi}')
        out[k] = v
    return {'clientReviewPeriodSeconds': out['client_review_hours'] * HOUR,
            'resolverReviewPeriodSeconds': out['resolver_review_days'] * DAY,
            'evidenceSubmissionPeriodSeconds': out['evidence_days'] * DAY,
            'reservationValiditySeconds': out['reservation_days'] * DAY}


def initial(project_id, name, rules, milestones, periods, ends_at, now_ms, category_caps=None):
    """Version 1 of a project's policy."""
    ps = parties()
    expense_budget = int(lang.Mandate(rules['mandate']).budget)
    milestone_budget = sum(m['amount'] for m in milestones)
    ends = day_end(ends_at, 'ends_at')
    if any(m['deliveryDueAt'] > ends for m in milestones):
        raise PolicyError('ends_at: every milestone must be due before the project ends')
    return {'schemaVersion': 'ploby.policy/1', 'protocolVersion': 'ploby-mvp-1', 'projectId': project_id,
            'projectName': name, 'version': 1, 'previousPolicyHash': None,
            'clientAddress': ps['client']['address'], 'contractorAddress': ps['contractor']['address'],
            'resolverAddress': ps['resolver']['address'], 'settlementAsset': 'tKRW (test token, 1 unit = 1 KRW)',
            'settlementAssetDecimals': 0, 'projectBudget': expense_budget + milestone_budget,
            'expenseBudget': expense_budget, 'milestoneBudget': milestone_budget,
            'initialFunding': expense_budget + milestone_budget,
            'defaultPaymentMode': 'REIMBURSEMENT', 'allowedPaymentModes': ['REIMBURSEMENT'],
            'expenseRules': rules, 'startsAt': now_ms, 'endsAt': ends, **periods_of(periods),
            'evidenceRequirements': {'purchaseQuote': 'E1', 'receipt': 'E1', 'milestoneDelivery': 'E1',
                                     'note': 'E1 uploads are accepted for automatic settlement in this policy'},
            'categoryBudgets': category_budgets(category_caps), 'riskRules': risk_rules(),
            'milestones': milestones, 'createdAt': now_ms}


def risk_rules():
    """The risk signals the policy pins (they may only recommend HOLD): the domain pack's typical amounts."""
    d = domain()
    return {'typicalAmounts': dict(d.pack.get('typical_amounts') or {}), 'anomalyFactor': 3,
            'duplicateWindowSeconds': 7 * DAY, 'splitWindowSeconds': DAY}


def amended(active, active_hash, new_milestone, expense_delta, now_ms):
    """The next version (a change order): the active one plus an optional milestone and an optional expense-budget
    increase, the project budget raised by both. The mandate's own total is not rewritten: the expense budget in
    the policy is the cap the engine reserves against."""
    doc = json.loads(canonical(active))
    doc.update(version=active['version'] + 1, previousPolicyHash=active_hash, createdAt=now_ms)
    if new_milestone:
        doc['milestones'] = doc['milestones'] + [new_milestone]
        doc['milestoneBudget'] += new_milestone['amount']
        doc['projectBudget'] += new_milestone['amount']
        doc['endsAt'] = max(doc['endsAt'], new_milestone['deliveryDueAt'] + new_milestone['deliveryGracePeriodSeconds'] * 1000)
    if expense_delta:
        doc['expenseBudget'] += expense_delta
        doc['projectBudget'] += expense_delta
    return doc


FALLBACKS = [  # shown before signing (PROJECT_OVERVIEW §5.5, §6): what silence does, per case
    {'case': '작업자가 마일스톤 제출 통지를 보냈는데 클라이언트가 검수 기한까지 응답하지 않음',
     'silence': '제출된 납품 단위 금액을 작업자에게 자동 지급 (RELEASED_BY_TIMEOUT)', 'resolver_silence': '—'},
    {'case': '클라이언트가 사전 합의된 인수 기준으로 이의를 제기함',
     'silence': '분쟁 해결로 이동', 'resolver_silence': '제출이 완전하고 결함이 증명되지 않으면 지급'},
    {'case': '작업자가 납기 + 유예기간까지 아무것도 제출하지 않음',
     'silence': '미납 검토 (분쟁 해결)', 'resolver_silence': '미납 단위 거절, 예약금은 가용 잔액으로 복귀'},
    {'case': '구매 약정 후 제출한 영수증에 객관적 결함이 없음 (CLIENT_REVIEW)',
     'silence': '약정된 적격 금액 자동 정산 (약정 상한 이내)', 'resolver_silence': '이의가 있었다면 해결자 침묵 시에도 정산'},
    {'case': '판독·정책 엔진·증빙 서비스 장애로 판단 불가 (POLICY_OR_SYSTEM_AMBIGUITY)',
     'silence': '분쟁 해결로 이동', 'resolver_silence': '청구액과 약정 상한 중 작은 금액 정산'},
    {'case': '영수증 누락·손상·지연 또는 금액·공급자 확인 실패 (EVIDENCE_DEFECT)',
     'silence': '분쟁 해결로 이동 (작업자는 증빙 보완 가능)', 'resolver_silence': '거절, 예약금 가용 복귀'},
    {'case': '같은 문서 재사용 의심·서명 문제 등 무결성 신호 (INTEGRITY_RISK)',
     'silence': '분쟁 해결로 이동', 'resolver_silence': '거절, 예약금 가용 복귀'},
    {'case': '실제 적격 비용이 약정 상한을 초과 (EXCESS_AMOUNT)',
     'silence': '약정분은 즉시 정산, 초과분은 미지급', 'resolver_silence': '초과분은 양자 변경 주문 없이는 지급되지 않음'},
    {'case': '구매 약정 없이 먼저 지출한 사후 청구 (RETROACTIVE_REQUEST)',
     'silence': '거절 (침묵으로 지급 권리가 생기지 않음)', 'resolver_silence': '—'},
    {'case': '구매 전 요청이 HOLD됨 (아직 약정 없음)', 'silence': '만료 (약정이 생기지 않음)', 'resolver_silence': '—'},
    {'case': '예약 유효기간 안에 구매 보고가 없음', 'silence': '예약 만료, 금액 가용 복귀', 'resolver_silence': '—'},
    {'case': '예약된 마일스톤을 착수 기한까지 시작하지 않음', 'silence': '미사용 예약 만료 (EXPIRED_UNUSED), 가용 복귀',
     'resolver_silence': '—'},
]
