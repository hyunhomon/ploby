// Dev fixture for `?fixture=1`: realistic ProjectViews per role, built to docs/api.md, so the
// UI can be checked without the server. Numbers add up (ADR 0004):
//   available = funded − expense_reserved − milestone_reserved − released − refunded − migrated_out
// Actions are not sent anywhere: `act` answers with an ApiError (code 'fixture') that shows the
// request body the UI would have posted.

import { ApiError, type Backend } from "../api"
import { won } from "../format"
import type {
  Action,
  ChangeOrder,
  Deadline,
  Doc,
  DocRef,
  Expense,
  Ledger,
  LogEntry,
  Meta,
  Milestone,
  Party,
  PolicyMilestone,
  PolicyView,
  ProjectSummary,
  ProjectView,
  Quote,
  Reading,
  Role,
  RuleKind,
  RuleResult,
  RulesCandidate,
  Sample,
  Target,
  Vendor,
} from "../types"

// ---------------------------------------------------------------- clock and hashes

const KST = 9 * 3600 * 1000
/** KST wall time in 2026 -> ms. */
const t = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h, mi) - KST
/** End of a KST day. */
const eod = (mo: number, d: number) => t(mo, d, 23, 59) + 59_999
const BASE_NOW = t(10, 14, 10, 0)
let offset = 0
const now = () => BASE_NOW + offset

function hex(seed: string, len = 64): string {
  let x = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    x ^= seed.charCodeAt(i)
    x = Math.imul(x, 0x01000193) >>> 0
  }
  if (x === 0) x = 0x9e3779b9
  let out = ""
  while (out.length < len) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out += x.toString(16).padStart(8, "0")
  }
  return out.slice(0, len)
}
const h0x = (seed: string) => `0x${hex(seed)}`
const docId = (seed: string) => hex(`doc:${seed}`)

// ---------------------------------------------------------------- parties and meta

const PARTIES: Record<Role, Party> = {
  client: { role: "client", name: "카페 온담", address: "0x3f1c9a52e07b4d18c6a2f09b7e35d8c41a6b2e90" },
  contractor: { role: "contractor", name: "한결웹스튜디오", address: "0x8a2d47c1b9e6f3a05d72c8e14b69f0a3d57e21c6" },
  resolver: { role: "resolver", name: "Ploby 분쟁 해결자", address: "0x5b90e3a7c12d48f6b09a5e7c3d81f24a6c9b0e53" },
}

const VENDORS: Vendor[] = [
  { id: "aws", name: "AWS", category: "hosting", category_ko: "호스팅" },
  { id: "vercel", name: "Vercel", category: "hosting", category_ko: "호스팅" },
  { id: "gabia", name: "가비아", category: "domain", category_ko: "도메인" },
  { id: "figma", name: "Figma", category: "software", category_ko: "소프트웨어" },
  { id: "adobe-stock", name: "Adobe Stock", category: "assets", category_ko: "디자인 소스" },
  { id: "kiln-api", name: "Kiln API", category: "ai-api", category_ko: "AI API" },
  { id: "coupang", name: "쿠팡", category: "general", category_ko: "일반 쇼핑" },
  { id: "fastpay-agency", name: "빠른결제대행", category: "payment-service", category_ko: "결제 대행" },
]

const META: Meta = {
  roles: [PARTIES.client, PARTIES.contractor, PARTIES.resolver],
  vendors: VENDORS,
  categories: [
    { id: "hosting", name_ko: "호스팅" },
    { id: "domain", name_ko: "도메인" },
    { id: "software", name_ko: "소프트웨어" },
    { id: "assets", name_ko: "디자인 소스" },
    { id: "ai-api", name_ko: "AI API" },
    { id: "general", name_ko: "일반 쇼핑" },
    { id: "payment-service", name_ko: "결제 대행" },
  ],
  defaults: { client_review_hours: 72, resolver_review_days: 7, evidence_days: 7, reservation_days: 7 },
  ai: { enabled: true, model: "fixture (캐시 재생)" },
  implementation: {
    current: [
      "양측이 같은 해시에 서명하는 버전형 정책 (서버 보관 데모 키, HMAC)",
      "마일스톤 예약·제출 통지·검수·분쟁 해결과 기한별 침묵 시 결과 (서버 엔진)",
      "구매 약정: 예약 → 구매 보고 → 영수증 → 정산, 사후 청구",
      "AI 문서 판독과 결정론적 규칙 검사 (APPROVE / HOLD / BLOCK)",
      "해시 체인 감사 로그와 데모 시계 (keeper 타임아웃)",
    ],
    target: [
      "프로젝트별 불변 ProjectEscrow 컨트랙트의 온체인 자금 집행",
      "지갑 서명 (EIP-712 / EIP-1271)",
      "공급자 직접 지급 (DIRECT_VENDOR)과 미정산 기록",
      "E2 (DKIM)·E3 (공급자 API) 증빙 확인",
      "프로젝트 간 인보이스 배분 레지스트리",
      "프로젝트 자산 인계와 보안 동결·마이그레이션",
    ],
  },
}

const vendor = (id: string) => {
  const v = VENDORS.find((x) => x.id === id)!
  return { vendor: v.id, vendor_name: v.name, category: v.category, category_ko: v.category_ko }
}

// ---------------------------------------------------------------- sample documents

const SAMPLES: Sample[] = [
  {
    id: "q-gabia",
    name: "가비아 도메인 1년 견적",
    kind: "quote",
    text: "견적서\n견적일: 2026-10-02\n공급자: (주)가비아\n수신: 한결웹스튜디오 (카페 온담 홈페이지 리뉴얼)\n\n도메인 신규 등록 ondam-cafe.co.kr  1년  22,000\n부가세  2,200\n합계  24,200원\n유효기간: 7일",
  },
  {
    id: "q-vercel",
    name: "Vercel Pro 1개월 견적",
    kind: "quote",
    text: "Quote — Vercel Inc.\nPlan: Pro (1 seat), 1 month\nSubtotal: 25,000 KRW\nVAT: 2,500 KRW\nTotal: 27,500 KRW",
  },
  {
    id: "q-adobe",
    name: "Adobe Stock 일러스트 팩 견적",
    kind: "quote",
    text: "Adobe Stock 견적\n품목: 일러스트 팩 (카페 메뉴 아이콘 60종) 확장 라이선스\n공급가 129,000원\n부가세 12,900원\n합계 141,900원",
  },
  {
    id: "q-coupang",
    name: "쿠팡 기계식 키보드 주문서",
    kind: "quote",
    text: "쿠팡 주문 확인\n상품: 무선 기계식 키보드 (갈축)\n수량 1\n결제 금액 89,000원 (부가세 포함)",
  },
  {
    id: "q-aws",
    name: "AWS Lightsail 3개월 선결제 견적",
    kind: "quote",
    text: "AWS Lightsail\n인스턴스 2GB · 3개월 선결제\n소계 60,000원\n세금 6,000원\n합계 66,000원",
  },
  {
    id: "r-gabia",
    name: "가비아 결제 영수증",
    kind: "receipt",
    text: "영수증\n(주)가비아\n결제일 2026-10-02 14:58\n도메인 등록 ondam-cafe.co.kr 1년\n결제 금액 24,200원\n결제자: 한결웹스튜디오",
  },
  {
    id: "r-figma",
    name: "Figma Professional 2석 영수증",
    kind: "receipt",
    text: "Receipt — Figma, Inc.\nProfessional plan, 2 editors, Oct 2026\nSubtotal 36,000 KRW\nTax 3,600 KRW\nTotal paid 39,600 KRW\nBilled to: Hangyeol Web Studio",
  },
  {
    id: "r-vercel",
    name: "Vercel 커스텀 도메인 추가 요금 영수증",
    kind: "receipt",
    text: "Receipt — Vercel Inc.\nAdd-on: custom domain (ondam-cafe.co.kr)\nSubtotal 10,000 KRW\nVAT 1,000 KRW\nTotal 11,000 KRW",
  },
  {
    id: "r-aws",
    name: "AWS 10월 사용료 청구서",
    kind: "receipt",
    text: "AWS 청구서 (2026년 10월)\nAmazon S3  18,000\nAmazon CloudFront  30,000\n세금  4,800\n합계 52,800원",
  },
  {
    id: "r-adobe-photo",
    name: "Adobe Stock 사진 5장 영수증 (잘린 이미지)",
    kind: "receipt",
    text: "Adobe Stock\n사진 5장 (매장 인테리어)\n결제 금액 ■■,■■■원\n결제자: 한결■■■■■",
  },
  {
    id: "r-gabia-hosting",
    name: "가비아 웹호스팅 1년 영수증",
    kind: "receipt",
    text: "영수증\n(주)가비아\n웹호스팅 비즈니스 1년\n공급가 88,000원 (10월 6일 가격 인상 반영)\n부가세 8,800원\n합계 96,800원",
  },
  {
    id: "d-design",
    name: "디자인 시안 제출 설명",
    kind: "delivery",
    text: "Figma 파일: 카페 온담 리뉴얼 v3\n- Main (데스크톱 1440 / 모바일 375)\n- Sub: 메뉴 페이지\n브랜드 컬러 #3B2A20, 로고 가로형 적용",
  },
  {
    id: "d-publish",
    name: "반응형 퍼블리싱 납품 노트",
    kind: "delivery",
    text: "스테이징: https://staging.ondam-cafe.co.kr\n확인 브라우저: Chrome, Safari(iOS), Samsung Internet\n페이지: 메인, 메뉴, 매장 안내\n브레이크포인트: 375 / 768 / 1280",
  },
]

