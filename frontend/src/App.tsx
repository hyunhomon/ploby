import { useEffect, useState } from "react"
import { api, basescanTx, type Decision, type Health, type Hold, type Metrics, type Spending } from "./api"

const STORAGE_KEY = "smartescrow.projectId"
const CASES = [
  { label: "Case 1 · $200 AWS", text: "Request $200 for AWS server costs." },
  { label: "Case 2 · gaming console", text: "Gaming console $300" },
  { label: "Case 3 · $500 over limit", text: "Request $500 for AWS server costs." },
  { label: "Case 4 · invoice #1023", text: "Invoice #1023 for AWS server costs $200" },
]

const CHECK_LABELS: Record<string, string> = {
  project_scope: "Project scope",
  allowed_category: "Allowed category",
  approved_vendor: "Approved vendor",
  remaining_budget: "Remaining budget",
  category_budget: "Category budget",
  max_transaction: "Transaction limit",
  deadline: "Deadline",
  duplicate_evidence: "Duplicate evidence",
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [name, setName] = useState("Website Development")
  const [clientAddress, setClientAddress] = useState("0x1111111111111111111111111111111111111111")
  const [payeeAddress, setPayeeAddress] = useState("0x2222222222222222222222222222222222222222")
  const [policyText, setPolicyText] = useState("")
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectStatus, setProjectStatus] = useState<string>("")
  const [text, setText] = useState(CASES[0].text)
  const [file, setFile] = useState<File | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [holds, setHolds] = useState<Hold[]>([])
  const [spending, setSpending] = useState<Spending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.health().then(setHealth).catch((err: Error) => setError(err.message))
    api.demoPolicy().then((policy) => setPolicyText(JSON.stringify(policy, null, 2))).catch(() => undefined)
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) void loadProject(saved)
  }, [])

  useEffect(() => {
    if (!projectId) return
    const source = new EventSource(`/api/projects/${projectId}/events`)
    source.onmessage = () => {
      void refresh(projectId)
    }
    return () => source.close()
  }, [projectId])

  async function loadProject(id: string) {
    try {
      const project = await api.project(id)
      setProjectId(project.id)
      setProjectStatus(project.status)
      setName(project.name)
      localStorage.setItem(STORAGE_KEY, project.id)
      await refresh(project.id)
    } catch {
      localStorage.removeItem(STORAGE_KEY)
      setProjectId(null)
    }
  }

  async function refresh(id: string) {
    const [nextHolds, nextSpending, nextMetrics, project] = await Promise.all([
      api.holds(id),
      api.spending(id),
      api.metrics(),
      api.project(id),
    ])
    setHolds(nextHolds)
    setSpending(nextSpending)
    setMetrics(nextMetrics)
    setProjectStatus(project.status)
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const policy = JSON.parse(policyText) as unknown
      const created = await api.createProject({ name, clientAddress, payeeAddress, policy })
      setDecision(null)
      await loadProject(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create project")
    } finally {
      setBusy(false)
    }
  }

  async function submitExpense(event: React.FormEvent) {
    event.preventDefault()
    if (!projectId) return
    setError(null)
    setBusy(true)
    try {
      const next = await api.submit(projectId, text, file)
      setDecision(next)
      await refresh(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not submit expense")
    } finally {
      setBusy(false)
    }
  }

  async function resolveHold(holdId: string, action: "approve" | "reject") {
    if (!projectId) return
    setError(null)
    setBusy(true)
    try {
      if (action === "approve") await api.approve(holdId)
      else await api.reject(holdId)
      await refresh(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update hold")
    } finally {
      setBusy(false)
    }
  }

  async function stopAgent() {
    if (!projectId) return
    setError(null)
    setBusy(true)
    try {
      await api.stop(projectId)
      await refresh(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not stop the agent")
    } finally {
      setBusy(false)
    }
  }

  const stopped = projectStatus === "stopped"

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Outsourcing expense escrow</p>
          <h1>Release only compliant expenses.</h1>
        </div>
        <p className="status">
          {health ? `Model ${health.kiln === "mock" ? "mock" : "Kiln"} · chain ${health.chain ? "on" : "skipped"}` : "API unreachable"}
        </p>
      </header>

      {error && <p className="banner error">{error}</p>}
      {stopped && <p className="banner">Agent stopped. New requests are blocked.</p>}

      <section>
        <h2>Submit an expense</h2>
        <form onSubmit={submitExpense}>
          <div className="cases">
            {CASES.map((item) => (
              <button key={item.label} type="button" onClick={() => setText(item.text)}>{item.label}</button>
            ))}
          </div>
          <label>
            Request
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} required />
          </label>
          <label>
            Invoice or receipt
            <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" disabled={!projectId || busy}>{busy ? "Working…" : "Submit"}</button>
          {!projectId && <p className="hint">Create the project below before submitting.</p>}
        </form>
      </section>

      <section>
        <h2>Decision</h2>
        {decision ? <DecisionView decision={decision} /> : <p className="hint">No expense submitted yet.</p>}
      </section>

      <section>
        <h2>HOLD queue</h2>
        {holds.length === 0 && <p className="hint">No held expenses.</p>}
        <ul className="holds">
          {holds.map((hold) => (
            <li key={hold.id}>
              <div>
                <strong>{hold.vendor}</strong> · {hold.category} · ${hold.amount_usd}
                <p>{hold.reason}</p>
                <p className="hint">{hold.text}</p>
              </div>
              {hold.status === "pending" && !stopped ? (
                <div className="row">
                  <button type="button" onClick={() => resolveHold(hold.id, "approve")} disabled={busy}>Approve and release</button>
                  <button type="button" className="secondary" onClick={() => resolveHold(hold.id, "reject")} disabled={busy}>Reject</button>
                </div>
              ) : <span className={`pill ${hold.status}`}>{hold.status}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Project and policy</h2>
        <form onSubmit={createProject}>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>Client address<input value={clientAddress} onChange={(event) => setClientAddress(event.target.value)} required /></label>
          <label>Payee address<input value={payeeAddress} onChange={(event) => setPayeeAddress(event.target.value)} required /></label>
          <label>Policy JSON<textarea value={policyText} onChange={(event) => setPolicyText(event.target.value)} rows={12} required /></label>
          <button type="submit" disabled={busy}>{projectId ? "Create another project" : "Create project"}</button>
          {projectId && <p className="hint">Current project {projectId} · {projectStatus || "active"}</p>}
        </form>
      </section>

      <section>
        <div className="section-head">
          <h2>Spending</h2>
          <button type="button" className="danger" onClick={stopAgent} disabled={!projectId || stopped || busy}>Stop agent</button>
        </div>
        {spending ? (
          <>
            <dl className="stats">
              <div><dt>Budget</dt><dd>${spending.budget}</dd></div>
              <div><dt>Released</dt><dd>${spending.released}</dd></div>
              <div><dt>Pending holds</dt><dd>${spending.pendingHolds}</dd></div>
              <div><dt>Remaining</dt><dd>${spending.remaining}</dd></div>
            </dl>
            {spending.settlements.length > 0 && (
              <ul className="settlements">
                {spending.settlements.map((item, index) => (
                  <li key={`${item.tx_hash ?? "local"}-${index}`}>
                    ${item.amount_usd} to {short(item.payee)} · <TxHash hash={item.tx_hash} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : <p className="hint">Spending appears after a project exists.</p>}
      </section>

      <section>
        <h2>Token metrics</h2>
        <MetricsView metrics={metrics} />
      </section>
    </main>
  )
}

function DecisionView({ decision }: { decision: Decision }) {
  return (
    <div>
      <p className={`pill ${decision.outcome.toLowerCase()}`}>{decision.outcome}</p>
      <p className="reason">{decision.reason}</p>
      {decision.fallback && <p className="hint">The model output failed validation. This hold is the safe fallback.</p>}
      <dl className="expense">
        <div><dt>Vendor</dt><dd>{decision.expense.vendor}</dd></div>
        <div><dt>Category</dt><dd>{decision.expense.category}</dd></div>
        <div><dt>Amount</dt><dd>{decision.expense.currency} {decision.expense.amount}</dd></div>
        <div><dt>Purpose</dt><dd>{decision.expense.purpose}</dd></div>
        <div><dt>Relevance</dt><dd>{decision.expense.project_relevance}</dd></div>
        <div><dt>Document</dt><dd>{decision.expense.document_type}</dd></div>
      </dl>
      <p className="hint">{decision.expense.rationale}</p>
      {decision.expense.anomaly_flags.length > 0 && <p>Flags: {decision.expense.anomaly_flags.join(", ")}</p>}
      {decision.checks.length > 0 && (
        <table>
          <thead><tr><th>Check</th><th>Result</th><th>Reason</th></tr></thead>
          <tbody>
            {decision.checks.map((check) => (
              <tr key={check.id}>
                <td>{CHECK_LABELS[check.id] ?? check.id}</td>
                <td>{check.pass ? "Pass" : "Fail"}</td>
                <td>{check.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>Record <TxHash hash={decision.chain.recordTx} /> · Release <TxHash hash={decision.chain.releaseTx} /> · {decision.chain.status}</p>
      {decision.chain.error && <p className="hint">{decision.chain.error}</p>}
      <p className="hint">
        Tokens ({decision.llm.source === "mock" ? "mock, not Kiln evidence" : "Kiln"}): {decision.llm.calls.map((call) => `${call.flow} ${call.prompt_tokens}+${call.completion_tokens}`).join(" · ") || "none"}
      </p>
    </div>
  )
}

function TxHash({ hash }: { hash: string | null }) {
  if (!hash) return <span>none</span>
  const href = basescanTx(hash)
  if (!href) return <span>{hash}</span>
  return <a href={href} target="_blank" rel="noreferrer">{hash}</a>
}

function MetricsView({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) return <p className="hint">No model calls yet.</p>
  return (
    <div className="metrics">
      <MetricBlock title="Kiln" group={metrics.kiln} />
      <MetricBlock title="Mock" group={metrics.mock} note="Not Kiln evidence." />
    </div>
  )
}

function MetricBlock({ title, group, note }: { title: string; group: Metrics["kiln"]; note?: string }) {
  const flows = Object.entries(group.byFlow)
  return (
    <div>
      <h3>{title}</h3>
      {note && <p className="hint">{note}</p>}
      {flows.length === 0 && <p className="hint">No calls.</p>}
      {flows.map(([flow, totals]) => (
        <p key={flow}>{flow}: {totals.calls} calls, prompt {totals.prompt_tokens}, completion {totals.completion_tokens}, total {totals.total_tokens}</p>
      ))}
    </div>
  )
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}
