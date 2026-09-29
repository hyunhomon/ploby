// Types mirroring docs/api.md (the Ploby API contract). Money is integer KRW; times are
// milliseconds since 1970 (UTC) on the demo clock; request dates are 'YYYY-MM-DD' (KST).

export type Role = "client" | "contractor" | "resolver"
export type Actor = Role | "keeper" | "relayer"
export type Ms = number
/** 'YYYY-MM-DD' (KST); `start_by` / `due_at` / `until` / `ends_at` mean the end of that day. */
export type DateStr = string
/** Ids are strings in practice; policy targets may carry the version number. */
export type Id = string | number

export interface Party {
  role: Role
  name: string
  address: string
}

// ---------------------------------------------------------------- meta, clock, documents

export interface Periods {
  client_review_hours: number
  resolver_review_days: number
  evidence_days: number
  reservation_days: number
}

export interface Vendor {
  id: string
  name: string
  category: string
  category_ko: string
}

export interface Category {
  id: string
  name_ko: string
}

export interface Implementation {
  /** 현재 구현: what this repository runs today. */
  current: string[]
  /** 목표 설계: agreed in the ADRs, not implemented yet. */
  target: string[]
}

export interface ChainMeta {
  enabled: boolean
  network?: string
  chain_id?: number
  escrow?: string
  escrow_url?: string
  token?: string
  token_url?: string
  client_wallet?: string
  operator?: string
  explorer?: string
}

export interface Meta {
  roles: Party[]
  vendors: Vendor[]
  categories: Category[]
  defaults: Periods
  ai: { enabled: boolean; model: string | null }
  chain?: ChainMeta
  implementation?: Implementation
}

export interface Clock {
  now: Ms
  offset: number
}

export type SampleKind = "quote" | "receipt" | "delivery"

export interface Sample {
  id: string
  name: string
  kind: SampleKind
  text: string
}

export interface DocRef {
  id: string
  name: string
}

export interface Doc extends DocRef {
  text: string
}

export interface Usage {
  calls?: number
  tokens?: number
  cost_usd?: number
  /** What a cached call cost when it ran live. */
  recorded_cost_usd?: number
  seconds?: number
  cached?: boolean
}

// ---------------------------------------------------------------- rules compile

export type RulesSource = "writer" | "reader"

export interface RulesOption {
  source: RulesSource
  ok: boolean
  hash: string | null
  readback: string[]
  expressions: Record<string, string>
  error: string | null
}

export interface RulesCandidate {
  candidate: string
  agree: boolean
  problems: string[]
  differences: string[]
  options: RulesOption[]
  usage: Usage
}

// ---------------------------------------------------------------- new project

export interface NewUnit {
  title: string
  criteria: string[]
  amount: number
}

export interface NewMilestone {
  title: string
  start_by: DateStr
  due_at: DateStr
  grace_days: number
  units: NewUnit[]
}

export interface RulesForm {
  vendors: string[]
  budget: number
  max_per_purchase: number
  until: DateStr
  /** Optional per-category budgets, by category id. */
  category_budgets?: Record<string, number>
}

export type NewRules =
  | { mode: "form"; form: RulesForm }
  | { mode: "words"; words: string; candidate: string; pick: RulesSource }

export interface NewProject {
  name: string
  rules: NewRules
  milestones: NewMilestone[]
  periods: Periods
  ends_at: DateStr
}

// ---------------------------------------------------------------- project view

export type ProjectStatus = "DRAFT" | "ACTIVE" | "CLOSING" | "CLOSED" | "CANCELLED"

/**
 * Not specified field-by-field in docs/api.md. The server sends
 * {id, name, status, paused, ledger, todo, next_deadline, created_at}; the UI tolerates any
 * optional field being absent.
 */
export interface ProjectSummary {
  id: string
  name: string
  status: ProjectStatus
  paused: boolean
  created_at?: Ms
  parties?: Partial<Record<Role, Party>>
  ledger?: Partial<Ledger>
  /** How many of the viewer's actions have `needs_response` (the server's field). */
  todo?: number
  /** Same count under another name (accepted too). */
  needs_response?: number
  /** Alternatively the viewer's actions; counted when no count is given. */
  actions?: Action[]
  next_deadline?: Deadline | null
}

export type PolicyStatus = "PROPOSED" | "ACTIVE" | "SUPERSEDED" | "WITHDRAWN"

