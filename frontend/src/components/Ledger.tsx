// 자금 현황: where the funded money is (ADR 0004). The bar spans the larger of the budget
// and the funded amount; every funded won is in exactly one of reserved / paid / refunded /
// available.

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
  const l: LedgerT = view.ledger
  const role = view.viewer.role
  const unfunded = Math.max(l.budget - l.funded, 0)
  const scale = Math.max(l.budget, l.funded, 1)
  const segs: Seg[] = [
    { key: "mr", label: "마일스톤 예약", value: l.milestone_reserved, cls: "seg-ms" },
    { key: "er", label: "경비 예약", value: l.expense_reserved, cls: "seg-ex" },
    { key: "rel", label: "지급", value: l.released, cls: "seg-paid", note: `작업비 ${won(l.milestone_released)} · 경비 ${won(l.expense_released)}` },
    { key: "ref", label: "환불", value: l.refunded, cls: "seg-refund" },
    { key: "av", label: "가용", value: l.available, cls: "seg-avail", note: "새 약정 또는 종료 환불에 쓸 수 있는 금액" },
  ]
  const bar = [...segs, { key: "un", label: "미입금", value: unfunded, cls: "seg-unfunded" }]

  return (
    <Card title="자금 현황" id="sec-ledger" sub={<>예치금 <strong className="num">{won(l.funded)}</strong> / 프로젝트 예산 {won(l.budget)}</>}>
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
            <i className="dot seg-funded" /> 예치
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
              <i className="dot seg-unfunded" /> 미입금 (예산 − 예치)
            </span>
            <Money n={unfunded} />
          </li>
        )}
      </ul>

      <div className="capacity">
        <Capacity title="경비 예산" total={l.expense_budget} left={l.expense_capacity} />
        <Capacity title="마일스톤 예산" total={l.milestone_budget} left={l.milestone_capacity} />
      </div>

      <details className="mini-fold">
        <summary>회계 식</summary>
        <p className="formula">
          가용 = 예치 − 경비 예약 − 마일스톤 예약 − 지급 − 환불 − 이전
          <br />
          <span className="num">
            {won(l.available)} = {won(l.funded)} − {won(l.expense_reserved)} − {won(l.milestone_reserved)} − {won(l.released)} − {won(l.refunded)} − {won(l.migrated_out ?? 0)}
          </span>
        </p>
        <dl className="kv">
          <div className="kv-row">
            <dt>새 에스크로로 이전 (migrated_out)</dt>
            <dd>
              <Money n={l.migrated_out ?? 0} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>입금 필요액 (funding_needed)</dt>
            <dd>
              <Money n={l.funding_needed ?? 0} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>추가 입금 가능액 (deposit_room)</dt>
            <dd>
              <Money n={l.deposit_room} />
            </dd>
          </div>
        </dl>
      </details>

      {role === "contractor" && l.milestone_reserved > 0 && (
        <Banner tone="ok" title={<>작업비 {won(l.milestone_reserved)} 예약 완료</>}>
          예약된 작업비는 클라이언트가 혼자 되돌릴 수 없습니다. 착수해도 지급이 보장되며, 검수 기한까지 침묵하면 제출 단위가 지급됩니다.
        </Banner>
      )}
      {role === "contractor" && l.expense_capacity > 0 && view.status === "ACTIVE" && (
        <p className="muted small">구매 전에 약정을 요청하면 경비 예산 잔여({won(l.expense_capacity)}) 안에서 최대 정산액이 먼저 예약됩니다.</p>
      )}
      {role === "client" && (l.funding_needed ?? l.deposit_room) > 0 && (
        <Banner tone="warn" title={<>입금 필요 {won(l.funding_needed ?? l.deposit_room)}</>}>
          {view.status === "DRAFT"
            ? "양측이 서명하고 초기 자금이 입금되면 프로젝트가 시작되고 모든 마일스톤 금액이 예약됩니다."
            : "서명된 변경 주문의 마일스톤은 입금으로 가용 잔액이 충분해질 때 예약됩니다."}
        </Banner>
      )}
      {role === "client" && (view.status === "CLOSING" || view.status === "CANCELLED") && l.available > 0 && (
        <p className="muted small">예약되지 않은 가용 잔액 {won(l.available)}만 환불받을 수 있습니다. 예약된 금액은 기존 약정이 끝날 때까지 남습니다.</p>
      )}
    </Card>
  )
}

function Capacity({ title, total, left }: { title: string; total: number; left: number }) {
  const used = Math.max(total - left, 0)
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0
  return (
    <div className="cap">
      <div className="cap-head">
        <span>{title}</span>
        <span className="num small">
          잔여 <strong>{won(left)}</strong> / {won(total)}
        </span>
      </div>
      <div className="cap-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
