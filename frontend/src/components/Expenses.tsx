// 경비: purchase commitments and retroactive requests (ADR 0005, PROJECT_OVERVIEW.md §5.3,
// §6). Each card shows the rules that decided it in decision order, what the AI read from the
// documents, the clocks and what silence does.

import { useTranslation } from "react-i18next"
import { tr } from "../i18n"
import { kst, num, shortHash, usd, won } from "../format"
import {
  ASSURANCE,
  DECISION,
  DECISION_KO,
  DECISION_TONE,
  EXPENSE_KIND,
  EXPENSE_STATUS,
  EXPENSE_TONE,
  FINAL_EXPENSE,
  HOLD_CLASS,
  HOLD_CLASS_HELP,
  HOLD_RESOLVER_SILENCE,
  HOLD_TONE,
  NON_WAIVABLE_HOLD,
  PAYMENT_MODE,
  READING_FIELD_KO,
  REASON_KO,
  RULE_DEFAULT_KIND,
  RULE_KIND,
  RULE_KO,
  caption,
  RULE_ORDER,
  TIMEOUT,
  TIMEOUT_TONE,
  label,
  toneOf,
} from "../labels"
import type { DocRef, Expense, ProjectView, Reading, RuleKind, RuleResult } from "../types"
import { Clock } from "./Milestones"
import { Act, actionLabel, deadlinesFor, findAction, scrollToAnchor, useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, DocLink, Empty, Money } from "./ui"

export function ExpensesSection({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const active = view.expenses.filter((e) => !FINAL_EXPENSE.has(e.status))
  const done = view.expenses.filter((e) => FINAL_EXPENSE.has(e.status))
  return (
    <Card
      title={t("spend.title")}
      id="sec-expenses"
      sub={t("spend.sub")}
      aside={
        <div className="row-wrap">
          <Act name="request_commitment" variant="primary">
            {t("spend.request")}
          </Act>
          <Act name="retroactive_request" variant="ghost">
            {t("spend.retro")}
          </Act>
        </div>
      }
    >
      {view.expenses.length === 0 && <Empty>{t("spend.empty")}</Empty>}
      <div className="stack">
        {active.map((e) => (
          <ExpenseCard key={e.id} e={e} view={view} />
        ))}
      </div>
      {done.length > 0 && (
        <details className="policy-fold" open={active.length === 0}>
          <summary>{t("spend.done", { count: done.length })}</summary>
          <div className="stack">
            {done.map((e) => (
              <ExpenseCard key={e.id} e={e} view={view} />
            ))}
          </div>
        </details>
      )}
    </Card>
  )
}

function clockRows(e: Expense, t: (key: string) => string): { title: string; at: number | null; fallback: string }[] {
  const nonWaivable = !!e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class)
  switch (e.status) {
    case "HOLD_REVIEW":
      return [{ title: t("spend.clientReply"), at: e.review_deadline, fallback: t("spend.expiresNoPromise") }]
    case "RETRO_REVIEW":
      return [{ title: t("spend.clientReply"), at: e.review_deadline, fallback: t("spend.silenceNoRight") }]
    case "RESERVED":
      return [{ title: t("spend.reservationEnds"), at: e.expires_at, fallback: t("spend.reservationFallback") }]
    case "SPEND_REPORTED":
      return [{ title: t("spend.evidenceDeadline"), at: e.evidence_deadline, fallback: t("spend.evidenceFallback") }]
    case "EVIDENCE_SUBMITTED":
      return [
        {
          title: t("spend.settlementReview"),
          at: e.review_deadline,
          fallback: nonWaivable ? t("spend.escalateTimeout") : t("spend.releaseTimeout"),
        },
      ]
    case "DISPUTED":
      return [
        {
          title: t("spend.resolverDeadline"),
          at: e.resolver_deadline,
          fallback: e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : t("spend.agreedResult"),
        },
      ]
    default:
      return []
  }
}