export interface Signature {
  sig: string
  at: Ms
}

export interface PolicySummary {
  project_budget: number
  expense_budget: number
  milestone_budget: number
  initial_funding: number
  starts_at: Ms | null
  ends_at: Ms | null
  client_review_seconds: number
  resolver_review_seconds: number
  evidence_seconds: number
  reservation_seconds: number
}

export interface PolicyRules {
  source: "form" | "words"
  words: string | null
  readback: string[]
  expressions: Record<string, string>
  mandate_hash: string
  vendors: string[]
  max_per_purchase: number | null
  until: Ms | DateStr | null
  /** Sent by the server besides the contract fields. */
  budget?: number
  category_budgets?: Record<string, number> | null
}

export interface PolicyUnit {
  id: string
  title: string
  criteria: string[]
  amount: number
}

export interface PolicyMilestone {
  id: string
  title: string
  amount: number
  start_by: Ms
  due_at: Ms
  grace_until: Ms
  units: PolicyUnit[]
}

export interface Fallback {
  case: string
  silence: string
  resolver_silence: string | null
}

export interface PolicyView {
  version: number
  hash: string
  previous_hash: string | null
  status: PolicyStatus
  kind: "initial" | "change_order"
  change_order_id: string | null
  signatures: { client: Signature | null; contractor: Signature | null }
  summary: PolicySummary
  rules: PolicyRules
  milestones: PolicyMilestone[]
  fallbacks: Fallback[]
  doc: unknown
}

export interface Ledger {
  budget: number
  expense_budget: number
  milestone_budget: number
  funded: number
  expense_reserved: number
  milestone_reserved: number
  expense_released: number
  milestone_released: number
  released: number
  refunded: number
  /** Always 0 in the MVP (no migration yet). */
  migrated_out?: number
  available: number
  expense_capacity: number
  milestone_capacity: number
  /** How much more the client may deposit now (the policy budget cap). */
  deposit_room: number
  /** What a deposit must add so everything signed is funded. */
  funding_needed?: number
}

export type MilestoneStatus =
  | "PLANNED"
  | "FUNDED_AND_RESERVED"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "DISPUTED"
  | "NON_DELIVERY"
  | "PAID"
  | "PARTIAL"
  | "REJECTED"
  | "EXPIRED_UNUSED"
  | "CANCELLED"

export type UnitStatus =
  | "PLANNED"
  | "RESERVED"
  | "CLAIMED"
  | "DISPUTED"
  | "PAID"
  | "RELEASED_BY_TIMEOUT"
  | "REJECTED"
  | "NOT_DELIVERED"
  | "RETURNED"

export interface MilestoneUnit {
  id: string
  title: string
  criteria: string[]
  amount: number
  status: UnitStatus
  reason: string | null
}

export interface Submission {
  at: Ms
  units: string[]
  note: string
  documents: DocRef[]
}

export type ReasonCode = "NOT_MET" | "MISSING" | "DEFECTIVE"

export interface Objection {
  unit: string
  criterion: string
  reason_code?: ReasonCode | string
  reason: string
  at?: Ms
}

export interface Milestone {
  id: string
  title: string
  version: number
  status: MilestoneStatus
  amount: number
  start_by: Ms
  due_at: Ms
  grace_until: Ms
  units: MilestoneUnit[]
  submission: Submission | null
  review_deadline: Ms | null
  resolver_deadline: Ms | null
  objections: Objection[]
  paid: number
  returned: number
  started_at?: Ms | null
  chain?: ChainResult[]
}

export type ExpenseStatus =
  | "HOLD_REVIEW"
  | "BLOCKED"
  | "RESERVED"
  | "SPEND_REPORTED"
  | "EVIDENCE_SUBMITTED"
  | "DISPUTED"
  | "RETRO_REVIEW"
  | "SETTLED"
  | "PARTIALLY_SETTLED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"

export type HoldClass =
  | "CLIENT_REVIEW"
  | "POLICY_OR_SYSTEM_AMBIGUITY"
  | "EVIDENCE_DEFECT"
  | "INTEGRITY_RISK"
  | "EXCESS_AMOUNT"

export interface Reading {
  ok: boolean
  source: "ai" | "manual" | "unavailable"
  fields: Record<string, unknown>
  problems: string[]
  model?: string | null
  usage: Usage | null
  generation_ids?: string[]
}

