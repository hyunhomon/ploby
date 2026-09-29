// One dialog per action. Every dialog ends in POST /api/projects/{id}/actions through the
// page's `run`, which sends the action's target params plus the fields collected here.

import { useState, type ReactNode } from "react"
import type { ActionParams } from "../api"
import { duration, kst, won } from "../format"
import { tr } from "../i18n"
import {
  HOLD_CLASS,
  HOLD_RESOLVER_SILENCE,
  NON_WAIVABLE_HOLD,
  REASON_CODE,
  REASON_CODES,
  RULE_KO,
  caption,
  label,
} from "../labels"
import type { Action, DocRef, Expense, Milestone, ProjectView } from "../types"
import { FallbackTable } from "./Policy"
import { actionLabel, scrollToAnchor, useProject, type Preset } from "./projectCtx"
import { AttachedDocs, Banner, Chip, CopyHash, DocLink, DocPicker, Field, KV, Modal, Money, MoneyInput, Segmented, useApp, When } from "./ui"


function useSubmit(action: Action, onClose: () => void) {
  const { run } = useProject()
  const [busy, setBusy] = useState(false)
  const submit = async (params: ActionParams = {}) => {
    setBusy(true)
    const ok = await run(action, params)
    setBusy(false)
    if (ok) onClose()
    return ok
  }
  return { busy, submit }
}

function Footer({
  onClose,
  onConfirm,
  disabled,
  busy,
  confirm,
  danger,
}: {
  onClose: () => void
  onConfirm: () => void
  disabled?: boolean
  busy: boolean
  confirm: ReactNode
  danger?: boolean
}) {
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {tr("common.close")}
      </button>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={disabled || busy}>
        {busy ? tr("dialogs.working") : confirm}
      </button>
    </>
  )
}

function DeadlineNote({ action, now }: { action: Action; now: number }) {
  if (!action.deadline && !action.fallback) return null
  return (
    <div className="clock">
      <div className="clock-head">
        <span className="clock-title">{tr("dialogs.responseDeadline")}</span>
        <When at={action.deadline} now={now} />
      </div>
      {action.fallback && <div className="clock-fallback">{tr("dialogs.onSilence", { fallback: caption(action.fallback) })}</div>}
    </div>
  )
}

export function ActionDialog({ action, preset, onClose }: { action: Action; preset?: Preset; onClose: () => void }) {
  const { view } = useProject()
  const id = action.target ? String(action.target.id) : ""
  const milestone = view.milestones.find((m) => m.id === id)
  const expense = view.expenses.find((e) => e.id === id)
  const p = { action, onClose, view }
  switch (action.action) {
    case "sign_policy":
      return <SignDialog {...p} />
    case "deposit":
      return <DepositDialog {...p} />
    case "withdraw":
      return <WithdrawDialog {...p} />
    case "pause":
    case "resume":
      return <ReasonDialog {...p} />
    case "submit_delivery":
      return milestone ? <SubmitDeliveryDialog {...p} m={milestone} /> : <ConfirmDialog {...p} />
    case "review_delivery":
      return milestone ? <ReviewDeliveryDialog {...p} m={milestone} /> : <ConfirmDialog {...p} />
    case "resolve_milestone":
      return milestone ? <ResolveMilestoneDialog {...p} m={milestone} /> : <ConfirmDialog {...p} />
    case "request_commitment":
    case "retroactive_request":
      return <RequestDialog {...p} retro={action.action === "retroactive_request"} />
    case "submit_receipt":
      return expense ? <ReceiptDialog {...p} e={expense} /> : <ConfirmDialog {...p} />
    case "supplement_evidence":
      return expense ? <SupplementDialog {...p} e={expense} /> : <ConfirmDialog {...p} />
    case "answer_request":
      return expense ? <AnswerDialog {...p} e={expense} preset={preset} /> : <ConfirmDialog {...p} />
    case "review_settlement":
      return expense ? <SettlementDialog {...p} e={expense} preset={preset} /> : <ConfirmDialog {...p} />
    case "escalate_settlement":
      return expense ? <EscalateDialog {...p} e={expense} /> : <ConfirmDialog {...p} />
    case "resolve_expense":
      return expense ? <ResolveExpenseDialog {...p} e={expense} /> : <ConfirmDialog {...p} />
    case "draft_change_order":
      return <DraftChangeOrderDialog {...p} preset={preset} />
    default:
      return <ConfirmDialog {...p} />
  }
}