const DOCS = new Map<string, Doc>(SAMPLES.map((s) => [docId(s.id), { id: docId(s.id), name: s.name, text: s.text }]))

const ref = (sampleId: string): DocRef => {
  const s = SAMPLES.find((x) => x.id === sampleId)!
  return { id: docId(sampleId), name: s.name }
}

// ---------------------------------------------------------------- readings and rules

function reading(fields: Record<string, unknown>, opts: { ok?: boolean; problems?: string[]; tokens?: number } = {}): Reading {
  const tokens = opts.tokens ?? 2800 + Object.keys(fields).length * 90
  return {
    ok: opts.ok ?? true,
    source: "ai",
    fields,
    problems: opts.problems ?? [],
    usage: { tokens, cost_usd: Math.round(tokens * 0.0000011 * 1e6) / 1e6, seconds: 2.4 + tokens / 2000, cached: true },
  }
}

function quote(amount: number, fee: number, sampleId: string, fields: Record<string, unknown>, opts?: Parameters<typeof reading>[1]): Quote {
  return {
    amount,
    fee,
    total: amount + fee,
    document: ref(sampleId),
    manifest_hash: h0x(`manifest:${sampleId}`),
    reading: reading({ ...fields, amount, fee, total: amount + fee }, opts),
  }
}

const RULE_META: Record<string, { label: string; kind: RuleKind }> = {
  allocation: { label: "인보이스 배분 (100% 초과 금지)", kind: "mandatory" },
  state: { label: "프로젝트 상태", kind: "mandatory" },
  window: { label: "허용 기간", kind: "mandatory" },
  payment_mode: { label: "결제 방식", kind: "mandatory" },
  vendor: { label: "공급자", kind: "mandatory" },
  category: { label: "카테고리", kind: "mandatory" },
  payee: { label: "수취인", kind: "mandatory" },
  per_purchase: { label: "건별 한도", kind: "mandatory" },
  expense_budget: { label: "경비 예산", kind: "mandatory" },
  funds: { label: "예약 가능 자금", kind: "mandatory" },
  evidence: { label: "증빙", kind: "evidence" },
  probable_duplicate: { label: "유력한 중복", kind: "risk" },
  split_pattern: { label: "분할 청구 패턴", kind: "risk" },
  price_anomaly: { label: "가격 이상", kind: "risk" },
}

function rules(v: { name: string; category_ko: string; total: number }, over: Record<string, [boolean | null, string]> = {}): RuleResult[] {
  const base: Record<string, [boolean | null, string]> = {
    allocation: [true, "같은 문서의 배분 합계 100% 이하"],
    state: [true, "진행 중 · 새 약정 허용"],
    window: [true, "2026년 10월 31일까지 허용"],
    payment_mode: [true, "작업자 환급 (REIMBURSEMENT)"],
    vendor: [true, `${v.name}: 허용 공급자`],
    category: [true, `${v.category_ko}: 허용 카테고리`],
    payee: [true, "수취인 = 정책의 작업자 주소"],
    per_purchase: [true, `${won(v.total)} ≤ 건별 한도 200,000원`],
    expense_budget: [true, "경비 예산 500,000원 안"],
    funds: [true, "가용 잔액으로 예약 가능"],
    evidence: [true, "E1 파일 보존 · 필수 필드 확인"],
    probable_duplicate: [true, "같은 문서 해시 없음"],
    split_pattern: [true, "분할 청구 패턴 없음"],
    price_anomaly: [true, "가격 정상 범위"],
  }
  return Object.keys(RULE_META).map((rule) => {
    const [ok, detail] = over[rule] ?? base[rule]
    return { rule, label: RULE_META[rule].label, ok, detail, kind: RULE_META[rule].kind }
  })
}

function expense(p: Partial<Expense> & Pick<Expense, "id" | "status">): Expense {
  return {
    kind: "COMMITMENT",
    hold_class: null,
    payment_mode: "REIMBURSEMENT",
    payee: PARTIES.contractor.address,
    assurance: "E1",
    vendor: null,
    vendor_name: null,
    category: null,
    category_ko: null,
    item: null,
    quote: null,
    maximum: 0,
    reserved: 0,
    expires_at: null,
    spent_at: null,
    evidence_deadline: null,
    receipt: null,
    review_deadline: null,
    resolver_deadline: null,
    paid: 0,
    excess: 0,
    excess_paid: 0,
    settlement: null,
    timeout: null,
    decision: null,
    out_of_scope: false,
    resolution: null,
    ...p,
  }
}

const settle = (amount: number, at: number) => ({ payee: PARTIES.contractor.address, amount, asset: "KRW", at })

// ---------------------------------------------------------------- project A: 카페 홈페이지 리뉴얼 (ACTIVE)

const A_ID = "p-cafe"