export interface Quote {
  amount: number
  fee: number
  total: number
  document: DocRef | null
  manifest_hash?: string | null
  reading: Reading | null
}

export interface Receipt {
  document: DocRef | null
  manifest_hash?: string | null
  claimed: number
  reading: Reading | null
  eligible: number | null
  at: Ms
  /** Documents added by `supplement_evidence`. */
  supplements?: DocRef[]
}

export interface Settlement {
  payee: string
  amount: number
  asset: string
  at: Ms
}

export type DecisionResult = "APPROVE" | "HOLD" | "BLOCK"

export type RuleKind = "mandatory" | "risk" | "evidence"

export interface RuleResult {
  rule: string
  /** Korean label from the server; the UI falls back to labels.ts. */
  label?: string
  /** null: not evaluated / not applicable. */
  ok: boolean | null
  detail: string
  kind?: RuleKind
}

export interface Decision {
  result: DecisionResult
  reason: string
  rules: RuleResult[]
}

export type PaymentMode = "REIMBURSEMENT" | "DIRECT_VENDOR"
export type Assurance = "E0" | "E1" | "E2" | "E3"
export type TimeoutOutcome = "RELEASED_BY_TIMEOUT" | "ESCALATED_BY_TIMEOUT" | "REJECTED_BY_TIMEOUT"

export interface Expense {
  id: string
  kind: "COMMITMENT" | "RETROACTIVE"
  status: ExpenseStatus
  hold_class: HoldClass | null
  /** The policy version this obligation pins. */
  version?: number
  payment_mode?: PaymentMode | string
  /** The exact payee address (the contractor for reimbursement). */
  payee?: string | null
  assurance?: Assurance | string | null
  vendor: string | null
  vendor_name: string | null
  category: string | null
  category_ko: string | null
  item: string | null
  quote: Quote | null
  maximum: number
  reserved: number
  expires_at: Ms | null
  spent_at: Ms | null
  evidence_deadline: Ms | null
  receipt: Receipt | null
  review_deadline: Ms | null
  resolver_deadline: Ms | null
  paid: number
  excess: number
  excess_paid?: number
  settlement?: Settlement | null
  timeout?: TimeoutOutcome | null
  decision: Decision | null
  out_of_scope: boolean
  resolution: { by: Actor; accept: boolean; reason: string } | null
  /** Filed by the contractor's purchase agent (escrow/agent.py). */
  via?: { task: string; need: string; why: string; try: number } | null
  chain?: ChainResult[]
}

export type ChangeOrderStatus = "DRAFT" | "PROPOSED" | "SIGNED" | "FUNDED" | "WITHDRAWN"

export interface ChangeOrderUnit {
  title: string
  criteria: string[]
  amount: number
}

/** Dates in a draft are sent as 'YYYY-MM-DD'; the UI also accepts milliseconds when reading. */
export interface ChangeOrderDraft {
  /** Title of the added milestone (empty when the order only raises the expense budget). */
  title: string
  /** Milestone amount = sum of units. */
  amount: number
  start_by: DateStr | Ms | null
  due_at: DateStr | Ms | null
  grace_days: number
  units: ChangeOrderUnit[]
  note: string
  /** Raise of the expense budget (0 = none). */
  expense_budget_delta?: number
  /** The expense whose excess this order covers, if any. */
  covers_excess?: string | null
}

export interface ChangeOrder {
  id: string
  status: ChangeOrderStatus
  by: Role
  text: string
  draft: ChangeOrderDraft | null
  policy_version: number | null
  ai: { ok: boolean; problems: string[]; usage: Usage | null } | null
}

export type TargetKind = "project" | "policy" | "milestone" | "expense" | "change_order"

export interface Target {
  kind: TargetKind
  id: Id
}

export interface Action {
  action: string
  target: Target | null
  label: string
  deadline: Ms | null
  fallback: string | null
  needs_response: boolean
}

export interface Deadline {
  target: Target
  label: string
  at: Ms
  owner: Actor
  fallback: string | null
}

/** One contract call that mirrors a log line on chain (escrow/chain.py), written back by the relayer. */
export interface ChainResult {
  line: number
  n: number
  call: "open" | "fund" | "accept" | "pause" | "decide" | "settle" | "refund" | string
  args: Record<string, unknown>
  tx: string | null
  url: string | null
  ok: boolean
  error: string | null
  block: number | null
}

