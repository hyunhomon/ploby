// 변경 주문: an out-of-scope request (or an expense's excess) becomes a non-binding AI draft,
// then a new policy version both parties sign, then funded authority (ADR 0002, 0009;
// PROJECT_OVERVIEW.md §5.6). An order may add a milestone and/or raise the expense budget.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { num, sum, toDateInput, usd, when, won } from "../format"
import { CO_STATUS, CO_TONE, ROLE_KO, caption, label, toneOf } from "../labels"
import type { ChangeOrder, ChangeOrderDraft, ProjectView } from "../types"
import { Act, findAction, scrollToAnchor, useProject } from "./projectCtx"
import { Banner, Card, Chip, Empty, Field, Money, MoneyInput } from "./ui"

export function ChangeOrdersSection({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  return (
    <Card
      title={t("changes.title")}
      id="sec-changes"
      sub={t("changes.sub")}
      aside={
        <Act name="draft_change_order" variant="primary">
          {t("changes.request")}
        </Act>
      }
    >
      {view.change_orders.length === 0 && <Empty>{t("changes.empty")}</Empty>}
      <div className="stack">
        {[...view.change_orders].reverse().map((c) => (
          <ChangeOrderCard key={c.id} c={c} view={view} />
        ))}
      </div>
    </Card>
  )
}

function ChangeOrderCard({ c, view }: { c: ChangeOrder; view: ProjectView }) {
  const { t } = useTranslation()
  const target = { kind: "change_order" as const, id: c.id }
  const edit = findAction(view, "edit_change_order", target)
  const d = c.draft
  const delta = d?.expense_budget_delta ?? 0
  const covered = d?.covers_excess ? view.expenses.find((e) => e.id === d.covers_excess) : undefined
  return (
    <details className={`item record ${c.status === "WITHDRAWN" ? "item-final" : ""}`} id={`change_order-${c.id}`}>
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>{d?.title || (d?.covers_excess ? t("changes.excessOrder") : delta > 0 ? t("changes.budgetIncrease") : t("changes.order"))}</h3>
          <Chip tone={toneOf(CO_TONE, c.status)}>{label(CO_STATUS, c.status)}</Chip>
          <span className="muted small">
            {t("changes.requested", { role: label(ROLE_KO, c.by), id: c.id })}
          </span>
        </div>
        {d && <Money n={d.amount + delta} className="item-amt" />}
      </summary>
      <div className="record-body">
        {d?.covers_excess && (
          <div className="meta-line small">
            <span>
              <span className="muted">{t("changes.covers")}</span>{" "}
              <button type="button" className="linkish" onClick={() => scrollToAnchor(`expense-${d.covers_excess}`)}>
                {covered
                  ? `${covered.vendor_name ?? covered.vendor ?? ""} ${covered.item ?? ""}`.trim()
                  : d.covers_excess}
              </button>
              {covered && covered.excess > 0 && <> · {t("changes.excessAmount", { amount: won(covered.excess) })}</>}
            </span>
          </div>
        )}

        <blockquote className="words">
          <span className="muted small">{t("changes.original")}</span>
          <p>{c.text}</p>
        </blockquote>

        {c.status === "DRAFT" && <Banner tone="warn">{t("dialogs.noEffect")}</Banner>}
        {c.status === "PROPOSED" && (
          <Banner tone="info" title={t("changes.proposedTitle", { version: c.policy_version ?? "?" })}>
            {t("changes.proposedBody")}
            <div className="banner-actions">
              <button type="button" className="btn btn-ghost" onClick={() => scrollToAnchor("sec-policy")}>
                {t("changes.goToPolicy")}
              </button>
            </div>
          </Banner>
        )}
        {c.status === "SIGNED" && (
          <Banner tone="info" title={t("changes.signedTitle")}>
            {t("changes.signedBody", { version: c.policy_version })}
          </Banner>
        )}
        {c.status === "FUNDED" && <Banner tone="ok">{t("changes.funded")}</Banner>}

        {c.ai && (!c.ai.ok || c.ai.problems.length > 0) && (
          <Banner tone="warn" title={c.ai.ok ? t("changes.aiNotes") : t("changes.aiFailed")}>
            <ul className="problems">
              {c.ai.problems.map((p, i) => (
                <li key={i}>{caption(p)}</li>
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
            {t("changes.aiDraft")}
            {c.ai.usage.tokens !== undefined && <span>{t("changes.tokens", { count: num(c.ai.usage.tokens) })}</span>}
            {c.ai.usage.cost_usd !== undefined && <span>{t("changes.cost", { amount: usd(c.ai.usage.cost_usd) })}</span>}
            {c.ai.usage.cached && <Chip tone="muted">{t("changes.cached")}</Chip>}
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
  const { t } = useTranslation()
  const delta = draft.expense_budget_delta ?? 0
  return (
    <div className="draft">
      {delta > 0 && (
        <div className="meta-line small">
          <span>
            <span className="muted">{t("changes.budgetIncrease")}</span> <Money n={delta} />
          </span>
        </div>
      )}
      {draft.units.length > 0 && (
        <>
          <div className="meta-line small">
            <span>
              <span className="muted">{t("changes.addedMilestone")}</span> <strong>{draft.title}</strong> <Money n={draft.amount} />
            </span>
          </div>
          <div className="dates small">
            <span>
              <span className="muted">{t("changes.startBy")}</span> {when(draft.start_by, now)}
            </span>
            <span>
              <span className="muted">{t("changes.due")}</span> {when(draft.due_at, now)}
            </span>
            <span>
              <span className="muted">{t("changes.grace")}</span> {t("changes.graceDays", { count: draft.grace_days })}
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
  const { t } = useTranslation()
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
  if (out.units.length === 0 && delta <= 0) problems.push(t("changes.needOne"))
  if (out.units.length > 0) {
    if (!out.title) problems.push(t("changes.needTitle"))
    if (!out.start_by || !out.due_at) problems.push(t("changes.needDates"))
  }
  out.units.forEach((u, i) => {
    if (!u.title) problems.push(t("changes.unitName", { n: i + 1 }))
    if (u.criteria.length === 0) problems.push(t("changes.unitCriteria", { n: i + 1 }))
    if (!(u.amount > 0)) problems.push(t("changes.unitAmount", { n: i + 1 }))
  })
  if (delta < 0) problems.push(t("changes.deltaNonNegative"))
  if (out.start_by && out.due_at && out.start_by > out.due_at) problems.push(t("changes.dateOrder"))

  const setUnit = (i: number, patch: Partial<EditUnit>) =>
    setS((p) => ({ ...p, units: p.units.map((u, j) => (j === i ? { ...u, ...patch } : u)) }))

  return (
    <div className="draft-edit">
      <div className="grid-2">
        <Field
          label={t("changes.budgetIncrease")}
          hint={draft.covers_excess ? t("changes.coversHint", { id: draft.covers_excess }) : t("changes.zeroIfNone")}
        >
          <MoneyInput value={s.expense_budget_delta} onChange={(n) => setS({ ...s, expense_budget_delta: n })} />
        </Field>
        <span />
        <Field label={t("changes.milestoneTitle")} hint={t("changes.milestoneHint")}>
          <input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} />
        </Field>
        <Field label={t("changes.graceLabel")}>
          <input
            type="number"
            min={0}
            value={s.grace_days}
            onChange={(e) => setS({ ...s, grace_days: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        <Field label={t("changes.startBy")}>
          <input type="date" value={s.start_by} onChange={(e) => setS({ ...s, start_by: e.target.value })} />
        </Field>
        <Field label={t("changes.due")}>
          <input type="date" value={s.due_at} onChange={(e) => setS({ ...s, due_at: e.target.value })} />
        </Field>
      </div>
      <div className="units-edit">
        {s.units.map((u, i) => (
          <div className="unit-edit" key={i}>
            <div className="grid-2">
              <Field label={t("changes.unit", { n: i + 1 })}>
                <input value={u.title} onChange={(e) => setUnit(i, { title: e.target.value })} />
              </Field>
              <Field label={t("changes.amount")}>
                <MoneyInput value={u.amount} onChange={(n) => setUnit(i, { amount: n })} />
              </Field>
            </div>
            <Field label={t("changes.criteria")} hint={t("changes.criteriaHint")}>
              <textarea rows={2} value={u.criteria} onChange={(e) => setUnit(i, { criteria: e.target.value })} />
            </Field>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setS({ ...s, units: s.units.filter((_, j) => j !== i) })}
            >
              {t("changes.removeUnit")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setS({ ...s, units: [...s.units, { title: "", criteria: "", amount: null }] })}
        >
          {t("changes.addUnit")}
        </button>
      </div>
      <Field label={t("changes.note")}>
        <textarea rows={2} value={s.note} onChange={(e) => setS({ ...s, note: e.target.value })} />
      </Field>
      <div className="draft-total">
        {t("changes.total", { milestone: won(out.amount), delta: won(delta), sum: won(out.amount + delta) })}
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
            {t("changes.save")}
          </button>
        )}
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => setS(initial)}>
            {t("changes.revert")}
          </button>
        )}
        {propose && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || dirty || problems.length > 0}
            onClick={() => open(propose)}
            title={dirty ? t("changes.saveFirst") : undefined}
          >
            {t("changes.propose")}
          </button>
        )}
        {dirty && propose && <span className="muted small">{t("changes.saveBeforePropose")}</span>}
      </div>
    </div>
  )
}
