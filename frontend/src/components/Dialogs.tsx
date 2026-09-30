// One dialog per action. Every dialog ends in POST /api/projects/{id}/actions through the
// page's `run`, which sends the action's target params plus the fields collected here.

import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { ActionParams } from "../api"
import { duration, kst, won } from "../format"
import { L } from "../i18n"
import {
  HOLD_CLASS,
  HOLD_RESOLVER_SILENCE,
  NON_WAIVABLE_HOLD,
  REASON_CODE,
  REASON_CODES,
  RULE_KO,
  label,
} from "../labels"
import type { Action, DocRef, Expense, Milestone, ProjectView } from "../types"
import { coDisclaimer } from "./ChangeOrders"
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
  useTranslation()
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {L("닫기", "Close")}
      </button>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={disabled || busy}>
        {busy ? L("처리 중…", "Working…") : confirm}
      </button>
    </>
  )
}

function DeadlineNote({ action, now }: { action: Action; now: number }) {
  useTranslation()
  if (!action.deadline && !action.fallback) return null
  return (
    <div className="clock">
      <div className="clock-head">
        <span className="clock-title">{L("응답 기한", "Response deadline")}</span>
        <When at={action.deadline} now={now} />
      </div>
      {action.fallback && <div className="clock-fallback">{L("침묵 시: ", "On silence: ")}{action.fallback}</div>}
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
      return {
        body: L(
          "초안(DRAFT) 프로젝트를 취소합니다. 입금된 금액은 환불받을 수 있게 됩니다. 되돌릴 수 없습니다.",
          "Cancels this DRAFT project. Any deposit becomes refundable. This cannot be undone.",
        ),
        danger: true,
      }
    case "begin_close":
      return {
        body: (
          <>
            <p>{L("종료를 시작하면 프로젝트가 종료 중(CLOSING)이 되어 새 약정을 만들 수 없습니다.", "Starting to close moves the project to CLOSING; no new commitments can be made.")}</p>
            <p>
              {L(
                `이미 수락된 약정, 분쟁은 끝까지 처리됩니다. 클라이언트는 예약되지 않은 금액(${won(view.ledger.available)})만 환불받을 수 있습니다.`,
                `Accepted commitments and disputes run to completion. The client can only get back the unreserved amount (${won(view.ledger.available)}).`,
              )}
            </p>
          </>
        ),
        danger: true,
      }
    case "start_milestone":
      return {
        body: (
          <>
            <p>
              {L("", "Starting work on ")}<strong>{m?.title}</strong>
              {L(` 작업을 시작합니다. 작업비 ${won(m?.amount)}은 이미 예약되어 있습니다.`, `. The fee of ${won(m?.amount)} is already reserved.`)}
            </p>
            <p>
              {L(
                "착수 후에는 작업자가 이 마일스톤을 취소할 수 없고, 클라이언트도 예약을 혼자 지울 수 없습니다.",
                "Once started, the contractor cannot cancel this milestone and the client cannot remove the reservation alone.",
              )}
            </p>
            {m && (
              <p>
                {L(
                  `납기 ${kst(m.due_at, view.now)}, 유예 ${kst(m.grace_until, view.now)}까지 제출 통지를 보내야 합니다. 그때까지 제출이 없으면 미제출(NON_DELIVERY)로 분쟁 해결에 넘어갑니다.`,
                  `Due ${kst(m.due_at, view.now)}; send a submission notice by the end of grace, ${kst(m.grace_until, view.now)}. Without one it goes to the resolver as NON_DELIVERY.`,
                )}
              </p>
            )}
          </>
        ),
      }
    case "cancel_milestone":
      return {
        body: L(
          `착수 전 취소: 예약된 ${won(m?.amount)}이 가용 잔액으로 돌아갑니다.`,
          `Cancel before start: the reserved ${won(m?.amount)} returns to the available balance.`,
        ),
        danger: true,
      }
    case "cancel_reservation":
      return {
        body: L(
          `구매 전 예약 취소: ${won(e?.reserved)}이 경비 예산으로 돌아갑니다. 클라이언트는 이 예약을 혼자 취소할 수 없습니다.`,
          `Cancel the reservation before purchase: ${won(e?.reserved)} returns to the expense budget. The client cannot cancel this reservation alone.`,
        ),
        danger: true,
      }
    case "report_spend":
      return {
        body: (
          <>
            <p>{L("구매를 완료했다고 보고합니다. 보고는 금액·수취인·정책을 바꾸지 않습니다.", "Reports the purchase as made. Reporting does not change the amount, payee or policy.")}</p>
            <p>
              {L(
                `보고 시각부터 증빙 제출 기간(${duration(view.policy?.summary.evidence_seconds)})이 시작됩니다. 기간 안에 영수증을 내지 않으면 증빙 결함(EVIDENCE_DEFECT)으로 분쟁 해결에 넘어갑니다.`,
                `The evidence window (${duration(view.policy?.summary.evidence_seconds)}) starts at the report. Without a receipt in time it goes to the resolver as EVIDENCE_DEFECT.`,
              )}
            </p>
          </>
        ),
      }
    case "propose_change_order":
      return {
        body: (
          <>
            <p>{L("이 초안으로 다음 정책 버전(서명 대기)을 만듭니다.", "Turns this draft into the next policy version (awaiting signatures).")}</p>
            <p>
              {L(
                "두 당사자가 정책 카드에서 서명하고, 클라이언트가 추가 금액을 입금한 뒤에만 새 마일스톤·경비 권한이 생깁니다.",
                "New milestone and expense authority exists only after both parties sign on the policy card and the client deposits the extra amount.",
              )}
            </p>
          </>
        ),
      }
    case "withdraw_change_order":
      return {
        body: L("변경 주문을 철회합니다. 제안된 정책 버전이 있으면 함께 철회됩니다.", "Withdraws the change order, along with any proposed policy version."),
        danger: true,
      }
    case "run_timeouts":
      return { body: L("기한이 지난 모든 시계에 사전 합의된 침묵 시 결과를 지금 적용합니다.", "Applies the agreed on-silence outcome to every clock past its deadline, now.") }
    default:
      return { body: L(`${actionLabel(a)}을(를) 실행합니다.`, `Run: ${actionLabel(a)}.`) }
  }
}

