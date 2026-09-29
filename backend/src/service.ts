import { invoiceNumberFrom } from "./ai/schema.js"
import { interpret } from "./ai/interpret.js"
import type { Bus, DecisionEvent } from "./bus.js"
import type { ChainWriter, DecisionCode } from "./chain/types.js"
import type { Db } from "./db.js"
import { evidenceHash, sha256Hex, usdToBase } from "./domain/ids.js"
import type { KilnClient } from "./kiln/types.js"
import { evaluate, revokedDecision } from "./policy/engine.js"
import type { Check, Expense, Outcome, Policy } from "./policy/types.js"

export type Deps = {
  db: Db
  kiln: KilnClient
  chain: ChainWriter
  bus: Bus
  today: () => string
  now?: () => string
}

export type DecisionView = {
  expenseRequestId: string
  decisionId: string
  holdId: string | null
  outcome: Outcome
  reason: string
  expense: Expense
  checks: Check[]
  fallback: boolean
  chain: { status: string; recordTx: string | null; releaseTx: string | null; error: string | null }
  llm: {
    source: "kiln" | "mock"
    calls: Array<{ flow: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number }>
  }
}

const CODES: Record<Outcome, DecisionCode> = { APPROVE: 1, HOLD: 2, BLOCK: 3 }

export async function submitExpense(deps: Deps, projectId: string, input: { text: string; filename: string | null; file: Buffer }): Promise<DecisionView> {
  const project = deps.db.getProject(projectId)
  const policy = deps.db.getPolicy(projectId)
  if (!project || !policy) throw new HttpError(404, "project not found")
  if (!input.text.trim()) throw new HttpError(400, "text is required")

  const documentText = readDocument(input.filename, input.file)
  const documentHash = sha256Hex(input.file.length > 0 ? input.file : Buffer.from(input.text))
  const invoiceNumber = invoiceNumberFrom(`${input.text}\n${documentText}`)
  const now = (deps.now ?? (() => new Date().toISOString()))()
  const expenseId = crypto.randomUUID()

  if (project.status === "stopped") {
    return persist(deps, {
      projectId,
      expenseId,
      text: input.text,
      filename: input.filename,
      documentHash,
      documentText,
      invoiceNumber,
      expense: {
        vendor: "unknown",
        category: "unknown",
        amount: 1,
        currency: policy.currency,
        purpose: "revoked",
        project_relevance: "low",
        document_type: "other",
        anomaly_flags: [],
        rationale: "Authorization revoked",
      },
      fallback: false,
      evaluation: revokedDecision(),
      calls: [],
      payee: project.payee_address,
      policyHash: project.policy_hash,
      now,
    })
  }

  const interpretation = await interpret({ kiln: deps.kiln, requestText: input.text, documentText, policy })
  const spend = deps.db.committedSpend(projectId)
  const prior = deps.db.priorEvidence(projectId)
  let evaluation = interpretation.fallback
    ? { outcome: "HOLD" as const, reason: "AI output invalid; held for review", checks: [] as Check[] }
    : evaluate({
      expense: interpretation.expense,
      policy,
      spentUsd: spend.total,
      categorySpentUsd: spentFor(spend.byCategory, interpretation.expense.category),
      today: deps.today(),
      documentHash,
      invoiceNumber,
      priorDocumentHashes: prior.hashes,
      priorInvoiceNumbers: prior.invoices,
    })

  if (!interpretation.fallback && interpretation.expense.currency.trim().toLowerCase() !== policy.currency.trim().toLowerCase() && evaluation.outcome !== "BLOCK") {
    evaluation = { outcome: "BLOCK", reason: "currency not allowed", checks: evaluation.checks }
  }

  return persist(deps, {
    projectId,
    expenseId,
    text: input.text,
    filename: input.filename,
    documentHash,
    documentText,
    invoiceNumber,
    expense: interpretation.expense,
    fallback: interpretation.fallback,
    evaluation,
    calls: interpretation.calls,
    payee: project.payee_address,
    policyHash: project.policy_hash,
    now,
  })
}

