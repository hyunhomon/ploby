// Every code -> Korean label map in one place, in PROJECT_OVERVIEW.md's terms (클라이언트,
// 작업자, 분쟁 해결자, 공급자, 카테고리, 건별 한도, 약정, 예약, 정산, 제출 통지, 변경 주문,
// 새 약정 일시정지, 종료). `label(map, code)` falls back to the raw code so an unknown value
// from the server is still visible, never hidden.

import type { Actor, Role } from "./types"
import i18n, { language } from "./i18n"

export type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "accent"

export function label(map: Record<string, string>, code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return "—"
  const source = map[code]
  return source ? caption(source) : code
}

/** Translate a Korean phrase the API sent. Amounts, ids, and parentheticals are filled back in. */
export function caption(text: string | null | undefined): string {
  if (text === null || text === undefined || text === "") return "—"
  return translate(text, 0)
}

function translate(text: string, depth: number): string {
  if (language() !== "en" || depth > 6) return text
  const exact = lookup(text)
  if (exact) return exact
  const id = text.match(/^([ECM]\d+)\s+([\s\S]+)$/)
  if (id && !id[2].includes(" — ")) {
    const rest = lookup(id[2]) ?? lookupParen(id[2])
    if (rest) return `${id[1]} ${rest}`
  }
  const version = text.match(/^정책 v(\d+)\s+(.+)$/)
  if (version) {
    const rest = translate(version[2], depth + 1)
    if (rest !== version[2]) return `Policy v${version[1]} ${rest}`
  }
  const onlyAmount = text.match(/^(\d{1,3}(?:,\d{3})*)원$/)
  if (onlyAmount) return `₩${onlyAmount[1]}`
  if (text.startsWith("타임아웃: ")) {
    const rest = text.slice("타임아웃: ".length)
    const rendered = translate(rest, depth + 1)
    if (rendered !== rest) return `Timeout: ${rendered}`
  }
  if (text.startsWith("마일스톤 예약:")) {
    const body = text.slice("마일스톤 예약:".length).replace(/\s*\([^)]*\)$/, "").trim()
    const items = body.split(", ").map((part) => {
      const item = part.match(/^([ECM]\d+)\s+(\d{1,3}(?:,\d{3})*원)$/)
      return item ? `${item[1]} ₩${item[2].slice(0, -1)}` : translate(part, depth + 1)
    })
    return `Milestones reserved: ${items.join(", ")} (FUNDED_AND_RESERVED, work can start)`
  }
  const blocked = text.match(/^(\S+) 요청 BLOCK$/)
  if (blocked) return `${blocked[1]} request blocked`
  const violated = text.match(/^(.+) 위반(?: \((.+)\))?$/)
  if (violated) {
    const head = translate(violated[1], depth + 1)
    if (head !== violated[1]) {
      const note = violated[2] ? translate(violated[2], depth + 1) : ""
      return note ? `${head} violated (${note})` : `${head} violated`
    }
  }
  const approveAt = text.indexOf(" APPROVE:")
  if (approveAt >= 0) {
    const tail = text.slice(approveAt + " APPROVE:".length).trim()
    const rendered = tail ? translate(tail, depth + 1) : ""
    return `${text.slice(0, approveAt)} approved${rendered ? `: ${rendered}` : ""}`
  }
  const started = text.match(/^작업자가 ([ECM]\d+) (.+) 작업을 시작했습니다 \((.+)\)$/)
  if (started) return `Contractor started ${started[1]} ${started[2]} (${translate(started[3], depth + 1)})`
  const remain = text.match(/^(.+) 잔여 (\d{1,3}(?:,\d{3})*원)$/)
  if (remain) return `${remain[1]} remaining ₩${remain[2].slice(0, -1)}`
  const anomaly = text.match(/^(.+) 대표값 (\d{1,3}(?:,\d{3})*원)의 (\d+)배 초과$/)
  if (anomaly) return `${anomaly[1]} is over ${anomaly[3]}× the typical ₩${anomaly[2].slice(0, -1)}`
  const parts = text.split(" — ")
  if (parts.length > 1) {
    const done = parts.map((part) => translate(part, depth + 1))
    if (done.some((part, i) => part !== parts[i])) return done.join(" — ")
  }
  const slotted = slot(text, depth)
  const hit = lookup(slotted.key)
  if (hit) return fill(hit, slotted.slots)
  return lookupParen(text) ?? text
}

