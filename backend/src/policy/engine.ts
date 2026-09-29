import type { Check, Evaluation, Expense, Policy } from "./types.js"

export type PolicyContext = {
  expense: Expense
  policy: Policy
  spentUsd: number
  categorySpentUsd: number
  today: string
  documentHash: string
  invoiceNumber: string | null
  priorDocumentHashes: string[]
  priorInvoiceNumbers: string[]
}

const REVOKED = "Authorization revoked by project owner"

export function checkProjectScope(expense: Expense): Check {
  const pass = expense.project_relevance !== "low"
  return check("project_scope", pass, pass ? null : "outside project scope")
}

export function checkAllowedCategory(expense: Expense, policy: Policy): Check {
  const pass = listed(policy.allowed_categories, expense.category)
  return check("allowed_category", pass, pass ? null : "outside project scope")
}

export function checkApprovedVendor(expense: Expense, policy: Policy): Check {
  const pass = listed(policy.allowed_vendors, expense.vendor)
  return check("approved_vendor", pass, pass ? null : "vendor not approved")
}

export function checkRemainingBudget(expense: Expense, policy: Policy, spentUsd: number): Check {
  const pass = spentUsd + expense.amount <= policy.project_budget
  return check("remaining_budget", pass, pass ? null : "project budget exceeded")
}

export function checkCategoryBudget(expense: Expense, policy: Policy, categorySpentUsd: number): Check {
  const cap = lookup(policy.category_budget, expense.category)
  const pass = cap === undefined || categorySpentUsd + expense.amount <= cap
  return check("category_budget", pass, pass ? null : "category budget exceeded")
}

export function checkMaxTransaction(expense: Expense, policy: Policy): Check {
  const pass = expense.amount <= policy.max_transaction
  return check("max_transaction", pass, pass ? null : "transaction limit exceeded")
}

export function checkDeadline(policy: Policy, today: string): Check {
  const pass = policy.deadline >= today
  return check("deadline", pass, pass ? null : "deadline passed")
}

export function checkDuplicateEvidence(input: {
  documentHash: string
  invoiceNumber: string | null
  priorDocumentHashes: string[]
  priorInvoiceNumbers: string[]
}): Check {
  const sameFile = input.priorDocumentHashes.includes(input.documentHash)
  const sameInvoice =
    input.invoiceNumber !== null && input.priorInvoiceNumbers.includes(input.invoiceNumber.toLowerCase())
  const pass = !sameFile && !sameInvoice
  return check("duplicate_evidence", pass, pass ? null : "possible duplicate invoice")
}

export function evaluate(ctx: PolicyContext): Evaluation {
  const checks: Check[] = [
    checkProjectScope(ctx.expense),
    checkAllowedCategory(ctx.expense, ctx.policy),
    checkApprovedVendor(ctx.expense, ctx.policy),
    checkRemainingBudget(ctx.expense, ctx.policy, ctx.spentUsd),
    checkCategoryBudget(ctx.expense, ctx.policy, ctx.categorySpentUsd),
    checkMaxTransaction(ctx.expense, ctx.policy),
    checkDeadline(ctx.policy, ctx.today),
    checkDuplicateEvidence({
      documentHash: ctx.documentHash,
      invoiceNumber: ctx.invoiceNumber,
      priorDocumentHashes: ctx.priorDocumentHashes,
      priorInvoiceNumbers: ctx.priorInvoiceNumbers,
    }),
  ]

  const hard = checks.find((item) => item.id !== "duplicate_evidence" && !item.pass)
  if (hard) return { outcome: "BLOCK", reason: hard.reason ?? "policy violation", checks }

  const duplicate = checks.find((item) => item.id === "duplicate_evidence")
  if (duplicate && !duplicate.pass) {
    return { outcome: "HOLD", reason: "possible duplicate invoice", checks }
  }

  if (ctx.expense.anomaly_flags.includes("duplicate_evidence")) {
    return { outcome: "HOLD", reason: "possible duplicate invoice", checks }
  }
  if (ctx.expense.anomaly_flags.includes("abnormal_pricing") || farAboveTypical(ctx.expense, ctx.policy)) {
    return {
      outcome: "HOLD",
      reason: ctx.expense.anomaly_flags.includes("abnormal_pricing") ? "abnormal price detected" : "unusual spending pattern",
      checks,
    }
  }
  if (ctx.expense.anomaly_flags.length > 0) {
    return { outcome: "HOLD", reason: "unusual spending pattern", checks }
  }

  return { outcome: "APPROVE", reason: "all policy checks passed", checks }
}

export function revokedDecision(): Evaluation {
  return { outcome: "BLOCK", reason: REVOKED, checks: [] }
}

function farAboveTypical(expense: Expense, policy: Policy): boolean {
  const typical = lookup(policy.typical_amount, expense.category)
  return typical !== undefined && expense.amount > typical * 3
}

function listed(values: string[], candidate: string): boolean {
  return values.some((value) => value.trim().toLowerCase() === candidate.trim().toLowerCase())
}

function lookup(table: Record<string, number> | undefined, key: string): number | undefined {
  if (!table) return undefined
  const found = Object.entries(table).find(([name]) => name.trim().toLowerCase() === key.trim().toLowerCase())
  return found?.[1]
}

function check(id: Check["id"], pass: boolean, reason: string | null): Check {
  return { id, pass, reason }
}