const EXPENSES_A: Expense[] = [
  expense({
    id: "ex-1",
    status: "SETTLED",
    ...vendor("gabia"),
    item: "도메인 신규 등록 1년 (ondam-cafe.co.kr)",
    quote: quote(22_000, 2_200, "q-gabia", { vendor_text: "(주)가비아", merchant: "gabia", item: "도메인 신규 등록 1년" }),
    maximum: 24_200,
    expires_at: t(10, 9, 11),
    spent_at: t(10, 2, 15),
    evidence_deadline: t(10, 9, 15),
    receipt: {
      document: ref("r-gabia"),
      manifest_hash: h0x("manifest:r-gabia"),
      claimed: 24_200,
      reading: reading({ vendor_text: "(주)가비아", total: 24_200, date: "2026-10-02", payee: "한결웹스튜디오" }),
      eligible: 24_200,
      at: t(10, 3, 10),
    },
    review_deadline: t(10, 6, 10),
    paid: 24_200,
    settlement: settle(24_200, t(10, 6, 10)),
    timeout: "RELEASED_BY_TIMEOUT",
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "가비아", category_ko: "도메인", total: 24_200 }) },
  }),
  expense({
    id: "ex-2",
    status: "BLOCKED",
    ...vendor("coupang"),
    item: "무선 기계식 키보드",
    quote: quote(89_000, 0, "q-coupang", { vendor_text: "쿠팡", merchant: "coupang", item: "무선 기계식 키보드" }),
    maximum: 0,
    out_of_scope: true,
    decision: {
      result: "BLOCK",
      reason: "vendor_not_allowed",
      rules: rules(
        { name: "쿠팡", category_ko: "일반 쇼핑", total: 89_000 },
        {
          vendor: [false, "쿠팡: 허용 공급자 목록에 없음"],
          category: [false, "일반 쇼핑: 허용되지 않은 카테고리"],
          funds: [null, "BLOCK이라 예약하지 않음"],
        },
      ),
    },
  }),
  expense({
    id: "ex-3",
    status: "HOLD_REVIEW",
    hold_class: "CLIENT_REVIEW",
    ...vendor("adobe-stock"),
    item: "일러스트 팩 (카페 메뉴 아이콘 60종)",
    quote: quote(129_000, 12_900, "q-adobe", { vendor_text: "Adobe Stock", merchant: "adobe-stock", item: "일러스트 팩 확장 라이선스" }),
    maximum: 141_900,
    review_deadline: t(10, 16, 16),
    decision: {
      result: "HOLD",
      reason: "price_anomaly",
      rules: rules(
        { name: "Adobe Stock", category_ko: "디자인 소스", total: 141_900 },
        { price_anomaly: [false, "같은 카테고리 최근 견적 평균보다 46% 높음 (확장 라이선스)"] },
      ),
    },
  }),
  expense({
    id: "ex-4",
    status: "RESERVED",
    ...vendor("aws"),
    item: "Lightsail 인스턴스 3개월 선결제",
    quote: quote(60_000, 6_000, "q-aws", { vendor_text: "AWS", merchant: "aws", item: "Lightsail 2GB 3개월" }),
    maximum: 66_000,
    reserved: 66_000,
    expires_at: t(10, 19, 11),
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "AWS", category_ko: "호스팅", total: 66_000 }) },
  }),
  expense({
    id: "ex-5",
    status: "EVIDENCE_SUBMITTED",
    hold_class: "CLIENT_REVIEW",
    ...vendor("figma"),
    item: "Figma Professional 2석 1개월",
    quote: quote(36_000, 3_600, "r-figma", { vendor_text: "Figma, Inc.", merchant: "figma", item: "Professional 2 editors" }),
    maximum: 39_600,
    reserved: 39_600,
    expires_at: t(10, 11, 15),
    spent_at: t(10, 8, 15),
    evidence_deadline: t(10, 15, 15),
    receipt: {
      document: ref("r-figma"),
      manifest_hash: h0x("manifest:r-figma"),
      claimed: 39_600,
      reading: reading({ vendor_text: "Figma, Inc.", total: 39_600, date: "2026-10-08", payee: "Hangyeol Web Studio" }),
      eligible: 39_600,
      at: t(10, 13, 9),
    },
    review_deadline: t(10, 16, 9),
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "Figma", category_ko: "소프트웨어", total: 39_600 }) },
  }),
  expense({
    id: "ex-6",
    status: "SPEND_REPORTED",
    ...vendor("vercel"),
    item: "Vercel Pro 1개월 (1석)",
    quote: quote(25_000, 2_500, "q-vercel", { vendor_text: "Vercel Inc.", merchant: "vercel", item: "Pro plan 1 seat" }),
    maximum: 27_500,
    reserved: 27_500,
    expires_at: t(10, 15, 12),
    spent_at: t(10, 10, 12),
    evidence_deadline: t(10, 17, 12),
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "Vercel", category_ko: "호스팅", total: 27_500 }) },
  }),
  expense({
    id: "ex-7",
    status: "DISPUTED",
    hold_class: "CLIENT_REVIEW",
    ...vendor("aws"),
    item: "AWS 10월 사용료 (S3·CloudFront)",
    quote: quote(50_000, 5_000, "q-aws", { vendor_text: "AWS", merchant: "aws", item: "S3·CloudFront 월 사용료 추정" }),
    maximum: 55_000,
    reserved: 55_000,
    expires_at: t(10, 12, 10),
    spent_at: t(10, 5, 18),
    evidence_deadline: t(10, 12, 18),
    receipt: {
      document: ref("r-aws"),
      manifest_hash: h0x("manifest:r-aws"),
      claimed: 52_800,
      reading: reading({ vendor_text: "Amazon Web Services", total: 52_800, date: "2026-10-08" }),
      eligible: 52_800,
      at: t(10, 8, 18),
    },
    review_deadline: t(10, 11, 18),
    resolver_deadline: t(10, 18, 17, 30),
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "AWS", category_ko: "호스팅", total: 55_000 }) },
  }),
  expense({
    id: "ex-8",
    kind: "RETROACTIVE",
    status: "RETRO_REVIEW",
    ...vendor("vercel"),
    item: "Vercel 커스텀 도메인 추가 요금",
    quote: quote(10_000, 1_000, "r-vercel", { vendor_text: "Vercel Inc.", merchant: "vercel", item: "custom domain add-on" }),
    maximum: 11_000,
    review_deadline: t(10, 17, 8),
    decision: {
      result: "HOLD",
      reason: "retroactive",
      rules: rules({ name: "Vercel", category_ko: "호스팅", total: 11_000 }, { funds: [null, "사후 청구: 승인 시 가용 잔액에서 정산"] }),
    },
  }),
  expense({
    id: "ex-9",
    status: "EXPIRED",
    hold_class: "CLIENT_REVIEW",
    ...vendor("vercel"),
    item: "Vercel 팀 좌석 추가 1석",
    quote: quote(25_000, 2_500, "q-vercel", { vendor_text: "Vercel Inc.", merchant: "vercel", item: "Pro seat add-on" }),
    maximum: 27_500,
    review_deadline: t(10, 11, 10),
    decision: {
      result: "HOLD",
      reason: "split_pattern",
      rules: rules({ name: "Vercel", category_ko: "호스팅", total: 27_500 }, { split_pattern: [false, "같은 공급자에 같은 금액 요청이 같은 날 2건"] }),
    },
  }),
  expense({
    id: "ex-10",
    status: "EVIDENCE_SUBMITTED",
    hold_class: "EVIDENCE_DEFECT",
    ...vendor("adobe-stock"),
    item: "스톡 사진 5장 (매장 인테리어)",
    quote: quote(35_000, 3_500, "q-adobe", { vendor_text: "Adobe Stock", merchant: "adobe-stock", item: "사진 5장 표준 라이선스" }),
    maximum: 38_500,
    reserved: 38_500,
    expires_at: t(10, 14, 11),
    spent_at: t(10, 9, 14),
    evidence_deadline: t(10, 16, 14),
    receipt: {
      document: ref("r-adobe-photo"),
      manifest_hash: h0x("manifest:r-adobe-photo"),
      claimed: 38_500,
      reading: reading(
        { vendor_text: "Adobe Stock", item: "사진 5장", total: null, payee: "한결■■■■■" },
        { ok: false, problems: ["영수증에서 결제 금액을 읽을 수 없음", "결제자(수취인) 이름이 잘려 있음"] },
      ),
      eligible: null,
      at: t(10, 13, 20),
    },
    review_deadline: t(10, 16, 20),
    decision: {
      result: "HOLD",
      reason: "evidence_defect",
      rules: rules(
        { name: "Adobe Stock", category_ko: "디자인 소스", total: 38_500 },
        { evidence: [false, "금액·결제자를 확인할 수 없음 (E1, 필수 필드 누락)"] },
      ),
    },
  }),
  expense({
    id: "ex-11",
    status: "PARTIALLY_SETTLED",
    hold_class: "EXCESS_AMOUNT",
    ...vendor("gabia"),
    item: "웹호스팅 1년 (비즈니스)",
    quote: quote(80_000, 8_000, "r-gabia-hosting", { vendor_text: "(주)가비아", merchant: "gabia", item: "웹호스팅 비즈니스 1년" }),
    maximum: 88_000,
    expires_at: t(10, 12, 9),
    spent_at: t(10, 6, 9),
    evidence_deadline: t(10, 13, 9),
    receipt: {
      document: ref("r-gabia-hosting"),
      manifest_hash: h0x("manifest:r-gabia-hosting"),
      claimed: 96_800,
      reading: reading({ vendor_text: "(주)가비아", total: 96_800, date: "2026-10-06" }, { problems: ["견적보다 8,800원 많음 (10월 6일 가격 인상)"] }),
      eligible: 96_800,
      at: t(10, 6, 20),
    },
    review_deadline: t(10, 9, 20),
    paid: 88_000,
    excess: 8_800,
    settlement: settle(88_000, t(10, 7, 16)),
    decision: { result: "APPROVE", reason: "ok", rules: rules({ name: "가비아", category_ko: "도메인", total: 88_000 }) },
  }),
]

