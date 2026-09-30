// The chain, the purchase agent and the auditor on screen (escrow/chain.py, escrow/agent.py,
// escrow/audit.py): tx links under the lines they mirror, the contract's balances next to the
// engine ledger, the contractor's agent, and a verification that uses the records alone.

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, downloadEvidence, errorText, FIXTURE } from "../api"
import { L } from "../i18n"
import { shortHash, won } from "../format"
import { DECISION_TONE, ROLE_KO, RULE_KO, label, toneOf } from "../labels"
import type { AgentRun, AgentTask, AuditReport, ChainResult, Expense, Milestone, OnchainState, ProjectView } from "../types"
import { useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, Empty, Field, KV, Modal, Money, useApp, useSamples } from "./ui"

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
          <details className="mini-fold">
          <summary>{L("검토할 견적", "Offers to review")} · {chosen.length}</summary>
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
          </details>
          <p className="muted small">{t("agent.rule")}</p>
          <div className="row-end">
            <button type="button" className="btn btn-primary" onClick={run} disabled={running || !task.trim()}>
              {running ? t("agent.running") : t("agent.run")}
            </button>
          </div>
        </div>
      )}
      {!can && view.viewer.role === "client" && <Banner tone="info">{t("agent.clientNote")}</Banner>}
      {last?.stopped && <Banner tone="warn">{L("프로젝트가 멈춰 있어 나머지 구매를 중단했습니다.", "Project paused. Remaining purchases stopped.")}</Banner>}
      <h3 className="agent-h">{L("최근 결과", "Latest result")}</h3>
      {tasks.length === 0 && <Empty>{t("agent.none")}</Empty>}
      <div className="stack">
        {tasks.length > 0 && <AgentTaskView key={tasks[tasks.length - 1].id} task={tasks[tasks.length - 1]} />}
        {tasks.length > 1 && <details className="mini-fold"><summary>{t("agent.history")} · {tasks.length - 1}</summary>
          {[...tasks].reverse().slice(1).map((task) => <AgentTaskView key={task.id} task={task} />)}
        </details>}
      </div>
    </Card>
  )
}