function ExpenseCard({ e, view }: { e: Expense; view: ProjectView }) {
  const { t } = useTranslation()
  const { open, busy } = useProject()
  const now = view.now
  const target = { kind: "expense" as const, id: e.id }
  const clocks = deadlinesFor(view, target)
  const fallbackFor = (at: number | null) => clocks.find((d) => d.at === at)?.fallback ?? null
  const final = FINAL_EXPENSE.has(e.status)
  const draftCo = findAction(view, "draft_change_order", target) ?? findAction(view, "draft_change_order")
  const title = [e.vendor_name ?? e.vendor, e.item].filter(Boolean).join(" · ") || e.id
  const showRules = !!e.decision && e.decision.result !== "APPROVE"
  const nonWaivable = e.status === "EVIDENCE_SUBMITTED" && !!e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class)
  const excessCo = view.change_orders.find((c) => c.draft?.covers_excess === e.id && c.status !== "WITHDRAWN")
  const payeeIsContractor = !!e.payee && e.payee.toLowerCase() === view.parties.contractor.address.toLowerCase()

  return (
    <details className={`item record ${final ? "item-final" : ""}`} id={`expense-${e.id}`}>
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>{title}</h3>
          <Chip tone={toneOf(EXPENSE_TONE, e.status)}>{label(EXPENSE_STATUS, e.status)}</Chip>
        </div>
        <span className="muted small">{e.id}</span>
      </summary>
      <div className="record-body">
        <div className="chips">
          {" "}
          <Chip tone={e.kind === "RETROACTIVE" ? "warn" : "muted"}>{label(EXPENSE_KIND, e.kind)}</Chip>
          {e.hold_class && (
            <Chip
              tone={toneOf(HOLD_TONE, e.hold_class)}
              title={`${e.hold_class}: ${label(HOLD_CLASS_HELP, e.hold_class)}`}
            >
              HOLD · {label(HOLD_CLASS, e.hold_class)}
            </Chip>
          )}
          {e.timeout && <Chip tone={toneOf(TIMEOUT_TONE, e.timeout)}>{label(TIMEOUT, e.timeout)}</Chip>}
        </div>

        <div className="meta-line small">
          {e.category_ko && (
            <span>
              <span className="muted">{t("spend.category")}</span> {caption(e.category_ko)}
            </span>
          )}
          {e.payment_mode && (
            <span>
              <span className="muted">{t("spend.payment")}</span> {label(PAYMENT_MODE, e.payment_mode)}
            </span>
          )}
          {e.payee && (
            <span>
              <span className="muted">{t("spend.payee")}</span> <CopyHash hash={e.payee} head={6} tail={4} />
              {payeeIsContractor && <span className="muted"> {t("spend.contractor")}</span>}
            </span>
          )}
          {e.assurance && (
            <span title={label(ASSURANCE, e.assurance)}>
              <span className="muted">{t("spend.assurance")}</span> {label(ASSURANCE, e.assurance)}
            </span>
          )}
        </div>

        {e.out_of_scope && (
          <Banner tone="bad" title={t("spend.outOfScope")}>
            {t("spend.outOfScopeBody")}
            {draftCo && (
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    open(draftCo, {
                      text: t("spend.allowPurchase", {
                        what: `${e.vendor_name ?? e.vendor ?? ""} ${e.item ?? ""}`.replace(/\s+/g, " ").trim(),
                      }),
                    })
                  }
                >
                  {t("spend.draftFromItem")}
                </button>
              </div>
            )}
          </Banner>
        )}

        <div className="amounts">
          {e.quote && (
            <Amt
              label={e.kind === "RETROACTIVE" ? t("spend.claimTotal") : t("spend.quoteTotal")}
              n={e.quote.total}
              hint={t("spend.quoteHint", { amount: num(e.quote.amount), fee: num(e.quote.fee) })}
            />
          )}
          <Amt label={t("spend.cap")} n={e.maximum} />
          <Amt label={t("spend.reserved")} n={e.reserved} tone={e.reserved > 0 ? "info" : undefined} />
          <Amt label={t("spend.paid")} n={e.paid} tone={e.paid > 0 ? "ok" : undefined} />
          {e.receipt && (
            <Amt
              label={t("spend.receiptClaim")}
              n={e.receipt.claimed}
              hint={e.receipt.eligible !== null ? t("spend.eligible", { amount: won(e.receipt.eligible) }) : undefined}
            />
          )}
          {e.excess > 0 && <Amt label={t("spend.excess")} n={e.excess} tone="bad" />}
          {(e.excess_paid ?? 0) > 0 && (
            <Amt label={t("spend.excessPaid")} n={e.excess_paid ?? 0} tone="ok" hint={t("spend.paidByChange")} />
          )}
        </div>

        {e.excess > 0 && (
          <Banner tone="warn" title={t("spend.excessTitle", { amount: won(e.excess) })}>
            {t("spend.excessBody")}
            <div className="banner-actions">
              {excessCo ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => scrollToAnchor(`change_order-${excessCo.id}`)}
                >
                  {t("spend.viewExcess", { id: excessCo.id })}
                </button>
              ) : (
                draftCo &&
                (e.excess_paid ?? 0) < e.excess && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      open(draftCo, {
                        covers_excess: e.id,
                        text: t("spend.excessDraftText", {
                          what: `${e.vendor_name ?? e.vendor ?? ""} ${e.item ?? ""}`.replace(/\s+/g, " ").trim(),
                          amount: won(e.excess),
                        }),
                      })
                    }
                  >
                    {t("spend.excessDraft")}
                  </button>
                )
              )}
            </div>
          </Banner>
        )}

        {e.kind === "RETROACTIVE" && e.status === "RETRO_REVIEW" && (
          <Banner tone="warn">{t("spend.retroWarn")}</Banner>
        )}

        {nonWaivable && (
          <Banner tone="warn" title={t("spend.cannotWaive", { hold: label(HOLD_CLASS, e.hold_class) })}>
            {t("spend.cannotWaiveBody")}
            {e.hold_class === "EVIDENCE_DEFECT" && t("spend.canSupplement")}
          </Banner>
        )}

        {e.decision && (
          <div className="decision">
            <span className="muted small">{t("spend.decision")}</span>
            <Chip tone={toneOf(DECISION_TONE, e.decision.result)} title={label(DECISION_KO, e.decision.result)}>
              {label(DECISION, e.decision.result)}
            </Chip>
            <span>{label(REASON_KO, e.decision.reason)}</span>
          </div>
        )}

        {e.resolution && (
          <div className="decision">
            <span className="muted small">{t("spend.resolution")}</span>
            <Chip tone={e.resolution.accept ? "ok" : "bad"}>{e.resolution.accept ? t("spend.acceptPay") : t("spend.reject")}</Chip>
            <span>{e.resolution.reason}</span>
          </div>
        )}

        {e.settlement && (
          <div className="settlement small">
            <span className="muted">{t("spend.settlement")}</span> <Money n={e.settlement.amount} /> {e.settlement.asset} → {t("spend.payeeArrow")}{" "}
            <CopyHash hash={e.settlement.payee} head={6} /> · {kst(e.settlement.at, now)}
          </div>
        )}
        <ChainLine view={view} expenseId={e.id} />

        {!final && (
          <div className="clocks">
            {clockRows(e, t)
              .filter((c) => c.at !== null)
              .map((c) => (
                <Clock
                  key={c.title}
                  title={c.title}
                  at={c.at as number}
                  now={now}
                  fallback={fallbackFor(c.at) ?? c.fallback}
                />
              ))}
          </div>
        )}

        <div className="dates small">
          {e.expires_at && (
            <span>
              <span className="muted">{t("spend.reservationEnds")}</span> {kst(e.expires_at, now)}
            </span>
          )}
          {e.spent_at && (
            <span>
              <span className="muted">{t("spend.spendReported")}</span> {kst(e.spent_at, now)}
            </span>
          )}
          {e.receipt && (
            <span>
              <span className="muted">{t("spend.receiptSubmitted")}</span> {kst(e.receipt.at, now)}
            </span>
          )}
        </div>

        {e.decision && e.decision.rules.length > 0 && (
          <RulesTable rules={e.decision.rules} open={showRules && !final} />
        )}

        {(e.quote || e.receipt) && (
          <details className="mini-fold">
            <summary>{t("spend.docsAndAi")}</summary>
            {e.quote && (
              <ReadingBlock
                title={e.kind === "RETROACTIVE" ? t("spend.claimDoc") : t("spend.quote")}
                doc={e.quote.document}
                manifest={e.quote.manifest_hash ?? null}
                reading={e.quote.reading}
              />
            )}
            {e.receipt && (
              <ReadingBlock
                title={t("spend.receipt")}
                doc={e.receipt.document}
                manifest={e.receipt.manifest_hash ?? null}
                reading={e.receipt.reading}
              />
            )}
            {e.receipt?.supplements && e.receipt.supplements.length > 0 && (
              <div className="reading">
                <div className="reading-head">
                  <strong>{t("spend.supplements")}</strong>
                  {e.receipt.supplements.map((d) => (
                    <DocLink key={d.id} doc={d} />
                  ))}
                </div>
                <p className="muted small">{t("spend.supplementNote")}</p>
              </div>
            )}
            <p className="muted small">{t("spend.aiReads")}</p>
          </details>
        )}

        <div className="item-actions">
          <ChoiceButtons e={e} name="answer_request" yes={t("spend.approve")} no={t("spend.reject")} />
          <ChoiceButtons e={e} name="review_settlement" yes={t("spend.approvePay")} no={t("spend.object")} />
          <Act name="escalate_settlement" target={target} variant="primary" />
          <Act name="resolve_expense" target={target} variant="primary" />
          <Act name="report_spend" target={target} variant="primary" />
          <Act name="submit_receipt" target={target} variant="primary" />
          <Act name="supplement_evidence" target={target} variant="primary" />
          <Act name="cancel_reservation" target={target} variant="ghost" />
        </div>
      </div>
    </details>
  )
}

