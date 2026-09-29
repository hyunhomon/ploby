import Database from "better-sqlite3"
import type { Check, Expense, Outcome, Policy } from "./policy/types.js"

export type ProjectRow = {
  id: string
  name: string
  client_address: string
  payee_address: string
  budget_usd: number
  policy_hash: string
  status: "active" | "stopped"
  created_at: string
}

export type DecisionRow = {
  id: string
  project_id: string
  expense_request_id: string
  outcome: Outcome
  reason: string
  checks_json: string
  evidence_hash: string
  amount_usd: number
  payee: string
  chain_record_tx: string | null
  chain_release_tx: string | null
  chain_status: string
  chain_error: string | null
  created_at: string
}

export type HoldRow = {
  id: string
  decision_id: string
  project_id: string
  status: "pending" | "approved" | "rejected"
  resolved_at: string | null
}

export class Db {
  constructor(private readonly sqlite: Database.Database) {}

  static open(path: string): Db {
    const sqlite = new Database(path)
    sqlite.pragma("journal_mode = WAL")
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client_address TEXT NOT NULL,
        payee_address TEXT NOT NULL,
        budget_usd REAL NOT NULL,
        policy_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        create_tx TEXT,
        deposit_tx TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policies (
        project_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expense_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        text TEXT NOT NULL,
        filename TEXT,
        document_hash TEXT NOT NULL,
        document_text TEXT NOT NULL,
        invoice_number TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_extractions (
        id TEXT PRIMARY KEY,
        expense_request_id TEXT NOT NULL,
        json TEXT NOT NULL,
        fallback INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        expense_request_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        payee TEXT NOT NULL,
        chain_record_tx TEXT,
        chain_release_tx TEXT,
        chain_status TEXT NOT NULL,
        chain_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hold_queue (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settlements (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        tx_hash TEXT,
        amount_usd REAL NOT NULL,
        payee TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY,
        expense_request_id TEXT,
        flow TEXT NOT NULL,
        model TEXT NOT NULL,
        source TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        generation_id TEXT,
        created_at TEXT NOT NULL
      );
    `)
    return new Db(sqlite)
  }

  insertProject(row: ProjectRow & { policy: Policy; createTx: string | null; depositTx: string | null }): void {
    this.sqlite.prepare(`INSERT INTO projects (id, name, client_address, payee_address, budget_usd, policy_hash, status, create_tx, deposit_tx, created_at)
      VALUES (@id, @name, @client_address, @payee_address, @budget_usd, @policy_hash, @status, @create_tx, @deposit_tx, @created_at)`).run({
      ...row,
      create_tx: row.createTx,
      deposit_tx: row.depositTx,
    })
    this.sqlite.prepare("INSERT INTO policies (project_id, json) VALUES (?, ?)").run(row.id, JSON.stringify(row.policy))
  }

  getProject(id: string): (ProjectRow & { create_tx: string | null; deposit_tx: string | null }) | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as (ProjectRow & { create_tx: string | null; deposit_tx: string | null }) | undefined
  }

  getPolicy(projectId: string): Policy | undefined {
    const row = this.sqlite.prepare("SELECT json FROM policies WHERE project_id = ?").get(projectId) as { json: string } | undefined
    return row ? JSON.parse(row.json) as Policy : undefined
  }

  markStopped(projectId: string): void {
    this.sqlite.prepare("UPDATE projects SET status = 'stopped' WHERE id = ?").run(projectId)
  }

  priorEvidence(projectId: string): { hashes: string[]; invoices: string[] } {
    const rows = this.sqlite.prepare("SELECT document_hash, invoice_number FROM expense_requests WHERE project_id = ?").all(projectId) as Array<{ document_hash: string; invoice_number: string | null }>
    return {
      hashes: rows.map((row) => row.document_hash),
      invoices: rows.map((row) => row.invoice_number).filter((value): value is string => Boolean(value)),
    }
  }

  committedSpend(projectId: string): { total: number; byCategory: Record<string, number> } {
    const rows = this.sqlite.prepare(`
      SELECT d.amount_usd AS amount, json_extract(a.json, '$.category') AS category
      FROM decisions d
      JOIN ai_extractions a ON a.expense_request_id = d.expense_request_id
      LEFT JOIN hold_queue h ON h.decision_id = d.id
      WHERE d.project_id = ?
        AND (d.outcome = 'APPROVE' OR (d.outcome = 'HOLD' AND h.status IN ('pending', 'approved')))
    `).all(projectId) as Array<{ amount: number; category: string | null }>
    const byCategory: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      total += row.amount
      if (row.category) byCategory[row.category] = (byCategory[row.category] ?? 0) + row.amount
    }
    return { total, byCategory }
  }

  insertExpense(row: { id: string; projectId: string; text: string; filename: string | null; documentHash: string; documentText: string; invoiceNumber: string | null; createdAt: string }): void {
    this.sqlite.prepare(`INSERT INTO expense_requests (id, project_id, text, filename, document_hash, document_text, invoice_number, created_at)
      VALUES (@id, @projectId, @text, @filename, @documentHash, @documentText, @invoiceNumber, @createdAt)`).run(row)
  }

  insertExtraction(row: { id: string; expenseRequestId: string; expense: Expense; fallback: boolean }): void {
    this.sqlite.prepare("INSERT INTO ai_extractions (id, expense_request_id, json, fallback) VALUES (?, ?, ?, ?)").run(row.id, row.expenseRequestId, JSON.stringify(row.expense), row.fallback ? 1 : 0)
  }

  insertLlmCall(row: { id: string; expenseRequestId: string; flow: string; model: string; source: string; promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number | null; latencyMs: number; generationId: string | null; createdAt: string }): void {
    this.sqlite.prepare(`INSERT INTO llm_calls (id, expense_request_id, flow, model, source, prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, latency_ms, generation_id, created_at)
      VALUES (@id, @expenseRequestId, @flow, @model, @source, @promptTokens, @completionTokens, @totalTokens, @reasoningTokens, @latencyMs, @generationId, @createdAt)`).run(row)
  }

  insertDecision(row: DecisionRow): void {
    this.sqlite.prepare(`INSERT INTO decisions (id, project_id, expense_request_id, outcome, reason, checks_json, evidence_hash, amount_usd, payee, chain_record_tx, chain_release_tx, chain_status, chain_error, created_at)
      VALUES (@id, @project_id, @expense_request_id, @outcome, @reason, @checks_json, @evidence_hash, @amount_usd, @payee, @chain_record_tx, @chain_release_tx, @chain_status, @chain_error, @created_at)`).run(row)
  }

  insertHold(row: HoldRow): void {
    this.sqlite.prepare("INSERT INTO hold_queue (id, decision_id, project_id, status, resolved_at) VALUES (@id, @decision_id, @project_id, @status, @resolved_at)").run(row)
  }

  getHold(id: string): (HoldRow & { evidence_hash: string; amount_usd: number; payee: string; reason: string }) | undefined {
    return this.sqlite.prepare(`
      SELECT h.*, d.evidence_hash, d.amount_usd, d.payee, d.reason
      FROM hold_queue h JOIN decisions d ON d.id = h.decision_id
      WHERE h.id = ?
    `).get(id) as (HoldRow & { evidence_hash: string; amount_usd: number; payee: string; reason: string }) | undefined
  }

  resolveHold(id: string, status: "approved" | "rejected", resolvedAt: string): void {
    this.sqlite.prepare("UPDATE hold_queue SET status = ?, resolved_at = ? WHERE id = ?").run(status, resolvedAt, id)
  }

  setDecisionChain(id: string, patch: { chain_record_tx?: string | null; chain_release_tx?: string | null; chain_status: string; chain_error?: string | null }): void {
    const current = this.sqlite.prepare("SELECT chain_record_tx, chain_release_tx, chain_error FROM decisions WHERE id = ?").get(id) as { chain_record_tx: string | null; chain_release_tx: string | null; chain_error: string | null }
    this.sqlite.prepare("UPDATE decisions SET chain_record_tx = ?, chain_release_tx = ?, chain_status = ?, chain_error = ? WHERE id = ?").run(
      patch.chain_record_tx === undefined ? current.chain_record_tx : patch.chain_record_tx,
      patch.chain_release_tx === undefined ? current.chain_release_tx : patch.chain_release_tx,
      patch.chain_status,
      patch.chain_error === undefined ? current.chain_error : patch.chain_error,
      id,
    )
  }

  insertSettlement(row: { id: string; decisionId: string; txHash: string | null; amountUsd: number; payee: string; createdAt: string }): void {
    this.sqlite.prepare("INSERT INTO settlements (id, decision_id, tx_hash, amount_usd, payee, created_at) VALUES (@id, @decisionId, @txHash, @amountUsd, @payee, @createdAt)").run(row)
  }

  listHolds(projectId: string): Array<HoldRow & { amount_usd: number; reason: string; vendor: string; category: string; purpose: string; text: string }> {
    return this.sqlite.prepare(`
      SELECT h.*, d.amount_usd, d.reason,
        json_extract(a.json, '$.vendor') AS vendor,
        json_extract(a.json, '$.category') AS category,
        json_extract(a.json, '$.purpose') AS purpose,
        e.text AS text
      FROM hold_queue h
      JOIN decisions d ON d.id = h.decision_id
      JOIN expense_requests e ON e.id = d.expense_request_id
      JOIN ai_extractions a ON a.expense_request_id = e.id
      WHERE h.project_id = ?
      ORDER BY h.rowid
    `).all(projectId) as Array<HoldRow & { amount_usd: number; reason: string; vendor: string; category: string; purpose: string; text: string }>
  }

  recentDecisions(projectId: string): DecisionRow[] {
    return this.sqlite.prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at").all(projectId) as DecisionRow[]
  }

  spending(projectId: string): { released: number; pendingHolds: number; settlements: Array<{ tx_hash: string | null; amount_usd: number; payee: string }> } {
    const released = this.sqlite.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM settlements WHERE decision_id IN (SELECT id FROM decisions WHERE project_id = ?)").get(projectId) as { total: number }
    const pending = this.sqlite.prepare(`
      SELECT COALESCE(SUM(d.amount_usd), 0) AS total
      FROM hold_queue h JOIN decisions d ON d.id = h.decision_id
      WHERE h.project_id = ? AND h.status = 'pending'
    `).get(projectId) as { total: number }
    const settlements = this.sqlite.prepare(`
      SELECT s.tx_hash, s.amount_usd, s.payee FROM settlements s
      JOIN decisions d ON d.id = s.decision_id
      WHERE d.project_id = ?
    `).all(projectId) as Array<{ tx_hash: string | null; amount_usd: number; payee: string }>
    return { released: released.total, pendingHolds: pending.total, settlements }
  }

  metrics(): { kiln: MetricGroup; mock: MetricGroup } {
    const rows = this.sqlite.prepare("SELECT flow, source, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at FROM llm_calls ORDER BY created_at").all() as Array<{
      flow: string
      source: "kiln" | "mock"
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      latency_ms: number
      created_at: string
    }>
    return { kiln: group(rows.filter((row) => row.source === "kiln")), mock: group(rows.filter((row) => row.source === "mock")) }
  }
}

export type MetricGroup = {
  calls: Array<{ flow: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number; created_at: string }>
  byFlow: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number; total_tokens: number }>
}

function group(rows: Array<{ flow: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number; created_at: string }>): MetricGroup {
  const byFlow: MetricGroup["byFlow"] = {}
  for (const row of rows) {
    const bucket = byFlow[row.flow] ?? { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    bucket.calls += 1
    bucket.prompt_tokens += row.prompt_tokens
    bucket.completion_tokens += row.completion_tokens
    bucket.total_tokens += row.total_tokens
    byFlow[row.flow] = bucket
  }
  return {
    calls: rows.map(({ flow, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at }) => ({ flow, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at })),
    byFlow,
  }
}

export function checksFrom(json: string): Check[] {
  return JSON.parse(json) as Check[]
}