function fill(template: string, slots: string[]): string {
  return template.replace(/\{(\d+)\}/g, (_, n: string) => slots[Number(n)] ?? "")
}

/** Pull variable pieces out so one caption covers every amount and id. */
function slot(text: string, depth: number): { key: string; slots: string[] } {
  const slots: string[] = []
  const put = (value: string) => {
    const i = slots.length
    slots.push(value)
    return `{${i}}`
  }
  let key = text.replace(/\(([^)]*[가-힣][^)]*)\)/g, (_full, inner: string) => {
    const rendered = translate(inner, depth + 1)
    return put(rendered === inner ? `(${inner})` : `(${rendered})`)
  })
  key = key.replace(/분쟁 해결자|클라이언트|작업자/g, (name) => put(lookup(name) ?? name))
  key = key.replace(/\b[ECM]\d+\b/g, (name) => put(name))
  key = key.replace(/[0-9a-f]{8,}…/g, (name) => put(name))
  key = key.replace(/\d{1,3}(?:,\d{3})*원/g, (amount) => put(`₩${amount.slice(0, -1)}`))
  key = key.replace(/\d+개/g, (count) => put(count.slice(0, -1)))
  key = key.replace(/\d+건/g, (count) => put(count.slice(0, -1)))
  key = key.replace(/v\d+/g, (name) => put(name))
  return { key, slots }
}

function lookup(text: string): string | null {
  if (!i18n.exists(text, { ns: "codes" })) return null
  const value = String(i18n.t(text, { ns: "codes" }))
  return value === text ? null : value
}

function lookupParen(text: string): string | null {
  const match = text.match(/^(.+?)\s+\((.+)\)$/)
  if (!match) return null
  const left = lookup(match[1].trim())
  const right = lookup(match[2].trim())
  if (!left && !right) return null
  return `${left ?? match[1]} (${right ?? match[2]})`
}

export function toneOf(map: Record<string, Tone>, code: string | null | undefined): Tone {
  if (!code) return "muted"
  return map[code] ?? "muted"
}

// ---------------------------------------------------------------- roles

export const ROLE_KO: Record<string, string> = {
  client: "클라이언트",
  contractor: "작업자",
  resolver: "분쟁 해결자",
  keeper: "타임아웃 실행 (keeper)",
}

/** Fallback names only: the real ones come from GET /api/meta roles. */
export const ROLE_NAME: Record<Role, string> = {
  client: "카페 온담",
  contractor: "한결웹스튜디오",
  resolver: "Ploby 분쟁 해결자",
}

export const ROLE_INTRO: Record<Role, string> = {
  client: "자금을 예치하고, 사전에 합의한 인수 기준과 규칙으로만 검토합니다. 수락된 약정은 혼자 취소할 수 없습니다.",
  contractor: "예약된 작업비와 구매 약정을 확인한 뒤 착수·구매하세요. 모든 검토에는 기한과 침묵 시 결과가 있습니다.",
  resolver: "이의가 제기된 건만, 사전에 정의된 기준과 금액 한도 안에서 판단합니다. 수취인·금액·정책은 바꿀 수 없습니다.",
}

export const ROLES: Role[] = ["client", "contractor", "resolver"]

export function actorLabel(by: Actor | string): string {
  return label(ROLE_KO, by)
}

// ---------------------------------------------------------------- project

export const PROJECT_STATUS: Record<string, string> = {
  DRAFT: "초안",
  ACTIVE: "진행 중",
  CLOSING: "종료 중",
  CLOSED: "종료",
  CANCELLED: "취소",
}