export async function approveHold(deps: Deps, holdId: string): Promise<{ holdId: string; releaseTx: string | null; chainStatus: string }> {
  const hold = deps.db.getHold(holdId)
  if (!hold) throw new HttpError(404, "hold not found")
  if (hold.status !== "pending") throw new HttpError(409, "hold is not pending")
  const project = deps.db.getProject(hold.project_id)
  if (!project) throw new HttpError(404, "project not found")
  if (project.status === "stopped") throw new HttpError(409, "project is stopped")

  let releaseTx: string | null = null
  let chainStatus = "skipped"
  if (deps.chain.enabled) {
    try {
      await deps.chain.approveHold({ projectId: asHex(project.id), evidenceHash: asHex(hold.evidence_hash) })
      releaseTx = await deps.chain.release({
        projectId: asHex(project.id),
        evidenceHash: asHex(hold.evidence_hash),
        payee: asHex(hold.payee),
        amountBase: usdToBase(hold.amount_usd),
      })
      chainStatus = "released"
    } catch (error) {
      deps.db.setDecisionChain(hold.decision_id, { chain_status: "failed", chain_error: message(error) })
      throw new HttpError(502, message(error))
    }
  }

  const now = (deps.now ?? (() => new Date().toISOString()))()
  deps.db.resolveHold(holdId, "approved", now)
  deps.db.setDecisionChain(hold.decision_id, { chain_release_tx: releaseTx, chain_status: chainStatus, chain_error: null })
  deps.db.insertSettlement({ id: crypto.randomUUID(), decisionId: hold.decision_id, txHash: releaseTx, amountUsd: hold.amount_usd, payee: hold.payee, createdAt: now })
  return { holdId, releaseTx, chainStatus }
}

export async function rejectHold(deps: Deps, holdId: string): Promise<{ holdId: string; chainStatus: string }> {
  const hold = deps.db.getHold(holdId)
  if (!hold) throw new HttpError(404, "hold not found")
  if (hold.status !== "pending") throw new HttpError(409, "hold is not pending")
  const project = deps.db.getProject(hold.project_id)
  if (!project) throw new HttpError(404, "project not found")
  let chainStatus = "skipped"
  if (deps.chain.enabled) {
    try {
      await deps.chain.rejectHold({ projectId: asHex(project.id), evidenceHash: asHex(hold.evidence_hash) })
      chainStatus = "recorded"
    } catch (error) {
      throw new HttpError(502, message(error))
    }
  }
  deps.db.resolveHold(holdId, "rejected", (deps.now ?? (() => new Date().toISOString()))())
  return { holdId, chainStatus }
}

export async function stopProject(deps: Deps, projectId: string): Promise<{ projectId: string; tx: string | null }> {
  const project = deps.db.getProject(projectId)
  if (!project) throw new HttpError(404, "project not found")
  if (project.status === "stopped") throw new HttpError(409, "project is stopped")
  let tx: string | null = null
  if (deps.chain.enabled) {
    try {
      tx = await deps.chain.stopProject(asHex(project.id))
    } catch (error) {
      throw new HttpError(502, message(error))
    }
  }
  deps.db.markStopped(projectId)
  return { projectId, tx }
}

