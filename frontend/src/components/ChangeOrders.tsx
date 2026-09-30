// 변경 주문: an out-of-scope request (or an expense's excess) becomes a non-binding AI draft,
// then a new policy version both parties sign, then funded authority (ADR 0002, 0009;
// PROJECT_OVERVIEW.md §5.6). An order may add a milestone and/or raise the expense budget.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { L } from "../i18n"
import { num, sum, toDateInput, usd, when, won } from "../format"
import { CO_STATUS, CO_TONE, ROLE_KO, label, toneOf } from "../labels"
import type { ChangeOrder, ChangeOrderDraft, ProjectView } from "../types"
import { Act, findAction, scrollToAnchor, useProject } from "./projectCtx"
import { Banner, Card, Chip, Empty, Field, Money, MoneyInput } from "./ui"

/** Call during render (in a component using `useTranslation()`) so it follows the language. */
export const coDisclaimer = () =>
  L(
    "초안은 법적·금전적 효력이 없습니다. 두 당사자 서명 + 입금 후에만 새 마일스톤이 생깁니다.",
    "A draft has no legal or financial effect. A new milestone exists only after both parties sign and the deposit is made.",
  )

export function ChangeOrdersSection({ view }: { view: ProjectView }) {
  useTranslation()
  return (
    <Card
      title={L("변경 요청", "Change requests")}
      id="sec-changes"
      sub={L("추가 작업이나 예산 변경은 새로운 조건으로 합의하세요.", "Agree on new terms for extra work or budget changes.")}
      aside={
        <Act name="draft_change_order" variant="primary">
          {L("변경 요청하기", "Request a change")}
        </Act>
      }
    >
      {view.change_orders.length === 0 && <Empty>{L("변경 주문이 없습니다.", "No change orders yet.")}</Empty>}
      <div className="stack">
        {[...view.change_orders].reverse().map((c) => (
          <ChangeOrderCard key={c.id} c={c} view={view} />
        ))}
      </div>
    </Card>
  )
}