export const PROJECT_STATUS_HELP: Record<string, string> = {
  DRAFT: "서명·초기자금 미완료",
  ACTIVE: "새 약정·제출·정산·정책 변경 가능",
  CLOSING: "새 약정 불가 · 기존 의무 처리와 미예약 잔액 환불",
  CLOSED: "모든 의무와 환불 종료 · 읽기 전용",
  CANCELLED: "활성 의무 없이 취소됨",
}

export const PROJECT_TONE: Record<string, Tone> = {
  DRAFT: "warn",
  ACTIVE: "ok",
  CLOSING: "info",
  CLOSED: "muted",
  CANCELLED: "muted",
}

// ---------------------------------------------------------------- policy

export const POLICY_STATUS: Record<string, string> = {
  PROPOSED: "서명 대기",
  ACTIVE: "적용 중",
  SUPERSEDED: "이전 버전",
  WITHDRAWN: "철회됨",
}

export const POLICY_TONE: Record<string, Tone> = {
  PROPOSED: "warn",
  ACTIVE: "ok",
  SUPERSEDED: "muted",
  WITHDRAWN: "muted",
}

export const POLICY_KIND: Record<string, string> = {
  initial: "최초 정책",
  change_order: "변경 주문 반영",
}

export const RULES_SOURCE: Record<string, string> = {
  form: "양식",
  words: "문장",
  writer: "작성 해석",
  reader: "검토 해석",
}

export const EXPRESSION_KO: Record<string, string> = {
  budget: "총 한도",
  merchant_ok: "공급자 조건",
  category_ok: "카테고리 조건",
  window_ok: "기간 조건",
  order_ok: "건별 한도 조건",
  count_limit: "건수 한도",
}

// ---------------------------------------------------------------- milestones

export const MILESTONE_STATUS: Record<string, string> = {
  PLANNED: "서명됨 · 입금 대기",
  FUNDED_AND_RESERVED: "예약 완료 · 착수 가능",
  IN_PROGRESS: "작업 중",
  DELIVERED: "제출 통지 · 검수 중",
  DISPUTED: "이의 · 분쟁 해결 중",
  NON_DELIVERY: "미제출 · 분쟁 해결 중",
  PAID: "지급 완료",
  PARTIAL: "부분 지급",
  REJECTED: "거절",
  EXPIRED_UNUSED: "착수 기한 만료",
  CANCELLED: "취소",
}

export const MILESTONE_TONE: Record<string, Tone> = {
  PLANNED: "muted",
  FUNDED_AND_RESERVED: "info",
  IN_PROGRESS: "info",
  DELIVERED: "warn",
  DISPUTED: "warn",
  NON_DELIVERY: "bad",
  PAID: "ok",
  PARTIAL: "ok",
  REJECTED: "bad",
  EXPIRED_UNUSED: "muted",
  CANCELLED: "muted",
}

export const UNIT_STATUS: Record<string, string> = {
  PLANNED: "예정",
  RESERVED: "예약됨",
  CLAIMED: "제출됨",
  DISPUTED: "이의",
  PAID: "지급",
  RELEASED_BY_TIMEOUT: "기한 경과 지급",
  REJECTED: "거절",
  NOT_DELIVERED: "미제출",
  RETURNED: "예약 반환",
}

export const UNIT_TONE: Record<string, Tone> = {
  PLANNED: "muted",
  RESERVED: "info",
  CLAIMED: "warn",
  DISPUTED: "warn",
  PAID: "ok",
  RELEASED_BY_TIMEOUT: "ok",
  REJECTED: "bad",
  NOT_DELIVERED: "bad",
  RETURNED: "muted",
}

export const FINAL_MILESTONE = new Set(["PAID", "PARTIAL", "REJECTED", "EXPIRED_UNUSED", "CANCELLED"])

