export type Check = { id: string; pass: boolean; reason: string | null }

export type Expense = {
  vendor: string
  category: string
  amount: number
  currency: string
  purpose: string
  project_relevance: string
  document_type: string
  anomaly_flags: string[]
  rationale: string
}

export type Decision = {
  expenseRequestId: string
  decisionId: string
  holdId: string | null
  outcome: "APPROVE" | "HOLD" | "BLOCK"
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

export type Hold = {
  id: string
  status: "pending" | "approved" | "rejected"
  amount_usd: number
  reason: string
  vendor: string
  category: string
  purpose: string
  text: string
}

export type Spending = {
  budget: number
  released: number
  pendingHolds: number
  remaining: number
  settlements: Array<{ tx_hash: string | null; amount_usd: number; payee: string }>
}

export type Health = { ok: boolean; kiln: "kiln" | "mock"; chain: boolean }

export type Metrics = {
  kiln: MetricGroup
  mock: MetricGroup
}

type MetricGroup = {
  calls: Array<{ flow: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number }>
  byFlow: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number; total_tokens: number }>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const text = await response.text()
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `request failed (${response.status})`)
  return body as T
}

export const api = {
  health: () => request<Health>("/api/health"),
  demoPolicy: () => request<unknown>("/api/demo-policy"),
  metrics: () => request<Metrics>("/api/metrics"),
  createProject: (body: { name: string; clientAddress: string; payeeAddress: string; policy: unknown }) =>
    request<{ id: string; policyHash: string; chain: boolean }>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  project: (id: string) => request<{ id: string; name: string; status: string; policy_hash: string; budget_usd: number }>(`/api/projects/${id}`),
  submit: (id: string, text: string, file: File | null) => {
    const form = new FormData()
    form.set("text", text)
    if (file) form.set("file", file)
    return request<Decision>(`/api/projects/${id}/expenses`, { method: "POST", body: form })
  },
  holds: (id: string) => request<Hold[]>(`/api/projects/${id}/holds`),
  approve: (holdId: string) => request<{ holdId: string; releaseTx: string | null; chainStatus: string }>(`/api/holds/${holdId}/approve`, { method: "POST" }),
  reject: (holdId: string) => request<{ holdId: string }>(`/api/holds/${holdId}/reject`, { method: "POST" }),
  stop: (id: string) => request<{ projectId: string; tx: string | null }>(`/api/projects/${id}/stop`, { method: "POST" }),
  spending: (id: string) => request<Spending>(`/api/projects/${id}/spending`),
}

export function basescanTx(hash: string | null): string | null {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  return `https://sepolia.basescan.org/tx/${hash}`
}
