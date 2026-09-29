// 자금 현황: where the funded money is (ADR 0004). The bar spans the larger of the budget
// and the funded amount; every funded won is in exactly one of reserved / paid / refunded /
// available.

import { useTranslation } from "react-i18next"
import { won } from "../format"
import type { Ledger as LedgerT, ProjectView } from "../types"
import { Banner, Card, Money } from "./ui"

interface Seg {
  key: string
  label: string
  value: number
  cls: string
  note?: string
}

export function LedgerCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const l: LedgerT = view.ledger
  const role = view.viewer.role
  const unfunded = Math.max(l.budget - l.funded, 0)
  const scale = Math.max(l.budget, l.funded, 1)
  const segs: Seg[] = [
    { key: "mr", label: t("ledger.milestoneReserved"), value: l.milestone_reserved, cls: "seg-ms" },
    { key: "er", label: t("ledger.expenseReserved"), value: l.expense_reserved, cls: "seg-ex" },
    {
      key: "rel",
      label: t("ledger.paid"),
      value: l.released,
      cls: "seg-paid",
      note: t("ledger.paidNote", { work: won(l.milestone_released), expenses: won(l.expense_released) }),
    },
    { key: "ref", label: t("ledger.refunded"), value: l.refunded, cls: "seg-refund" },
    { key: "av", label: t("ledger.available"), value: l.available, cls: "seg-avail", note: t("ledger.availableNote") },
  ]
  const bar = [...segs, { key: "un", label: t("ledger.unfunded"), value: unfunded, cls: "seg-unfunded" }]

  return (
    <Card
      title={t("ledger.title")}
      id="sec-ledger"
      sub={
        <>
          {t("ledger.deposited")} <strong className="num">{won(l.funded)}</strong> / {t("ledger.projectBudget")} {won(l.budget)}
        </>
      }
    >
      <div className="stackbar" role="img" aria-label={bar.map((s) => `${s.label} ${won(s.value)}`).join(", ")}>
        {bar
          .filter((s) => s.value > 0)
          .map((s) => (
            <span key={s.key} className={`stack-seg ${s.cls}`} style={{ width: `${(s.value / scale) * 100}%` }} title={`${s.label} ${won(s.value)}`} />
          ))}
      </div>
      <ul className="legend">
        <li className="legend-row legend-total">
          <span className="legend-key">
            <i className="dot seg-funded" /> {t("ledger.depositedShort")}
          </span>
          <Money n={l.funded} />
        </li>
        {segs.map((s) => (
          <li key={s.key} className="legend-row">
            <span className="legend-key">
              <i className={`dot ${s.cls}`} /> {s.label}
              {s.note && <span className="legend-note">{s.note}</span>}
            </span>
            <Money n={s.value} />
          </li>
        ))}
        {unfunded > 0 && (
          <li className="legend-row">
            <span className="legend-key">
              <i className="dot seg-unfunded" /> {t("ledger.unfundedFull")}
            </span>
            <Money n={unfunded} />
          </li>
        )}
      </ul>

      <div className="capacity">
        <Capacity title={t("ledger.expenseBudget")} total={l.expense_budget} left={l.expense_capacity} />
        <Capacity title={t("ledger.milestoneBudget")} total={l.milestone_budget} left={l.milestone_capacity} />
      </div>

      <details className="mini-fold">
        <summary>{t("ledger.formulaTitle")}</summary>
        <p className="formula">
          {t("ledger.formula")}
          <br />
          <span className="num">
            {won(l.available)} = {won(l.funded)} − {won(l.expense_reserved)} − {won(l.milestone_reserved)} − {won(l.released)} − {won(l.refunded)} − {won(l.migrated_out ?? 0)}
          </span>
        </p>
        <dl className="kv">
          <div className="kv-row">
            <dt>{t("ledger.migrated")}</dt>
            <dd>
              <Money n={l.migrated_out ?? 0} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("ledger.fundingNeeded")}</dt>
            <dd>
              <Money n={l.funding_needed ?? 0} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("ledger.depositRoom")}</dt>
            <dd>
              <Money n={l.deposit_room} />
            </dd>
          </div>
        </dl>
      </details>

      {role === "contractor" && l.milestone_reserved > 0 && (
        <Banner tone="ok" title={t("ledger.workReservedTitle", { amount: won(l.milestone_reserved) })}>
          {t("ledger.workReservedBody")}
        </Banner>
      )}
      {role === "contractor" && l.expense_capacity > 0 && view.status === "ACTIVE" && (
        <p className="muted small">{t("ledger.expenseHint", { amount: won(l.expense_capacity) })}</p>
      )}
      {role === "client" && (l.funding_needed ?? l.deposit_room) > 0 && (
        <Banner tone="warn" title={t("ledger.depositNeeded", { amount: won(l.funding_needed ?? l.deposit_room) })}>
          {view.status === "DRAFT" ? t("ledger.depositDraft") : t("ledger.depositChange")}
        </Banner>
      )}
      {role === "client" && (view.status === "CLOSING" || view.status === "CANCELLED") && l.available > 0 && (
        <p className="muted small">{t("ledger.refundOnly", { amount: won(l.available) })}</p>
      )}
      <p className="muted small">{t("project.offChainMoney")}</p>
    </Card>
  )
}

function Capacity({ title, total, left }: { title: string; total: number; left: number }) {
  const { t } = useTranslation()
  const used = Math.max(total - left, 0)
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0
  return (
    <div className="cap">
      <div className="cap-head">
        <span>{title}</span>
        <span className="num small">
          {t("ledger.remaining")} <strong>{won(left)}</strong> / {won(total)}
        </span>
      </div>
      <div className="cap-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
