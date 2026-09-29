import assert from "node:assert/strict"
import { test } from "node:test"
import { extractJson, stripModelContent, validateExpense } from "./schema.js"

const valid = {
  vendor: "AWS",
  category: "Cloud",
  amount: 200,
  currency: "USD",
  purpose: "production_server",
  project_relevance: "high",
  document_type: "invoice",
  anomaly_flags: [],
  rationale: "Monthly server cost.",
}

test("accepts the expense schema", () => {
  const result = validateExpense(valid)
  assert.equal(result.ok, true)
})

test("rejects an unknown field, a bad enum, and an over-long rationale", () => {
  const result = validateExpense({ ...valid, extra: true, project_relevance: "urgent", rationale: "x".repeat(201) })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.includes("unknown field")))
    assert.ok(result.errors.some((error) => error.includes("project_relevance")))
    assert.ok(result.errors.some((error) => error.includes("200")))
  }
})

test("strips a thinking block and a json fence before parsing", () => {
  const content = `<think>hidden</think>\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``
  assert.equal(stripModelContent(content).includes("hidden"), false)
  const parsed = validateExpense(extractJson(content))
  assert.equal(parsed.ok, true)
})