const M1: Milestone = {
  id: "ms-1",
  title: "디자인 시안",
  version: 1,
  status: "DISPUTED",
  amount: 1_500_000,
  start_by: eod(10, 3),
  due_at: eod(10, 10),
  grace_until: eod(10, 12),
  units: [
    { id: "u-1", title: "메인 시안", criteria: ["데스크톱·모바일 시안 각 1종", "브랜드 컬러·로고 적용"], amount: 1_000_000, status: "PAID", reason: "클라이언트 승인 (10월 10일)" },
    { id: "u-2", title: "서브 페이지 시안", criteria: ["메뉴·매장 안내 페이지"], amount: 500_000, status: "DISPUTED", reason: null },
  ],
  submission: {
    at: t(10, 9, 18),
    units: ["u-1", "u-2"],
    note: "Figma 파일 ‘카페 온담 리뉴얼 v3’의 Main·Sub 페이지를 확인해 주세요. 모바일 프레임은 375px 기준입니다.",
    documents: [ref("d-design")],
  },
  review_deadline: t(10, 12, 18),
  resolver_deadline: t(10, 17, 15),
  objections: [{ unit: "u-2", criterion: "메뉴·매장 안내 페이지", reason_code: "MISSING", reason: "메뉴 페이지만 있고 매장 안내(위치·영업시간) 페이지 시안이 없습니다." }],
  paid: 1_000_000,
  returned: 0,
}

const M2: Milestone = {
  id: "ms-2",
  title: "반응형 퍼블리싱",
  version: 1,
  status: "DELIVERED",
  amount: 2_500_000,
  start_by: eod(10, 12),
  due_at: eod(10, 31),
  grace_until: eod(11, 3),
  units: [
    {
      id: "u-3",
      title: "반응형 웹 퍼블리싱",
      criteria: ["메인·메뉴·매장 안내 페이지 모바일·태블릿·데스크톱 대응", "시안과 같은 레이아웃·색상", "배포된 URL에서 확인 가능"],
      amount: 2_500_000,
      status: "CLAIMED",
      reason: null,
    },
  ],
  submission: {
    at: t(10, 13, 13),
    units: ["u-3"],
    note: "스테이징 주소에 배포했습니다. 브라우저 3종에서 확인했고, 확인 방법은 첨부 노트에 있습니다.",
    documents: [ref("d-publish")],
  },
  review_deadline: t(10, 16, 13),
  resolver_deadline: null,
  objections: [],
  paid: 0,
  returned: 0,
}

const M3: Milestone = {
  id: "ms-3",
  title: "운영 인수인계",
  version: 1,
  status: "FUNDED_AND_RESERVED",
  amount: 500_000,
  start_by: eod(11, 5),
  due_at: eod(11, 20),
  grace_until: eod(11, 22),
  units: [{ id: "u-4", title: "관리 가이드·계정 인계", criteria: ["관리 매뉴얼 PDF", "도메인·호스팅 관리자 권한 이전 확인"], amount: 500_000, status: "RESERVED", reason: null }],
  submission: null,
  review_deadline: null,
  resolver_deadline: null,
  objections: [],
  paid: 0,
  returned: 0,
}

const toPolicyMilestone = (m: Milestone): PolicyMilestone => ({
  id: m.id,
  title: m.title,
  amount: m.amount,
  start_by: m.start_by,
  due_at: m.due_at,
  grace_until: m.grace_until,
  units: m.units.map((u) => ({ id: u.id, title: u.title, criteria: u.criteria, amount: u.amount })),
})

const M4_POLICY: PolicyMilestone = {
  id: "ms-4",
  title: "회원 로그인",
  amount: 1_200_000,
  start_by: eod(11, 10),
  due_at: eod(11, 30),
  grace_until: eod(12, 3),
  units: [
    { id: "u-5", title: "카카오·이메일 로그인", criteria: ["카카오 로그인·이메일 가입 동작", "비밀번호 재설정 메일 발송"], amount: 800_000 },
    { id: "u-6", title: "회원 정보 페이지", criteria: ["회원 정보 조회·수정", "탈퇴 처리"], amount: 400_000 },
  ],
}

const FALLBACKS = [
  { case: "착수 기한까지 착수하지 않음", silence: "예약이 풀려 가용 잔액으로 돌아갑니다 (EXPIRED_UNUSED)", resolver_silence: null },
  { case: "납기 + 유예까지 제출 통지 없음", silence: "미제출(NON_DELIVERY)로 분쟁 해결에 넘어갑니다", resolver_silence: "미제출 단위 거절, 예약 반환" },
  { case: "제출물 검수 (클라이언트 72시간)", silence: "제출된 납품 단위 지급 (RELEASED_BY_TIMEOUT)", resolver_silence: null },
  { case: "납품 단위 이의 → 분쟁 해결 (7일)", silence: "분쟁 해결자가 판단", resolver_silence: "이의 단위 지급 (결함이 증명되지 않음)" },
  { case: "HOLD된 구매 약정 요청 (72시간)", silence: "만료 — 약속된 것 없음", resolver_silence: null },
  { case: "경비 예약 (7일)", silence: "구매 보고가 없으면 만료, 예산으로 반환", resolver_silence: null },
  { case: "구매 보고 뒤 증빙 제출 (7일)", silence: "증빙 결함(EVIDENCE_DEFECT)으로 분쟁 해결", resolver_silence: "거절" },
  { case: "영수증 정산 검토 · CLIENT_REVIEW (72시간)", silence: "약정 한도 안에서 지급", resolver_silence: "약정된 적격 금액 지급" },
  { case: "영수증 HOLD · POLICY_OR_SYSTEM_AMBIGUITY", silence: "분쟁 해결로 이관 (ESCALATED_BY_TIMEOUT)", resolver_silence: "청구액과 약정 한도 중 작은 금액 지급" },
  { case: "영수증 HOLD · EVIDENCE_DEFECT / INTEGRITY_RISK", silence: "분쟁 해결로 이관 (ESCALATED_BY_TIMEOUT)", resolver_silence: "거절" },
  { case: "약정 초과 금액 (EXCESS_AMOUNT)", silence: "약정분 지급, 초과분 미지급", resolver_silence: "초과분은 양자 변경 주문으로만" },
  { case: "사후 청구 (72시간)", silence: "거절 — 침묵만으로 지급 권리가 생기지 않음", resolver_silence: null },
]