function ConfirmDialog({ action, onClose, view }: DialogProps) {
  useTranslation()
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
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const version = action.target?.kind === "policy" ? Number(action.target.id) : view.proposals[0]?.version
  const p = view.proposals.find((x) => x.version === version) ?? view.proposals[0]
  return (
    <Modal
      title={L(`정책 v${p?.version ?? "?"} 서명`, `Sign policy v${p?.version ?? "?"}`)}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit()} busy={busy} confirm={L("이 정책에 서명", "Sign this policy")} />}
    >
      {p ? (
        <>
          <p>
            {L(
              "서명하면 아래 해시의 정책 문서에 동의합니다. 양측이 같은 해시에 서명해야 효력이 생깁니다.",
              "By signing you agree to the policy document with the hash below. It takes effect once both parties sign the same hash.",
            )}
          </p>
          <KV
            items={[
              [L("정책 해시", "Policy hash"), <CopyHash hash={p.hash} head={12} tail={8} />],
              [L("프로젝트 예산", "Project budget"), <Money n={p.summary.project_budget} />],
              [L("초기 입금액", "Initial deposit"), <Money n={p.summary.initial_funding} />],
              [
                L("마일스톤", "Milestones"),
                L(`${p.milestones.length}개 · ${won(p.summary.milestone_budget)}`, `${p.milestones.length} · ${won(p.summary.milestone_budget)}`),
              ],
              [L("경비 예산", "Expense budget"), <Money n={p.summary.expense_budget} />],
            ]}
          />
          <h3 className="dialog-h">{L("침묵 시 결과 (최종 대체 결과)", "On silence (final fallback outcomes)")}</h3>
          <FallbackTable p={p} />
        </>
      ) : (
        <p>{L("서명할 정책을 찾을 수 없습니다.", "No policy to sign was found.")}</p>
      )}
    </Modal>
  )
}

function DepositDialog({ action, onClose, view }: DialogProps) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const room = view.ledger.deposit_room
  const needed = view.ledger.funding_needed ?? 0
  const [amount, setAmount] = useState<number | null>(needed > 0 ? needed : room > 0 ? room : null)
  const bad = amount === null || amount <= 0 || (room > 0 && amount > room)
  return (
    <Modal
      title={L("입금", "Deposit")}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit({ amount })} busy={busy} disabled={bad} confirm={L("입금", "Deposit")} />}
    >
      <KV
        items={[
          [L("입금 필요액", "Deposit needed"), <Money n={needed} />],
          [L("최대 입금 가능액 (정책 예산 한도)", "Maximum deposit (policy budget limit)"), <Money n={room} />],
        ]}
      />
      <Field
        label={L("입금액", "Deposit amount")}
        hint={
          needed > 0
            ? L(`서명된 모든 약정을 채우려면 ${won(needed)}이 필요합니다.`, `${won(needed)} is needed to fund every signed commitment.`)
            : L(`지금 입금할 수 있는 최대 금액: ${won(room)}`, `Maximum you can deposit now: ${won(room)}`)
        }
        error={amount !== null && room > 0 && amount > room ? L("입금 가능액을 넘었습니다", "Exceeds the maximum deposit") : null}
      >
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Banner tone="info">
        {view.status === "DRAFT"
          ? L(
              `양측이 서명하고 초기 자금(${won(view.proposals[0]?.summary.initial_funding ?? room)})이 들어오면 프로젝트가 진행 중(ACTIVE)이 되고, 모든 마일스톤 금액이 예약됩니다.`,
              `Once both parties sign and the initial funding (${won(view.proposals[0]?.summary.initial_funding ?? room)}) arrives, the project becomes ACTIVE and every milestone amount is reserved.`,
            )
          : L(
              "서명된 변경 주문의 마일스톤은 가용 잔액이 그 금액을 덮을 때 예약됩니다.",
              "A signed change order's milestone is reserved once the available balance covers its amount.",
            )}
      </Banner>
      <p className="muted small">{L("데모 결제 토큰: 1 단위 = 1원 (KRW). 실제 자금이 아닙니다.", "Demo payment token: 1 unit = 1 KRW. Not real money.")}</p>
    </Modal>
  )
}

