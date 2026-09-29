// The chain, the purchase agent and the auditor on screen (escrow/chain.py, escrow/agent.py,
// escrow/audit.py): tx links under the lines they mirror, the contract's balances next to the
// engine ledger, the contractor's agent, and a verification that uses the records alone.

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, errorText } from "../api"
import { shortHash, won } from "../format"
import { DECISION_TONE, ROLE_KO, RULE_KO, label, toneOf } from "../labels"
import type { AgentRun, AgentTask, AuditReport, ChainResult, OnchainState, ProjectView } from "../types"
import { useProject } from "./projectCtx"
import { Banner, Card, Chip, Empty, Field, Money, useApp, useSamples } from "./ui"

/** The tx (or the contract's refusal) of each call that mirrors a line or an item. */
export function ChainLinks({ results }: { results?: ChainResult[] | null }) {
  const { t } = useTranslation()
  if (!results?.length) return null
  return (
    <span className="chain-links">
      {results.map((r) =>
        r.tx ? (
          <a
            key={`${r.line}.${r.n}`}
            className="chain-link"
            href={r.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={`${r.call} ${JSON.stringify(r.args)}`}
          >
            ⛓ {r.call} {shortHash(r.tx, 6, 4)} ↗
          </a>
        ) : (
          <span key={`${r.line}.${r.n}`} className={`chain-link ${r.ok ? "" : "chain-refused"}`}>
            ⛓ {r.call} · {r.ok ? t("chain.already") : t("chain.refused", { error: r.error })}
          </span>
        ),
      )}
    </span>
  )
}

const ROWS = ["funded", "reserved", "paid", "refunded", "available"] as const

/** The contract's view of the project next to the engine's ledger. */
export function ChainCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const [state, setState] = useState<OnchainState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enabled = !!view.chain?.enabled
  const load = useCallback(() => {
    api
      .onchain(view.id)
      .then((s) => {
        setState(s)
        setError(null)
      })
      .catch((e) => setError(errorText(e)))
  }, [view.id])
  useEffect(() => {
    if (enabled) load()
  }, [enabled, load, view.log.length])
  const pending = state?.chain.pending ?? view.chain?.pending ?? 0
  useEffect(() => {
    if (!enabled || pending === 0) return
    const h = window.setTimeout(load, 2500)
    return () => window.clearTimeout(h)
  }, [enabled, pending, load, state])

  if (!enabled) {
    return (
      <Card title={t("chain.title")} id="sec-chain">
        <p className="muted small">{t("chain.off")}</p>
      </Card>
    )
  }
  const on = state?.onchain
  const eng = state?.engine
  return (
    <Card
      title={t("chain.title")}
      id="sec-chain"
      sub={t("chain.sub")}
      aside={
        view.chain?.contract_url && (
          <a className="linkish small" href={view.chain.contract_url} target="_blank" rel="noreferrer">
            {t("chain.contract")} {shortHash(view.chain.contract, 6, 4)} ↗
          </a>
        )
      }
    >
      <div className="chips">
        {pending > 0 ? (
          <Chip tone="warn">{t("chain.pending", { count: pending })}</Chip>
        ) : state?.match ? (
          <Chip tone="ok">✓ {t("chain.match")}</Chip>
        ) : on ? (
          <Chip tone="bad">{t("chain.mismatch")}</Chip>
        ) : null}
        {on?.paused && <Chip tone="warn">{t("project.paused")}</Chip>}
        <Chip tone="muted">
          {view.chain?.network} · {view.chain?.sent ?? 0} tx
        </Chip>
      </div>
      {error && <p className="muted small">{t("chain.loadError", { error })}</p>}
      {state && !on && <p className="muted small">{t("chain.notOpened")}</p>}
      {on && eng && (
        <table className="chain-table">
          <thead>
            <tr>
              <th />
              <th>{t("chain.onchain")}</th>
              <th>{t("chain.engine")}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((k) => (
              <tr key={k} className={on[k] === eng[k] ? "" : "chain-diff"}>
                <th>{t(`chain.${k}`)}</th>
                <td>
                  <Money n={on[k]} />
                </td>
                <td>
                  <Money n={eng[k]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">{t("chain.guard")}</p>
    </Card>
  )
}

/** The contractor hands a task to the purchase agent; everyone sees what it asked and what the rules said. */
export function AgentPanel({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const { notify } = useApp()
  const { replace } = useProject()
  const quotes = useSamples().filter((s) => s.kind === "quote")
  const can = view.actions.some((a) => a.action === "agent_run")
  const [task, setTask] = useState(() => t("agent.example"))
  const [picked, setPicked] = useState<string[] | null>(null)
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<AgentRun | null>(null)
  const chosen = picked ?? quotes.map((q) => q.id)
  const tasks = view.agent_tasks ?? []
  if (!can && tasks.length === 0) return null

  const run = async () => {
    const selected = quotes.filter((q) => chosen.includes(q.id))
    if (!selected.length) return notify("error", t("agent.noOffers"))
    setRunning(true)
    try {
      const docs = await Promise.all(selected.map((q) => api.uploadDocument(q.name, q.text)))
      const res = await api.agentRun(view.id, view.viewer.role, task, docs.map((d) => d.id))
      setLast(res.result)
      replace(res.view)
      notify("ok", t("agent.done", { id: res.result.task, count: res.result.tried.length }))
    } catch (e) {
      notify("error", errorText(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card title={t("agent.title")} id="sec-agent" sub={t("agent.sub")}>
      {can && (
        <div className="agent-form">
          <Field label={t("agent.task")}>
            <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} />
          </Field>
          <fieldset className="agent-offers">
            <legend className="small muted">{t("agent.offers")}</legend>
            {quotes.map((q) => (
              <label key={q.id} className="agent-offer">
                <input
                  type="checkbox"
                  checked={chosen.includes(q.id)}
                  onChange={(e) =>
                    setPicked(e.target.checked ? [...chosen, q.id] : chosen.filter((x) => x !== q.id))
                  }
                />
                {q.name}
              </label>
            ))}
          </fieldset>
          <p className="muted small">{t("agent.rule")}</p>
          <div className="row-end">
            <button type="button" className="btn btn-primary" onClick={run} disabled={running || !task.trim()}>
              {running ? t("agent.running") : t("agent.run")}
            </button>
          </div>
        </div>
      )}
      {!can && view.viewer.role === "client" && <Banner tone="info">{t("agent.clientNote")}</Banner>}
      {last?.stopped && <Banner tone="warn">{t("agent.stopped", { why: last.stopped })}</Banner>}
      <h3 className="agent-h">{t("agent.history")}</h3>
      {tasks.length === 0 && <Empty>{t("agent.none")}</Empty>}
      <div className="stack">
        {[...tasks].reverse().map((task) => (
          <AgentTaskView key={task.id} task={task} />
        ))}
      </div>
    </Card>
  )
}

function AgentTaskView({ task }: { task: AgentTask }) {
  const { t } = useTranslation()
  const name = (id: string) => task.offers.find((o) => o.id === id)?.name ?? shortHash(id, 6, 4)
  const u = task.ai?.usage
  return (
    <details className="item record agent-task" open>
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>
            {task.id} · {task.task}
          </h3>
        </div>
        <span className="muted small">#{task.line}</span>
      </summary>
      <div className="record-body">
        {u && (
          <p className="muted small">
            {t("agent.usage", { model: task.ai?.model ?? "", tokens: u.tokens ?? 0, cost: (u.cost_usd ?? 0).toFixed(5), seconds: u.seconds ?? 0 })}
          </p>
        )}
        <ol className="agent-needs">
          {task.plan.needs.map((n) => {
            const tried = task.requests.filter((r) => r.need === n.need)
            return (
              <li key={n.need}>
                <strong>{n.need}</strong> <span className="muted small">{n.why}</span>
                <div className="agent-tries">
                  {n.offers.length === 0 && <span className="muted small">{t("agent.offerless")}</span>}
                  {n.offers.map((id, k) => {
                    const r = tried.find((x) => x.try === k + 1)
                    return (
                      <span key={id} className="agent-try">
                        {k > 0 && <span aria-hidden>→ </span>}
                        {name(id)}{" "}
                        {r?.result && (
                          <Chip tone={toneOf(DECISION_TONE, r.result)}>
                            {r.expense} {r.result}
                            {r.rule ? ` · ${label(RULE_KO, r.rule)}` : ""}
                          </Chip>
                        )}
                      </span>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ol>
        {task.plan.skip.length > 0 && (
          <p className="muted small">
            {t("agent.skip")}: {task.plan.skip.map((s) => `${name(s.offer)} (${s.why})`).join(" · ")}
          </p>
        )}
      </div>
    </details>
  )
}

/** python3 -m escrow.audit on screen: every payment rebuilt from the records alone. */
export function AuditCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const [report, setReport] = useState<AuditReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(await api.audit(view.id))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const v = report?.verdict
  return (
    <Card
      title={t("audit.title")}
      id="sec-audit"
      sub={
        <>
          {t("audit.sub")} <code className="small">{t("audit.cli", { id: view.id })}</code>
        </>
      }
      aside={
        <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? t("audit.running") : t("audit.run")}
        </button>
      }
    >
      {error && <Banner tone="bad">{error}</Banner>}
      {report && !report.replay.ok && report.replay.refused && (
        <Banner tone="bad">{t("audit.tampered", { line: report.replay.refused.line, error: report.replay.refused.error })}</Banner>
      )}
      {report && report.replay.ok && (
        <div className="audit">
          {v && (
            <Banner tone={v.records_consistent && v.inside === v.payments ? "ok" : "bad"}>
              {t("audit.verdict", {
                payments: v.payments,
                inside: v.inside,
                stops: v.stops,
                state: v.records_consistent ? t("audit.consistent") : t("audit.inconsistent"),
              })}
            </Banner>
          )}
          <ul className="audit-checks">
            <li>✓ {t("audit.signatures", { lines: report.lines })}</li>
            <li>
              ✓ {t("audit.replay", { status: report.replay.status, paid: won(report.replay.ledger.released) })}
            </li>
            {report.policies.map((p) => (
              <li key={p.version}>
                ✓ v{p.version} <code>{shortHash(p.hash, 10, 6)}</code> · {label(ROLE_KO, "client")} {p.signed.client ? "✓" : "✗"} ·{" "}
                {label(ROLE_KO, "contractor")} {p.signed.contractor ? "✓" : "✗"} · {p.status}
              </li>
            ))}
          </ul>
          <h3 className="agent-h">{t("audit.payments")}</h3>
          {(report.payments ?? []).length === 0 && <Empty>{t("audit.noPayments")}</Empty>}
          {(report.payments ?? []).map((p) => (
            <div key={p.ref} className="audit-payment">
              <div className="audit-line">
                <strong>{p.ref}</strong>{" "}
                <Money n={p.payments.reduce((a, x) => a + x.amount, 0)} /> → {shortHash(p.payee, 6, 4)} · v{p.policy.version}{" "}
                <Chip tone={p.inside ? "ok" : "bad"}>{p.inside ? t("audit.inside") : t("audit.outside")}</Chip>
              </div>
              {p.request && (
                <div className="small">
                  {t("audit.requested", { line: p.request.line, by: label(ROLE_KO, p.request.by) })}
                  {p.request.via && <> · {t("agent.via", { need: p.request.via.need })}</>} ·{" "}
                  {p.request.reading.vendor} {won(p.request.reading.amount)} + {won(p.request.reading.fee)} ={" "}
                  {won(p.request.reading.total)} ·{" "}
                  {p.request.evidence.found
                    ? `${p.request.evidence.hash_ok ? t("audit.evidenceOk") : "hash ✗"}${p.request.evidence.total_in_text ? ` · ${t("audit.totalInDoc")}` : ""}`
                    : t("audit.evidenceMissing")}
                </div>
              )}
              {p.decision && (
                <div className="audit-rules small">
                  {p.decision.rules.map((r) => (
                    <span key={r.rule} className={r.ok === false ? "rule-bad" : ""}>
                      {label(RULE_KO, r.rule)} {r.ok ? "✓" : r.ok === false ? "✗" : "?"}
                    </span>
                  ))}
                  <strong> → {p.decision.result}</strong>
                </div>
              )}
              {(p.client_approval ?? []).map((a) => (
                <div key={a.line} className="small">
                  {t("audit.approvedBy", { line: a.line })}
                </div>
              ))}
              {p.payments.map((x) => (
                <div key={`${x.line}-${x.unit ?? ""}`} className="small">
                  #{x.line} {x.unit ? `${x.unit} ` : ""}
                  {won(x.amount)} — {x.how}
                </div>
              ))}
            </div>
          ))}
          <h3 className="agent-h">{t("audit.stops")}</h3>
          {(report.stops ?? []).map((s) => (
            <div key={s.ref} className="small audit-line">
              <Chip tone={toneOf(DECISION_TONE, s.result)}>{s.result}</Chip> {s.ref} #{s.line} · {label(RULE_KO, s.rule)}
              {s.via && <> · {t("agent.via", { need: s.via.need })}</>}
              {s.amount ? ` · ${won(s.amount)}` : ""}
            </div>
          ))}
          {report.chain && (
            <>
              <h3 className="agent-h">{t("audit.chain")}</h3>
              {report.chain.error && <p className="muted small">{report.chain.error}</p>}
              <ul className="audit-checks">
                {report.chain.balances_match !== undefined && (
                  <li>
                    {report.chain.balances_match ? "✓" : "✗"} {t("audit.balances")}
                  </li>
                )}
                {(report.chain.problems ?? []).map((x) => (
                  <li key={x} className="rule-bad">
                    ✗ {x}
                  </li>
                ))}
              </ul>
              <div className="chain-links">
                {(report.chain.calls ?? []).map((c) => (
                  <a key={`${c.line}.${c.n}`} className="chain-link" href={c.url} target="_blank" rel="noreferrer">
                    {c.ok ? "✓" : "✗"} #{c.line} {c.call} {shortHash(c.tx, 6, 4)} ↗
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