const RULES_FORM = {
  source: "form" as const,
  words: null,
  readback: [
    "허용 공급자: AWS, Vercel, 가비아, Figma, Adobe Stock (그 밖의 공급자는 BLOCK)",
    "경비 예산: 500,000원",
    "건별 한도: 부가세·수수료 포함 200,000원 이하",
    "사용 기한: 2026년 10월 31일 23:59 (KST)까지",
  ],
  expressions: {
    budget: "500000",
    merchant_ok: 'm == "aws" || m == "vercel" || m == "gabia" || m == "figma" || m == "adobe-stock"',
    category_ok: "1",
    window_ok: 't <= "2026-10-31T23:59:59+09:00"',
    order_ok: "total <= 200000",
  },
  mandate_hash: h0x("mandate:p-cafe"),
  vendors: ["aws", "vercel", "gabia", "figma", "adobe-stock"],
  max_per_purchase: 200_000,
  until: "2026-10-31",
}

const PERIODS_SECONDS = {
  client_review_seconds: 72 * 3600,
  resolver_review_seconds: 7 * 86400,
  evidence_seconds: 7 * 86400,
  reservation_seconds: 7 * 86400,
}

const V1_MILESTONES = [M1, M2, M3].map(toPolicyMilestone)

const POLICY_A1: PolicyView = {
  version: 1,
  hash: h0x("policy:p-cafe:1"),
  previous_hash: null,
  status: "ACTIVE",
  kind: "initial",
  change_order_id: null,
  signatures: {
    client: { sig: h0x("sig:client:1"), at: t(10, 1, 10, 12) },
    contractor: { sig: h0x("sig:contractor:1"), at: t(10, 1, 14, 3) },
  },
  summary: {
    project_budget: 5_000_000,
    expense_budget: 500_000,
    milestone_budget: 4_500_000,
    initial_funding: 5_000_000,
    starts_at: t(10, 1, 15),
    ends_at: eod(12, 31),
    ...PERIODS_SECONDS,
  },
  rules: RULES_FORM,
  milestones: V1_MILESTONES,
  fallbacks: FALLBACKS,
  doc: {
    schema: "ploby.policy/1",
    project: A_ID,
    version: 1,
    asset: "KRW",
    parties: { client: PARTIES.client.address, contractor: PARTIES.contractor.address, resolver: PARTIES.resolver.address },
    budgets: { project: 5_000_000, expense: 500_000, milestone: 4_500_000, initial_funding: 5_000_000 },
    rules: { vendors: RULES_FORM.vendors, max_per_purchase: 200_000, until: "2026-10-31", mandate: RULES_FORM.mandate_hash },
    milestones: V1_MILESTONES.map((m) => ({ id: m.id, amount: m.amount, units: m.units.map((u) => [u.id, u.amount]) })),
    periods: PERIODS_SECONDS,
    ends_at: "2026-12-31",
  },
}

const POLICY_A2: PolicyView = {
  ...POLICY_A1,
  version: 2,
  hash: h0x("policy:p-cafe:2"),
  previous_hash: POLICY_A1.hash,
  status: "PROPOSED",
  kind: "change_order",
  change_order_id: "co-1",
  signatures: { client: { sig: h0x("sig:client:2"), at: t(10, 13, 18, 20) }, contractor: null },
  summary: { ...POLICY_A1.summary, project_budget: 6_200_000, milestone_budget: 5_700_000 },
  milestones: [...V1_MILESTONES, M4_POLICY],
  doc: {
    ...(POLICY_A1.doc as Record<string, unknown>),
    version: 2,
    previous: POLICY_A1.hash,
    change_order: "co-1",
    budgets: { project: 6_200_000, expense: 500_000, milestone: 5_700_000, initial_funding: 5_000_000 },
    milestones: [...V1_MILESTONES, M4_POLICY].map((m) => ({ id: m.id, amount: m.amount, units: m.units.map((u) => [u.id, u.amount]) })),
  },
}

// ledger: every number follows from the milestones and expenses above
const LEDGER_A: Ledger = (() => {
  const expense_reserved = EXPENSES_A.reduce((a, e) => a + e.reserved, 0) // 226,600
  const expense_released = EXPENSES_A.reduce((a, e) => a + e.paid, 0) // 112,200
  const milestone_reserved = [M1, M2, M3].reduce((a, m) => a + m.units.filter((u) => ["RESERVED", "CLAIMED", "DISPUTED"].includes(u.status)).reduce((b, u) => b + u.amount, 0), 0) // 3,500,000
  const milestone_released = [M1, M2, M3].reduce((a, m) => a + m.paid, 0) // 1,000,000
  const funded = 5_000_000
  const released = expense_released + milestone_released
  return {
    budget: 5_000_000,
    expense_budget: 500_000,
    milestone_budget: 4_500_000,
    funded,
    expense_reserved,
    milestone_reserved,
    expense_released,
    milestone_released,
    released,
    refunded: 0,
    migrated_out: 0,
    available: funded - expense_reserved - milestone_reserved - released,
    expense_capacity: 500_000 - expense_reserved - expense_released,
    milestone_capacity: 4_500_000 - milestone_reserved - milestone_released,
    deposit_room: 0,
    funding_needed: 0,
  }
})()

const CHANGE_ORDERS_A: ChangeOrder[] = [
  {
    id: "co-1",
    status: "PROPOSED",
    by: "client",
    text: "회원 로그인 기능도 추가해 주세요. 카카오 로그인이면 좋겠어요.",
    draft: {
      title: "회원 로그인",
      amount: 1_200_000,
      start_by: "2026-11-10",
      due_at: "2026-11-30",
      grace_days: 3,
      units: M4_POLICY.units.map((u) => ({ title: u.title, criteria: u.criteria, amount: u.amount })),
      note: "AI 초안에서 회원 정보 페이지 금액을 작업자와 협의해 400,000원으로 조정",
      expense_budget_delta: 0,
      covers_excess: null,
    },
    policy_version: 2,
    ai: { ok: true, problems: [], usage: { tokens: 4210, cost_usd: 0.0004, seconds: 5.2, cached: true } },
  },
  {
    id: "co-2",
    status: "DRAFT",
    by: "contractor",
    text: "가비아 웹호스팅 초과분 8,800원(10월 6일 가격 인상)을 경비 예산 증액으로 처리해 주세요.",
    draft: {
      title: "",
      amount: 0,
      start_by: null,
      due_at: null,
      grace_days: 0,
      units: [],
      note: "영수증 기준 초과분. 마일스톤 추가 없음.",
      expense_budget_delta: 8_800,
      covers_excess: "ex-11",
    },
    policy_version: null,
    ai: { ok: true, problems: [], usage: { tokens: 1980, cost_usd: 0.0002, seconds: 2.9, cached: true } },
  },
  {
    id: "co-3",
    status: "DRAFT",
    by: "client",
    text: "메뉴판 사진 촬영도 같이 해 주실 수 있나요?",
    draft: {
      title: "메뉴 사진 촬영",
      amount: 600_000,
      start_by: "2026-11-02",
      due_at: "2026-11-09",
      grace_days: 2,
      units: [{ title: "메뉴 사진 20컷", criteria: ["메뉴 20종 각 1컷 보정본", "웹용 2000px JPG"], amount: 600_000 }],
      note: "",
      expense_budget_delta: 0,
      covers_excess: null,
    },
    policy_version: null,
    ai: { ok: true, problems: ["촬영 장소·일정은 초안에 없습니다. 두 당사자가 정해야 합니다."], usage: { tokens: 3650, cost_usd: 0.0004, seconds: 4.8, cached: true } },
  },
]