export const REASON_CODE: Record<string, string> = {
  NOT_MET: "기준 미충족",
  MISSING: "누락",
  DEFECTIVE: "결함",
}

export const REASON_CODES = ["NOT_MET", "MISSING", "DEFECTIVE"] as const

// ---------------------------------------------------------------- expenses

export const EXPENSE_KIND: Record<string, string> = {
  COMMITMENT: "구매 약정",
  RETROACTIVE: "사후 청구",
}

export const EXPENSE_STATUS: Record<string, string> = {
  HOLD_REVIEW: "HOLD · 클라이언트 검토",
  BLOCKED: "BLOCK",
  RESERVED: "예약됨",
  SPEND_REPORTED: "구매 완료 · 증빙 대기",
  EVIDENCE_SUBMITTED: "증빙 제출 · 검토 중",
  DISPUTED: "분쟁 해결 중",
  RETRO_REVIEW: "사후 청구 검토",
  SETTLED: "정산 완료",
  PARTIALLY_SETTLED: "부분 정산",
  REJECTED: "거절",
  EXPIRED: "만료",
  CANCELLED: "취소",
}

export const EXPENSE_TONE: Record<string, Tone> = {
  HOLD_REVIEW: "warn",
  BLOCKED: "bad",
  RESERVED: "info",
  SPEND_REPORTED: "info",
  EVIDENCE_SUBMITTED: "warn",
  DISPUTED: "warn",
  RETRO_REVIEW: "warn",
  SETTLED: "ok",
  PARTIALLY_SETTLED: "ok",
  REJECTED: "bad",
  EXPIRED: "muted",
  CANCELLED: "muted",
}

export const FINAL_EXPENSE = new Set(["BLOCKED", "SETTLED", "PARTIALLY_SETTLED", "REJECTED", "EXPIRED", "CANCELLED"])

export const PAYMENT_MODE: Record<string, string> = {
  REIMBURSEMENT: "작업자 환급",
  DIRECT_VENDOR: "공급자 직접 지급",
}

export const ASSURANCE: Record<string, string> = {
  E0: "E0 · 주장만 존재",
  E1: "E1 · 파일 보존 (발급처 미인증)",
  E2: "E2 · DKIM 검증 이메일",
  E3: "E3 · 공급자 API·서명 자격증명",
}

export const TIMEOUT: Record<string, string> = {
  RELEASED_BY_TIMEOUT: "기한 경과 지급",
  ESCALATED_BY_TIMEOUT: "기한 경과 · 분쟁 해결로 이관",
  REJECTED_BY_TIMEOUT: "기한 경과 거절",
}

export const TIMEOUT_TONE: Record<string, Tone> = {
  RELEASED_BY_TIMEOUT: "ok",
  ESCALATED_BY_TIMEOUT: "warn",
  REJECTED_BY_TIMEOUT: "bad",
}

export const HOLD_CLASS: Record<string, string> = {
  CLIENT_REVIEW: "비즈니스 검토",
  POLICY_OR_SYSTEM_AMBIGUITY: "정책·시스템 모호",
  EVIDENCE_DEFECT: "증빙 결함",
  INTEGRITY_RISK: "무결성 위험",
  EXCESS_AMOUNT: "약정 초과",
}

export const HOLD_CLASS_HELP: Record<string, string> = {
  CLIENT_REVIEW: "객관적 실패 없이 비즈니스 검토 또는 클라이언트 이의가 필요",
  POLICY_OR_SYSTEM_AMBIGUITY: "적시 제출은 완전하지만 파서·정책 엔진·증빙 결과가 불명확하거나 사용 불가",
  EVIDENCE_DEFECT: "증빙 누락·손상·지연 또는 금액·수취인 확인 실패",
  INTEGRITY_RISK: "서명 문제, 유력한 중복, 근거 있는 사기 신호",
  EXCESS_AMOUNT: "적격 실제 비용이 약정 상한을 초과",
}

