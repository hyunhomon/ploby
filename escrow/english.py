"""English for what the engine says, on the way out (`?lang=en`): the log's sentences, deadlines, fallbacks, reasons
and rule details are written in Korean (the product's reference language) and stored that way, signed and hashed.
This translates a view for the screen only; the log itself never changes. A sentence no pattern covers stays Korean.
"""
import re

NAMES = {'카페 온담': 'Cafe Ondam', '한결웹스튜디오': 'Hangyeol Web Studio', 'Ploby 분쟁 해결자': 'Ploby resolver',
         'Ploby 체인 릴레이어': 'Ploby chain relayer'}
ROLES = {'클라이언트': 'the client', '작업자': 'the contractor', '분쟁 해결자': 'the resolver'}
WORDS = [  # whole phrases first, then pieces; applied in order
    (r'^자동 정산$', 'automatic settlement'),
    (r'([\d,]+)원', r'₩\1'),
    (r'온체인 기록 \(#(\d+)\): ', r'On chain (#\1): '),
    (r'온체인 거절 \(#(\d+)\): ', r'Refused on chain (#\1): '),
    (r' — 컨트랙트가 거부 \((\w+)\), 전송하지 않음', r' — the contract refused it (\1), not sent'),
    (r' — 이미 체인에 있음', ' — already on chain'),
    (r'프로젝트 개설 \(예산 (₩[\d,]+), 수취인 작업자 지갑 고정\)', r'project opened (budget \1, payee fixed to the contractor wallet)'),
    (r'클라이언트 예치 (₩[\d,]+)', r'client deposit \1'),
    (r'클라이언트가 새 정책 해시 수락 \(예산 (₩[\d,]+)\)', r'the client accepted a new policy hash (budget \1)'),
    (r'새 약정 일시정지 중', 'new commitments paused'),
    (r'^(?:On chain \(#\d+\): )?새 약정 일시정지', lambda m: m.group(0).replace('새 약정 일시정지', 'new commitments paused')),
    (r'새 약정 재개', 'new commitments resumed'),
    (r'(\w+) (APPROVE|HOLD|BLOCK) \((\w+)\) (₩[\d,]+) 예약', r'\1 \2 (\3) \4 reserved'),
    (r'(\w+) (APPROVE|HOLD|BLOCK) \((\w+)\) (₩[\d,]+) 기록, 돈은 움직이지 않음', r'\1 \2 (\3) \4 recorded, no money moved'),
    (r'(\w+) 작업자에게 (₩[\d,]+) 지급, 예약 (₩[\d,]+) 반환', r'\1 \2 paid to the contractor, reservation \3 returned'),
    (r'(\w+) 작업자에게 (₩[\d,]+) 지급', r'\1 \2 paid to the contractor'),
    (r'클라이언트에게 (₩[\d,]+) 환불', r'\1 refunded to the client'),
    (r'클라이언트가 프로젝트와 정책 v(\d+) 초안을 만들었습니다 \(총 (₩[\d,]+)\)', r'The client created the project and draft policy v\1 (total \2)'),
    (r'(클라이언트|작업자)가 정책 v(\d+)에 서명했습니다', lambda m: f"{ROLES[m.group(1)].capitalize()} signed policy v{m.group(2)}"),
    (r'두 당사자 서명 완료, 정책 v(\d+) 발효', r'both parties signed, policy v\1 in force'),
    (r'양측 서명과 초기 자금이 모두 충족되어 프로젝트가 ACTIVE가 됐습니다', 'both signatures and the initial funding are in: the project is ACTIVE'),
    (r'마일스톤 예약: ', 'milestones reserved: '),
    (r'\(FUNDED_AND_RESERVED, 착수 가능\)', '(FUNDED_AND_RESERVED, ready to start)'),
    (r'클라이언트가 (₩[\d,]+)을 예치했습니다', r'The client deposited \1'),
    (r'작업자가 구매 에이전트\((A\d+)\)에게 맡겼습니다: ', r'The contractor handed a task to the purchase agent (\1): '),
    (r' — 계획 ', ' — plan: '),
    (r'맞는 견적 없음', 'no matching offer'),
    (r'(E\d+) (.*?) APPROVE: (₩[\d,]+) 예약 — 구매 약정 \1 성립 \(예약 유효기간 안에 구매 보고\)',
     r'\1 \2 APPROVE: \3 reserved — purchase commitment \1 made (report the purchase within its validity)'),
    (r'(E\d+) (.*?) 요청 BLOCK — (.*?) 위반', r'\1 \2 request BLOCK — violates: \3'),
    (r' \(범위 밖: 변경 주문으로만 가능\)', ' (out of scope: only a change order can allow it)'),
    (r'(E\d+) 요청 HOLD \((.*?)\) — 클라이언트 확인 필요, 응답 없으면 만료 \(약정 없음\)',
     r'\1 request HOLD (\2) — the client must look; no answer means it expires (no commitment)'),
    (r'(E\d+) 사후 청구 (₩[\d,]+) — 사전 약정이 없어 클라이언트가 응답하지 않으면 거절',
     r'\1 retroactive claim \2 — no prior commitment, so no answer from the client means rejection'),
    (r'클라이언트가 HOLD된 (E\d+)을\(를\) 승인했습니다: ', r'The client approved the held \1: '),
    (r'클라이언트가 (E\d+) 요청을 거절했습니다', r'The client rejected request \1'),
    (r' — 사전 약정이 없어 최종', ' — final, there was no prior commitment'),
    (r'클라이언트가 새 약정을 일시정지했습니다', 'The client paused new commitments'),
    (r'클라이언트가 새 약정을 재개했습니다', 'The client resumed new commitments'),
    (r' — 기존 약정의 제출·검수·정산은 그대로', ' — existing commitments still submit, review and settle'),
    (r'작업자가 (E\d+) 구매를 보고했습니다 — 증빙 제출 기한 시작', r'The contractor reported purchase \1 — the evidence deadline starts'),
    (r'(E\d+) 제출 통지 \((₩[\d,]+)\) — 클라이언트 검토, 침묵하면 기한에 자동 정산',
     r'\1 submission notice (\2) — client review; silence settles it at the deadline'),
    (r'클라이언트가 (E\d+) 정산을 승인해 (₩[\d,]+)이 작업자에게 지급됐습니다', r'The client approved settlement \1: \2 paid to the contractor'),
    (r'작업자가 (M\d+) (.*?) 작업을 시작했습니다 \(작업비 (₩[\d,]+) 예약 확인\)', r'The contractor started \1 \2 (fee \3 confirmed reserved)'),
    (r'작업자가 (M\d+) 제출 통지를 보냈습니다 \(납품 단위 (\d+)개, (₩[\d,]+)\) — 클라이언트 검수 기한 시작',
     r'The contractor sent the \1 submission notice (\2 units, \3) — the client review deadline starts'),
    (r'클라이언트가 (M\d+)을\(를\) 검수했습니다: 승인 (\d+)건 (₩[\d,]+) 지급', r'The client reviewed \1: \2 accepted, \3 paid'),
    (r', 이의 (\d+)건 → 분쟁 해결', r', \1 objected → resolver'),
    (r'작업자가 착수 전 (M\d+)을\(를\) 취소했습니다 \(예약 (₩[\d,]+) 가용 복귀\)', r'The contractor cancelled \1 before starting (reservation \2 back to available)'),
    (r'타임아웃: ', 'Timeout: '),
    (r'(E\d+) HOLD 요청에 클라이언트 응답 없음 — 만료 \(약정은 생기지 않음\)', r'no client answer to held request \1 — expired (no commitment)'),
    (r'(E\d+) 구매 보고 없이 예약 만료 — (₩[\d,]+) 가용 복귀', r'\1 reservation expired without a purchase report — \2 back to available'),
    (r'(E\d+) 클라이언트 검토 기한 경과 — (₩[\d,]+) 자동 정산 \(RELEASED_BY_TIMEOUT\)', r'\1 client review deadline passed — \2 settled automatically (RELEASED_BY_TIMEOUT)'),
    (r'(M\d+) 착수 기한 경과 — 미사용 예약 (₩[\d,]+) 복귀 \(EXPIRED_UNUSED\)', r'\1 start deadline passed — unused reservation \2 returned (EXPIRED_UNUSED)'),
    (r'(M\d+) 클라이언트 검수 기한 경과 — 제출 단위 (₩[\d,]+) 자동 지급 \(RELEASED_BY_TIMEOUT\)', r'\1 client review deadline passed — submitted units \2 paid (RELEASED_BY_TIMEOUT)'),
    (r'(클라이언트|작업자)가 종료를 시작했습니다 \(CLOSING\) — 새 약정 불가, 기존 약정·분쟁은 끝까지 진행',
     lambda m: f"{ROLES[m.group(1)].capitalize()} started closing (CLOSING) — no new commitments; existing ones and disputes run to the end"),
    (r'클라이언트가 예약되지 않은 (₩[\d,]+)을 환불받았습니다', r'The client was refunded \1 of unreserved funds'),
    # deadlines and fallbacks
    (r'HOLD 요청 응답 기한', 'HOLD answer deadline'),
    (r'사후 청구 응답 기한', 'retroactive claim answer deadline'),
    (r'예약 유효기간 \(구매 보고\)', 'reservation validity (purchase report)'),
    (r'증빙 제출 기한', 'evidence deadline'),
    (r'클라이언트 검토 기한', 'client review deadline'),
    (r'클라이언트 검수 기한', 'client review deadline'),
    (r'분쟁 해결 기한', 'resolver deadline'),
    (r'착수 기한', 'start deadline'),
    (r'납기 \+ 유예기간', 'due date + grace'),
    (r'제출 통지에 없는 단위 정리', 'units missing from the submission'),
    (r'만료 — 약정이 생기지 않음', 'expires — no commitment is made'),
    (r'거절 — 침묵으로 지급되지 않음', 'rejected — silence never pays'),
    (r'예약 만료, 가용 복귀', 'reservation expires, back to available'),
    (r'증빙 결함 → 분쟁 해결', 'evidence defect → resolver'),
    (r'미사용 예약 만료 \(EXPIRED_UNUSED\), 가용 복귀', 'unused reservation expires (EXPIRED_UNUSED), back to available'),
    (r'미납 검토 \(분쟁 해결\)', 'non-delivery review (resolver)'),
    (r'미납 처리, 가용 복귀', 'not delivered, back to available'),
    (r'제출 단위 자동 지급 \(RELEASED_BY_TIMEOUT\)', 'submitted units paid automatically (RELEASED_BY_TIMEOUT)'),
    (r'자동 정산 \(RELEASED_BY_TIMEOUT\)', 'settled automatically (RELEASED_BY_TIMEOUT)'),
    (r'분쟁 해결로 이동 \(ESCALATED_BY_TIMEOUT\)', 'goes to the resolver (ESCALATED_BY_TIMEOUT)'),
    (r'이의 단위 지급 \(제출 완전, 결함 증명 없음\)', 'objected units paid (complete submission, no defect shown)'),
    (r'미납 단위 거절, 가용 복귀', 'undelivered units rejected, back to available'),
    (r'약정된 적격 금액 정산', 'settles the committed eligible amount'),
    (r'거절, 예약 가용 복귀', 'rejected, reservation back to available'),
    # reasons and rule details
    (r'(\S+) 대표값 (₩[\d,]+)의 (\d+)배 초과', r'over \3× the typical \1 amount \2'),
    (r'디자인 소스', 'design assets'), (r'일반 쇼핑', 'general shopping'), (r'결제 대행', 'payment service'), (r'AI API', 'AI API'), (r'호스팅', 'hosting'), (r'도메인', 'domain'), (r'소프트웨어', 'software'), (r'디자인 에셋', 'design assets'),
    (r'잔여 ', 'left '), (r'가용 ', 'available '), (r'카테고리 예산 없음', 'no category budget'),
    (r'새 약정 일시정지 중', 'new commitments paused'), (r'정책 기간 밖', 'outside the policy window'),
    (r'환급 \(작업자에게 지급\)', 'reimbursement (paid to the contractor)'),
    (r'E1 업로드 문서, 판독 일치', 'E1 uploaded document, reading consistent'),
    (r'판독 결과를 신뢰할 수 없음', 'the reading cannot be trusted'),
    (r'작업자 (0x[0-9a-f]+…)', r'contractor \1'),
    (r'쿠팡', 'Coupang'), (r'가비아', 'Gabia'),
    (r'건별 한도 \(부가세·수수료 포함\)', 'per-purchase cap (incl. VAT and fees)'),
    (r'허용 공급자', 'allowed vendors'),
    (r'프로젝트 상태 \(진행 중, 새 약정 일시정지 아님\)', 'project state (active, not paused)'),
    (r'정책 기간', 'policy window'),
]
COMPILED = [(re.compile(p), r) for p, r in WORDS]
FALLBACKS = {
    '작업자가 마일스톤 제출 통지를 보냈는데 클라이언트가 검수 기한까지 응답하지 않음': {'case': 'The contractor sent a milestone submission notice and the client did not answer by the review deadline', 'silence': 'The submitted units are paid to the contractor automatically (RELEASED_BY_TIMEOUT)', 'resolver_silence': '—'},
    '클라이언트가 사전 합의된 인수 기준으로 이의를 제기함': {'case': 'The client objected on a pre-agreed acceptance criterion', 'silence': 'Goes to the resolver', 'resolver_silence': 'Paid if the submission was complete and no defect was shown'},
    '작업자가 납기 + 유예기간까지 아무것도 제출하지 않음': {'case': 'The contractor submitted nothing by the due date + grace', 'silence': 'Non-delivery review (resolver)', 'resolver_silence': 'Undelivered units rejected; the reservation returns to available'},
    '구매 약정 후 제출한 영수증에 객관적 결함이 없음 (CLIENT_REVIEW)': {'case': 'A receipt after a purchase commitment with no objective defect (CLIENT_REVIEW)', 'silence': 'The committed eligible amount settles automatically (within the cap)', 'resolver_silence': 'If there was an objection, it still settles when the resolver is silent'},
    '판독·정책 엔진·증빙 서비스 장애로 판단 불가 (POLICY_OR_SYSTEM_AMBIGUITY)': {'case': 'Undecidable because the reader, policy engine or evidence service failed (POLICY_OR_SYSTEM_AMBIGUITY)', 'silence': 'Goes to the resolver', 'resolver_silence': 'The smaller of the claim and the cap settles'},
    '영수증 누락·손상·지연 또는 금액·공급자 확인 실패 (EVIDENCE_DEFECT)': {'case': 'Receipt missing, damaged or late, or amount or vendor not confirmed (EVIDENCE_DEFECT)', 'silence': 'Goes to the resolver (the contractor may supplement evidence)', 'resolver_silence': 'Rejected; the reservation returns to available'},
    '같은 문서 재사용 의심·서명 문제 등 무결성 신호 (INTEGRITY_RISK)': {'case': 'Integrity signals such as a reused document or a signature problem (INTEGRITY_RISK)', 'silence': 'Goes to the resolver', 'resolver_silence': 'Rejected; the reservation returns to available'},
    '실제 적격 비용이 약정 상한을 초과 (EXCESS_AMOUNT)': {'case': 'The eligible actual cost exceeds the commitment cap (EXCESS_AMOUNT)', 'silence': 'The committed part settles now; the excess is not paid', 'resolver_silence': 'The excess is never paid without a bilateral change order'},
    '구매 약정 없이 먼저 지출한 사후 청구 (RETROACTIVE_REQUEST)': {'case': 'A retroactive claim for spending without a commitment (RETROACTIVE_REQUEST)', 'silence': 'Rejected (silence never creates a right to payment)', 'resolver_silence': '—'},
    '구매 전 요청이 HOLD됨 (아직 약정 없음)': {'case': 'A request before purchase was held (no commitment yet)', 'silence': 'Expires (no commitment is made)', 'resolver_silence': '—'},
    '예약 유효기간 안에 구매 보고가 없음': {'case': 'No purchase report within the reservation validity', 'silence': 'The reservation expires and returns to available', 'resolver_silence': '—'},
    '예약된 마일스톤을 착수 기한까지 시작하지 않음': {'case': 'A reserved milestone was not started by its start deadline', 'silence': 'The unused reservation expires (EXPIRED_UNUSED) and returns to available', 'resolver_silence': '—'},
}
ITEMS = [('도메인 신규 등록', 'new domain registration'), ('서비스', 'services'), ('이미지 팩', 'image pack'), ('표준 라이선스 이미지', 'standard-license images'), ('장)', ')'), ('기계식 키보드', 'mechanical keyboard')]
READBACK = [
    (r'총 한도: (\S+) 원 \(부가세·수수료 포함\) — 모두 합쳐 이보다 많이 결제되지 않습니다\.', r'Total limit: ₩\1 (incl. VAT and fees) — never more than this in all.'),
    (r'공급자: (.*)만', r'Vendors: only \1'),
    (r'기간: 지금부터 (\S+)\((.)\) (\S+)까지', r'Window: from now until \1 \3'),
    (r'한 번에: (\S+) 원까지 \(부가세·수수료 포함\)', r'Per purchase: up to ₩\1 (incl. VAT and fees)'),
    (r'횟수: 제한 없음', 'Number of purchases: no limit'),
    (r'(\d+)만', lambda m: f'{int(m.group(1)) * 10000:,}'),
    (r'가비아', 'Gabia'),
]
VENDORS = {'가비아': 'Gabia', '쿠팡': 'Coupang', '빠른결제대행': 'FastPay Agency'}
CATEGORIES = {'도메인': 'Domain', '호스팅': 'Hosting', '소프트웨어': 'Software', '디자인 소스': 'Design assets',
              '일반 쇼핑': 'General shopping', '결제 대행': 'Payment service'}