interface DialogProps {
  action: Action
  onClose: () => void
  view: ProjectView
}

// ---------------------------------------------------------------- simple confirmations

function confirmText(view: ProjectView, a: Action): { body: ReactNode; danger?: boolean } {
  const id = a.target ? String(a.target.id) : ""
  const m = view.milestones.find((x) => x.id === id)
  const e = view.expenses.find((x) => x.id === id)
  switch (a.action) {
    case "cancel_project":
      return { body: tr("dialogs.cancelProject"), danger: true }
    case "begin_close":
      return {
        body: (
          <>
            <p>{tr("dialogs.beginClose1")}</p>
            <p>{tr("dialogs.beginClose2", { amount: won(view.ledger.available) })}</p>
          </>
        ),
        danger: true,
      }
    case "start_milestone":
      return {
        body: (
          <>
            <p>{tr("dialogs.startWork", { title: m?.title ?? "", amount: won(m?.amount) })}</p>
            <p>{tr("dialogs.startWorkLocked")}</p>
            {m && <p>{tr("dialogs.startWorkDue", { due: kst(m.due_at, view.now), grace: kst(m.grace_until, view.now) })}</p>}
          </>
        ),
      }
    case "cancel_milestone":
      return { body: tr("dialogs.cancelMilestone", { amount: won(m?.amount) }), danger: true }
    case "cancel_reservation":
      return { body: tr("dialogs.cancelReservation", { amount: won(e?.reserved) }), danger: true }
    case "report_spend":
      return {
        body: (
          <>
            <p>{tr("dialogs.reportSpend1")}</p>
            <p>{tr("dialogs.reportSpend2", { period: duration(view.policy?.summary.evidence_seconds) })}</p>
          </>
        ),
      }
    case "propose_change_order":
      return {
        body: (
          <>
            <p>{tr("dialogs.propose1")}</p>
            <p>{tr("dialogs.propose2")}</p>
          </>
        ),
      }
    case "withdraw_change_order":
      return { body: tr("dialogs.withdrawChange"), danger: true }
    case "run_timeouts":
      return { body: tr("dialogs.runTimeouts") }
    default:
      return { body: tr("dialogs.runAction", { action: actionLabel(a) }) }
  }
}

function ConfirmDialog({ action, onClose, view }: DialogProps) {
  const { busy, submit } = useSubmit(action, onClose)
  const t = confirmText(view, action)
  return (
    <Modal title={actionLabel(action)} onClose={onClose} footer={<Footer onClose={onClose} onConfirm={() => submit()} busy={busy} confirm={actionLabel(action)} danger={t.danger} />}>
      <div className="prose">{t.body}</div>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

// ---------------------------------------------------------------- project

function SignDialog({ action, onClose, view }: DialogProps) {
  const { busy, submit } = useSubmit(action, onClose)
  const version = action.target?.kind === "policy" ? Number(action.target.id) : view.proposals[0]?.version
  const p = view.proposals.find((x) => x.version === version) ?? view.proposals[0]
  return (
    <Modal
      title={tr("dialogs.signTitle", { version: p?.version ?? "?" })}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit()} busy={busy} confirm={tr("dialogs.signConfirm")} />}
    >
      {p ? (
        <>
          <p>{tr("dialogs.signBody")}</p>
          <KV
            items={[
              [tr("dialogs.policyHash"), <CopyHash hash={p.hash} head={12} tail={8} />],
              [tr("dialogs.projectBudget"), <Money n={p.summary.project_budget} />],
              [tr("dialogs.initialFunding"), <Money n={p.summary.initial_funding} />],
              [tr("dialogs.milestones"), tr("dialogs.milestoneCount", { count: p.milestones.length, amount: won(p.summary.milestone_budget) })],
              [tr("dialogs.expenseBudget"), <Money n={p.summary.expense_budget} />],
            ]}
          />
          <h3 className="dialog-h">{tr("dialogs.silenceOutcomes")}</h3>
          <FallbackTable p={p} />
        </>
      ) : (
        <p>{tr("dialogs.noPolicy")}</p>
      )}
    </Modal>
  )
}