/** What resolver silence does, per HOLD class (PROJECT_OVERVIEW.md §6). */
export const HOLD_RESOLVER_SILENCE: Record<string, string> = {
  CLIENT_REVIEW: "약정된 적격 금액이 지급됩니다",
  POLICY_OR_SYSTEM_AMBIGUITY: "청구액과 약정 한도 중 작은 금액이 지급됩니다",
  EVIDENCE_DEFECT: "거절됩니다 (지급 없음)",
  INTEGRITY_RISK: "거절됩니다 (지급 없음)",
  EXCESS_AMOUNT: "약정분만 지급되고 초과분은 변경 주문이 필요합니다",
}

/** HOLD classes the client cannot approve: a mandatory evidence / integrity rule is not waivable. */
export const NON_WAIVABLE_HOLD = new Set(["EVIDENCE_DEFECT", "INTEGRITY_RISK", "POLICY_OR_SYSTEM_AMBIGUITY"])

export const HOLD_TONE: Record<string, Tone> = {
  CLIENT_REVIEW: "warn",
  POLICY_OR_SYSTEM_AMBIGUITY: "warn",
  EVIDENCE_DEFECT: "bad",
  INTEGRITY_RISK: "bad",
  EXCESS_AMOUNT: "warn",
}

export const DECISION: Record<string, string> = {
  APPROVE: "APPROVE",
  HOLD: "HOLD",
  BLOCK: "BLOCK",
}

export const DECISION_KO: Record<string, string> = {
  APPROVE: "승인",
  HOLD: "검토 보류",
  BLOCK: "차단",
}

export const DECISION_TONE: Record<string, Tone> = {
  APPROVE: "ok",
  HOLD: "warn",
  BLOCK: "bad",
}

/** Rule ids, in PROJECT_OVERVIEW.md §6 decision order. */
export const RULE_KO: Record<string, string> = {
  allocation: "인보이스 배분 (100% 초과 금지)",
  state: "프로젝트 상태",
  window: "허용 기간",
  payment_mode: "결제 방식",
  vendor: "공급자",
  category: "카테고리",
  payee: "수취인",
  per_purchase: "건별 한도",
  expense_budget: "경비 예산",
  category_budget: "카테고리 예산 잔여",
  funds: "예약 가능 자금",
  evidence: "증빙",
  probable_duplicate: "유력한 중복",
  split_pattern: "분할 청구 패턴",
  price_anomaly: "가격 이상",
  // older ids
  merchant: "공급자",
  order: "건별 한도",
  capacity: "경비 잔여 한도",
  duplicate: "중복 청구",
}

export const RULE_ORDER = [
  "allocation",
  "state",
  "window",
  "payment_mode",
  "vendor",
  "category",
  "payee",
  "per_purchase",
  "expense_budget",
  "category_budget",
  "funds",
  "evidence",
  "probable_duplicate",
  "split_pattern",
  "price_anomaly",
]

export const RULE_KIND: Record<string, string> = {
  mandatory: "필수 규칙",
  evidence: "증빙",
  risk: "위험 신호",
}

/** Default kind for a rule id when the server leaves `kind` out. */
export const RULE_DEFAULT_KIND: Record<string, "mandatory" | "risk" | "evidence"> = {
  evidence: "evidence",
  probable_duplicate: "risk",
  split_pattern: "risk",
  price_anomaly: "risk",
}

