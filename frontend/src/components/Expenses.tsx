// 경비: purchase commitments and retroactive requests (ADR 0005, PROJECT_OVERVIEW.md §5.3,
// §6). Each card shows the rules that decided it in decision order, what the AI read from the
// documents, the clocks and what silence does.

import { kst, num, usd, won } from "../format"
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
  const active = view.expenses.filter((e) => !FINAL_EXPENSE.has(e.status))
  const done = view.expenses.filter((e) => FINAL_EXPENSE.has(e.status))
  return (
    <Card
      title="경비"
      id="sec-expenses"
      sub="항목을 선택하면 구매 약정과 정산 내역을 볼 수 있어요."
      aside={
        <div className="row-wrap">
          <Act name="request_commitment" variant="primary">
            구매 약정 요청
          </Act>
          <Act name="retroactive_request" variant="ghost">
            사후 청구
          </Act>
        </div>
      }
    >
      {view.expenses.length === 0 && <Empty>아직 경비 요청이 없습니다.</Empty>}
      <div className="stack">
        {active.map((e) => (
          <ExpenseCard key={e.id} e={e} view={view} />
        ))}
      </div>
      {done.length > 0 && (
        <details className="policy-fold" open={active.length === 0}>
          <summary>끝난 경비 {done.length}건</summary>
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

function clockRows(e: Expense): { title: string; at: number | null; fallback: string }[] {
  const nonWaivable = !!e.hold_class && NON_WAIVABLE_HOLD.has(e.hold_class)
  switch (e.status) {
    case "HOLD_REVIEW":
      return [{ title: "클라이언트 응답 기한", at: e.review_deadline, fallback: "만료됩니다 (약속된 것이 없음)" }]
    case "RETRO_REVIEW":
      return [
        {
          title: "클라이언트 응답 기한",
          at: e.review_deadline,
          fallback: "거절됩니다 (침묵만으로 지급 권리가 생기지 않음)",
        },
      ]
    case "RESERVED":
      return [
        { title: "예약 만료", at: e.expires_at, fallback: "구매 보고가 없으면 예약이 만료되고 예산으로 돌아갑니다" },
      ]
    case "SPEND_REPORTED":
      return [
        {
          title: "증빙 제출 기한",
          at: e.evidence_deadline,
          fallback: "증빙 결함(EVIDENCE_DEFECT)으로 분쟁 해결에 넘어갑니다",
        },
      ]
    case "EVIDENCE_SUBMITTED":
      return [
        {
          title: "클라이언트 정산 검토 기한",
          at: e.review_deadline,
          fallback: nonWaivable
            ? "분쟁 해결로 넘어갑니다 (ESCALATED_BY_TIMEOUT)"
            : "청구액이 약정 한도 안에서 지급됩니다 (RELEASED_BY_TIMEOUT)",
        },
      ]
    case "DISPUTED":
      return [
        {
          title: "분쟁 해결 기한",
          at: e.resolver_deadline,
          fallback: e.hold_class ? label(HOLD_RESOLVER_SILENCE, e.hold_class) : "사전 합의된 결과가 적용됩니다",
        },
      ]
    default:
      return []
  }
}

function ExpenseCard({ e, view }: { e: Expense; view: ProjectView }) {
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
              <span className="muted">카테고리</span> {e.category_ko}
            </span>
          )}
          {e.payment_mode && (
            <span>
              <span className="muted">결제 방식</span> {label(PAYMENT_MODE, e.payment_mode)}
            </span>
          )}
          {e.payee && (
            <span>
              <span className="muted">수취인</span> <CopyHash hash={e.payee} head={6} tail={4} />
              {payeeIsContractor && <span className="muted"> (작업자)</span>}
            </span>
          )}
          {e.assurance && (
            <span title={label(ASSURANCE, e.assurance)}>
              <span className="muted">증빙 수준</span> {label(ASSURANCE, e.assurance)}
            </span>
          )}
        </div>

        {e.out_of_scope && (
          <Banner tone="bad" title="범위 밖 (OUT_OF_SCOPE)">
            허용된 공급자·카테고리 목록에 없어 BLOCK 되었습니다. 의무는 생기지 않았습니다. 필요하면 변경 주문으로 정책을
            바꾸고, 양측 서명과 입금 뒤에만 약정할 수 있습니다.
            {draftCo && (
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    open(draftCo, {
                      text: `${e.vendor_name ?? e.vendor ?? ""} ${e.item ?? ""} 구매를 프로젝트 경비로 허용해 주세요.`
                        .replace(/\s+/g, " ")
                        .trim(),
                    })
                  }
                >
                  이 항목으로 변경 주문 초안
                </button>
              </div>
            )}
          </Banner>
        )}

        <div className="amounts">
          {e.quote && (
            <Amt
              label={e.kind === "RETROACTIVE" ? "청구 합계" : "견적 합계"}
              n={e.quote.total}
              hint={`공급가 ${num(e.quote.amount)} + 부가세·수수료 ${num(e.quote.fee)}`}
            />
          )}
          <Amt label="약정 한도" n={e.maximum} />
          <Amt label="예약 중" n={e.reserved} tone={e.reserved > 0 ? "info" : undefined} />
          <Amt label="지급" n={e.paid} tone={e.paid > 0 ? "ok" : undefined} />
          {e.receipt && (
            <Amt
              label="영수증 청구"
              n={e.receipt.claimed}
              hint={e.receipt.eligible !== null ? `적격 ${won(e.receipt.eligible)}` : undefined}
            />
          )}
          {e.excess > 0 && <Amt label="초과분" n={e.excess} tone="bad" />}
          {(e.excess_paid ?? 0) > 0 && (
            <Amt label="초과분 지급" n={e.excess_paid ?? 0} tone="ok" hint="변경 주문으로 지급" />
          )}
        </div>

        {e.excess > 0 && (
          <Banner tone="warn" title={`초과분 ${won(e.excess)}은 자동 지급되지 않습니다`}>
            약정된 금액은 먼저 지급되고, 초과분은 양측이 서명한 변경 주문으로만 지급할 수 있습니다.
            <div className="banner-actions">
              {excessCo ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => scrollToAnchor(`change_order-${excessCo.id}`)}
                >
                  초과분 변경 주문 {excessCo.id} 보기
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
                        text: `${e.vendor_name ?? e.vendor ?? ""} ${e.item ?? ""}의 약정 초과분 ${won(e.excess)}을 경비 예산 증액으로 처리해 주세요.`
                          .replace(/\s+/g, " ")
                          .trim(),
                      })
                    }
                  >
                    초과분 변경 주문 초안
                  </button>
                )
              )}
            </div>
          </Banner>
        )}

        {e.kind === "RETROACTIVE" && e.status === "RETRO_REVIEW" && (
          <Banner tone="warn">
            사전 약정 없는 사후 청구(RETROACTIVE_REQUEST)입니다. 클라이언트가 기한까지 승인하지 않으면 지급되지
            않습니다.
          </Banner>
        )}

        {nonWaivable && (
          <Banner tone="warn" title={`${label(HOLD_CLASS, e.hold_class)}: 클라이언트가 면제할 수 없습니다`}>
            필수 증빙·무결성 규칙은 승인으로 덮을 수 없습니다. 클라이언트는 분쟁 해결로 넘길 수 있고, 침묵해도 기한에
            분쟁 해결로 넘어갑니다.
            {e.hold_class === "EVIDENCE_DEFECT" &&
              " 작업자는 증빙을 보완할 수 있지만 어떤 기한도 다시 시작되지 않습니다."}
          </Banner>
        )}

        {e.decision && (
          <div className="decision">
            <span className="muted small">규칙 판정</span>
            <Chip tone={toneOf(DECISION_TONE, e.decision.result)} title={label(DECISION_KO, e.decision.result)}>
              {label(DECISION, e.decision.result)}
            </Chip>
            <span>{label(REASON_KO, e.decision.reason)}</span>
          </div>
        )}

        {e.resolution && (
          <div className="decision">
            <span className="muted small">분쟁 해결 결과</span>
            <Chip tone={e.resolution.accept ? "ok" : "bad"}>{e.resolution.accept ? "지급 인정" : "거절"}</Chip>
            <span>{e.resolution.reason}</span>
          </div>
        )}

        {e.settlement && (
          <div className="settlement small">
            <span className="muted">정산</span> <Money n={e.settlement.amount} /> {e.settlement.asset} → 수취인{" "}
            <CopyHash hash={e.settlement.payee} head={6} /> · {kst(e.settlement.at, now)}
          </div>
        )}

        {!final && (
          <div className="clocks">
            {clockRows(e)
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
              <span className="muted">예약 만료</span> {kst(e.expires_at, now)}
            </span>
          )}
          {e.spent_at && (
            <span>
              <span className="muted">구매 보고</span> {kst(e.spent_at, now)}
            </span>
          )}
          {e.receipt && (
            <span>
              <span className="muted">영수증 제출</span> {kst(e.receipt.at, now)}
            </span>
          )}
        </div>

        {e.decision && e.decision.rules.length > 0 && (
          <RulesTable rules={e.decision.rules} open={showRules && !final} />
        )}

        {(e.quote || e.receipt) && (
          <details className="mini-fold">
            <summary>문서와 AI 판독</summary>
            {e.quote && (
              <ReadingBlock
                title={e.kind === "RETROACTIVE" ? "청구 문서" : "견적서"}
                doc={e.quote.document}
                manifest={e.quote.manifest_hash ?? null}
                reading={e.quote.reading}
              />
            )}
            {e.receipt && (
              <ReadingBlock
                title="영수증"
                doc={e.receipt.document}
                manifest={e.receipt.manifest_hash ?? null}
                reading={e.receipt.reading}
              />
            )}
            {e.receipt?.supplements && e.receipt.supplements.length > 0 && (
              <div className="reading">
                <div className="reading-head">
                  <strong>보완 증빙</strong>
                  {e.receipt.supplements.map((d) => (
                    <DocLink key={d.id} doc={d} />
                  ))}
                </div>
                <p className="muted small">보완 제출은 어떤 기한도 다시 시작하지 않습니다.</p>
              </div>
            )}
            <p className="muted small">
              AI는 문서를 읽기만 합니다. 예약·정산 여부는 서명된 정책을 코드가 적용해 정합니다. 문서 속 송금·계좌 지시는
              따르지 않습니다.
            </p>
          </details>
        )}

        <div className="item-actions">
          <ChoiceButtons e={e} name="answer_request" yes="승인" no="거절" />
          <ChoiceButtons e={e} name="review_settlement" yes="승인 (지급)" no="이의 → 분쟁 해결" />
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
  if (r.ok === true) return <Chip tone="ok">통과</Chip>
  if (r.ok === null || r.ok === undefined) return <Chip tone="muted">해당 없음</Chip>
  const k = kindOf(r)
  if (k === "mandatory") return <Chip tone="bad">실패 → BLOCK</Chip>
  if (k === "evidence") return <Chip tone="warn">부족 → HOLD</Chip>
  return <Chip tone="warn">신호 → HOLD</Chip>
}

