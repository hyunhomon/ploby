import assert from "node:assert/strict"
import { test } from "node:test"
import { interpret } from "./interpret.js"
import { MockKilnClient, selectFixture } from "../kiln/mock.js"
import type { KilnClient } from "../kiln/types.js"
import { demoPolicy } from "../policy/types.js"

test("mock fixture selection follows the four demo requests", () => {
  assert.equal(selectFixture("parse", "Request $200 for AWS server costs."), "parse-aws.json")
  assert.equal(selectFixture("classify", "Gaming console $300"), "classify-console.json")
  assert.equal(selectFixture("parse", "Request $500 for AWS"), "parse-over-limit.json")
  assert.equal(selectFixture("parse", "Invoice #1023 for AWS server costs"), "parse-invoice-1023.json")
})

test("mock interpretation of the AWS request is a valid $200 expense and is labeled mock", async () => {
  const result = await interpret({
    kiln: new MockKilnClient(),
    requestText: "Request $200 for AWS server costs.",
    documentText: "Vendor: AWS\nAmount: $200",
    policy: demoPolicy,
  })
  assert.equal(result.fallback, false)
  assert.equal(result.expense.amount, 200)
  assert.equal(result.expense.vendor, "AWS")
  assert.equal(result.calls.length, 2)
  assert.equal(result.calls.every((call) => call.result.source === "mock"), true)
  assert.ok((result.calls[0]?.result.usage.reasoningTokens ?? 0) > 0)
})

test("invalid JSON is re-asked once and then held", async () => {
  let calls = 0
  const kiln: KilnClient = {
    source: "mock",
    async complete() {
      calls += 1
      return {
        content: "{",
        model: "qwen3-32b",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: null, costUsd: null, generationId: null },
        latencyMs: 1,
        source: "mock",
      }
    },
  }
  const result = await interpret({
    kiln,
    requestText: "Request $200 for AWS server costs.",
    documentText: "",
    policy: demoPolicy,
  })
  assert.equal(result.fallback, true)
  assert.equal(calls, 2)
  assert.equal(result.expense.amount, 200)
})