function AgentTaskView({ task }: { task: AgentTask }) {
  const { t } = useTranslation()
  const name = (id: string) => task.offers.find((o) => o.id === id)?.name ?? shortHash(id, 6, 4)
  const u = task.ai?.usage
  const count = (state: string) => task.requests.filter((r) => r.result === state).length
  return (
    <details className="item record agent-task">
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>
            {task.id} · {L("구매 결과와 이유", "Purchase results and reasons")}
          </h3>
          {task.stopped && <p className="small">{L("프로젝트가 멈춰 있어 나머지 구매를 중단했습니다.", "Project paused. Remaining purchases stopped.")}</p>}
          <p className="muted small">{count("APPROVE")} {L("예약", "reserved")} · {count("HOLD")} {L("검토 대기", "awaiting review")} · {count("BLOCK")} {L("차단", "blocked")}</p>
        </div>
        <span className="muted small">#{task.line}</span>
      </summary>
      <div className="record-body">
        <p>{task.task}</p>
        {u && (
          <p className="muted small">
            <Chip tone="muted">{u.cached ? L("기록 재생", "Recorded replay") : L("실제 API 호출", "Live API call")}</Chip>{" "}
            {t("agent.usage", { model: task.ai?.model ?? "", tokens: u.tokens ?? 0, cost: (u.cost_usd ?? 0).toFixed(5), seconds: u.seconds ?? 0 })}
            {u.cached && <span> · {L("토큰·시간은 최초 호출 기준", "Tokens and time refer to the original call")}</span>}
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
  const [exporting, setExporting] = useState(false)
  const stale = !!report && report.head !== view.head
  const exportRecords = async () => {
    setExporting(true)
    setError(null)
    try { await downloadEvidence(view.id) }
    catch (e) { setError(errorText(e)) }
    finally { setExporting(false) }
  }
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
  // `#/p/…?tab=audit&run=1` opens the tab with the check already running (a link for the demo).
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("run") === "1") void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
        <div className="row-wrap">
          <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>{busy ? t("audit.running") : t("audit.run")}</button>
          <button type="button" className="btn" onClick={exportRecords} disabled={exporting || FIXTURE}>
            {exporting ? L("준비 중…", "Preparing…") : L("증빙 ZIP 내려받기", "Export evidence ZIP")}
          </button>
        </div>
      }
    >
      {error && <Banner tone="bad">{error}</Banner>}
      <p className="muted small">{L("ZIP에는 이 프로젝트의 기록·원문·독립 검증기가 들어 있습니다. API 키 없이 verify.py로 확인할 수 있습니다.", "The ZIP contains this project’s records, originals and a standalone verifier. Run verify.py without an API key.")}</p>
      {stale && <Banner tone="warn">{L("검사 이후 기록이 바뀌었습니다. 다시 검증해 주세요.", "Records changed after this check. Verify again for the current state.")}</Banner>}
      {report && !report.replay.ok && report.replay.refused && (
        <Banner tone="bad">{t("audit.tampered", { line: report.replay.refused.line, error: report.replay.refused.error })}</Banner>
      )}
      {report && report.replay.ok && (
        <div className="audit">
          {v && (
            <Banner tone={stale || v.status === "incomplete" || !v.status ? "warn" : v.status === "verified" ? "ok" : "bad"}>
              <strong>{stale ? L("이전 검사 결과", "Previous check") : v.status === "verified" ? L("검증 완료", "Verified") : v.status === "failed" ? L("검증 실패", "Verification failed") : L("일부 검증 완료", "Partially verified")}</strong>{" · "}
              {t("audit.verdict", {
                payments: v.payments,
                inside: v.inside,
                stops: v.stops,
                state: v.records_consistent
                  ? t("audit.consistent")
                  : v.chain === "unreachable"
                    ? t("audit.unverified")
                    : t("audit.inconsistent"),
              })}
            </Banner>
          )}
          {v && v.payments === 0 && <p>{L("아직 완료된 지급이 없습니다. 정산 후 지급의 근거를 검증할 수 있습니다.", "No payment has completed yet. Settle a purchase to verify its payment trail.")}</p>}
          <ul className="audit-checks">
            <li>{L("원문", "Original documents")}: {report.evidence?.status === "verified" ? "✓" : report.evidence?.status === "failed" ? "✗" : "—"} {report.evidence?.checked ?? 0}/{report.evidence?.total ?? 0}
              {!!report.evidence?.missing.length && <> · {report.evidence.missing.length} {L("누락", "missing")}</>}
              {!!report.evidence?.failed.length && <> · {report.evidence.failed.length} {L("불일치", "invalid")}</>}
            </li>
            <li>{L("공개 체인", "Public chain")}: {v?.chain === "checked" && !report.chain?.problems?.length ? "✓" : "—"} {v?.chain === "checked" ? L("대조 완료", "Compared") : L("확인하지 못함", "Not checked")}</li>
            <li>{L("사용자 승인", "Human approval")}: {report.authorization?.status === "verified" ? `✓ ${report.authorization.wallet_actions} EIP-712` : L("데모 서명 또는 승인 미완료", "Demo signatures or pending approvals")}</li>
          </ul>
          {report.authorization?.status !== "verified" && <p className="muted small">{L("데모 서명은 기록 재생용입니다. 실제 사람이 승인했다는 독립적인 증명은 제공하지 않습니다.", "Demo signatures support replay. They do not independently prove a person’s approval.")}</p>}
          <details className="mini-fold">
          <summary>{L("지급·규칙·거래 상세", "Payment, rule and transaction details")}</summary>
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
                  {won(x.amount)} — {t(`audit.how.${x.op}`, { defaultValue: x.how })}
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
              {report.chain.error && <Banner tone="bad">{t("audit.unreachable", { error: report.chain.error })}</Banner>}
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
          </details>
        </div>
      )}
    </Card>
  )
}

/** The payment receipt the client receives: who was paid, how much, under which signed policy and rules, with the
 * evidence hashes, the log lines and the transactions that anyone can re-check. */
