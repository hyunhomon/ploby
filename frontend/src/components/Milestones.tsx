// 마일스톤: funded work payments (ADR 0009). Each card shows the units and criteria agreed
// before work began, the submission, the running clocks and what silence does.

import { kst, kstDate, won } from "../format"
import {
  FINAL_MILESTONE,
  MILESTONE_STATUS,
  MILESTONE_TONE,
  REASON_CODE,
  UNIT_STATUS,
  UNIT_TONE,
  label,
  toneOf,
} from "../labels"
import type { Milestone, ProjectView } from "../types"
import { MilestoneReceiptButton } from "./Onchain"
import { Act, deadlinesFor } from "./projectCtx"
import { Banner, Card, Chip, DocLink, Empty, Money, When } from "./ui"

export function MilestonesSection({ view }: { view: ProjectView }) {
  const list = [...view.milestones].sort(
    (a, b) => Number(FINAL_MILESTONE.has(a.status)) - Number(FINAL_MILESTONE.has(b.status)),
  )
  return (
    <Card title="작업과 대금" id="sec-milestones" sub="작업을 선택하면 납품 내역과 검수 조건을 볼 수 있어요.">
      {list.length === 0 && <Empty>아직 마일스톤이 없습니다.</Empty>}
      <div className="stack">
        {list.map((m) => (
          <MilestoneCard key={m.id} m={m} view={view} />
        ))}
      </div>
    </Card>
  )
}

function MilestoneCard({ m, view }: { m: Milestone; view: ProjectView }) {
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
            <span className="muted small">착수 기한</span> {kst(m.start_by, now)}
          </span>
          <span>
            <span className="muted small">납기</span> {kst(m.due_at, now)}
          </span>
          <span>
            <span className="muted small">유예 종료</span> {kst(m.grace_until, now)}
          </span>
        </div>

        {role === "contractor" && m.status === "FUNDED_AND_RESERVED" && (
          <Banner tone="ok" title="작업비 예약 완료 — 착수해도 지급이 보장됩니다">
            {won(m.amount)}이 이 마일스톤에 예약되어 있습니다. {kstDate(m.start_by, now)}까지 착수하지 않으면 예약이
            풀립니다.
          </Banner>
        )}
        {m.status === "PLANNED" && (
          <Banner tone="info">서명은 끝났지만 아직 입금·예약되지 않았습니다. PLANNED는 착수 허가가 아닙니다.</Banner>
        )}

        <div className="table-wrap">
          <table className="table units">
            <thead>
              <tr>
                <th>납품 단위</th>
                <th>인수 기준</th>
                <th className="r">금액</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {m.units.map((u) => (
                <tr key={u.id} className={claimed.has(u.id) ? "row-claimed" : undefined}>
                  <td data-h="납품 단위">
                    <strong>{u.title}</strong>
                  </td>
                  <td data-h="인수 기준">
                    <ul className="criteria">
                      {u.criteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </td>
                  <td data-h="금액" className="r">
                    <Money n={u.amount} />
                  </td>
                  <td data-h="상태">
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
            <h4>제출 통지</h4>
            <div className="muted small">
              {kst(m.submission.at, now)} 제출 · 청구한 납품 단위 {m.submission.units.length}개 · 이 시각부터 검수
              기한이 흐릅니다
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
            <h4>이의 제기</h4>
            <ul className="objections">
              {m.objections.map((o, i) => (
                <li key={i}>
                  <strong>{m.units.find((u) => u.id === o.unit)?.title ?? o.unit}</strong>
                  {o.reason_code && <Chip tone="warn">{label(REASON_CODE, o.reason_code)}</Chip>}
                  <span className="muted small"> · 인수 기준: </span>
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
                title="클라이언트 검수 기한"
                at={m.review_deadline}
                now={now}
                fallback={fallbackFor(m.review_deadline) ?? "제출된 납품 단위가 지급됩니다 (RELEASED_BY_TIMEOUT)"}
              />
            )}
            {m.resolver_deadline && (m.status === "DISPUTED" || m.status === "NON_DELIVERY") && (
              <Clock
                title="분쟁 해결 기한"
                at={m.resolver_deadline}
                now={now}
                fallback={
                  fallbackFor(m.resolver_deadline) ??
                  (m.status === "NON_DELIVERY"
                    ? "미제출 단위는 거절되고 예약이 반환됩니다"
                    : "이의가 제기된 단위가 지급됩니다 (결함이 증명되지 않음)")
                }
              />
            )}
          </div>
        )}
        {clocks
          .filter((d) => d.at !== m.review_deadline && d.at !== m.resolver_deadline)
          .map((d, i) => (
            <div className="clocks" key={i}>
              <Clock title={d.label} at={d.at} now={now} fallback={d.fallback} />
            </div>
          ))}

        {(m.paid > 0 || m.returned > 0) && (
          <div className="totals">
            <span>
              지급 <Money n={m.paid} />
            </span>
            <span>
              예약 반환 <Money n={m.returned} />
            </span>
            <MilestoneReceiptButton m={m} view={view} />
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
  return (
    <div className="clock">
      <div className="clock-head">
        <span className="clock-title">{title}</span>
        <When at={at} now={now} />
      </div>
      {fallback && <div className="clock-fallback">침묵 시: {fallback}</div>}
    </div>
  )
}
