// One dialog per action. Every dialog ends in POST /api/projects/{id}/actions through the
// page's `run`, which sends the action's target params plus the fields collected here.

import { useState, type ReactNode } from "react"
import type { ActionParams } from "../api"
import { duration, kst, won } from "../format"
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
import { CO_DISCLAIMER } from "./ChangeOrders"
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
        닫기
      </button>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={disabled || busy}>
        {busy ? "처리 중…" : confirm}
      </button>
    </>
  )
}

function DeadlineNote({ action, now }: { action: Action; now: number }) {
  if (!action.deadline && !action.fallback) return null
  return (
    <div className="clock">
      <div className="clock-head">
        <span className="clock-title">응답 기한</span>
        <When at={action.deadline} now={now} />
      </div>
      {action.fallback && <div className="clock-fallback">침묵 시: {action.fallback}</div>}
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
      return { body: "초안(DRAFT) 프로젝트를 취소합니다. 입금된 금액은 환불받을 수 있게 됩니다. 되돌릴 수 없습니다.", danger: true }
    case "begin_close":
      return {
        body: (
          <>
            <p>종료를 시작하면 프로젝트가 종료 중(CLOSING)이 되어 새 약정을 만들 수 없습니다.</p>
            <p>이미 수락된 약정, 분쟁은 끝까지 처리됩니다. 클라이언트는 예약되지 않은 금액({won(view.ledger.available)})만 환불받을 수 있습니다.</p>
          </>
        ),
        danger: true,
      }
    case "start_milestone":
      return {
        body: (
          <>
            <p>
              <strong>{m?.title}</strong> 작업을 시작합니다. 작업비 {won(m?.amount)}은 이미 예약되어 있습니다.
            </p>
            <p>착수 후에는 작업자가 이 마일스톤을 취소할 수 없고, 클라이언트도 예약을 혼자 지울 수 없습니다.</p>
            {m && (
              <p>
                납기 {kst(m.due_at, view.now)}, 유예 {kst(m.grace_until, view.now)}까지 제출 통지를 보내야 합니다. 그때까지 제출이 없으면 미제출(NON_DELIVERY)로 분쟁 해결에 넘어갑니다.
              </p>
            )}
          </>
        ),
      }
    case "cancel_milestone":
      return { body: `착수 전 취소: 예약된 ${won(m?.amount)}이 가용 잔액으로 돌아갑니다.`, danger: true }
    case "cancel_reservation":
      return { body: `구매 전 예약 취소: ${won(e?.reserved)}이 경비 예산으로 돌아갑니다. 클라이언트는 이 예약을 혼자 취소할 수 없습니다.`, danger: true }
    case "report_spend":
      return {
        body: (
          <>
            <p>구매를 완료했다고 보고합니다. 보고는 금액·수취인·정책을 바꾸지 않습니다.</p>
            <p>
              보고 시각부터 증빙 제출 기간({duration(view.policy?.summary.evidence_seconds)})이 시작됩니다. 기간 안에 영수증을 내지 않으면 증빙 결함(EVIDENCE_DEFECT)으로 분쟁 해결에 넘어갑니다.
            </p>
          </>
        ),
      }
    case "propose_change_order":
      return {
        body: (
          <>
            <p>이 초안으로 다음 정책 버전(서명 대기)을 만듭니다.</p>
            <p>두 당사자가 정책 카드에서 서명하고, 클라이언트가 추가 금액을 입금한 뒤에만 새 마일스톤·경비 권한이 생깁니다.</p>
          </>
        ),
      }
    case "withdraw_change_order":
      return { body: "변경 주문을 철회합니다. 제안된 정책 버전이 있으면 함께 철회됩니다.", danger: true }
    case "run_timeouts":
      return { body: "기한이 지난 모든 시계에 사전 합의된 침묵 시 결과를 지금 적용합니다." }
    default:
      return { body: `${actionLabel(a)}을(를) 실행합니다.` }
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
      title={`정책 v${p?.version ?? "?"} 서명`}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit()} busy={busy} confirm="이 정책에 서명" />}
    >
      {p ? (
        <>
          <p>
            서명하면 아래 해시의 정책 문서에 동의합니다. 양측이 같은 해시에 서명해야 효력이 생깁니다.
          </p>
          <KV
            items={[
              ["정책 해시", <CopyHash hash={p.hash} head={12} tail={8} />],
              ["프로젝트 예산", <Money n={p.summary.project_budget} />],
              ["초기 입금액", <Money n={p.summary.initial_funding} />],
              ["마일스톤", `${p.milestones.length}개 · ${won(p.summary.milestone_budget)}`],
              ["경비 예산", <Money n={p.summary.expense_budget} />],
            ]}
          />
          <h3 className="dialog-h">침묵 시 결과 (최종 대체 결과)</h3>
          <FallbackTable p={p} />
        </>
      ) : (
        <p>서명할 정책을 찾을 수 없습니다.</p>
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
    <Modal title="입금" onClose={onClose} footer={<Footer onClose={onClose} onConfirm={() => submit({ amount })} busy={busy} disabled={bad} confirm="입금" />}>
      <KV
        items={[
          ["입금 필요액", <Money n={needed} />],
          ["최대 입금 가능액 (정책 예산 한도)", <Money n={room} />],
        ]}
      />
      <Field
        label="입금액"
        hint={needed > 0 ? `서명된 모든 약정을 채우려면 ${won(needed)}이 필요합니다.` : `지금 입금할 수 있는 최대 금액: ${won(room)}`}
        error={amount !== null && room > 0 && amount > room ? "입금 가능액을 넘었습니다" : null}
      >
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Banner tone="info">
        {view.status === "DRAFT"
          ? `양측이 서명하고 초기 자금(${won(view.proposals[0]?.summary.initial_funding ?? room)})이 들어오면 프로젝트가 진행 중(ACTIVE)이 되고, 모든 마일스톤 금액이 예약됩니다.`
          : "서명된 변경 주문의 마일스톤은 가용 잔액이 그 금액을 덮을 때 예약됩니다."}
      </Banner>
      <p className="muted small">데모 결제 토큰: 1 단위 = 1원 (KRW). 실제 자금이 아닙니다.</p>
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
      title="미예약 잔액 환불"
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit(all === "all" ? {} : { amount })} busy={busy} disabled={bad} confirm="환불받기" />}
    >
      <p>
        예약되지 않은 가용 잔액 <strong>{won(avail)}</strong>만 환불받을 수 있습니다. 예약된 금액은 기존 약정이 끝날 때까지 남습니다.
      </p>
      <Segmented
        value={all}
        onChange={setAll}
        label="환불 금액"
        options={[
          { value: "all", label: `가용 잔액 전부 (${won(avail)})` },
          { value: "part", label: "일부만" },
        ]}
      />
      {all === "part" && (
        <Field label="환불 금액">
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
        <Banner tone="info" title="새 약정만 멈춥니다">
          일시정지는 새 구매 약정과 새 의무만 막습니다. 이미 수락된 약정의 제출, 검수, 정산 기한은 그대로 진행되고 지급도 미뤄지지 않습니다.
        </Banner>
      ) : (
        <p>새 약정을 다시 허용합니다.</p>
      )}
      <Field label="사유" hint="기록에 남습니다.">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={pause ? "예: 예산 재검토 중" : "예: 검토 완료"} />
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
      title={`제출 통지 · ${m.title}`}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ units: [...units], note: note.trim(), documents: docs.map((d) => d.id) })}
          busy={busy}
          disabled={units.size === 0}
          confirm={`제출 통지 보내기 (${won(total)})`}
        />
      }
    >
      <Banner tone="info">
        제출 통지는 무엇을 언제 제출했는지 고정하고, 이 시각부터 클라이언트 검수 기한({duration(view.policy?.summary.client_review_seconds)})이 흐르게 합니다. 기한까지 클라이언트가 침묵하면 제출한 납품 단위가 지급됩니다. 제출 후에는 청구 단위를 추가할 수 없습니다.
      </Banner>
      <fieldset className="fieldset">
        <legend>청구할 납품 단위</legend>
        {claimable.length === 0 && <p className="muted">청구할 수 있는 납품 단위가 없습니다.</p>}
        {claimable.map((u) => (
          <label key={u.id} className="check">
            <input type="checkbox" checked={units.has(u.id)} onChange={() => toggle(u.id)} />
            <span className="check-body">
              <span className="check-title">
                {u.title} <Money n={u.amount} />
              </span>
              <span className="muted small">인수 기준: {u.criteria.join(" · ")}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="메모" hint="결과물 위치, 확인 방법 등">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 시안 링크와 확인 방법을 적어 주세요" />
      </Field>
      <fieldset className="fieldset">
        <legend>증빙 문서 ({docs.length})</legend>
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
      title={`제출물 검수 · ${m.title}`}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept, object: objectList })}
          busy={busy}
          disabled={nothing || invalid}
          confirm={`검수 결과 보내기 (승인 ${accept.length} · 이의 ${objectList.length})`}
        />
      }
    >
      <Banner tone="info" title="인수 기준은 사전에 합의된 항목만 선택할 수 있습니다">
        검수 단계에서 새 기준을 추가할 수 없습니다. 이의는 최종 거절이 아니라 분쟁 해결로 넘어가며, 분쟁 해결자는 같은 기준으로만 판단합니다.
      </Banner>
      {m.review_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">검수 기한</span>
            <When at={m.review_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">침묵 시: 응답하지 않은(보류) 납품 단위는 이 기한에 지급됩니다 (RELEASED_BY_TIMEOUT).</div>
        </div>
      )}
      {m.submission && (
        <div className="sub-block">
          <div className="muted small">{kst(m.submission.at, view.now)} 제출 통지</div>
          {m.submission.note && <p className="note">{m.submission.note}</p>}
          <div className="docs">
            {m.submission.documents.map((d) => (
              <DocLink key={d.id} doc={d} />
            ))}
          </div>
        </div>
      )}
      <div className="stack">
        {units.length === 0 && <p className="muted">검수할 납품 단위가 없습니다.</p>}
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
                label={`${u.title} 검수`}
                onChange={(v) => setChoice((s) => ({ ...s, [u.id]: v }))}
                options={[
                  { value: "accept", label: "승인", tone: "ok" },
                  { value: "object", label: "이의", tone: "bad" },
                  { value: "skip", label: "보류 (응답 안 함)", tone: "muted" },
                ]}
              />
              {c === "object" && (
                <div className="grid-2">
                  <Field label="어긋난 인수 기준">
                    <select value={crit[u.id] ?? u.criteria[0] ?? ""} onChange={(e) => setCrit((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {u.criteria.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="이유 코드">
                    <select value={code[u.id] ?? "NOT_MET"} onChange={(e) => setCode((s) => ({ ...s, [u.id]: e.target.value }))}>
                      {REASON_CODES.map((k) => (
                        <option key={k} value={k}>
                          {label(REASON_CODE, k)} ({k})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="이유" error={!(reason[u.id] ?? "").trim() ? "이유를 적어 주세요" : null}>
                    <textarea rows={2} value={reason[u.id] ?? ""} onChange={(e) => setReason((s) => ({ ...s, [u.id]: e.target.value }))} />
                  </Field>
                </div>
              )}
              {c === "accept" && <p className="small ok-text">승인하면 {won(u.amount)}이 즉시 지급됩니다.</p>}
              {c === "skip" && <p className="muted small">응답하지 않으면 검수 기한에 지급됩니다.</p>}
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
      title={`분쟁 해결 · ${m.title}`}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ decisions })} busy={busy} disabled={invalid} confirm={`결정 보내기 (${decisions.length})`} />}
    >
      <Banner tone="info" title="사전 인수 기준과 제출 증빙으로만 판단합니다">
        분쟁 해결자는 납품 단위의 고정 금액을 지급하거나 거절할 수만 있습니다. 금액을 바꾸거나 수취인을 바꾸거나 새 기준을 만들 수 없습니다.
      </Banner>
      {m.resolver_deadline && (
        <div className="clock">
          <div className="clock-head">
            <span className="clock-title">분쟁 해결 기한</span>
            <When at={m.resolver_deadline} now={view.now} />
          </div>
          <div className="clock-fallback">
            침묵 시: {action.fallback ?? (nonDelivery ? "미제출 단위는 거절되고 예약이 반환됩니다." : "이의가 제기된 단위가 지급됩니다 (결함이 증명되지 않음).")}
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
        {units.length === 0 && <p className="muted">판단할 납품 단위가 없습니다.</p>}
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
                  <span className="muted small">클라이언트 이의</span> {o.reason_code && <Chip tone="warn">{label(REASON_CODE, o.reason_code)}</Chip>}{" "}
                  <span className="small">기준: {o.criterion}</span>
                  <div className="note">{o.reason}</div>
                </div>
              ))}
              {nonDelivery && <p className="muted small">유예 기간까지 제출 통지가 없었습니다.</p>}
              <Segmented
                value={v}
                label={`${u.title} 결정`}
                onChange={(x) => setVerdict((s) => ({ ...s, [u.id]: x }))}
                options={[
                  { value: "accept", label: "인정 (지급)", tone: "ok" },
                  { value: "reject", label: "거절", tone: "bad" },
                  { value: "skip", label: "아직 결정 안 함", tone: "muted" },
                ]}
              />
              {v !== "skip" && (
                <Field label="이유" error={!(reason[u.id] ?? "").trim() ? "이유를 적어 주세요" : null}>
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
      title={retro ? "사후 청구 (RETROACTIVE_REQUEST)" : "구매 약정 요청"}
      onClose={onClose}
      wide
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit(manual ? { document: doc?.id, manual } : { document: doc?.id })}
          busy={busy}
          disabled={!doc}
          confirm={retro ? "사후 청구 보내기" : "약정 요청 보내기"}
          danger={retro}
        />
      }
    >
      {retro ? (
        <Banner tone="bad" title="사전 약정이 없어서 클라이언트가 응답하지 않으면 지급되지 않습니다">
          사후 청구는 클라이언트가 명시적으로 승인할 때만 정산됩니다. 가능하면 구매 전에 구매 약정을 요청하세요.
        </Banner>
      ) : (
        <Banner tone="info" title="구매 전에 요청하세요">
          AI가 견적서를 읽고, 서명된 정책 규칙이 APPROVE(최대 정산액 예약) / HOLD(클라이언트 검토) / BLOCK을 결정합니다. APPROVE면 예약된 금액까지는 구매해도 지급이 보장됩니다.
        </Banner>
      )}
      {view.paused && <Banner tone="warn">새 약정 일시정지 중입니다. 요청이 거절될 수 있습니다.</Banner>}
      <fieldset className="fieldset">
        <legend>{retro ? "영수증·청구 문서" : "견적서"}</legend>
        {doc ? (
          <div className="row-wrap">
            <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} />
          </div>
        ) : (
          <DocPicker kinds={retro ? ["receipt", "quote"] : ["quote"]} onAttach={setDoc} cta="이 문서 사용" />
        )}
      </fieldset>
      <details className="mini-fold">
        <summary>수동 입력 (AI를 쓸 수 없을 때만 사용)</summary>
        <p className="muted small">AI 판독이 가능하면 서버는 이 값을 쓰지 않습니다. 수동 입력은 증빙 수준을 올리지 않습니다.</p>
        <div className="grid-2">
          <Field label="공급자">
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">— 선택 안 함 —</option>
              {(meta?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.category_ko})
                </option>
              ))}
            </select>
          </Field>
          <Field label="품목">
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="예: 도메인 1년" />
          </Field>
          <Field label="공급가액">
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
          <Field label="부가세·수수료">
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
      title={`영수증 제출 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id, claimed })} busy={busy} disabled={!doc || !claimed} confirm="제출 통지 보내기" />}
    >
      <Banner tone="info">
        제출 통지 시각부터 클라이언트 정산 검토 기한이 흐릅니다. 증빙이 늦게 확인되어도 제출 시각은 뒤로 밀리지 않습니다.
      </Banner>
      <fieldset className="fieldset">
        <legend>영수증</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta="이 영수증 사용" />}
      </fieldset>
      <Field label="청구액" hint={`약정 한도 ${won(e.maximum)}`}>
        <MoneyInput value={claimed} onChange={setClaimed} />
      </Field>
      {over && (
        <Banner tone="warn">
          청구액이 약정 한도를 {won((claimed ?? 0) - e.maximum)} 넘습니다. 약정분 {won(e.maximum)}은 먼저 정산되고, 초과분은 변경 주문으로만 지급할 수 있습니다.
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
      title={`증빙 보완 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      wide
      footer={<Footer onClose={onClose} onConfirm={() => submit({ document: doc?.id })} busy={busy} disabled={!doc} confirm="보완 증빙 제출" />}
    >
      <Banner tone="warn" title="보완해도 어떤 기한도 다시 시작되지 않습니다">
        새 문서를 다시 읽어 증빙 결함이 해소되는지 확인합니다. 청구 금액과 검토·분쟁 해결 기한은 그대로입니다.
      </Banner>
      <fieldset className="fieldset">
        <legend>보완 문서</legend>
        {doc ? <AttachedDocs docs={[doc]} onRemove={() => setDoc(null)} /> : <DocPicker kinds={["receipt"]} onAttach={setDoc} cta="이 문서 사용" />}
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
  const { busy, submit } = useSubmit(action, onClose)
  const [choice, setChoice] = useState<YesNo>(initialYesNo(preset))
  const [reason, setReason] = useState("")
  const retro = e.status === "RETRO_REVIEW"
  const amount = retro ? e.quote?.total ?? e.maximum : e.maximum
  return (
    <Modal
      title={`${retro ? "사후 청구" : "HOLD 요청"} 응답 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? "거절" : "승인"}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          ["품목", e.item ?? "—"],
          [retro ? "청구 합계" : "견적 합계", <Money n={e.quote?.total ?? null} />],
          ["약정 한도", <Money n={e.maximum} />],
        ]}
      />
      <FailedRules e={e} />
      <Segmented
        value={choice}
        onChange={setChoice}
        label="응답"
        options={[
          { value: "yes", label: "승인", tone: "ok" },
          { value: "no", label: "거절", tone: "bad" },
        ]}
      />
      {choice === "yes" && (
        <p className="small">{retro ? `승인하면 ${won(amount)}이 정산됩니다.` : `승인하면 최대 정산액 ${won(amount)}이 예약되어 구매 약정이 됩니다. 이후에는 혼자 취소할 수 없습니다.`}</p>
      )}
      {choice === "no" && <p className="small">{retro ? "거절하면 지급되지 않습니다." : "거절하면 약정 없이 끝납니다. 아직 약속된 것이 없으므로 분쟁으로 가지 않습니다."}</p>}
      <Field label={choice === "no" ? "사유 (필수)" : "사유"}>
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
      title={`정산 검토 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ approve: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || (choice === "no" && !reason.trim())}
          confirm={choice === "no" ? "이의 → 분쟁 해결" : "승인 (지급)"}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          ["영수증 청구액", <Money n={claimed} />],
          ["약정 한도", <Money n={e.maximum} />],
          ["승인 시 지급", <Money n={payable} />],
          ["영수증", <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <Segmented
        value={choice}
        onChange={setChoice}
        label="검토"
        options={[
          { value: "yes", label: "승인 (지급)", tone: "ok" },
          { value: "no", label: "이의", tone: "bad" },
        ]}
      />
      {choice === "no" && (
        <Banner tone="info">
          유효한 약정에 대한 이의는 최종 거절이 아니라 분쟁 해결(CLIENT_REVIEW)로 넘어갑니다. 분쟁 해결자도 침묵하면 {label(HOLD_RESOLVER_SILENCE, "CLIENT_REVIEW")}.
        </Banner>
      )}
      <Field label={choice === "no" ? "이의 사유 (필수)" : "메모"}>
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
      title={`분쟁 해결로 넘기기 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={() => submit({ reason: reason.trim() })} busy={busy} disabled={!reason.trim()} confirm="분쟁 해결로 넘기기" />}
    >
      <Banner tone="warn" title={`HOLD · ${label(HOLD_CLASS, e.hold_class)}`}>
        {e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class) ? "필수 증빙·무결성 규칙은 클라이언트가 승인으로 면제할 수 없습니다. " : ""}
        분쟁 해결자가 판단하며, 분쟁 해결자도 침묵하면 {label(HOLD_RESOLVER_SILENCE, e.hold_class)}. 지금 넘기지 않아도 검토 기한에 자동으로 넘어갑니다.
      </Banner>
      <FailedRules e={e} />
      <Field label="사유">
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
      title={`경비 분쟁 해결 · ${e.vendor_name ?? e.vendor ?? e.id}`}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          onConfirm={() => submit({ accept: choice === "yes", reason: reason.trim() })}
          busy={busy}
          disabled={choice === "" || !reason.trim()}
          confirm={choice === "no" ? "거절" : "지급 인정"}
          danger={choice === "no"}
        />
      }
    >
      <KV
        items={[
          ["HOLD 유형", e.hold_class ? `${label(HOLD_CLASS, e.hold_class)} (${e.hold_class})` : "—"],
          ["청구액", <Money n={claimed} />],
          ["약정 한도 (지급 상한)", <Money n={e.maximum} />],
          ["영수증", <DocLink doc={e.receipt?.document ?? null} />],
        ]}
      />
      <FailedRules e={e} />
      <Banner tone="info" title={`기한까지 결정하지 않으면: ${e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : "사전 합의된 결과가 적용됩니다"}`}>
        분쟁 해결자는 약정 한도 안에서 지급을 인정하거나 거절할 수만 있습니다. 수취인·금액 상한·정책은 바꿀 수 없습니다.
      </Banner>
      <Segmented
        value={choice}
        onChange={setChoice}
        label="결정"
        options={[
          { value: "yes", label: "지급 인정", tone: "ok" },
          { value: "no", label: "거절", tone: "bad" },
        ]}
      />
      <Field label="이유 (필수)">
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
      title={covers ? "초과분 변경 주문 초안" : "범위 밖 요청 → 변경 주문 초안"}
      onClose={onClose}
      footer={<Footer onClose={onClose} onConfirm={go} busy={busy} disabled={!text.trim()} confirm="AI로 초안 만들기" />}
    >
      <Banner tone="warn">{CO_DISCLAIMER}</Banner>
      {covered && (
        <p className="small">
          대상 경비: <strong>{`${covered.vendor_name ?? covered.vendor ?? ""} ${covered.item ?? ""}`.trim()}</strong> · 초과분 {won(covered.excess)}
        </p>
      )}
      <Field label="요청 내용" hint="평소 말투로 적으면 AI가 범위·가격·일정·인수 기준을 담은 초안을 만듭니다. 초안은 두 당사자가 고칠 수 있습니다.">
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 로그인 기능도 추가해 주세요" autoFocus />
      </Field>
    </Modal>
  )
}