const ms = (id: string): Target => ({ kind: "milestone", id })
const ex = (id: string): Target => ({ kind: "expense", id })
const co = (id: string): Target => ({ kind: "change_order", id })
const proj = (id: string): Target => ({ kind: "project", id })

const act = (action: string, target: Target | null, label: string, extra: Partial<Action> = {}): Action => ({
  action,
  target,
  label,
  deadline: null,
  fallback: null,
  needs_response: false,
  ...extra,
})

function changeOrderActions(): Action[] {
  return [
    act("withdraw_change_order", co("co-1"), "변경 주문 철회"),
    act("edit_change_order", co("co-2"), "초안 수정"),
    act("propose_change_order", co("co-2"), "정식 제안"),
    act("withdraw_change_order", co("co-2"), "변경 주문 철회"),
    act("edit_change_order", co("co-3"), "초안 수정"),
    act("propose_change_order", co("co-3"), "정식 제안"),
    act("withdraw_change_order", co("co-3"), "변경 주문 철회"),
  ]
}

function actionsA(role: Role): Action[] {
  const p = proj(A_ID)
  if (role === "client")
    return [
      act("review_delivery", ms("ms-2"), "제출물 검수: 반응형 퍼블리싱", {
        deadline: t(10, 16, 13),
        fallback: "제출된 납품 단위 2,500,000원이 지급됩니다 (RELEASED_BY_TIMEOUT)",
        needs_response: true,
      }),
      act("review_settlement", ex("ex-5"), "정산 검토: Figma 영수증", { deadline: t(10, 16, 9), fallback: "청구액 39,600원이 지급됩니다", needs_response: true }),
      act("answer_request", ex("ex-3"), "HOLD 요청 응답: Adobe Stock 일러스트 팩", {
        deadline: t(10, 16, 16),
        fallback: "만료됩니다 (약속된 것 없음)",
        needs_response: true,
      }),
      act("escalate_settlement", ex("ex-10"), "분쟁 해결로 넘기기: Adobe Stock 사진 영수증", {
        deadline: t(10, 16, 20),
        fallback: "분쟁 해결로 넘어갑니다 (ESCALATED_BY_TIMEOUT)",
        needs_response: true,
      }),
      act("answer_request", ex("ex-8"), "사후 청구 응답: Vercel 커스텀 도메인", { deadline: t(10, 17, 8), fallback: "거절됩니다 (사전 약정 없음)", needs_response: true }),
      act("pause", p, "새 약정 일시정지"),
      act("begin_close", p, "종료 시작"),
      act("draft_change_order", p, "변경 주문 초안"),
      ...changeOrderActions(),
      act("run_timeouts", p, "타임아웃 실행"),
    ]
  if (role === "contractor")
    return [
      act("sign_policy", { kind: "policy", id: 2 }, "정책 v2 서명 (회원 로그인 변경 주문)", {
        fallback: "서명하지 않으면 변경 주문은 효력이 없습니다",
        needs_response: true,
      }),
      act("submit_receipt", ex("ex-6"), "영수증 제출: Vercel Pro", {
        deadline: t(10, 17, 12),
        fallback: "증빙 결함(EVIDENCE_DEFECT)으로 분쟁 해결에 넘어갑니다",
        needs_response: true,
      }),
      act("report_spend", ex("ex-4"), "구매 완료 보고: AWS Lightsail", { deadline: t(10, 19, 11), fallback: "예약이 만료되고 경비 예산으로 돌아갑니다", needs_response: true }),
      act("start_milestone", ms("ms-3"), "착수: 운영 인수인계", { deadline: eod(11, 5), fallback: "예약이 풀려 가용 잔액으로 돌아갑니다 (EXPIRED_UNUSED)", needs_response: true }),
      act("cancel_milestone", ms("ms-3"), "마일스톤 취소"),
      act("cancel_reservation", ex("ex-4"), "예약 취소"),
      act("supplement_evidence", ex("ex-10"), "증빙 보완", { deadline: t(10, 16, 20) }),
      act("request_commitment", p, "구매 약정 요청"),
      act("retroactive_request", p, "사후 청구"),
      act("draft_change_order", p, "변경 주문 초안"),
      ...changeOrderActions(),
      act("begin_close", p, "종료 시작"),
      act("run_timeouts", p, "타임아웃 실행"),
    ]
  return [
    act("resolve_milestone", ms("ms-1"), "분쟁 해결: 디자인 시안 · 서브 페이지 시안", {
      deadline: t(10, 17, 15),
      fallback: "이의 단위 500,000원이 지급됩니다 (결함이 증명되지 않음)",
      needs_response: true,
    }),
    act("resolve_expense", ex("ex-7"), "분쟁 해결: AWS 10월 사용료", {
      deadline: t(10, 18, 17, 30),
      fallback: "약정된 적격 금액 52,800원이 지급됩니다 (CLIENT_REVIEW)",
      needs_response: true,
    }),
    act("run_timeouts", p, "타임아웃 실행"),
  ]
}

const DEADLINES_A: Deadline[] = [
  { target: ex("ex-5"), label: "정산 검토 기한 · Figma", at: t(10, 16, 9), owner: "client", fallback: "청구액 39,600원 지급" },
  { target: ms("ms-2"), label: "제출물 검수 기한 · 반응형 퍼블리싱", at: t(10, 16, 13), owner: "client", fallback: "제출 단위 2,500,000원 지급" },
  { target: ex("ex-3"), label: "HOLD 응답 기한 · Adobe Stock 일러스트", at: t(10, 16, 16), owner: "client", fallback: "만료 (약속 없음)" },
  { target: ex("ex-10"), label: "정산 검토 기한 · Adobe Stock 사진 (증빙 결함)", at: t(10, 16, 20), owner: "client", fallback: "분쟁 해결로 이관 (ESCALATED_BY_TIMEOUT)" },
  { target: ex("ex-8"), label: "사후 청구 응답 기한 · Vercel 도메인", at: t(10, 17, 8), owner: "client", fallback: "거절 (사전 약정 없음)" },
  { target: ex("ex-6"), label: "증빙 제출 기한 · Vercel Pro", at: t(10, 17, 12), owner: "contractor", fallback: "EVIDENCE_DEFECT로 분쟁 해결" },
  { target: ms("ms-1"), label: "분쟁 해결 기한 · 디자인 시안", at: t(10, 17, 15), owner: "resolver", fallback: "이의 단위 지급 (결함이 증명되지 않음)" },
  { target: ex("ex-7"), label: "분쟁 해결 기한 · AWS 10월 사용료", at: t(10, 18, 17, 30), owner: "resolver", fallback: "약정된 적격 금액 지급" },
  { target: ex("ex-4"), label: "예약 만료 · AWS Lightsail", at: t(10, 19, 11), owner: "contractor", fallback: "예약 만료, 경비 예산으로 반환" },
  { target: ms("ms-3"), label: "착수 기한 · 운영 인수인계", at: eod(11, 5), owner: "contractor", fallback: "예약 해제 (EXPIRED_UNUSED)" },
]

function makeLog(project: string, rows: [number, LogEntry["by"], string, string][]): LogEntry[] {
  return [...rows]
    .sort((a, b) => a[0] - b[0])
    .map(([at, by, op, text], i) => ({ i: i + 1, at, by, op, text, head: h0x(`head:${project}:${i + 1}`) }))
}