RULES = {'allocation': 'Invoice allocation within 100% (no reusing a document)',
         'state': 'Project state (active, new commitments not paused)', 'window': 'Policy window',
         'payment_mode': 'Payment mode (reimbursement)', 'vendor': 'Allowed vendor', 'category': 'Allowed category',
         'payee': 'Payee (the contractor wallet in the policy)', 'per_purchase': 'Per-purchase cap (incl. VAT and fees)',
         'expense_budget': 'Expense budget left', 'category_budget': 'Category budget left', 'funds': 'Funds available',
         'evidence': 'Document reading and evidence level', 'probable_duplicate': 'Probable duplicate (same vendor, same amount)',
         'split_pattern': 'Split purchases (avoiding the per-purchase cap)', 'price_anomaly': 'Price anomaly (vs the category’s typical amount)'}


def text(s):
    if not isinstance(s, str) or not re.search(r'[가-힣]', s):
        return s
    for name, en in NAMES.items():
        s = s.replace(name, en)
    for p, r in COMPILED:
        s = p.sub(r, s)
    return s


def view(v):
    """A project view (or summary) with the engine's Korean sentences in English, for the screen."""
    if v.get('log'):
        v['log'] = [{**e, 'text': text(e['text'])} for e in v['log']]  # copies: the engine's own log is never touched
    for d in v.get('deadlines') or []:
        d['label'], d['fallback'] = text(d['label']), text(d['fallback'])
    for a in v.get('actions') or []:
        a['label'], a['fallback'] = text(a['label']), text(a.get('fallback'))
    if v.get('next_deadline'):
        v['next_deadline'] = {**v['next_deadline'], 'label': text(v['next_deadline']['label']),
                              'fallback': text(v['next_deadline']['fallback'])}
    for e in v.get('expenses') or []:
        d = e.get('decision') or {}
        if d:
            e['decision'] = {**d, 'reason': text(d.get('reason')),
                             'rules': [{**r, 'detail': text(r.get('detail')), 'label': RULES.get(r.get('rule'), r.get('label'))}
                                       for r in d.get('rules') or []]}
        e['vendor_name'] = VENDORS.get(e.get('vendor_name'), e.get('vendor_name'))
        e['category_ko'] = CATEGORIES.get(e.get('category_ko'), e.get('category_ko'))
    for p in (v.get('parties') or {}).values():
        p['name'] = NAMES.get(p['name'], p['name'])
    if v.get('viewer'):
        v['viewer'] = {**v['viewer'], 'name': NAMES.get(v['viewer']['name'], v['viewer']['name'])}
    for pv in [v.get('policy')] + list(v.get('versions') or []) + list(v.get('proposals') or []):
        if not pv:
            continue
        pv['fallbacks'] = [FALLBACKS.get(f['case'], f) for f in pv.get('fallbacks') or []]
        if pv.get('rules'):
            lines = []
            for line in pv['rules'].get('readback') or []:
                for pat, rep in READBACK:
                    line = re.sub(pat, rep, line)
                lines.append(line)
            pv['rules'] = {**pv['rules'], 'readback': lines}
    for e in v.get('expenses') or []:
        if isinstance(e.get('item'), str):
            for ko, en in ITEMS:
                e['item'] = e['item'].replace(ko, en)
    if isinstance(v.get('name'), str):
        v['name'] = v['name'].replace('카페 온담 홈페이지 리뉴얼', 'Cafe Ondam website renewal')
    return v


def meta(m):
    """/api/meta in English: party names, vendor and category names."""
    m = dict(m)
    m['roles'] = [{**r, 'name': NAMES.get(r['name'], r['name'])} for r in m.get('roles') or []]
    m['vendors'] = [{**v, 'name': VENDORS.get(v['name'], v['name']), 'category_ko': CATEGORIES.get(v['category_ko'], v['category_ko'])}
                    for v in m.get('vendors') or []]
    m['categories'] = [{**c, 'name_ko': CATEGORIES.get(c['name_ko'], c['name_ko'])} for c in m.get('categories') or []]
    return m
