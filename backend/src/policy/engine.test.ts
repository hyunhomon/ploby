import assert from "node:assert/strict"
import { test } from "node:test"
import { evaluate, checkAllowedCategory, checkApprovedVendor, checkCategoryBudget, checkDeadline, checkDuplicateEvidence, checkMaxTransaction, checkProjectScope, checkRemainingBudget, revokedDecision, type PolicyContext } from "./engine.js"
import { demoPolicy, type Expense } from "./types.js"

const aws = (): Expense => ({
  vendor: "AWS",
  category: "Cloud",
  amount: 200,
  currency: "USD",
  purpose: "production_server",
  project_relevance: "high",
  document_type: "invoice",
  anomaly_flags: [],
  rationale: "Monthly server cost for the website.",
})

function ctx(patch: Partial<PolicyContext> = {}): PolicyContext {
  return {
    expense: aws(),
    policy: demoPolicy,
    spentUsd: 0,
    categorySpentUsd: 0,
    today: "2026-09-29",
    documentHash: "hash-a",
    invoiceNumber: null,
    priorDocumentHashes: [],
    priorInvoiceNumbers: [],
    ...patch,
  }
}

test("project scope passes for high relevance and fails for low", () => {
  assert.equal(checkProjectScope(aws()).pass, true)
  const low = aws()
  low.project_relevance = "low"
  const failed = checkProjectScope(low)
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "outside project scope")
})

test("allowed category passes Cloud and fails Electronics", () => {
  assert.equal(checkAllowedCategory(aws(), demoPolicy).pass, true)
  const gaming = aws()
  gaming.category = "Electronics"
  const failed = checkAllowedCategory(gaming, demoPolicy)
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "outside project scope")
})

test("approved vendor passes AWS and fails an unlisted vendor", () => {
  assert.equal(checkApprovedVendor(aws(), demoPolicy).pass, true)
  const other = aws()
  other.vendor = "GameStop"
  assert.equal(checkApprovedVendor(other, demoPolicy).pass, false)
  assert.equal(checkApprovedVendor(other, demoPolicy).reason, "vendor not approved")
})

test("remaining budget passes inside the cap and fails over it", () => {
  assert.equal(checkRemainingBudget(aws(), demoPolicy, 700).pass, true)
  const failed = checkRemainingBudget(aws(), demoPolicy, 900)
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "project budget exceeded")
})

test("category budget passes without a cap and fails over a cap", () => {
  assert.equal(checkCategoryBudget(aws(), demoPolicy, 0).pass, true)
  const capped = { ...demoPolicy, category_budget: { Cloud: 100 } }
  const failed = checkCategoryBudget(aws(), capped, 0)
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "category budget exceeded")
})

test("max transaction passes at $200 and fails at $500", () => {
  assert.equal(checkMaxTransaction(aws(), demoPolicy).pass, true)
  const big = aws()
  big.amount = 500
  const failed = checkMaxTransaction(big, demoPolicy)
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "transaction limit exceeded")
})

test("deadline passes on the deadline day and fails after it", () => {
  assert.equal(checkDeadline(demoPolicy, "2026-12-31").pass, true)
  const failed = checkDeadline(demoPolicy, "2027-01-01")
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "deadline passed")
})

test("duplicate evidence passes a new hash and fails a repeated invoice number", () => {
  assert.equal(checkDuplicateEvidence({
    documentHash: "hash-a",
    invoiceNumber: "1023",
    priorDocumentHashes: [],
    priorInvoiceNumbers: [],
  }).pass, true)
  const failed = checkDuplicateEvidence({
    documentHash: "hash-b",
    invoiceNumber: "1023",
    priorDocumentHashes: ["hash-a"],
    priorInvoiceNumbers: ["1023"],
  })
  assert.equal(failed.pass, false)
  assert.equal(failed.reason, "possible duplicate invoice")
})

test("demo case 1 approves a $200 AWS expense", () => {
  const result = evaluate(ctx())
  assert.equal(result.outcome, "APPROVE")
  assert.equal(result.checks.every((item) => item.pass), true)
})

test("demo case 2 blocks a gaming console as outside project scope", () => {
  const expense = aws()
  expense.vendor = "GameStop"
  expense.category = "Electronics"
  expense.amount = 300
  expense.project_relevance = "low"
  expense.purpose = "gaming_console"
  const result = evaluate(ctx({ expense }))
  assert.equal(result.outcome, "BLOCK")
  assert.equal(result.reason, "outside project scope")
})

test("demo case 3 blocks a $500 request over the $400 limit", () => {
  const expense = aws()
  expense.amount = 500
  const result = evaluate(ctx({ expense }))
  assert.equal(result.outcome, "BLOCK")
  assert.equal(result.reason, "transaction limit exceeded")
})

test("demo case 4 holds a duplicate invoice instead of approving it", () => {
  const result = evaluate(ctx({ invoiceNumber: "1023", priorInvoiceNumbers: ["1023"] }))
  assert.equal(result.outcome, "HOLD")
  assert.equal(result.reason, "possible duplicate invoice")
})

test("anomaly flags hold an otherwise valid expense", () => {
  const expense = aws()
  expense.anomaly_flags = ["abnormal_pricing"]
  const result = evaluate(ctx({ expense }))
  assert.equal(result.outcome, "HOLD")
  assert.equal(result.reason, "abnormal price detected")
})

test("revoked authorization blocks before policy checks", () => {
  const result = revokedDecision()
  assert.equal(result.outcome, "BLOCK")
  assert.equal(result.reason, "Authorization revoked by project owner")
})