const LOG_A = makeLog(A_ID, [
  [t(10, 1, 9, 30), "client", "create", "프로젝트 ‘카페 온담 홈페이지 리뉴얼’ 초안과 정책 v1을 만들었습니다"],
  [t(10, 1, 10, 12), "client", "sign_policy", "클라이언트가 정책 v1에 서명했습니다"],
  [t(10, 1, 14, 3), "contractor", "sign_policy", "작업자가 정책 v1에 서명했습니다"],
  [t(10, 1, 15), "client", "deposit", "5,000,000원 입금 — 진행 중, 마일스톤 3개 4,500,000원 예약"],
  [t(10, 2, 11), "contractor", "request_commitment", "가비아 도메인 24,200원 구매 약정 — APPROVE, 예약"],
  [t(10, 2, 15), "contractor", "report_spend", "가비아 도메인 구매 완료 보고"],
  [t(10, 3, 10), "contractor", "submit_receipt", "가비아 영수증 제출 통지 (청구 24,200원)"],
  [t(10, 3, 11, 20), "contractor", "start_milestone", "디자인 시안 착수"],
  [t(10, 3, 14), "contractor", "request_commitment", "쿠팡 기계식 키보드 89,000원 — BLOCK (범위 밖 공급자)"],
  [t(10, 4, 15), "contractor", "request_commitment", "Figma 2석 39,600원 구매 약정 — APPROVE, 예약"],
  [t(10, 5, 9), "contractor", "request_commitment", "가비아 웹호스팅 88,000원 구매 약정 — APPROVE, 예약"],
  [t(10, 5, 10), "contractor", "request_commitment", "AWS 10월 사용료 55,000원 구매 약정 — APPROVE, 예약"],
  [t(10, 5, 18), "contractor", "report_spend", "AWS 10월 사용료 구매 완료 보고"],
  [t(10, 6, 9), "contractor", "report_spend", "가비아 웹호스팅 구매 완료 보고"],
  [t(10, 6, 10), "keeper", "timeout", "가비아 도메인 정산 검토 기한 경과 — 24,200원 지급 (RELEASED_BY_TIMEOUT)"],
  [t(10, 6, 20), "contractor", "submit_receipt", "가비아 웹호스팅 영수증 제출 통지 (청구 96,800원)"],
  [t(10, 7, 11), "contractor", "request_commitment", "Adobe Stock 사진 5장 38,500원 구매 약정 — APPROVE, 예약"],
  [t(10, 7, 16), "client", "review_settlement", "가비아 웹호스팅 승인 — 약정분 88,000원 지급, 초과분 8,800원 미지급 (EXCESS_AMOUNT)"],
  [t(10, 8, 10), "contractor", "request_commitment", "Vercel 팀 좌석 27,500원 — HOLD (분할 청구 패턴 신호)"],
  [t(10, 8, 12), "contractor", "request_commitment", "Vercel Pro 27,500원 구매 약정 — APPROVE, 예약"],
  [t(10, 8, 15), "contractor", "report_spend", "Figma 구매 완료 보고"],
  [t(10, 8, 18), "contractor", "submit_receipt", "AWS 10월 사용료 영수증 제출 통지 (청구 52,800원)"],
  [t(10, 9, 14), "contractor", "report_spend", "Adobe Stock 사진 구매 완료 보고"],
  [t(10, 9, 18), "contractor", "submit_delivery", "디자인 시안 제출 통지 — 메인 시안, 서브 페이지 시안 (1,500,000원)"],
  [t(10, 10, 12), "contractor", "report_spend", "Vercel Pro 구매 완료 보고"],
  [t(10, 10, 15), "client", "review_delivery", "메인 시안 승인 — 1,000,000원 지급 · 서브 페이지 시안 이의 (누락) → 분쟁 해결"],
  [t(10, 11, 10), "keeper", "timeout", "Vercel 팀 좌석 HOLD 응답 기한 경과 — 만료 (약속 없음)"],
  [t(10, 11, 11), "contractor", "start_milestone", "반응형 퍼블리싱 착수"],
  [t(10, 11, 17, 30), "client", "review_settlement", "AWS 10월 사용료 이의 — 분쟁 해결로 (CLIENT_REVIEW)"],
  [t(10, 12, 11), "contractor", "request_commitment", "AWS Lightsail 66,000원 구매 약정 — APPROVE, 예약"],
  [t(10, 13, 9), "contractor", "submit_receipt", "Figma 영수증 제출 통지 (청구 39,600원)"],
  [t(10, 13, 13), "contractor", "submit_delivery", "반응형 퍼블리싱 제출 통지 (2,500,000원)"],
  [t(10, 13, 16), "contractor", "request_commitment", "Adobe Stock 일러스트 팩 141,900원 — HOLD (가격 이상 신호)"],
  [t(10, 13, 17, 40), "client", "draft_change_order", "범위 밖 요청 ‘회원 로그인’ → AI 변경 주문 초안 co-1"],
  [t(10, 13, 18, 20), "client", "propose_change_order", "변경 주문 co-1을 정책 v2로 제안하고 서명했습니다"],
  [t(10, 13, 20), "contractor", "submit_receipt", "Adobe Stock 사진 영수증 제출 통지 — 증빙 결함(EVIDENCE_DEFECT)"],
  [t(10, 13, 21), "contractor", "draft_change_order", "가비아 웹호스팅 초과분 8,800원 → 변경 주문 초안 co-2"],
  [t(10, 14, 8), "contractor", "retroactive_request", "Vercel 커스텀 도메인 11,000원 사후 청구"],
  [t(10, 14, 9, 10), "client", "draft_change_order", "범위 밖 요청 ‘메뉴 사진 촬영’ → 변경 주문 초안 co-3"],
])

function viewA(role: Role): ProjectView {
  return {
    id: A_ID,
    name: "카페 온담 홈페이지 리뉴얼",
    status: "ACTIVE",
    paused: false,
    now: now(),
    created_at: t(10, 1, 9, 30),
    viewer: PARTIES[role],
    parties: { client: PARTIES.client, contractor: PARTIES.contractor, resolver: PARTIES.resolver },
    policy: POLICY_A1,
    proposals: [POLICY_A2],
    versions: [{ ...POLICY_A1 }, POLICY_A2],
    ledger: LEDGER_A,
    milestones: [M1, M2, M3],
    expenses: EXPENSES_A,
    change_orders: CHANGE_ORDERS_A,
    actions: actionsA(role),
    deadlines: DEADLINES_A,
    log: LOG_A,
    head: LOG_A[LOG_A.length - 1].head,
  }
}

// ---------------------------------------------------------------- project B: 원두 정기구독 페이지 (DRAFT)

const B_ID = "p-subs"

const B_MILESTONES: PolicyMilestone[] = [
  {
    id: "ms-b1",
    title: "정기구독 결제 화면",
    amount: 2_000_000,
    start_by: eod(11, 2),
    due_at: eod(11, 25),
    grace_until: eod(11, 28),
    units: [
      { id: "u-b1", title: "구독 상품 선택·주기 설정", criteria: ["원두 3종·주기 2주/4주 선택", "모바일 375px 대응"], amount: 1_200_000 },
      { id: "u-b2", title: "결제·구독 관리 페이지", criteria: ["테스트 결제 성공·실패 처리", "구독 일시중지·해지"], amount: 800_000 },
    ],
  },
]