function WithdrawDialog({ action, onClose, view }: DialogProps) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const avail = view.ledger.available
  const [all, setAll] = useState<"all" | "part">("all")
  const [amount, setAmount] = useState<number | null>(null)
  const bad = all === "part" && (amount === null || amount <= 0 || amount > avail)
  return (
    <Modal
      title={L("미예약 잔액 환불", "Refund unreserved balance")}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit(all === "all" ? {} : { amount })} busy={busy} disabled={bad} confirm={L("환불받기", "Get refund")} />}
    >
      <p>
        {L("예약되지 않은 가용 잔액 ", "Only the unreserved available balance of ")}
        <strong>{won(avail)}</strong>
        {L(
          "만 환불받을 수 있습니다. 예약된 금액은 기존 약정이 끝날 때까지 남습니다.",
          " can be refunded. Reserved amounts stay until existing commitments finish.",
        )}
      </p>
      <Segmented
        value={all}
        onChange={setAll}
        label={L("환불 금액", "Refund amount")}
        options={[
          { value: "all", label: L(`가용 잔액 전부 (${won(avail)})`, `All available (${won(avail)})`) },
          { value: "part", label: L("일부만", "Part") },
        ]}
      />
      {all === "part" && (
        <Field label={L("환불 금액", "Refund amount")}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
      )}
    </Modal>
  )
}

function ReasonDialog({ action, onClose, view }: DialogProps) {
  useTranslation()
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
        <Banner tone="info" title={L("새 약정만 멈춥니다", "Only new commitments pause")}>
          {L(
            "일시정지는 새 구매 약정과 새 의무만 막습니다. 이미 수락된 약정의 제출, 검수, 정산 기한은 그대로 진행되고 지급도 미뤄지지 않습니다.",
            "A pause blocks only new purchase commitments and new obligations. Submission, review and settlement deadlines on accepted commitments keep running, and payments are not delayed.",
          )}
        </Banner>
      ) : (
        <p>{L("새 약정을 다시 허용합니다.", "Allows new commitments again.")}</p>
      )}
      <Field label={L("사유", "Reason")} hint={L("기록에 남습니다.", "Kept in the record.")}>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={pause ? L("예: 예산 재검토 중", "e.g. Re-checking the budget") : L("예: 검토 완료", "e.g. Review done")} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

// ---------------------------------------------------------------- milestones

function SubmitDeliveryDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  useTranslation()
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
      title={L(`제출 통지 · ${m.title}`, `Submission notice · ${m.title}`)}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ units: [...units], note: note.trim(), documents: docs.map((d) => d.id) })}
          busy={busy}
          disabled={units.size === 0}
          confirm={L(`제출 통지 보내기 (${won(total)})`, `Send submission notice (${won(total)})`)}
        />
      }
    >
      <Banner tone="info">
        {L(
          `제출 통지는 무엇을 언제 제출했는지 고정하고, 이 시각부터 클라이언트 검수 기한(${duration(view.policy?.summary.client_review_seconds)})이 흐르게 합니다. 기한까지 클라이언트가 침묵하면 제출한 납품 단위가 지급됩니다. 제출 후에는 청구 단위를 추가할 수 없습니다.`,
          `A submission notice fixes what was submitted and when, and starts the client review window (${duration(view.policy?.summary.client_review_seconds)}). If the client stays silent until the deadline, the submitted deliverable units are paid. No units can be added after submitting.`,
        )}
      </Banner>
      <fieldset className="fieldset">
        <legend>{L("청구할 납품 단위", "Deliverable units to claim")}</legend>
        {claimable.length === 0 && <p className="muted">{L("청구할 수 있는 납품 단위가 없습니다.", "No deliverable units can be claimed.")}</p>}
        {claimable.map((u) => (
          <label key={u.id} className="check">
            <input type="checkbox" checked={units.has(u.id)} onChange={() => toggle(u.id)} />
            <span className="check-body">
              <span className="check-title">
                {u.title} <Money n={u.amount} />
              </span>
              <span className="muted small">{L("인수 기준: ", "Acceptance criteria: ")}{u.criteria.join(" · ")}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label={L("메모", "Note")} hint={L("결과물 위치, 확인 방법 등", "Where the work is, how to check it, etc.")}>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L("예: 시안 링크와 확인 방법을 적어 주세요", "e.g. Add the draft link and how to check it")} />
      </Field>
      <fieldset className="fieldset">
        <legend>{L(`증빙 문서 (${docs.length})`, `Evidence documents (${docs.length})`)}</legend>
        <AttachedDocs docs={docs} onRemove={(id) => setDocs((d) => d.filter((x) => x.id !== id))} />
        <DocPicker kinds={["delivery"]} onAttach={(d) => setDocs((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]))} />
      </fieldset>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

type UnitChoice = "accept" | "object" | "skip"

function ReviewDeliveryDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  useTranslation()
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
      title={L(`제출물 검수 · ${m.title}`, `Review submission · ${m.title}`)}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept, object: objectList })}
          busy={busy}
          disabled={nothing || invalid}
          confirm={L(
            `검수 결과 보내기 (승인 ${accept.length} · 이의 ${objectList.length})`,
            `Send review (accept ${accept.length} · object ${objectList.length})`,
          )}
        />
      }
    >
      <Banner
        tone="info"
        title={L("인수 기준은 사전에 합의된 항목만 선택할 수 있습니다", "Only the acceptance criteria agreed in advance can be chosen")}
      >
        {L(
          "검수 단계에서 새 기준을 추가할 수 없습니다. 이의는 최종 거절이 아니라 분쟁 해결로 넘어가며, 분쟁 해결자는 같은 기준으로만 판단합니다.",
          "No new criteria can be added at review. An objection is not a final rejection: it goes to the resolver, who judges by the same criteria only.",
        )}
      </Banner>
      {m.review_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">{L("검수 기한", "Review deadline")}</span>
            <When at={m.review_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">
            {L(
              "침묵 시: 응답하지 않은(보류) 납품 단위는 이 기한에 지급됩니다 (RELEASED_BY_TIMEOUT).",
              "On silence: deliverable units left unanswered (on hold) are paid at this deadline (RELEASED_BY_TIMEOUT).",
            )}
          </div>
        </div>
      )}
      {m.submission && (
        <div className="sub-block">
          <div className="muted small">{L(`${kst(m.submission.at, view.now)} 제출 통지`, `Submission notice ${kst(m.submission.at, view.now)}`)}</div>
          {m.submission.note && <p className="note">{m.submission.note}</p>}
          <div className="docs">
            {m.submission.documents.map((d) => (
              <DocLink key={d.id} doc={d} />
            ))}
          </div>
        </div>
      )}
      <div className="stack">
        {units.length === 0 && <p className="muted">{L("검수할 납품 단위가 없습니다.", "No deliverable units to review.")}</p>}
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
                label={L(`${u.title} 검수`, `Review ${u.title}`)}
                onChange={(v) => setChoice((s) => ({ ...s, [u.id]: v }))}
                options={[
                  { value: "accept", label: L("승인", "Accept"), tone: "ok" },
                  { value: "object", label: L("이의", "Object"), tone: "bad" },
                  { value: "skip", label: L("보류 (응답 안 함)", "Hold (no answer)"), tone: "muted" },
                ]}
              />
              {c === "object" && (
                <div className="grid-2">
                  <Field label={L("어긋난 인수 기준", "Criterion not met")}>
                    <select value={crit[u.id] ?? u.criteria[0] ?? ""} onChange={(e) => setCrit((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {u.criteria.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={L("이유 코드", "Reason code")}>
                    <select value={code[u.id] ?? "NOT_MET"} onChange={(e) => setCode((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {REASON_CODES.map((k) => (
                        <option key={k} value={k}>
                          {label(REASON_CODE, k)} ({k})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={L("이유", "Reason")} error={!(reason[u.id] ?? "").trim() ? L("이유를 적어 주세요", "Please give a reason") : null}>
                    <textarea rows={2} value={reason[u.id] ?? ""} onChange={(e) => setReason((s) => ({ ...s, [u.id]: e.target.value }))} />
                  </Field>
                </div>
              )}
              {c === "accept" && <p className="small ok-text">{L(`승인하면 ${won(u.amount)}이 즉시 지급됩니다.`, `Accepting pays ${won(u.amount)} immediately.`)}</p>}
              {c === "skip" && <p className="muted small">{L("응답하지 않으면 검수 기한에 지급됩니다.", "If left unanswered, it is paid at the review deadline.")}</p>}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

type Verdict = "accept" | "reject" | "skip"

function ResolveMilestoneDialog({ action, onClose, view, m }: DialogProps & { m: Milestone }) {
  useTranslation()
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
      title={L(`분쟁 해결 · ${m.title}`, `Resolve · ${m.title}`)}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ decisions })} busy={busy} disabled={invalid} confirm={L(`결정 보내기 (${decisions.length})`, `Send decisions (${decisions.length})`)} />}
    >
      <Banner tone="info" title={L("사전 인수 기준과 제출 증빙으로만 판단합니다", "Judged only by the agreed acceptance criteria and submitted evidence")}>
        {L(
          "분쟁 해결자는 납품 단위의 고정 금액을 지급하거나 거절할 수만 있습니다. 금액을 바꾸거나 수취인을 바꾸거나 새 기준을 만들 수 없습니다.",
          "The resolver can only pay or reject a deliverable unit's fixed amount. They cannot change the amount or payee, or create new criteria.",
        )}
      </Banner>
      {m.resolver_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">{L("분쟁 해결 기한", "Resolver deadline")}</span>
            <When at={m.resolver_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">
            {L("침묵 시: ", "On silence: ")}
            {action.fallback ??
              (nonDelivery
                ? L("미제출 단위는 거절되고 예약이 반환됩니다.", "Undelivered units are rejected and the reservation is returned.")
                : L("이의가 제기된 단위가 지급됩니다 (결함이 증명되지 않음).", "Objected units are paid (no defect proven)."))}
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
        {units.length === 0 && <p className="muted">{L("판단할 납품 단위가 없습니다.", "No deliverable units to decide.")}</p>}
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
                  <span className="muted small">{L("클라이언트 이의", "Client objection")}</span> {o.reason_code && <Chip tone="warn">{label(REASON_CODE, o.reason_code)}</Chip>}{" "}
                  <span className="small">{L("기준: ", "Criterion: ")}{o.criterion}</span>
                  <div className="note">{o.reason}</div>
                </div>
              ))}
              {nonDelivery && <p className="muted small">{L("유예 기간까지 제출 통지가 없었습니다.", "No submission notice arrived by the end of grace.")}</p>}
              <Segmented
                value={v}
                label={L(`${u.title} 결정`, `Decision on ${u.title}`)}
                onChange={(x) => setVerdict((s) => ({ ...s, [u.id]: x }))}
                options={[
                  { value: "accept", label: L("인정 (지급)", "Accept (pay)"), tone: "ok" },
                  { value: "reject", label: L("거절", "Reject"), tone: "bad" },
                  { value: "skip", label: L("아직 결정 안 함", "Undecided"), tone: "muted" },
                ]}
              />
              {v !== "skip" && (
                <Field label={L("이유", "Reason")} error={!(reason[u.id] ?? "").trim() ? L("이유를 적어 주세요", "Please give a reason") : null}>
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
  useTranslation()
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
      title={retro ? L("사후 청구 (RETROACTIVE_REQUEST)", "Retroactive claim (RETROACTIVE_REQUEST)") : L("구매 약정 요청", "Request a purchase commitment")}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit(manual ? { document: doc?.id, manual } : { document: doc?.id })}
          busy={busy}
          disabled={!doc}
          confirm={retro ? L("사후 청구 보내기", "Send retroactive claim") : L("약정 요청 보내기", "Send commitment request")}
          danger={retro}
        />
      }
    >
      {retro ? (
        <Banner
          tone="bad"
          title={L(
            "사전 약정이 없어서 클라이언트가 응답하지 않으면 지급되지 않습니다",
            "With no prior commitment, nothing is paid if the client doesn't respond",
          )}
        >
          {L(
            "사후 청구는 클라이언트가 명시적으로 승인할 때만 정산됩니다. 가능하면 구매 전에 구매 약정을 요청하세요.",
            "A retroactive claim is settled only if the client explicitly approves. When possible, request a purchase commitment before buying.",
          )}
        </Banner>
      ) : (
        <Banner tone="info" title={L("구매 전에 요청하세요", "Request before you buy")}>
          {L(
            "AI가 견적서를 읽고, 서명된 정책 규칙이 APPROVE(최대 정산액 예약) / HOLD(클라이언트 검토) / BLOCK을 결정합니다. APPROVE면 예약된 금액까지는 구매해도 지급이 보장됩니다.",
            "The AI reads the quote, and the signed policy rules decide APPROVE (reserve the maximum settlement) / HOLD (client review) / BLOCK. On APPROVE, payment is guaranteed up to the reserved amount.",
          )}
        </Banner>
      )}
      {view.paused && <Banner tone="warn">{L("새 약정 일시정지 중입니다. 요청이 거절될 수 있습니다.", "New commitments are paused. The request may be refused.")}</Banner>}
      <fieldset className="fieldset">
        <legend>{retro ? L("영수증·청구 문서", "Receipt / claim document") : L("견적서", "Quote")}</legend>
        {doc ? (
          <div className="row-wrap">
            <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} />
          </div>
        ) : (
          <DocPicker kinds={retro ? ["receipt", "quote"] : ["quote"]} onAttach={setDoc} cta={L("이 문서 사용", "Use this document")} />
        )}
      </fieldset>
      <details className="mini-fold">
        <summary>{L("수동 입력 (AI를 쓸 수 없을 때만 사용)", "Manual entry (only when AI is unavailable)")}</summary>
        <p className="muted small">
          {L(
            "AI 판독이 가능하면 서버는 이 값을 쓰지 않습니다. 수동 입력은 증빙 수준을 올리지 않습니다.",
            "The server ignores these values when AI reading works. Manual entry does not raise the evidence level.",
          )}
        </p>
        <div className="grid-2">
          <Field label={L("공급자", "Vendor")}>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">{L("— 선택 안 함 —", "— None —")}</option>
              {(meta?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.category_ko})
                </option>
              ))}
            </select>
          </Field>
          <Field label={L("품목", "Item")}>
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={L("예: 도메인 1년", "e.g. Domain, 1 year")} />
          </Field>
          <Field label={L("공급가액", "Net amount")}>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
          <Field label={L("부가세·수수료", "VAT / fees")}>
            <MoneyInput value={fee} onChange={setFee} />
          </Field>
        </div>
      </details>
    </Modal>
  )
}

function ReceiptDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [doc, setDoc] = useState<DocRef | null>(null)
  const [claimed, setClaimed] = useState<number | null>(e.quote?.total ?? e.maximum)
  const over = claimed !== null && claimed > e.maximum
  return (
    <Modal
      title={L(`영수증 제출 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Submit receipt · ${e.vendor_name ?? e.vendor ?? e.id}`)}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id, claimed })} busy={busy} disabled={!doc || !claimed} confirm={L("제출 통지 보내기", "Send submission notice")} />}
    >
      <Banner tone="info">
        {L(
          "제출 통지 시각부터 클라이언트 정산 검토 기한이 흐릅니다. 증빙이 늦게 확인되어도 제출 시각은 뒤로 밀리지 않습니다.",
          "The client's settlement review window starts at the submission notice. Even if the evidence is verified later, the submission time does not move.",
        )}
      </Banner>
      <fieldset className="fieldset">
        <legend>{L("영수증", "Receipt")}</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta={L("이 영수증 사용", "Use this receipt")} />}
      </fieldset>
      <Field label={L("청구액", "Claimed amount")} hint={L(`약정 한도 ${won(e.maximum)}`, `Commitment limit ${won(e.maximum)}`)}>
        <MoneyInput value={claimed} onChange={setClaimed} />
      </Field>
      {over && (
        <Banner tone="warn">
          {L(
            `청구액이 약정 한도를 ${won((claimed ?? 0) - e.maximum)} 넘습니다. 약정분 ${won(e.maximum)}은 먼저 정산되고, 초과분은 변경 주문으로만 지급할 수 있습니다.`,
            `The claim exceeds the commitment limit by ${won((claimed ?? 0) - e.maximum)}. The committed ${won(e.maximum)} settles first; the overage can only be paid through a change order.`,
          )}
        </Banner>
      )}
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function SupplementDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [doc, setDoc] = useState<DocRef | null>(null)
  return (
    <Modal
      title={L(`증빙 보완 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Supplement evidence · ${e.vendor_name ?? e.vendor ?? e.id}`)}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id })} busy={busy} disabled={!doc} confirm={L("보완 증빙 제출", "Submit supplementary evidence")} />}
    >
      <Banner tone="warn" title={L("보완해도 어떤 기한도 다시 시작되지 않습니다", "Supplementing does not restart any deadline")}>
        {L(
          "새 문서를 다시 읽어 증빙 결함이 해소되는지 확인합니다. 청구 금액과 검토·분쟁 해결 기한은 그대로입니다.",
          "The new document is read to check whether the evidence defect is resolved. The claimed amount and the review and resolver deadlines stay the same.",
        )}
      </Banner>
      <fieldset className="fieldset">
        <legend>{L("보완 문서", "Supplementary document")}</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta={L("이 문서 사용", "Use this document")} />}
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
          <strong>{r.label || label(RULE_KO, r.rule)}</strong> — {r.detail}
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
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>(initialYesNo(preset))
  const [reason, setReason] = useState("")
  const retro = e.status === "RETRO_REVIEW"
  const amount = retro ? e.quote?.total ?? e.maximum : e.maximum
  return (
    <Modal
      title={
        retro
          ? L(`사후 청구 응답 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Answer retroactive claim · ${e.vendor_name ?? e.vendor ?? e.id}`)
          : L(`HOLD 요청 응답 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Answer HOLD request · ${e.vendor_name ?? e.vendor ?? e.id}`)
      }
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? L("거절", "Reject") : L("승인", "Approve")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [L("품목", "Item"), e.item ?? "—"],
          [retro ? L("청구 합계", "Claim total") : L("견적 합계", "Quote total"), <Money n={e.quote?.total ?? null} />],
          [L("약정 한도", "Commitment limit"), <Money n={e.maximum} />],
        ]}
      />
      <FailedRules e={e} />
      <Segmented
        value={choice}
        onChange={setChoice}
        label={L("응답", "Answer")}
        options={[
          { value: "yes", label: L("승인", "Approve"), tone: "ok" },
          { value: "no", label: L("거절", "Reject"), tone: "bad" },
        ]}
      />
      {choice === "yes" && (
        <p className="small">
          {retro
            ? L(`승인하면 ${won(amount)}이 정산됩니다.`, `Approving settles ${won(amount)}.`)
            : L(
                `승인하면 최대 정산액 ${won(amount)}이 예약되어 구매 약정이 됩니다. 이후에는 혼자 취소할 수 없습니다.`,
                `Approving reserves a maximum settlement of ${won(amount)} as a purchase commitment. After that you cannot cancel it alone.`,
              )}
        </p>
      )}
      {choice === "no" && (
        <p className="small">
          {retro
            ? L("거절하면 지급되지 않습니다.", "Rejecting means nothing is paid.")
            : L(
                "거절하면 약정 없이 끝납니다. 아직 약속된 것이 없으므로 분쟁으로 가지 않습니다.",
                "Rejecting ends it with no commitment. Nothing was promised yet, so it does not go to dispute.",
              )}
        </p>
      )}
      <Field label={choice === "no" ? L("사유 (필수)", "Reason (required)") : L("사유", "Reason")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function SettlementDialog({ action, onClose, view, e, preset }: DialogProps & { e: Expense; preset?: Preset }) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>(initialYesNo(preset))
  const [reason, setReason] = useState("")
  const claimed = e.receipt?.claimed ?? 0
  const payable = Math.min(e.receipt?.eligible ?? claimed, e.maximum)
  return (
    <Modal
      title={L(`정산 검토 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Settlement review · ${e.vendor_name ?? e.vendor ?? e.id}`)}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? L("이의 → 분쟁 해결", "Object → resolver") : L("승인 (지급)", "Approve (pay)")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [L("영수증 청구액", "Receipt claim"), <Money n={claimed} />],
          [L("약정 한도", "Commitment limit"), <Money n={e.maximum} />],
          [L("승인 시 지급", "Paid on approval"), <Money n={payable} />],
          [L("영수증", "Receipt"), <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <Segmented
        value={choice}
        onChange={setChoice}
        label={L("검토", "Review")}
        options={[
          { value: "yes", label: L("승인 (지급)", "Approve (pay)"), tone: "ok" },
          { value: "no", label: L("이의", "Object"), tone: "bad" },
        ]}
      />
      {choice === "no" && (
        <Banner tone="info">
          {L(
            `유효한 약정에 대한 이의는 최종 거절이 아니라 분쟁 해결(CLIENT_REVIEW)로 넘어갑니다. 분쟁 해결자도 침묵하면 ${label(HOLD_RESOLVER_SILENCE, "CLIENT_REVIEW")}.`,
            `An objection to a valid commitment is not a final rejection; it goes to the resolver (CLIENT_REVIEW). If the resolver is also silent: ${label(HOLD_RESOLVER_SILENCE, "CLIENT_REVIEW")}.`,
          )}
        </Banner>
      )}
      <Field label={choice === "no" ? L("이의 사유 (필수)", "Objection reason (required)") : L("메모", "Note")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function EscalateDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [reason, setReason] = useState("")
  return (
    <Modal
      title={L(`분쟁 해결로 넘기기 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Send to resolver · ${e.vendor_name ?? e.vendor ?? e.id}`)}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit({ reason: reason.trim() })} busy={busy} disabled={!reason.trim()} confirm={L("분쟁 해결로 넘기기", "Send to resolver")} />}
    >
      <Banner tone="warn" title={`HOLD · ${label(HOLD_CLASS, e.hold_class)}`}>
        {e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class) ? L("필수 증빙·무결성 규칙은 클라이언트가 승인으로 면제할 수 없습니다. ", "The client cannot waive required-evidence or integrity rules by approving. ")
          : ""}
        {L(
          `분쟁 해결자가 판단하며, 분쟁 해결자도 침묵하면 ${label(HOLD_RESOLVER_SILENCE, e.hold_class)}. 지금 넘기지 않아도 검토 기한에 자동으로 넘어갑니다.`,
          `The resolver decides; if the resolver is also silent: ${label(HOLD_RESOLVER_SILENCE, e.hold_class)}. If you don't send it now, it goes automatically at the review deadline.`,
        )}
      </Banner>
      <FailedRules e={e} />
      <Field label={L("사유", "Reason")}>
        <textarea rows={3} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

function ResolveExpenseDialog({ action, onClose, view, e }: DialogProps & { e: Expense }) {
  useTranslation()
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>("")
  const [reason, setReason] = useState("")
  const claimed = e.receipt?.claimed ?? e.quote?.total ?? 0
  return (
    <Modal
      title={L(`경비 분쟁 해결 · ${e.vendor_name ?? e.vendor ?? e.id}`, `Resolve expense · ${e.vendor_name ?? e.vendor ?? e.id}`)}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || !reason.trim()}
          confirm={choice === "no" ? L("거절", "Reject") : L("지급 인정", "Allow payment")}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          [L("HOLD 유형", "HOLD type"), e.hold_class ? `${label(HOLD_CLASS, e.hold_class)} (${e.hold_class})` : "—"],
          [L("청구액", "Claimed amount"), <Money n={claimed} />],
          [L("약정 한도 (지급 상한)", "Commitment limit (payment cap)"), <Money n={e.maximum} />],
          [L("영수증", "Receipt"), <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <FailedRules e={e} />
      <Banner tone="info" title={L(
          `기한까지 결정하지 않으면: ${e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : "사전 합의된 결과가 적용됩니다"}`,
          `If undecided by the deadline: ${e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : "the agreed outcome applies"}`,
        )}>
        {L(
          "분쟁 해결자는 약정 한도 안에서 지급을 인정하거나 거절할 수만 있습니다. 수취인·금액 상한·정책은 바꿀 수 없습니다.",
          "The resolver can only allow or reject payment within the commitment limit. The payee, amount cap and policy cannot be changed.",
        )}
      </Banner>
      <Segmented
        value={choice}
        onChange={setChoice}
        label={L("결정", "Decision")}
        options={[
          { value: "yes", label: L("지급 인정", "Allow payment"), tone: "ok" },
          { value: "no", label: L("거절", "Reject"), tone: "bad" },
        ]}
      />
      <Field label={L("이유 (필수)", "Reason (required)")}>
        <textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
      </Field>
      <DeadlineNote action={action} now={view.now} />
    </Modal>
  )
}

// ---------------------------------------------------------------- change orders

function DraftChangeOrderDialog({ action, onClose, view, preset }: DialogProps & { preset?: Preset }) {
  useTranslation()
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
      title={covers ? L("초과분 변경 주문 초안", "Draft a change order for the overage") : L("범위 밖 요청 → 변경 주문 초안", "Out-of-scope request → change order draft")}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={go} busy={busy} disabled={!text.trim()} confirm={L("AI로 초안 만들기", "Draft with AI")} />}
    >
      <Banner tone="warn">{coDisclaimer()}</Banner>
      {covered && (
        <p className="small">
          {L("대상 경비: ", "Expense: ")}
          <strong>{`${covered.vendor_name ?? covered.vendor ?? ""} ${covered.item ?? ""}`.trim()}</strong> · {L("초과분", "overage")}{" "}
          {won(covered.excess)}
        </p>
      )}
      <Field
        label={L("요청 내용", "Request")}
        hint={L(
          "평소 말투로 적으면 AI가 범위·가격·일정·인수 기준을 담은 초안을 만듭니다. 초안은 두 당사자가 고칠 수 있습니다.",
          "Write it in plain words; the AI drafts scope, price, schedule and acceptance criteria. Both parties can edit the draft.",
        )}
      >
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={L("예: 로그인 기능도 추가해 주세요", "e.g. Please add a login feature too")} autoFocus />
      </Field>
    </Modal>
  )
}