async function persist(deps: Deps, input: {
  projectId: string
  expenseId: string
  text: string
  filename: string | null
  documentHash: string
  documentText: string
  invoiceNumber: string | null
  expense: Expense
  fallback: boolean
  evaluation: { outcome: Outcome; reason: string; checks: Check[] }
  calls: Array<{ flow: "parse" | "classify"; result: { model: string; source: "kiln" | "mock"; usage: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number | null; generationId: string | null }; latencyMs: number } }>
  payee: string
  policyHash: string
  now: string
}): Promise<DecisionView> {
  const onchainEvidence = evidenceHash(input.documentHash, input.expenseId)
  deps.db.insertExpense({
    id: input.expenseId,
    projectId: input.projectId,
    text: input.text,
    filename: input.filename,
    documentHash: input.documentHash,
    documentText: input.documentText,
    invoiceNumber: input.invoiceNumber,
    createdAt: input.now,
  })
  deps.db.insertExtraction({ id: crypto.randomUUID(), expenseRequestId: input.expenseId, expense: input.expense, fallback: input.fallback })
  for (const call of input.calls) {
    deps.db.insertLlmCall({
      id: crypto.randomUUID(),
      expenseRequestId: input.expenseId,
      flow: call.flow,
      model: call.result.model,
      source: call.result.source,
      promptTokens: call.result.usage.promptTokens,
      completionTokens: call.result.usage.completionTokens,
      totalTokens: call.result.usage.totalTokens,
      reasoningTokens: call.result.usage.reasoningTokens,
      latencyMs: call.result.latencyMs,
      generationId: call.result.usage.generationId,
      createdAt: input.now,
    })
  }

  const chain = await settle(deps, {
    projectId: input.projectId,
    evidenceHash: onchainEvidence,
    policyHash: input.policyHash,
    amountUsd: input.expense.amount,
    outcome: input.evaluation.outcome,
    payee: input.payee,
  })
  const decisionId = crypto.randomUUID()
  deps.db.insertDecision({
    id: decisionId,
    project_id: input.projectId,
    expense_request_id: input.expenseId,
    outcome: input.evaluation.outcome,
    reason: input.evaluation.reason,
    checks_json: JSON.stringify(input.evaluation.checks),
    evidence_hash: onchainEvidence,
    amount_usd: input.expense.amount,
    payee: input.payee,
    chain_record_tx: chain.recordTx,
    chain_release_tx: chain.releaseTx,
    chain_status: chain.status,
    chain_error: chain.error,
    created_at: input.now,
  })

  let holdId: string | null = null
  if (input.evaluation.outcome === "HOLD") {
    holdId = crypto.randomUUID()
    deps.db.insertHold({ id: holdId, decision_id: decisionId, project_id: input.projectId, status: "pending", resolved_at: null })
  }
  if (input.evaluation.outcome === "APPROVE" && chain.status === "released" || (input.evaluation.outcome === "APPROVE" && !deps.chain.enabled)) {
    deps.db.insertSettlement({
      id: crypto.randomUUID(),
      decisionId,
      txHash: chain.releaseTx,
      amountUsd: input.expense.amount,
      payee: input.payee,
      createdAt: input.now,
    })
  }

  const event: DecisionEvent = {
    type: "decision",
    projectId: input.projectId,
    expenseRequestId: input.expenseId,
    outcome: input.evaluation.outcome,
    reason: input.evaluation.reason,
    chainStatus: chain.status,
  }
  deps.bus.publish(event)

  return {
    expenseRequestId: input.expenseId,
    decisionId,
    holdId,
    outcome: input.evaluation.outcome,
    reason: input.evaluation.reason,
    expense: input.expense,
    checks: input.evaluation.checks,
    fallback: input.fallback,
    chain,
    llm: {
      source: input.calls[0]?.result.source ?? deps.kiln.source,
      calls: input.calls.map((call) => ({
        flow: call.flow,
        prompt_tokens: call.result.usage.promptTokens,
        completion_tokens: call.result.usage.completionTokens,
        total_tokens: call.result.usage.totalTokens,
        latency_ms: call.result.latencyMs,
      })),
    },
  }
}

async function settle(deps: Deps, input: { projectId: string; evidenceHash: `0x${string}`; policyHash: string; amountUsd: number; outcome: Outcome; payee: string }): Promise<DecisionView["chain"]> {
  if (!deps.chain.enabled) return { status: "skipped", recordTx: null, releaseTx: null, error: null }
  let recordTx: string | null = null
  try {
    recordTx = await deps.chain.recordDecision({
      projectId: asHex(input.projectId),
      evidenceHash: input.evidenceHash,
      policyHash: asHex(input.policyHash),
      amountBase: usdToBase(input.amountUsd),
      decision: CODES[input.outcome],
      payee: asHex(input.payee),
    })
  } catch (error) {
    return { status: "failed", recordTx: null, releaseTx: null, error: message(error) }
  }
  if (input.outcome !== "APPROVE") return { status: "recorded", recordTx, releaseTx: null, error: null }
  try {
    const releaseTx = await deps.chain.release({
      projectId: asHex(input.projectId),
      evidenceHash: input.evidenceHash,
      payee: asHex(input.payee),
      amountBase: usdToBase(input.amountUsd),
    })
    return { status: "released", recordTx, releaseTx, error: null }
  } catch (error) {
    return { status: "failed", recordTx, releaseTx: null, error: message(error) }
  }
}

function spentFor(byCategory: Record<string, number>, category: string): number {
  return Object.entries(byCategory).reduce((sum, [name, amount]) => name.toLowerCase() === category.toLowerCase() ? sum + amount : sum, 0)
}

function readDocument(filename: string | null, bytes: Buffer): string {
  if (bytes.length === 0) return ""
  if (bytes.subarray(0, 1000).includes(0)) return `(binary file ${filename ?? "upload"}, ${bytes.length} bytes)`
  return bytes.toString("utf8").slice(0, 12_000)
}

function asHex(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`expected hex, got ${value}`)
  return value as `0x${string}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "chain error"
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}