export function ReceiptButton({ e, view }: { e: Expense; view: ProjectView }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!e.paid) return null
  const v = view.versions.find((x) => x.version === e.version) ?? view.policy
  const calls = e.chain ?? []
  const decided = calls.find((r) => r.call === "decide")
  const settled = calls.filter((r) => r.call === "settle")
  const rules = e.decision?.rules ?? []
  const mandatory = rules.filter((r) => r.kind === "mandatory")
  const approval = e.resolution
    ? t(`receipt.by.${e.resolution.by}`, { reason: e.resolution.reason || "—" })
    : e.timeout === "RELEASED_BY_TIMEOUT"
      ? t("receipt.by.timeout")
      : t("receipt.by.rules")
  const line = (i: number | undefined) =>
    i === undefined ? "—" : `#${i} ${shortHash(view.log[i]?.head, 10, 4)}`
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t("receipt.open")}
      </button>
      {open && (
        <Modal title={t("receipt.title", { id: e.id })} onClose={() => setOpen(false)}>
          <KV
            items={[
              [t("receipt.amount"), <Money key="a" n={e.paid} />],
              [
                t("receipt.payee"),
                <span key="p">
                  {view.parties.contractor.name} <CopyHash hash={e.payee ?? ""} head={6} tail={4} />{" "}
                  <span className="muted small">{t("receipt.payeeNote")}</span>
                </span>,
              ],
              [t("receipt.what"), [e.vendor_name ?? e.vendor, e.item, e.category_ko].filter(Boolean).join(" · ")],
              [
                t("receipt.policy"),
                <span key="v">
                  v{v?.version} <CopyHash hash={v?.hash ?? ""} head={10} tail={6} /> · {t("receipt.signedBoth")}
                </span>,
              ],
              [
                t("receipt.decision"),
                `${e.decision?.result ?? "—"} · ${t("receipt.rulesPassed", {
                  passed: mandatory.filter((r) => r.ok).length,
                  total: mandatory.length,
                })}${e.via ? ` · ${t("agent.via", { need: e.via.need })}` : ""}`,
              ],
              [t("receipt.approval"), approval],
              [
                t("receipt.evidence"),
                <span key="d">
                  {t("receipt.quote")} <code>{shortHash(e.quote?.document?.id, 8, 4)}</code> · {t("receipt.receipt")}{" "}
                  <code>{shortHash(e.receipt?.document?.id, 8, 4)}</code>
                </span>,
              ],
              [t("receipt.record"), `${t("receipt.request")} ${line(decided?.line)} · ${t("receipt.payment")} ${line(settled[settled.length - 1]?.line)}`],
              [t("receipt.onchain"), <ChainLinks key="c" results={[...(decided ? [decided] : []), ...settled]} />],
            ]}
          />
          <p className="muted small">{t("receipt.note", { id: view.id })}</p>
        </Modal>
      )}
    </>
  )
}

/** The receipt for a milestone's paid units: which units, under which signed criteria, who accepted them (or which
 * deadline paid them), the submission's documents and the transactions. */
export function MilestoneReceiptButton({ m, view }: { m: Milestone; view: ProjectView }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!m.paid) return null
  const v = view.versions.find((x) => x.version === m.version) ?? view.policy
  const paid = m.units.filter((u) => u.status === "PAID" || u.status === "RELEASED_BY_TIMEOUT")
  const calls = (m.chain ?? []).filter((r) => r.call === "decide" || r.call === "settle")
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t("receipt.open")}
      </button>
      {open && (
        <Modal title={t("receipt.title", { id: m.id })} onClose={() => setOpen(false)}>
          <KV
            items={[
              [t("receipt.amount"), <Money key="a" n={m.paid} />],
              [
                t("receipt.payee"),
                <span key="p">
                  {view.parties.contractor.name} <CopyHash hash={view.parties.contractor.address} head={6} tail={4} />{" "}
                  <span className="muted small">{t("receipt.payeeNote")}</span>
                </span>,
              ],
              [t("receipt.work"), m.title],
              [
                t("receipt.policy"),
                <span key="v">
                  v{v?.version} <CopyHash hash={v?.hash ?? ""} head={10} tail={6} /> · {t("receipt.signedBoth")}
                </span>,
              ],
              ...paid.map((u): [string, string] => [
                `${u.title} · ${won(u.amount)}`,
                `${u.criteria.join(" · ")} — ${
                  u.status === "RELEASED_BY_TIMEOUT"
                    ? t("receipt.by.timeout")
                    : u.reason?.startsWith("resolver")
                      ? t("receipt.by.resolver", { reason: u.reason.replace(/^resolver:\s*/, "") })
                      : t("receipt.by.client", { reason: t("receipt.accepted") })
                }`,
              ]),
              [
                t("receipt.evidence"),
                (m.submission?.documents ?? []).map((d) => shortHash(d.id, 8, 4)).join(" · ") || "—",
              ],
              [t("receipt.onchain"), <ChainLinks key="c" results={calls} />],
            ]}
          />
          <p className="muted small">{t("receipt.note", { id: view.id })}</p>
        </Modal>
      )}
    </>
  )
}