export const REASON_KO: Record<string, string> = {
  ok: "정책 안의 지출",
  merchant_not_allowed: "허용 목록에 없는 공급자",
  vendor_not_allowed: "허용 목록에 없는 공급자",
  category_not_allowed: "허용되지 않은 카테고리",
  over_order_limit: "건별 한도 초과",
  over_per_purchase: "건별 한도 초과",
  outside_window: "허용 기간 밖",
  over_budget: "경비 예산 초과",
  over_capacity: "예약 가능 자금 부족",
  over_count: "건수 한도 초과",
  invalid_amount: "금액이 올바르지 않음",
  unreadable: "AI 판독을 신뢰할 수 없음",
  stopped: "새 약정 일시정지 중",
  paused: "새 약정 일시정지 중",
  closing: "종료 중인 프로젝트",
  duplicate: "이미 청구된 문서",
  allocation: "같은 문서가 이미 100% 배분됨",
  hold_rejected: "클라이언트가 HOLD 건 거절",
  accepted: "클라이언트 승인",
  review_timeout: "검토 기한 내 이의 없음 (사전 합의: 지급)",
  retroactive: "사전 약정 없는 사후 청구",
  out_of_scope: "범위 밖",
  price_anomaly: "가격 이상 신호 — 클라이언트 검토",
  split_pattern: "분할 청구 패턴 신호 — 클라이언트 검토",
  probable_duplicate: "유력한 중복 신호 — 클라이언트 검토",
  evidence_defect: "증빙 결함",
  over_category_budget: "카테고리 예산 초과",
}

export const READING_FIELD_KO: Record<string, string> = {
  vendor: "공급자",
  vendor_text: "문서상 공급자",
  merchant: "공급자 ID",
  category: "카테고리",
  item: "품목",
  amount: "공급가액",
  fee: "부가세·수수료",
  total: "합계",
  date: "일자",
  units: "수량",
  currency: "통화",
  invoice: "문서 번호",
  document_number: "문서 번호",
  issued_at: "발행일",
  valid_until: "유효기간",
  payee: "수취인",
  invoice_no: "문서 번호",
  amount_text: "공급가액 (문서 표기)",
  fee_text: "부가세·수수료 (문서 표기)",
  total_text: "합계 (문서 표기)",
}

// ---------------------------------------------------------------- change orders

export const CO_STATUS: Record<string, string> = {
  DRAFT: "초안 (효력 없음)",
  PROPOSED: "서명 대기",
  SIGNED: "서명 완료 · 입금 대기",
  FUNDED: "입금 완료 · 예약됨",
  WITHDRAWN: "철회",
}

export const CO_TONE: Record<string, Tone> = {
  DRAFT: "muted",
  PROPOSED: "warn",
  SIGNED: "info",
  FUNDED: "ok",
  WITHDRAWN: "muted",
}

// ---------------------------------------------------------------- actions and targets

export const TARGET_KO: Record<string, string> = {
  project: "프로젝트",
  policy: "정책",
  milestone: "마일스톤",
  expense: "경비",
  change_order: "변경 주문",
}

/** Used only when the server's Action has no label. */
export const ACTION_KO: Record<string, string> = {
  sign_policy: "정책 서명",
  deposit: "입금",
  cancel_project: "프로젝트 취소",
  pause: "새 약정 일시정지",
  resume: "일시정지 해제",
  begin_close: "종료 시작",
  withdraw: "미예약 잔액 환불",
  start_milestone: "착수",
  cancel_milestone: "마일스톤 취소",
  submit_delivery: "제출 통지",
  review_delivery: "제출물 검수",
  resolve_milestone: "마일스톤 분쟁 해결",
  request_commitment: "구매 약정 요청",
  retroactive_request: "사후 청구",
  answer_request: "HOLD 요청 응답",
  cancel_reservation: "예약 취소",
  report_spend: "구매 완료 보고",
  submit_receipt: "영수증 제출",
  supplement_evidence: "증빙 보완",
  review_settlement: "정산 검토",
  escalate_settlement: "분쟁 해결로 넘기기",
  resolve_expense: "경비 분쟁 해결",
  draft_change_order: "변경 주문 초안",
  edit_change_order: "초안 수정",
  propose_change_order: "정식 제안",
  withdraw_change_order: "변경 주문 철회",
  run_timeouts: "타임아웃 실행",
}

export const ERROR_CODE_KO: Record<string, string> = {
  forbidden: "권한 없음",
  state: "지금 상태에서는 불가",
  invalid: "입력 오류",
  deadline: "기한 문제",
}