const KIND_ORDER: RuleKind[] = ["mandatory", "evidence", "risk"]

function kindOf(r: RuleResult): RuleKind {
  return r.kind ?? RULE_DEFAULT_KIND[r.rule] ?? "mandatory"
}

function RuleChip({ r }: { r: RuleResult }) {
  const { t } = useTranslation()
  if (r.ok === true) return <Chip tone="ok">{t("spend.pass")}</Chip>
  if (r.ok === null || r.ok === undefined) return <Chip tone="muted">{t("spend.na")}</Chip>
  const k = kindOf(r)
  if (k === "mandatory") return <Chip tone="bad">{t("spend.failBlock")}</Chip>
  if (k === "evidence") return <Chip tone="warn">{t("spend.shortHold")}</Chip>
  return <Chip tone="warn">{t("spend.signalHold")}</Chip>
}

/** Rules grouped mandatory → evidence → risk, each in the overview's decision order. */
function RulesTable({ rules, open }: { rules: RuleResult[]; open: boolean }) {
  const { t } = useTranslation()
  const rank = (r: RuleResult) => {
    const i = RULE_ORDER.indexOf(r.rule)
    return i === -1 ? RULE_ORDER.length : i
  }
  const groups = KIND_ORDER.map((k) => ({
    kind: k,
    rows: rules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => kindOf(r) === k)
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map(({ r }) => r),
  })).filter((g) => g.rows.length > 0)
  const passed = rules.filter((r) => r.ok === true).length
  const failedMandatory = rules.filter((r) => r.ok === false && kindOf(r) === "mandatory").length
  const holdSignals = rules.filter((r) => r.ok === false && kindOf(r) !== "mandatory").length
  return (
    <details className="mini-fold" open={open}>
      <summary>
        {t("spend.rulesChecked", { passed, total: rules.length })}
        {failedMandatory > 0 && <span className="sum-bad">{t("spend.blockReasons", { count: failedMandatory })}</span>}
        {holdSignals > 0 && <span className="sum-warn">{t("spend.holdReasons", { count: holdSignals })}</span>}
      </summary>
      <div className="table-wrap">
        <table className="table compact rules">
          <thead>
            <tr>
              <th>{t("spend.rule")}</th>
              <th>{t("spend.result")}</th>
              <th>{t("spend.detail")}</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.kind}>
              <tr className="group-row">
                <th colSpan={3}>
                  {label(RULE_KIND, g.kind)}
                  <span className="muted small">
                    {g.kind === "mandatory"
                      ? t("spend.failBlocks")
                      : g.kind === "risk"
                        ? t("spend.signalOnly")
                        : t("spend.shortMeansHold")}
                  </span>
                </th>
              </tr>
              {g.rows.map((r, i) => (
                <tr
                  key={`${r.rule}-${i}`}
                  className={r.ok === false ? (g.kind === "mandatory" ? "row-fail" : "row-warn") : undefined}
                >
                  <td data-h={t("spend.rule")}>{r.label ? caption(r.label) : label(RULE_KO, r.rule)}</td>
                  <td data-h={t("spend.result")}>
                    <RuleChip r={r} />
                  </td>
                  <td data-h={t("spend.detail")}>{r.detail ? caption(r.detail) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </details>
  )
}

/** Approve / object as two buttons that open the same server-listed action. */
function ChoiceButtons({ e, name, yes, no }: { e: Expense; name: string; yes: string; no: string }) {
  const { view, open, busy } = useProject()
  const a = findAction(view, name, { kind: "expense", id: e.id })
  if (!a) return null
  return (
    <span className="choice">
      <button
        type="button"
        className="btn btn-primary btn-attn"
        disabled={busy}
        onClick={() => open(a, { approve: true })}
      >
        {yes}
      </button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={() => open(a, { approve: false })}>
        {no}
      </button>
      <span className="muted small">{actionLabel(a)}</span>
    </span>
  )
}

function Amt({ label: l, n, hint, tone }: { label: string; n: number; hint?: string; tone?: "ok" | "info" | "bad" }) {
  return (
    <div className={`amt ${tone ? `amt-${tone}` : ""}`}>
      <span className="amt-label">{l}</span>
      <Money n={n} />
      {hint && <span className="amt-hint">{hint}</span>}
    </div>
  )
}

function fieldText(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "number") return num(v)
  if (typeof v === "string") return v
  if (typeof v === "boolean") return v ? tr("spend.yes") : tr("spend.no")
  return JSON.stringify(v)
}

function ReadingBlock({
  title,
  doc,
  manifest,
  reading,
}: {
  title: string
  doc: DocRef | null
  manifest: string | null
  reading: Reading | null
}) {
  const { t } = useTranslation()
  return (
    <div className="reading">
      <div className="reading-head">
        <strong>{title}</strong>
        <DocLink doc={doc} />
        {reading && (
          <Chip tone={reading.ok ? "ok" : "warn"}>
            {reading.source === "ai" ? t("spend.aiRead") : reading.source === "manual" ? t("spend.manual") : t("spend.aiOff")}{" "}
            {reading.ok ? t("spend.ok") : t("spend.problem")}
          </Chip>
        )}
      </div>
      {manifest && (
        <div className="muted small">
          {t("spend.manifest")} <CopyHash hash={manifest} />
        </div>
      )}
      {reading && (
        <>
          {Object.keys(reading.fields ?? {}).length > 0 && (
            <dl className="kv kv-2 fields">
              {Object.entries(reading.fields).map(([k, v]) => (
                <div className="kv-row" key={k}>
                  <dt>{label(READING_FIELD_KO, k)}</dt>
                  <dd>{fieldText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {reading.problems.length > 0 && (
            <ul className="problems">
              {reading.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {(reading.usage || reading.model) && (
            <div className="usage">
              {reading.model && <span>{t("spend.model", { name: reading.model })}</span>}
              {reading.usage?.tokens !== undefined && <span>{t("spend.tokens", { count: num(reading.usage.tokens) })}</span>}
              {reading.usage?.cost_usd !== undefined && <span>{t("spend.cost", { amount: usd(reading.usage.cost_usd) })}</span>}
              {reading.usage?.recorded_cost_usd !== undefined && reading.usage.cached && (
                <span>{t("spend.recordedCost", { amount: usd(reading.usage.recorded_cost_usd) })}</span>
              )}
              {reading.usage?.seconds !== undefined && <span>{t("spend.seconds", { n: reading.usage.seconds.toFixed(1) })}</span>}
              {reading.usage?.cached && <Chip tone="muted">{t("spend.cached")}</Chip>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChainLine({ view, expenseId }: { view: ProjectView; expenseId: string }) {
  const { t } = useTranslation()
  const rec = view.chain?.expenses?.[expenseId]
  if (!view.chain?.enabled || !rec) return null
  const explorer = view.chain.explorer || "https://sepolia.basescan.org"
  const links = [
    [t("project.chainDecision"), rec.recordTx],
    [t("project.chainHold"), rec.approveTx],
    [t("project.chainReject"), rec.rejectTx],
    [t("project.chainRelease"), rec.releaseTx],
  ] as const
  return (
    <div className="settlement small">
      <span className="muted">Base Sepolia</span>
      {links.map(([labelText, hash]) =>
        hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (
          <a key={labelText} href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
            {labelText} {shortHash(hash, 6, 4)}
          </a>
        ) : null,
      )}
      {rec.error && <span>{rec.error}</span>}
    </div>
  )
}