export interface ChainStatus {
  enabled: boolean
  network?: string
  chain_id?: number
  contract?: string
  contract_url?: string
  token?: string
  pending?: number
  sent?: number
  refused?: number
}

export interface OnchainBalances {
  funded: number
  reserved: number
  paid: number
  refunded: number
  available: number
}

/** GET /api/projects/:id/chain — the contract's view next to the engine ledger. */
export interface OnchainState {
  chain: ChainStatus
  onchain?: (OnchainBalances & { client: string; contractor: string; policy_hash: string; budget: number; paused: boolean; log_head: string }) | null
  engine?: Omit<OnchainBalances, "available"> & { available: number }
  match?: boolean
}

/** A purchase the agent tried: the request it filed and the rules' answer. */
export interface AgentTry {
  need: string
  document: string
  expense?: string
  result?: DecisionResult
  rule?: string | null
  status?: string
  refused?: string
}

export interface AgentPlan {
  needs: { need: string; offers: string[]; why: string }[]
  skip: { offer: string; why: string }[]
}

export interface AgentRun {
  task: string
  plan: AgentPlan
  ai: { ok: boolean; problems: string[]; usage?: Usage | null; model?: string | null }
  tried: AgentTry[]
  stopped: string | null
}

export interface AgentTask {
  id: string
  task: string
  offers: DocRef[]
  plan: AgentPlan
  ai: { ok: boolean; problems: string[]; usage?: Usage | null; model?: string | null } | null
  at: Ms
  line: number
  requests: { expense: string; need: string; try: number; document: DocRef | null; status: string; result: DecisionResult | null; rule: string | null }[]
}

/** python3 -m escrow.audit (GET /api/projects/:id/audit): loose on purpose, rendered as found. */
export interface AuditReport {
  project: string
  name: string
  lines: number
  head: string
  replay: { ok: boolean; refused: { line: number; op: string; by: string; error: string } | null; status: string; ledger: Ledger }
  policies: { version: number; hash: string; status: string; signed: Record<string, number | null> }[]
  payments?: {
    ref: string
    paid?: number
    amount?: number
    payee: string
    policy: { version: number; hash: string }
    inside: boolean
    request?: {
      line: number
      op: string
      by: string
      via: { task: string; need: string } | null
      document: DocRef | null
      evidence: { found: boolean; hash_ok?: boolean; total_in_text?: boolean | null }
      reading: { vendor: string; category: string; amount: number; fee: number; total: number }
    }
    decision?: { result: DecisionResult; reason: string; rules: { rule: string; label: string; ok: boolean | null; detail: string }[] }
    client_approval?: { line: number; reason: string }[]
    payments: { line: number; op: string; by: string; amount: number; how: string; unit?: string }[]
  }[]
  refunds?: { line: number; amount: number }[]
  stops?: { ref: string; result: DecisionResult; status: string; rule: string; label: string; line: number; via: { need: string } | null; amount: number | null }[]
  chain?: {
    error?: string
    contract?: string
    contract_url?: string
    calls?: { line: number; n: number; call: string; tx: string; ok: boolean; url: string }[]
    balances_match?: boolean | null
    problems?: string[]
  }
  verdict?: { records_consistent: boolean; payments: number; inside: number; stops: number }
}

export interface LogEntry {
  i: number
  at: Ms
  by: Actor
  op: string
  text: string
  head: string
  chain?: ChainResult[]
}

export interface ProjectView {
  id: string
  name: string
  status: ProjectStatus
  paused: boolean
  now: Ms
  created_at: Ms
  viewer: Party
  parties: { client: Party; contractor: Party; resolver: Party }
  policy: PolicyView | null
  proposals: PolicyView[]
  versions: PolicyView[]
  ledger: Ledger
  milestones: Milestone[]
  expenses: Expense[]
  change_orders: ChangeOrder[]
  actions: Action[]
  deadlines: Deadline[]
  log: LogEntry[]
  head: string
  chain?: ChainStatus
  agent_tasks?: AgentTask[]
}

export interface ActionOk {
  ok: true
  result: unknown
  view: ProjectView
}

export interface ActionErr {
  ok: false
  error: string
  code: "forbidden" | "state" | "invalid" | "deadline" | string
}