function DepositDialog({ action, onClose, view }: DialogProps) {
  const { busy, submit } = useSubmit(action, onClose)
  const room = view.ledger.deposit_room
  const needed = view.ledger.funding_needed ?? 0
  const [amount, setAmount] = useState<number | null>(needed > 0 ? needed : room > 0 ? room : null)
  const bad = amount === null || amount <= 0 || (room > 0 && amount > room)
  return (
    <Modal title={tr("dialogs.deposit")} onClose={onClose} footer={<Footer onClose={onClose} onConfirm={() => submit({ amount })} busy={busy} disabled={bad} confirm={tr("dialogs.deposit")} />}>
      <KV
        items={[
          [tr("dialogs.depositNeeded"), <Money n={needed} />],
          [tr("dialogs.depositMax"), <Money n={room} />],
        ]}
      />
      <Field
        label={tr("dialogs.depositAmount")}
        hint={needed > 0 ? tr("dialogs.depositFill", { amount: won(needed) }) : tr("dialogs.depositRoom", { amount: won(room) })}
        error={amount !== null && room > 0 && amount > room ? tr("dialogs.depositOver") : null}
      >
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Banner tone="info">
        {view.status === "DRAFT"
          ? tr("dialogs.depositDraft", { amount: won(view.proposals[0]?.summary.initial_funding ?? room) })
          : tr("dialogs.depositChange")}
      </Banner>
      <p className="muted small">{tr("dialogs.demoToken")}</p>
    </Modal>
  )
}

function WithdrawDialog({ action, onClose, view }: DialogProps) {
  const { busy, submit } = useSubmit(action, onClose)
  const avail = view.ledger.available
  const [all, setAll] = useState<"all" | "part">("all")
  const [amount, setAmount] = useState<number | null>(null)
  const bad = all === "part" && (amount === null || amount <= 0 || amount > avail)
  return (
    <Modal
      title={tr("dialogs.refundTitle")}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit(all === "all" ? {} : { amount })} busy={busy} disabled={bad} confirm={tr("dialogs.refundConfirm")} />}
    >
      <p>
        {tr("dialogs.refundLead")} <strong>{won(avail)}</strong> {tr("dialogs.refundTail")}
      </p>
      <p className="muted small">{tr("project.offChainMoney")}</p>
      <Segmented
        value={all}
        onChange={setAll}
        label={tr("dialogs.refundAmount")}
        options={[
          { value: "all", label: tr("dialogs.refundAll", { amount: won(avail) }) },
          { value: "part", label: tr("dialogs.refundPart") },
        ]}
      />
      {all === "part" && (
        <Field label={tr("dialogs.refundAmount")}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
      )}
    </Modal>
  )
}

function ReasonDialog({ action, onClose, view }: DialogProps) {
  const { busy, submit } = useSubmit(action, onClose)
  const [reason, setReason] = useState("")
  const pause = action.action === "pause"
  return (
    <Modal
      title={actionLabel(action)}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit({ reason: reason.trim() })} busy={busy} disabled={!reason.trim()} confirm={actionLabel(action)} />}
    >
      {pause ? (
        <Banner tone="info" title={tr("dialogs.pauseOnlyTitle")}>
          {tr("dialogs.pauseOnly")}
        </Banner>
      ) : (
        <p>{tr("dialogs.resume")}</p>
      )}
      <Field label={tr("dialogs.reason")} hint={tr("dialogs.reasonRecorded")}>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={pause ? tr("dialogs.pausePlaceholder") : tr("dialogs.resumePlaceholder")} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

// ---------------------------------------------------------------- milestones

function SubmitDeliveryDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  const { busy, submit } = useSubmit(action, onClose)
  const claimable = m.units.filter((u) => u.status === "RESERVED")
  const [units, setUnits] = useState<Set<string>>(new Set(claimable.map((u) => u.id)))
  const [note, setNote] = useState("")
  const [docs, setDocs] = useState<DocRef[]>([])
  const total = claimable.filter((u) => units.has(u.id)).reduce((a, u) => a + u.amount, 0)
  const toggle = (id: string) =>
    setUnits((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <Modal
      title={tr("dialogs.submitTitle", { title: m.title })}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ units: [...units], note: note.trim(), documents: docs.map((d) => d.id) })}
          busy={busy}
          disabled={units.size === 0}
          confirm={tr("dialogs.submitConfirm", { amount: won(total) })}
        />
      }
    >
      <Banner tone="info">{tr("dialogs.submitBanner", { period: duration(view.policy?.summary.client_review_seconds) })}</Banner>
      <fieldset className="fieldset">
        <legend>{tr("dialogs.claimUnits")}</legend>
        {claimable.length === 0 && <p className="muted">{tr("dialogs.noClaimUnits")}</p>}
        {claimable.map((u) => (
          <label key={u.id} className="check">
            <input type="checkbox" checked={units.has(u.id)} onChange={() => toggle(u.id)} />
            <span className="check-body">
              <span className="check-title">
                {u.title} <Money n={u.amount} />
              </span>
              <span className="muted small">{tr("dialogs.criteria", { list: u.criteria.join(" · ") })}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label={tr("dialogs.note")} hint={tr("dialogs.noteHint")}>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("dialogs.notePlaceholder")} />
      </Field>
      <fieldset className="fieldset">
        <legend>{tr("dialogs.evidenceDocs", { count: docs.length })}</legend>
        <AttachedDocs docs={docs} onRemove={(id) => setDocs((d) => d.filter((x) => x.id !== id))} />
        <DocPicker kinds={["delivery"]} onAttach={(d) => setDocs((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]))} />
      </fieldset>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

type UnitChoice = "accept" | "object" | "skip"

function ReviewDeliveryDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  const { busy, submit } = useSubmit(action, onClose)
  const claimedIds = new Set(m.submission?.units ?? [])
  const units = m.units.filter((u) => u.status === "CLAIMED" || (claimedIds.has(u.id) && u.status !== "PAID" && u.status !== "DISPUTED"))
  const [choice, setChoice] = useState<Record<string, UnitChoice>>({})
  const [crit, setCrit] = useState<Record<string, string>>({})
  const [code, setCode] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const accept = units.filter((u) => choice[u.id] === "accept").map((u) => u.id)
  const objectList = units
    .filter((u) => choice[u.id] === "object")
    .map((u) => ({ unit: u.id, criterion: crit[u.id] ?? u.criteria[0] ?? "", reason_code: code[u.id] ?? "NOT_MET", reason: (reason[u.id] ?? "").trim() }))
  const invalid = objectList.some((o) => !o.criterion || !o.reason)
  const nothing = accept.length === 0 && objectList.length === 0
  return (
    <Modal
      title={tr("dialogs.reviewTitle", { title: m.title })}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept, object: objectList })}
          busy={busy}
          disabled={nothing || invalid}
          confirm={tr("dialogs.reviewConfirm", { accept: accept.length, object: objectList.length })}
        />
      }
    >
      <Banner tone="info" title={tr("dialogs.criteriaLockedTitle")}>
        {tr("dialogs.criteriaLocked")}
      </Banner>
      {m.review_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">{tr("dialogs.reviewDeadline")}</span>
            <When at={m.review_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">{tr("dialogs.reviewSilence")}</div>
        </div>
      )}
      {m.submission && (
        <div className="sub-block">
          <div className="muted small">{tr("dialogs.submittedAt", { when: kst(m.submission.at, view.now) })}</div>
          {m.submission.note && <p className="note">{m.submission.note}</p>}
          <div className="docs">
            {m.submission.documents.map((d) => (
              <DocLink key={d.id} doc={d} />
            ))}
          </div>
        </div>
      )}
      <div className="stack">
        {units.length === 0 && <p className="muted">{tr("dialogs.noReviewUnits")}</p>}
        {units.map((u) => {
          const c = choice[u.id] ?? "skip"
          return (
            <div key={u.id} className={`unit-review unit-${c}`}>
              <div className="unit-review-head">
                <strong>{u.title}</strong>
                <Money n={u.amount} />
              </div>
              <ul className="criteria">
                {u.criteria.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <Segmented
                value={c}
                label={tr("dialogs.reviewUnit", { title: u.title })}
                onChange={(v) => setChoice((s) => ({ ...s, [u.id]: v }))}
                options={[
                  { value: "accept", label: tr("dialogs.accept"), tone: "ok" },
                  { value: "object", label: tr("dialogs.object"), tone: "bad" },
                  { value: "skip", label: tr("dialogs.skip"), tone: "muted" },
                ]}
              />
              {c === "object" && (
                <div className="grid-2">
                  <Field label={tr("dialogs.missedCriterion")}>
                    <select value={crit[u.id] ?? u.criteria[0] ?? ""} onChange={(e) => setCrit((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {u.criteria.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={tr("dialogs.reasonCode")}>
                    <select value={code[u.id] ?? "NOT_MET"} onChange={(e) => setCode((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {REASON_CODES.map((k) => (
                        <option key={k} value={k}>
                          {label(REASON_CODE, k)} ({k})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={tr("dialogs.reason")} error={!(reason[u.id] ?? "").trim() ? tr("dialogs.writeReason") : null}>
                    <textarea rows={2} value={reason[u.id] ?? ""} onChange={(e) => setReason((s) => ({ ...s, [u.id]: e.target.value }))} />
                  </Field>
                </div>
              )}
              {c === "accept" && <p className="small ok-text">{tr("dialogs.acceptPays", { amount: won(u.amount) })}</p>}
              {c === "skip" && <p className="muted small">{tr("dialogs.skipPays")}</p>}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

type Verdict = "accept" | "reject" | "skip"

function ResolveMilestoneDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  const { busy, submit } = useSubmit(action, onClose)
  const nonDelivery = m.status === "NON_DELIVERY"
  const units = nonDelivery
    ? m.units.filter((u) => ["RESERVED", "NOT_DELIVERED", "CLAIMED", "DISPUTED"].includes(u.status))
    : m.units.filter((u) => u.status === "DISPUTED")
  const [verdict, setVerdict] = useState<Record<string, Verdict>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const decisions = units
    .filter((u) => (verdict[u.id] ?? "skip") !== "skip")
    .map((u) => ({ unit: u.id, accept: verdict[u.id] === "accept", reason: (reason[u.id] ?? "").trim() }))
  const invalid = decisions.length === 0 || decisions.some((d) => !d.reason)
  return (
    <Modal
      title={tr("dialogs.resolveTitle", { title: m.title })}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ decisions })} busy={busy} disabled={invalid} confirm={tr("dialogs.sendDecisions", { count: decisions.length })} />}
    >
      <Banner tone="info" title={tr("dialogs.resolveOnlyTitle")}>
        {tr("dialogs.resolveOnly")}
      </Banner>
      {m.resolver_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">{tr("dialogs.resolverDeadline")}</span>
            <When at={m.resolver_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">
            {tr("dialogs.onSilence", {
              fallback: action.fallback ? caption(action.fallback) : nonDelivery ? tr("dialogs.silenceNonDelivery") : tr("dialogs.silenceObjected"),
            })}
          </div>
        </div>
      )}
      {m.submission && (
        <div className="docs">
          {m.submission.documents.map((d) => (
            <DocLink key={d.id} doc={d} />
          ))}
        </div>
      )}
      <div className="stack">
        {units.length === 0 && <p className="muted">{tr("dialogs.noUnitsToJudge")}</p>}
        {units.map((u) => {
          const objs = m.objections.filter((o) => o.unit === u.id)
          const v = verdict[u.id] ?? "skip"
          return (
            <div key={u.id} className={`unit-review unit-${v === "accept" ? "accept" : v === "reject" ? "object" : "skip"}`}>
              <div className="unit-review-head">
                <strong>{u.title}</strong>
                <Money n={u.amount} />
              </div>
              <ul className="criteria">
                {u.criteria.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              {objs.map((o, i) => (
                <div key={i} className="objection">
                  <span className="muted small">{tr("dialogs.clientObjection")}</span> {o.reason_code && <Chip tone="warn">{label(REASON_CODE, o.reason_code)}</Chip>}{" "}
                  <span className="small">{tr("dialogs.criterion", { value: o.criterion })}</span>
                  <div className="note">{o.reason}</div>
                </div>
              ))}
              {nonDelivery && <p className="muted small">{tr("dialogs.noSubmission")}</p>}
              <Segmented
                value={v}
                label={tr("dialogs.decideUnit", { title: u.title })}
                onChange={(x) => setVerdict((s) => ({ ...s, [u.id]: x }))}
                options={[
                  { value: "accept", label: tr("dialogs.acceptPay"), tone: "ok" },
                  { value: "reject", label: tr("dialogs.reject"), tone: "bad" },
                  { value: "skip", label: tr("dialogs.undecided"), tone: "muted" },
                ]}
              />
              {v !== "skip" && (
                <Field label={tr("dialogs.reason")} error={!(reason[u.id] ?? "").trim() ? tr("dialogs.writeReason") : null}>
                  <textarea rows={2} value={reason[u.id] ?? ""} onChange={(e) => setReason((s) => ({ ...s, [u.id]: e.target.value }))} />
                </Field>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- expenses

function RequestDialog({ action, onClose, view, retro }: DialogProps & { retro: boolean }) {
  const { busy, submit } = useSubmit(action, onClose)
  const { meta } = useApp()
  const [doc, setDoc] = useState<DocRef | null>(null)
  const [vendor, setVendor] = useState("")
  const [amount, setAmount] = useState<number | null>(null)
  const [fee, setFee] = useState<number | null>(null)
  const [item, setItem] = useState("")
  const manualUsed = vendor !== "" || amount !== null || fee !== null || item.trim() !== ""
  const manual = manualUsed ? { vendor: vendor || undefined, amount: amount ?? undefined, fee: fee ?? undefined, item: item.trim() || undefined } : undefined
  return (
    <Modal
      title={retro ? tr("dialogs.retroTitle") : tr("dialogs.commitmentTitle")}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit(manual ? { document: doc?.id, manual } : { document: doc?.id })}
          busy={busy}
          disabled={!doc}
          confirm={retro ? tr("dialogs.sendRetro") : tr("dialogs.sendCommitment")}
          danger={retro}
        />
      }
    >
      {retro ? (
        <Banner tone="bad" title={tr("dialogs.retroWarnTitle")}>
          {tr("dialogs.retroWarn")}
        </Banner>
      ) : (
        <Banner tone="info" title={tr("dialogs.beforeBuyTitle")}>
          {tr("dialogs.beforeBuy")}
        </Banner>
      )}
      {view.paused && <Banner tone="warn">{tr("dialogs.pausedRequest")}</Banner>}
      <fieldset className="fieldset">
        <legend>{retro ? tr("dialogs.receiptOrClaim") : tr("dialogs.quote")}</legend>
        {doc ? (
          <div className="row-wrap">
            <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} />
          </div>
        ) : (
          <DocPicker kinds={retro ? ["receipt", "quote"] : ["quote"]} onAttach={setDoc} cta={tr("dialogs.useDocument")} />
        )}
      </fieldset>
      <details className="mini-fold">
        <summary>{tr("dialogs.manual")}</summary>
        <p className="muted small">{tr("dialogs.manualHint")}</p>
        <div className="grid-2">
          <Field label={tr("dialogs.vendor")}>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">{tr("dialogs.notSelected")}</option>
              {(meta?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({caption(v.category_ko)})
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr("dialogs.item")}>
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={tr("dialogs.itemPlaceholder")} />
          </Field>
          <Field label={tr("dialogs.net")}>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
          <Field label={tr("dialogs.fee")}>
            <MoneyInput value={fee} onChange={setFee} />
          </Field>
        </div>
      </details>
    </Modal>
  )
}

function ReceiptDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [doc, setDoc] = useState<DocRef | null>(null)
  const [claimed, setClaimed] = useState<number | null>(e.quote?.total ?? e.maximum)
  const over = claimed !== null && claimed > e.maximum
  return (
    <Modal
      title={tr("dialogs.receiptTitle", { name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id, claimed })} busy={busy} disabled={!doc || !claimed} confirm={tr("dialogs.sendSubmission")} />}
    >
      <Banner tone="info">{tr("dialogs.receiptClock")}</Banner>
      <fieldset className="fieldset">
        <legend>{tr("dialogs.receipt")}</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta={tr("dialogs.useReceipt")} />}
      </fieldset>
      <Field label={tr("dialogs.claimed")} hint={tr("dialogs.capHint", { amount: won(e.maximum) })}>
        <MoneyInput value={claimed} onChange={setClaimed} />
      </Field>
      {over && (
        <Banner tone="warn">
          {tr("dialogs.overCap", { over: won((claimed ?? 0) - e.maximum), cap: won(e.maximum) })}
        </Banner>
      )}
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function SupplementDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [doc, setDoc] = useState<DocRef | null>(null)
  return (
    <Modal
      title={tr("dialogs.supplementTitle", { name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id })} busy={busy} disabled={!doc} confirm={tr("dialogs.sendSupplement")} />}
    >
      <Banner tone="warn" title={tr("dialogs.supplementWarnTitle")}>
        {tr("dialogs.supplementWarn")}
      </Banner>
      <fieldset className="fieldset">
        <legend>{tr("dialogs.supplementDoc")}</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta={tr("dialogs.useDocument")} />}
      </fieldset>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function FailedRules({ e }: { e: Expense }) {
  const failed = (e.decision?.rules ?? []).filter((r) => r.ok === false)
  if (failed.length === 0) return null
  return (
    <ul className="problems">
      {failed.map((r, i) => (
        <li key={i}>
          <strong>{r.label ? caption(r.label) : label(RULE_KO, r.rule)}</strong> — {caption(r.detail)}
        </li>
      ))}
    </ul>
  )
}

type YesNo = "" | "yes" | "no"

function initialYesNo(preset?: Preset): YesNo {
  if (preset?.approve === true) return "yes"
  if (preset?.approve === false) return "no"
  return ""
}

function AnswerDialog({ action, onClose, view, e, preset }: DialogProps & { e: Expense; preset?: Preset }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>(initialYesNo(preset))
  const [reason, setReason] = useState("")
  const retro = e.status === "RETRO_REVIEW"
  const amount = retro ? e.quote?.total ?? e.maximum : e.maximum
  return (
    <Modal
      title={tr("dialogs.answerTitle", { kind: retro ? tr("dialogs.retroKind") : tr("dialogs.holdKind"), name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? tr("dialogs.reject") : tr("dialogs.accept")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [tr("dialogs.item"), e.item ?? "—"],
          [retro ? tr("dialogs.claimTotal") : tr("dialogs.quoteTotal"), <Money n={e.quote?.total ?? null} />],
          [tr("dialogs.commitmentCap"), <Money n={e.maximum} />],
        ]}
      />
      <FailedRules e={e} />
      <Segmented
        value={choice}
        onChange={setChoice}
        label={tr("dialogs.response")}
        options={[
          { value: "yes", label: tr("dialogs.accept"), tone: "ok" },
          { value: "no", label: tr("dialogs.reject"), tone: "bad" },
        ]}
      />
      {choice === "yes" && (
        <p className="small">{retro ? tr("dialogs.approveSettles", { amount: won(amount) }) : tr("dialogs.approveReserves", { amount: won(amount) })}</p>
      )}
      {choice === "no" && <p className="small">{retro ? tr("dialogs.rejectNoPay") : tr("dialogs.rejectNoCommitment")}</p>}
      <Field label={choice === "no" ? tr("dialogs.reasonMandatory") : tr("dialogs.reason")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function SettlementDialog({ action, onClose, view, e, preset }: DialogProps & { e: Expense; preset?: Preset }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>(initialYesNo(preset))
  const [reason, setReason] = useState("")
  const claimed = e.receipt?.claimed ?? 0
  const payable = Math.min(e.receipt?.eligible ?? claimed, e.maximum)
  return (
    <Modal
      title={tr("dialogs.settlementTitle", { name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? tr("dialogs.objectToResolver") : tr("dialogs.approvePay")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [tr("dialogs.receiptClaimed"), <Money n={claimed} />],
          [tr("dialogs.commitmentCap"), <Money n={e.maximum} />],
          [tr("dialogs.payIfApproved"), <Money n={payable} />],
          [tr("dialogs.receipt"), <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <Segmented
        value={choice}
        onChange={setChoice}
        label={tr("dialogs.review")}
        options={[
          { value: "yes", label: tr("dialogs.approvePay"), tone: "ok" },
          { value: "no", label: tr("dialogs.object"), tone: "bad" },
        ]}
      />
      {choice === "no" && (
        <Banner tone="info">
          {tr("dialogs.objectionNotFinal", { silence: label(HOLD_RESOLVER_SILENCE, "CLIENT_REVIEW") })}
        </Banner>
      )}
      <Field label={choice === "no" ? tr("dialogs.objectionReason") : tr("dialogs.note")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function EscalateDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [reason, setReason] = useState("")
  return (
    <Modal
      title={tr("dialogs.escalateTitle", { name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit({ reason: reason.trim() })} busy={busy} disabled={!reason.trim()} confirm={tr("dialogs.escalate")} />}
    >
      <Banner tone="warn" title={`HOLD · ${label(HOLD_CLASS, e.hold_class)}`}>
        {e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class) ? `${tr("dialogs.cannotWaive")} ` : ""}
        {tr("dialogs.escalateBody", { silence: label(HOLD_RESOLVER_SILENCE, e.hold_class) })}
      </Banner>
      <FailedRules e={e} />
      <Field label={tr("dialogs.reason")}>
        <textarea rows={3} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function ResolveExpenseDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>("")
  const [reason, setReason] = useState("")
  const claimed = e.receipt?.claimed ?? e.quote?.total ?? 0
  return (
    <Modal
      title={tr("dialogs.expenseResolveTitle", { name: e.vendor_name ?? e.vendor ?? e.id })}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || !reason.trim()}
          confirm={choice === "no" ? tr("dialogs.reject") : tr("dialogs.recognizePay")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [tr("dialogs.holdType"), e.hold_class ? `${label(HOLD_CLASS, e.hold_class)} (${e.hold_class})` : "—"],
          [tr("dialogs.claimAmount"), <Money n={claimed} />],
          [tr("dialogs.payCap"), <Money n={e.maximum} />],
          [tr("dialogs.receipt"), <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <FailedRules e={e} />
      <Banner tone="info" title={tr("dialogs.ifSilent", { result: e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : tr("dialogs.agreedResult") })}>
        {tr("dialogs.resolverLimits")}
      </Banner>
      <Segmented
        value={choice}
        onChange={setChoice}
        label={tr("dialogs.decision")}
        options={[
          { value: "yes", label: tr("dialogs.recognizePay"), tone: "ok" },
          { value: "no", label: tr("dialogs.reject"), tone: "bad" },
        ]}
      />
      <Field label={tr("dialogs.reasonRequiredLabel")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

// ---------------------------------------------------------------- change orders

function DraftChangeOrderDialog({ action, onClose, view, preset }: DialogProps & { preset?: Preset }) {
  const { run } = useProject()
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState(preset?.text ?? "")
  const covers = preset?.covers_excess
  const covered = covers ? view.expenses.find((e) => e.id === covers) : undefined
  const go = async () => {
    setBusy(true)
    const ok = await run(action, covers ? { text: text.trim(), covers_excess: covers } : { text: text.trim() })
    setBusy(false)
    if (ok) {
      onClose()
      window.setTimeout(() => scrollToAnchor("sec-changes"), 50)
    }
  }
  return (
    <Modal
      title={covers ? tr("dialogs.excessDraft") : tr("dialogs.outOfScopeDraft")}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={go} busy={busy} disabled={!text.trim()} confirm={tr("dialogs.draftWithAi")} />}
    >
      <Banner tone="warn">{tr("dialogs.noEffect")}</Banner>
      {covered && (
        <p className="small">
          {tr("dialogs.targetExpense")} <strong>{`${covered.vendor_name ?? covered.vendor ?? ""} ${covered.item ?? ""}`.trim()}</strong> · {tr("dialogs.excess", { amount: won(covered.excess) })}
        </p>
      )}
      <Field label={tr("dialogs.requestText")} hint={tr("dialogs.requestHint")}>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("dialogs.requestPlaceholder")} autoFocus />
      </Field>
    </Modal>
  )
}