const POLICY_B1: PolicyView = {
  version: 1,
  hash: h0x("policy:p-subs:1"),
  previous_hash: null,
  status: "PROPOSED",
  kind: "initial",
  change_order_id: null,
  signatures: { client: { sig: h0x("sig:client:b1"), at: t(10, 14, 9, 40) }, contractor: null },
  summary: {
    project_budget: 2_300_000,
    expense_budget: 300_000,
    milestone_budget: 2_000_000,
    initial_funding: 2_300_000,
    starts_at: null,
    ends_at: eod(12, 31),
    ...PERIODS_SECONDS,
  },
  rules: {
    source: "words",
    words: "정기구독 페이지 경비는 AWS, Vercel, Figma에서만 결제. 총 30만원, 부가세 포함 한 건에 10만원 이하, 11월 30일까지.",
    readback: ["허용 공급자: AWS, Vercel, Figma", "경비 예산: 300,000원", "건별 한도: 부가세·수수료 포함 100,000원 이하", "사용 기한: 2026년 11월 30일 23:59 (KST)까지"],
    expressions: { budget: "30만", merchant_ok: 'm == "aws" || m == "vercel" || m == "figma"', category_ok: "1", window_ok: 't <= "2026-11-30T23:59:59+09:00"', order_ok: "total <= 100000" },
    mandate_hash: h0x("mandate:p-subs"),
    vendors: ["aws", "vercel", "figma"],
    max_per_purchase: 100_000,
    until: "2026-11-30",
  },
  milestones: B_MILESTONES,
  fallbacks: FALLBACKS,
  doc: {
    schema: "ploby.policy/1",
    project: B_ID,
    version: 1,
    asset: "KRW",
    budgets: { project: 2_300_000, expense: 300_000, milestone: 2_000_000, initial_funding: 2_300_000 },
    rules: { source: "words", pick: "writer", mandate: h0x("mandate:p-subs") },
  },
}

const B_VIEW_MILESTONES: Milestone[] = B_MILESTONES.map((m) => ({
  id: m.id,
  title: m.title,
  version: 1,
  status: "PLANNED",
  amount: m.amount,
  start_by: m.start_by,
  due_at: m.due_at,
  grace_until: m.grace_until,
  units: m.units.map((u) => ({ ...u, status: "PLANNED", reason: null })),
  submission: null,
  review_deadline: null,
  resolver_deadline: null,
  objections: [],
  paid: 0,
  returned: 0,
}))

const LEDGER_B: Ledger = {
  budget: 2_300_000,
  expense_budget: 300_000,
  milestone_budget: 2_000_000,
  funded: 0,
  expense_reserved: 0,
  milestone_reserved: 0,
  expense_released: 0,
  milestone_released: 0,
  released: 0,
  refunded: 0,
  migrated_out: 0,
  available: 0,
  expense_capacity: 300_000,
  milestone_capacity: 2_000_000,
  deposit_room: 2_300_000,
  funding_needed: 2_300_000,
}

const LOG_B = makeLog(B_ID, [
  [t(10, 14, 9, 35), "client", "create", "프로젝트 ‘원두 정기구독 페이지’ 초안과 정책 v1을 만들었습니다 (문장 규칙, 작성 해석 선택)"],
  [t(10, 14, 9, 40), "client", "sign_policy", "클라이언트가 정책 v1에 서명했습니다"],
])

function actionsB(role: Role): Action[] {
  const p = proj(B_ID)
  if (role === "client")
    return [
      act("deposit", p, "초기 자금 입금 (2,300,000원)", { needs_response: true }),
      act("cancel_project", p, "프로젝트 취소"),
    ]
  if (role === "contractor")
    return [act("sign_policy", { kind: "policy", id: 1 }, "정책 v1 검토 후 서명", { fallback: "양측이 서명하기 전에는 프로젝트가 시작되지 않습니다", needs_response: true })]
  return []
}

function viewB(role: Role): ProjectView {
  return {
    id: B_ID,
    name: "원두 정기구독 페이지",
    status: "DRAFT",
    paused: false,
    now: now(),
    created_at: t(10, 14, 9, 35),
    viewer: PARTIES[role],
    parties: { client: PARTIES.client, contractor: PARTIES.contractor, resolver: PARTIES.resolver },
    policy: null,
    proposals: [POLICY_B1],
    versions: [POLICY_B1],
    ledger: LEDGER_B,
    milestones: B_VIEW_MILESTONES,
    expenses: [],
    change_orders: [],
    actions: actionsB(role),
    deadlines: [],
    log: LOG_B,
    head: LOG_B[LOG_B.length - 1].head,
  }
}

// ---------------------------------------------------------------- rules compile

const CANDIDATE: RulesCandidate = {
  candidate: "c_fx01",
  agree: false,
  problems: [],
  differences: ["건별 한도: 작성 해석은 부가세 포함 200,000원, 검토 해석은 공급가 200,000원 (부가세 별도)"],
  options: [
    {
      source: "writer",
      ok: true,
      hash: h0x("cand:writer"),
      readback: ["허용 공급자: AWS, Vercel, 가비아, Figma, Adobe Stock", "경비 예산: 500,000원", "건별 한도: 부가세 포함 200,000원 이하", "사용 기한: 2026년 10월 31일까지"],
      expressions: { budget: "50만", merchant_ok: 'm == "aws" || m == "vercel" || m == "gabia" || m == "figma" || m == "adobe-stock"', order_ok: "total <= 200000" },
      error: null,
    },
    {
      source: "reader",
      ok: true,
      hash: h0x("cand:reader"),
      readback: ["허용 공급자: AWS, Vercel, 가비아, Figma, Adobe Stock", "경비 예산: 500,000원", "건별 한도: 공급가 200,000원 이하 (부가세 별도)", "사용 기한: 2026년 10월 31일까지"],
      expressions: { budget: "500000", merchant_ok: 'm == "aws" || m == "vercel" || m == "gabia" || m == "figma" || m == "adobe-stock"', order_ok: "amount <= 200000" },
      error: null,
    },
  ],
  usage: { calls: 2, tokens: 6183, cost_usd: 0.0005, seconds: 7.4, cached: true },
}

// ---------------------------------------------------------------- backend

function summary(v: ProjectView): ProjectSummary {
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    paused: v.paused,
    created_at: v.created_at,
    parties: v.parties,
    ledger: v.ledger,
    todo: v.actions.filter((a) => a.needs_response).length,
    next_deadline: v.deadlines[0] ?? null,
  }
}

const pause = () => new Promise((r) => setTimeout(r, 120))

export const fixtureBackend: Backend = {
  meta: async () => META,
  clock: async () => ({ now: now(), offset }),
  moveClock: async (body) => {
    if ("reset" in body) offset = 0
    else offset += body.advance * 1000
    return { now: now(), offset }
  },
  samples: async () => SAMPLES,
  uploadDocument: async (name, text) => {
    const id = hex(`upload:${text}`)
    DOCS.set(id, { id, name, text })
    return { id, name }
  },
  document: async (id) => DOCS.get(id) ?? { id, name: "문서", text: "(픽스처에 없는 문서)" },
  compileRules: async () => {
    await pause()
    return CANDIDATE
  },
  projects: async (as) => [summary(viewA(as)), summary(viewB(as))],
  createProject: async () => viewB("client"),
  project: async (id, as) => {
    if (id === B_ID) return viewB(as)
    if (id === A_ID) return viewA(as)
    throw new ApiError(`픽스처에 없는 프로젝트: ${id}`, "not_found", 404)
  },
  act: async (_id, as, action, params) => {
    throw new ApiError(`픽스처 모드: 서버에 보내지 않았습니다 — ${JSON.stringify({ as, action, ...params })}`, "fixture", 0)
  },
}
