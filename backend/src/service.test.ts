import assert from "node:assert/strict"
import { test } from "node:test"
import { buildApp } from "./app.js"
import { Bus } from "./bus.js"
import { MemoryChain } from "./chain/types.js"
import { Db } from "./db.js"
import { MockKilnClient } from "./kiln/mock.js"
import { demoPolicy } from "./policy/types.js"

const CLIENT = "0x1111111111111111111111111111111111111111"
const PAYEE = "0x2222222222222222222222222222222222222222"

async function setup() {
  const chain = new MemoryChain()
  const app = buildApp({
    db: Db.open(":memory:"),
    kiln: new MockKilnClient(),
    chain,
    bus: new Bus(),
    today: () => "2026-09-29",
    now: () => "2026-09-29T00:00:00.000Z",
  })
  const created = await app.inject({
    method: "POST",
    url: "/projects",
    payload: { name: "Website Development", clientAddress: CLIENT, payeeAddress: PAYEE, policy: demoPolicy },
  })
  assert.equal(created.statusCode, 200)
  return { app, chain, id: created.json().id as string }
}

async function submit(app: Awaited<ReturnType<typeof setup>>["app"], id: string, text: string) {
  const response = await app.inject({ method: "POST", url: `/projects/${id}/expenses`, payload: { text } })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test("case 1 approves $200 AWS and releases to the recorded payee", async () => {
  const { app, chain, id } = await setup()
  const decision = await submit(app, id, "Request $200 for AWS server costs.")
  assert.equal(decision.outcome, "APPROVE")
  assert.equal(decision.chain.status, "released")
  assert.equal(chain.records[0]?.decision, 1)
  assert.equal(chain.records[0]?.payee, PAYEE)
  assert.equal(chain.records[0]?.amountBase, 200_000_000n)
  assert.equal(chain.releases.length, 1)
  assert.equal(decision.llm.source, "mock")
  assert.deepEqual(decision.llm.calls.map((call: { flow: string }) => call.flow), ["parse", "classify"])
})

test("case 2 blocks a gaming console as outside project scope", async () => {
  const { app, chain, id } = await setup()
  const decision = await submit(app, id, "Gaming console $300")
  assert.equal(decision.outcome, "BLOCK")
  assert.equal(decision.reason, "outside project scope")
  assert.equal(chain.records[0]?.decision, 3)
  assert.equal(chain.releases.length, 0)
  assert.equal(decision.checks.find((check: { id: string }) => check.id === "project_scope").pass, false)
})

test("case 3 blocks a $500 request over the $400 limit", async () => {
  const { app, chain, id } = await setup()
  const decision = await submit(app, id, "Request $500 for AWS server costs.")
  assert.equal(decision.outcome, "BLOCK")
  assert.equal(decision.reason, "transaction limit exceeded")
  assert.equal(chain.releases.length, 0)
})

test("case 4 holds the second invoice 1023 until the client approves it", async () => {
  const { app, chain, id } = await setup()
  const first = await submit(app, id, "Invoice #1023 for AWS server costs $200")
  assert.equal(first.outcome, "APPROVE")
  const second = await submit(app, id, "Invoice #1023 for AWS server costs $200 again")
  assert.equal(second.outcome, "HOLD")
  assert.equal(second.reason, "possible duplicate invoice")
  assert.equal(chain.releases.length, 1)

  const approved = await app.inject({ method: "POST", url: `/holds/${second.holdId}/approve` })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.equal(chain.approvals.length, 1)
  assert.equal(chain.releases.length, 2)
})

test("stopping the project blocks later requests with the revocation reason", async () => {
  const { app, chain, id } = await setup()
  const stopped = await app.inject({ method: "POST", url: `/projects/${id}/stop` })
  assert.equal(stopped.statusCode, 200)
  const decision = await submit(app, id, "Request $200 for AWS server costs.")
  assert.equal(decision.outcome, "BLOCK")
  assert.equal(decision.reason, "Authorization revoked by project owner")
  assert.equal(decision.chain.status, "failed")
  assert.equal(chain.records.length, 0)
})

test("metrics separate mock tokens and omit reasoning tokens", async () => {
  const { app, id } = await setup()
  await submit(app, id, "Request $200 for AWS server costs.")
  const metrics = await app.inject({ method: "GET", url: "/metrics" })
  const body = metrics.json()
  assert.equal(body.mock.byFlow.parse.prompt_tokens, 180)
  assert.equal(body.mock.byFlow.classify.prompt_tokens, 90)
  assert.equal(JSON.stringify(body).includes("reasoning"), false)
  assert.equal(body.kiln.calls.length, 0)
})
