export const ANOMALY_FLAGS = [
  "duplicate_evidence",
  "budget_splitting",
  "abnormal_pricing",
  "unusual_pattern",
] as const

export type AnomalyFlag = (typeof ANOMALY_FLAGS)[number]
export type ProjectRelevance = "high" | "medium" | "low"
export type DocumentType = "invoice" | "receipt" | "quotation" | "other"
export type Outcome = "APPROVE" | "HOLD" | "BLOCK"

export type Policy = {
  project_budget: number
  currency: string
  allowed_categories: string[]
  allowed_vendors: string[]
  category_budget?: Record<string, number>
  max_transaction: number
  deadline: string
  typical_amount?: Record<string, number>
}

export type Expense = {
  vendor: string
  category: string
  amount: number
  currency: string
  purpose: string
  project_relevance: ProjectRelevance
  document_type: DocumentType
  anomaly_flags: AnomalyFlag[]
  rationale: string
}

export type CheckId =
  | "project_scope"
  | "allowed_category"
  | "approved_vendor"
  | "remaining_budget"
  | "category_budget"
  | "max_transaction"
  | "deadline"
  | "duplicate_evidence"

export type Check = {
  id: CheckId
  pass: boolean
  reason: string | null
}

export type Evaluation = {
  outcome: Outcome
  reason: string
  checks: Check[]
}

/** Section 16 demo policy. Amounts are US dollars, not token base units. */
export const demoPolicy: Policy = {
  project_budget: 1000,
  currency: "USD",
  allowed_categories: ["Cloud", "AI API", "Design Software"],
  allowed_vendors: ["AWS", "OpenAI", "Figma", "Adobe"],
  category_budget: {
    Cloud: 1000,
    "AI API": 1000,
    "Design Software": 1000,
  },
  max_transaction: 400,
  deadline: "2026-12-31",
  typical_amount: {
    Cloud: 250,
    "AI API": 100,
    "Design Software": 150,
  },
}