function ChangeOrderCard({ c, view }: { c: ChangeOrder; view: ProjectView }) {
  useTranslation()
  const target = { kind: "change_order" as const, id: c.id }
  const edit = findAction(view, "edit_change_order", target)
  const d = c.draft
  const delta = d?.expense_budget_delta ?? 0
  const covered = d?.covers_excess ? view.expenses.find((e) => e.id === d.covers_excess) : undefined
  return (
    <details className={`item record ${c.status === "WITHDRAWN" ? "item-final" : ""}`} id={`change_order-${c.id}`}>
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>{d?.title || (d?.covers_excess
              ? L("초과분 변경 주문", "Change order for an overage")
              : delta > 0
                ? L("경비 예산 증액", "Expense budget increase")
                : L("변경 주문", "Change order"))}</h3>
          <Chip tone={toneOf(CO_TONE, c.status)}>{label(CO_STATUS, c.status)}</Chip>
          <span className="muted small">
            {L(`${label(ROLE_KO, c.by)} 요청`, `Requested by ${label(ROLE_KO, c.by)}`)} · {c.id}
          </span>
        </div>
        {d && <Money n={d.amount + delta} className="item-amt" />}
      </summary>
      <div className="record-body">
        {d?.covers_excess && (
          <div className="meta-line small">
            <span>
              <span className="muted">{L("초과분 대상 경비", "Expense with the overage")}</span>{" "}
              <button type="button" className="linkish" onClick={() => scrollToAnchor(`expense-${d.covers_excess}`)}>
                {covered
                  ? `${covered.vendor_name ?? covered.vendor ?? ""} ${covered.item ?? ""}`.trim()
                  : d.covers_excess}
              </button>
              {covered && covered.excess > 0 && <> · {L("초과분", "overage")} {won(covered.excess)}</>}
            </span>
          </div>
        )}

        <blockquote className="words">
          <span className="muted small">{L("요청 원문", "Original request")}</span>
          <p>{c.text}</p>
        </blockquote>

        {c.status === "DRAFT" && <Banner tone="warn">{coDisclaimer()}</Banner>}
        {c.status === "PROPOSED" && (
          <Banner tone="info" title={L(
              `정책 v${c.policy_version ?? "?"}로 제안됨 — 양측 서명 대기`,
              `Proposed as policy v${c.policy_version ?? "?"} — awaiting both signatures`,
            )}>
            {L(
              "정책 카드에서 두 당사자가 서명하면 적용됩니다. 그 뒤 클라이언트의 입금으로 새 마일스톤이 예약됩니다.",
              "It applies once both parties sign on the policy card. The client's deposit then reserves the new milestone.",
            )}
            <div className="banner-actions">
              <button type="button" className="btn btn-ghost" onClick={() => scrollToAnchor("sec-policy")}>
                {L("정책 카드로 이동", "Go to the policy card")}
              </button>
            </div>
          </Banner>
        )}
        {c.status === "SIGNED" && (
          <Banner tone="info" title={L("서명 완료 · 입금 대기", "Signed · awaiting deposit")}>
            {L(
              `정책 v${c.policy_version}이 적용되었습니다. 새 마일스톤은 클라이언트의 입금이 가용 잔액으로 금액을 덮을 때 예약됩니다. 그 전에는 착수 의무가 없습니다.`,
              `Policy v${c.policy_version} is in effect. The new milestone is reserved once the client's deposit leaves enough available balance to cover it. Until then there is no obligation to start.`,
            )}
          </Banner>
        )}
        {c.status === "FUNDED" && <Banner tone="ok">{L("입금되어 새 권한이 활성화되었습니다.", "Deposited — the new authority is active.")}</Banner>}

        {c.ai && (!c.ai.ok || c.ai.problems.length > 0) && (
          <Banner tone="warn" title={c.ai.ok ? L("AI 초안 참고 사항", "Notes on the AI draft") : L("AI가 초안을 만들지 못했습니다", "The AI could not produce a draft")}>
            <ul className="problems">
              {c.ai.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Banner>
        )}

        {d && c.status === "DRAFT" && edit ? (
          <DraftEditor key={JSON.stringify(d)} c={c} draft={d} />
        ) : d ? (
          <DraftView draft={d} now={view.now} />
        ) : null}

        {c.ai?.usage && (
          <div className="usage">
            {L("AI 초안", "AI draft")}
            {c.ai.usage.tokens !== undefined && <span>{L("토큰", "Tokens")} {num(c.ai.usage.tokens)}</span>}
            {c.ai.usage.cost_usd !== undefined && <span>{L("비용", "Cost")} {usd(c.ai.usage.cost_usd)}</span>}
            {c.ai.usage.cached && <Chip tone="muted">{L("캐시", "Cached")}</Chip>}
          </div>
        )}

        <div className="item-actions">
          {!(c.status === "DRAFT" && edit) && <Act name="propose_change_order" target={target} variant="primary" />}
          <Act name="withdraw_change_order" target={target} variant="ghost" />
        </div>
      </div>
    </details>
  )
}

function DraftView({ draft, now }: { draft: ChangeOrderDraft; now: number }) {
  useTranslation()
  const delta = draft.expense_budget_delta ?? 0
  return (
    <div className="draft">
      {delta > 0 && (
        <div className="meta-line small">
          <span>
            <span className="muted">{L("경비 예산 증액", "Expense budget increase")}</span> <Money n={delta} />
          </span>
        </div>
      )}
      {draft.units.length > 0 && (
        <>
          <div className="meta-line small">
            <span>
              <span className="muted">{L("추가 마일스톤", "New milestone")}</span> <strong>{draft.title}</strong> <Money n={draft.amount} />
            </span>
          </div>
          <div className="dates small">
            <span>
              <span className="muted">{L("착수 기한", "Start by")}</span> {when(draft.start_by, now)}
            </span>
            <span>
              <span className="muted">{L("납기", "Due")}</span> {when(draft.due_at, now)}
            </span>
            <span>
              <span className="muted">{L("유예", "Grace")}</span> {L(`${draft.grace_days}일`, `${draft.grace_days} days`)}
            </span>
          </div>
          <ul className="pm-units">
            {draft.units.map((u, i) => (
              <li key={i}>
                <div className="pm-unit-head">
                  <span>{u.title}</span>
                  <Money n={u.amount} />
                </div>
                <ul className="criteria">
                  {u.criteria.map((c, j) => (
                    <li key={j}>{c}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {draft.note && <p className="note">{draft.note}</p>}
    </div>
  )
}

interface EditUnit {
  title: string
  criteria: string
  amount: number | null
}

interface EditState {
  title: string
  start_by: string
  due_at: string
  grace_days: number
  note: string
  units: EditUnit[]
  expense_budget_delta: number | null
}

function toEdit(d: ChangeOrderDraft): EditState {
  return {
    title: d.title ?? "",
    start_by: toDateInput(d.start_by),
    due_at: toDateInput(d.due_at),
    grace_days: d.grace_days ?? 0,
    note: d.note ?? "",
    units: (d.units ?? []).map((u) => ({ title: u.title, criteria: u.criteria.join("\n"), amount: u.amount })),
    expense_budget_delta: d.expense_budget_delta ?? 0,
  }
}

function fromEdit(s: EditState, coversExcess: string | null): ChangeOrderDraft {
  const units = s.units.map((u) => ({
    title: u.title.trim(),
    criteria: u.criteria
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    amount: u.amount ?? 0,
  }))
  return {
    title: s.title.trim(),
    amount: sum(units.map((u) => u.amount)),
    start_by: s.start_by || null,
    due_at: s.due_at || null,
    grace_days: s.grace_days,
    units,
    note: s.note,
    expense_budget_delta: s.expense_budget_delta ?? 0,
    covers_excess: coversExcess,
  }
}

function DraftEditor({ c, draft }: { c: ChangeOrder; draft: ChangeOrderDraft }) {
  useTranslation()
  const { view, run, busy } = useProject()
  const target = { kind: "change_order" as const, id: c.id }
  const edit = findAction(view, "edit_change_order", target)
  const propose = findAction(view, "propose_change_order", target)
  const { open } = useProject()
  const initial = useMemo(() => toEdit(draft), [draft])
  const [s, setS] = useState<EditState>(initial)
  const dirty = JSON.stringify(s) !== JSON.stringify(initial)
  const out = fromEdit(s, draft.covers_excess ?? null)
  const delta = out.expense_budget_delta ?? 0
  const problems: string[] = []
  if (out.units.length === 0 && delta <= 0) problems.push(L("새 마일스톤이나 경비 예산 증액 중 하나는 있어야 합니다", "Add a new milestone or an expense budget increase"))
  if (out.units.length > 0) {
    if (!out.title) problems.push(L("마일스톤 제목을 입력하세요", "Enter a milestone title"))
    if (!out.start_by || !out.due_at) problems.push(L("착수 기한과 납기를 정하세요", "Set a start-by date and a due date"))
  }
  out.units.forEach((u, i) => {
    if (!u.title) problems.push(L(`납품 단위 ${i + 1}: 이름이 비어 있습니다`, `Deliverable unit ${i + 1}: name is empty`))
    if (u.criteria.length === 0) problems.push(L(`납품 단위 ${i + 1}: 인수 기준이 없습니다`, `Deliverable unit ${i + 1}: no acceptance criteria`))
    if (!(u.amount > 0)) problems.push(L(`납품 단위 ${i + 1}: 금액이 없습니다`, `Deliverable unit ${i + 1}: no amount`))
  })
  if (delta < 0) problems.push(L("경비 예산 증액은 0 이상이어야 합니다", "The expense budget increase must be 0 or more"))
  if (out.start_by && out.due_at && out.start_by > out.due_at) problems.push(L("착수 기한이 납기보다 늦습니다", "The start-by date is after the due date"))

  const setUnit = (i: number, patch: Partial<EditUnit>) =>
    setS((p) => ({ ...p, units: p.units.map((u, j) => (j === i ? { ...u, ...patch } : u)) }))

  return (
    <div className="draft-edit">
      <div className="grid-2">
        <Field
          label={L("경비 예산 증액", "Expense budget increase")}
          hint={
            draft.covers_excess
              ? L(`경비 ${draft.covers_excess}의 초과분을 덮는 증액입니다.`, `Covers the overage on expense ${draft.covers_excess}.`)
              : L("없으면 0", "0 if none")
          }
        >
          <MoneyInput value={s.expense_budget_delta} onChange={(n) => setS({ ...s, expense_budget_delta: n })} />
        </Field>
        <span />
        <Field
          label={L("추가 마일스톤 제목", "New milestone title")}
          hint={L("마일스톤을 추가하지 않으면 납품 단위를 모두 지우세요.", "If you are not adding a milestone, remove every deliverable unit.")}
        >
          <input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} />
        </Field>
        <Field label={L("유예 기간 (일)", "Grace period (days)")}>
          <input
            type="number"
            min={0}
            value={s.grace_days}
            onChange={(e) => setS({ ...s, grace_days: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        <Field label={L("착수 기한", "Start by")}>
          <input type="date" value={s.start_by} onChange={(e) => setS({ ...s, start_by: e.target.value })} />
        </Field>
        <Field label={L("납기", "Due date")}>
          <input type="date" value={s.due_at} onChange={(e) => setS({ ...s, due_at: e.target.value })} />
        </Field>
      </div>
      <div className="units-edit">
        {s.units.map((u, i) => (
          <div className="unit-edit" key={i}>
            <div className="grid-2">
              <Field label={L(`납품 단위 ${i + 1}`, `Deliverable unit ${i + 1}`)}>
                <input value={u.title} onChange={(e) => setUnit(i, { title: e.target.value })} />
              </Field>
              <Field label={L("금액", "Amount")}>
                <MoneyInput value={u.amount} onChange={(n) => setUnit(i, { amount: n })} />
              </Field>
            </div>
            <Field
              label={L("인수 기준", "Acceptance criteria")}
              hint={L(
                "한 줄에 기준 하나. 검수 때는 이 기준만 이의 사유로 고를 수 있습니다.",
                "One criterion per line. At review, only these criteria can be cited in an objection.",
              )}
            >
              <textarea rows={2} value={u.criteria} onChange={(e) => setUnit(i, { criteria: e.target.value })} />
            </Field>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setS({ ...s, units: s.units.filter((_, j) => j !== i) })}
            >
              {L("납품 단위 삭제", "Remove deliverable unit")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setS({ ...s, units: [...s.units, { title: "", criteria: "", amount: null }] })}
        >
          {L("+ 납품 단위 추가", "+ Add deliverable unit")}
        </button>
      </div>
      <Field label={L("메모", "Note")}>
        <textarea rows={2} value={s.note} onChange={(e) => setS({ ...s, note: e.target.value })} />
      </Field>
      <div className="draft-total">
        {L("마일스톤", "Milestone")} <Money n={out.amount} /> + {L("경비 예산 증액", "expense budget increase")}{" "}
        <Money n={delta} /> = {L("추가 금액", "additional amount")}{" "}
        <Money n={out.amount + delta} />
      </div>
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="item-actions">
        {edit && (
          <button
            type="button"
            className="btn"
            disabled={busy || !dirty || problems.length > 0}
            onClick={() => run(edit, { draft: out })}
          >
            {L("초안 저장", "Save draft")}
          </button>
        )}
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => setS(initial)}>
            {L("되돌리기", "Revert")}
          </button>
        )}
        {propose && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || dirty || problems.length > 0}
            onClick={() => open(propose)}
            title={dirty ? L("변경 사항을 먼저 저장하세요", "Save your changes first") : undefined}
          >
            {L("정식 제안 (새 정책 버전)", "Propose formally (new policy version)")}
          </button>
        )}
        {dirty && propose && <span className="muted small">{L("변경 사항을 먼저 저장해야 제안할 수 있습니다.", "Save your changes before proposing.")}</span>}
      </div>
    </div>
  )
}
