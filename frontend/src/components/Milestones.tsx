// 마일스톤: funded work payments (ADR 0009). Each card shows the units and criteria agreed
// before work began, the submission, the running clocks and what silence does.

import { useTranslation } from "react-i18next"
import { kst, kstDate, won } from "../format"
import {
  FINAL_MILESTONE,
  MILESTONE_STATUS,
  MILESTONE_TONE,
  REASON_CODE,
  UNIT_STATUS,
  UNIT_TONE,
  caption,
  label,
  toneOf,
} from "../labels"
import type { Milestone, ProjectView } from "../types"
import { Act, deadlinesFor } from "./projectCtx"
import { Banner, Card, Chip, DocLink, Empty, Money, When } from "./ui"

export function MilestonesSection({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const list = [...view.milestones].sort(
    (a, b) => Number(FINAL_MILESTONE.has(a.status)) - Number(FINAL_MILESTONE.has(b.status)),
  )
  return (
    <Card title={t("work.title")} id="sec-milestones" sub={t("work.sub")}>
      <p className="muted small">{t("project.offChainMoney")}</p>
      {list.length === 0 && <Empty>{t("work.empty")}</Empty>}
      <div className="stack">
        {list.map((m) => (
          <MilestoneCard key={m.id} m={m} view={view} />
        ))}
      </div>
    </Card>
  )
}

function MilestoneCard({ m, view }: { m: Milestone; view: ProjectView }) {
  const { t } = useTranslation()
  const now = view.now
  const target = { kind: "milestone" as const, id: m.id }
  const clocks = deadlinesFor(view, target)
  const fallbackFor = (at: number | null) => clocks.find((d) => d.at === at)?.fallback ?? null
  const final = FINAL_MILESTONE.has(m.status)
  const claimed = new Set(m.submission?.units ?? [])
  const role = view.viewer.role

  return (
    <details className={`item record ${final ? "item-final" : ""}`} id={`milestone-${m.id}`}>
      <summary className="item-head record-summary">
        <div className="item-title">
          <h3>{m.title}</h3>
          <Chip tone={toneOf(MILESTONE_TONE, m.status)}>{label(MILESTONE_STATUS, m.status)}</Chip>
          <span className="muted small">v{m.version}</span>
        </div>
        <Money n={m.amount} className="item-amt" />
      </summary>
      <div className="record-body">
        <div className="dates">
          <span>
            <span className="muted small">{t("work.startBy")}</span> {kst(m.start_by, now)}
          </span>
          <span>
            <span className="muted small">{t("work.due")}</span> {kst(m.due_at, now)}
          </span>
          <span>
            <span className="muted small">{t("work.graceEnd")}</span> {kst(m.grace_until, now)}
          </span>
        </div>

        {role === "contractor" && m.status === "FUNDED_AND_RESERVED" && (
          <Banner tone="ok" title={t("work.reservedTitle")}>
            {t("work.reservedBody", { amount: won(m.amount), date: kstDate(m.start_by, now) })}
          </Banner>
        )}
        {m.status === "PLANNED" && <Banner tone="info">{t("work.planned")}</Banner>}

        <div className="table-wrap">
          <table className="table units">
            <thead>
              <tr>
                <th>{t("work.unit")}</th>
                <th>{t("work.criteria")}</th>
                <th className="r">{t("work.amount")}</th>
                <th>{t("work.status")}</th>
              </tr>
            </thead>
            <tbody>
              {m.units.map((u) => (
                <tr key={u.id} className={claimed.has(u.id) ? "row-claimed" : undefined}>
                  <td data-h={t("work.unit")}>
                    <strong>{u.title}</strong>
                  </td>
                  <td data-h={t("work.criteria")}>
                    <ul className="criteria">
                      {u.criteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </td>
                  <td data-h={t("work.amount")} className="r">
                    <Money n={u.amount} />
                  </td>
                  <td data-h={t("work.status")}>
                    <Chip tone={toneOf(UNIT_TONE, u.status)}>{label(UNIT_STATUS, u.status)}</Chip>
                    {u.reason && <div className="muted small">{u.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {m.submission && (
          <section className="sub-block">
            <h4>{t("work.submission")}</h4>
            <div className="muted small">
              {t("work.submitted", { when: kst(m.submission.at, now), count: m.submission.units.length })}
            </div>
            <div className="chips">
              {m.submission.units.map((id) => (
                <Chip key={id} tone="warn">
                  {m.units.find((u) => u.id === id)?.title ?? id}
                </Chip>
              ))}
            </div>
            {m.submission.note && <p className="note">{m.submission.note}</p>}
            {m.submission.documents.length > 0 && (
              <div className="docs">
                {m.submission.documents.map((d) => (
                  <DocLink key={d.id} doc={d} />
                ))}
              </div>
            )}
          </section>
        )}

        {m.objections.length > 0 && (
          <section className="sub-block">
            <h4>{t("work.objections")}</h4>
            <ul className="objections">
              {m.objections.map((o, i) => (
                <li key={i}>
                  <strong>{m.units.find((u) => u.id === o.unit)?.title ?? o.unit}</strong>
                  {o.reason_code && <Chip tone="warn">{label(REASON_CODE, o.reason_code)}</Chip>}
                  <span className="muted small"> · {t("work.criterion")} </span>
                  <span>{o.criterion}</span>
                  {o.at && <span className="muted small"> · {kst(o.at, now)}</span>}
                  <div className="note">{o.reason}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(m.review_deadline || m.resolver_deadline) && (
          <div className="clocks">
            {m.review_deadline && m.status === "DELIVERED" && (
              <Clock
                title={t("work.clientReview")}
                at={m.review_deadline}
                now={now}
                fallback={fallbackFor(m.review_deadline) ?? t("work.reviewFallback")}
              />
            )}
            {m.resolver_deadline && (m.status === "DISPUTED" || m.status === "NON_DELIVERY") && (
              <Clock
                title={t("work.resolverDeadline")}
                at={m.resolver_deadline}
                now={now}
                fallback={
                  fallbackFor(m.resolver_deadline) ??
                  (m.status === "NON_DELIVERY" ? t("work.nonDelivery") : t("work.objectedPays"))
                }
              />
            )}
          </div>
        )}
        {clocks
          .filter((d) => d.at !== m.review_deadline && d.at !== m.resolver_deadline)
          .map((d, i) => (
            <div className="clocks" key={i}>
              <Clock title={caption(d.label)} at={d.at} now={now} fallback={d.fallback} />
            </div>
          ))}

        {(m.paid > 0 || m.returned > 0) && (
          <div className="totals">
            <span>
              {t("work.paid")} <Money n={m.paid} />
            </span>
            <span>
              {t("work.returned")} <Money n={m.returned} />
            </span>
          </div>
        )}

        <div className="item-actions">
          <Act name="start_milestone" target={target} variant="primary" />
          <Act name="submit_delivery" target={target} variant="primary" />
          <Act name="review_delivery" target={target} variant="primary" />
          <Act name="resolve_milestone" target={target} variant="primary" />
          <Act name="cancel_milestone" target={target} variant="ghost" />
        </div>
      </div>
    </details>
  )
}

export function Clock({
  title,
  at,
  now,
  fallback,
}: {
  title: string
  at: number
  now: number
  fallback: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="clock">
      <div className="clock-head">
        <span className="clock-title">{caption(title)}</span>
        <When at={at} now={now} />
      </div>
      {fallback && <div className="clock-fallback">{t("activity.silence", { fallback: caption(fallback) })}</div>}
    </div>
  )
}