/** Rules grouped mandatory → evidence → risk, each in the overview's decision order. */
function RulesTable({ rules, open }: { rules: RuleResult[]; open: boolean }) {
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
        규칙 검사 {passed}/{rules.length} 통과
        {failedMandatory > 0 && <span className="sum-bad"> · BLOCK 사유 {failedMandatory}</span>}
        {holdSignals > 0 && <span className="sum-warn"> · HOLD 사유 {holdSignals}</span>}
      </summary>
      <div className="table-wrap">
        <table className="table compact rules">
          <thead>
            <tr>
              <th>규칙</th>
              <th>결과</th>
              <th>내용</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.kind}>
              <tr className="group-row">
                <th colSpan={3}>
                  {label(RULE_KIND, g.kind)}
                  <span className="muted small">
                    {g.kind === "mandatory"
                      ? " · 실패하면 BLOCK"
                      : g.kind === "risk"
                        ? " · 신호는 HOLD만, BLOCK하지 않음"
                        : " · 부족하면 HOLD"}
                  </span>
                </th>
              </tr>
              {g.rows.map((r, i) => (
                <tr
                  key={`${r.rule}-${i}`}
                  className={r.ok === false ? (g.kind === "mandatory" ? "row-fail" : "row-warn") : undefined}
                >
                  <td data-h="규칙">{r.label || label(RULE_KO, r.rule)}</td>
                  <td data-h="결과">
                    <RuleChip r={r} />
                  </td>
                  <td data-h="내용">{r.detail || <span className="muted">—</span>}</td>
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
  if (typeof v === "boolean") return v ? "예" : "아니오"
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
  return (
    <div className="reading">
      <div className="reading-head">
        <strong>{title}</strong>
        <DocLink doc={doc} />
        {reading && (
          <Chip tone={reading.ok ? "ok" : "warn"}>
            {reading.source === "ai" ? "AI 판독" : reading.source === "manual" ? "수동 입력" : "AI 사용 불가"}{" "}
            {reading.ok ? "정상" : "문제 있음"}
          </Chip>
        )}
      </div>
      {manifest && (
        <div className="muted small">
          증빙 매니페스트 해시 <CopyHash hash={manifest} />
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
              {reading.model && <span>모델 {reading.model}</span>}
              {reading.usage?.tokens !== undefined && <span>토큰 {num(reading.usage.tokens)}</span>}
              {reading.usage?.cost_usd !== undefined && <span>비용 {usd(reading.usage.cost_usd)}</span>}
              {reading.usage?.recorded_cost_usd !== undefined && reading.usage.cached && (
                <span>(실행 당시 {usd(reading.usage.recorded_cost_usd)})</span>
              )}
              {reading.usage?.seconds !== undefined && <span>{reading.usage.seconds.toFixed(1)}초</span>}
              {reading.usage?.cached && <Chip tone="muted">캐시</Chip>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
