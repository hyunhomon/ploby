// 정책: the active version and every PROPOSED version, with signatures, rules, milestones and
// the fallbacks table (what silence does) shown before the sign button.

import { duration, kst, kstDate, when, won } from "../format"
import { POLICY_KIND, POLICY_STATUS, POLICY_TONE, RULES_SOURCE, EXPRESSION_KO, label, toneOf } from "../labels"
import type { PolicyView, ProjectView, Signature } from "../types"
import { actionLabel, findAction, useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, Empty, Money, useApp, vendorName } from "./ui"

export function PolicyCard({ view }: { view: ProjectView }) {
  const active = view.policy
  const proposals = view.proposals
  return (
    <Card
      title="정책"
      id="sec-policy"
      sub="클라이언트와 작업자가 같은 정책 해시에 서명해야 효력이 생깁니다. 변경은 새 버전으로만 합니다."
      aside={active ? <Chip tone="ok">v{active.version} 적용 중</Chip> : <Chip tone="warn">서명 전</Chip>}
    >
      {proposals.map((p, i) => (
        <PolicyBlock key={`p${p.version}`} p={p} base={active} first={i === 0} open />
      ))}
      {active &&
        (proposals.length > 0 ? (
          <details className="policy-fold">
            <summary>현재 적용 중인 v{active.version} 보기</summary>
            <PolicyBlock p={active} base={null} first={false} open />
          </details>
        ) : (
          <PolicyBlock p={active} base={null} first={false} open />
        ))}
      {!active && proposals.length === 0 && <Empty>정책이 없습니다.</Empty>}
      {view.versions.length > 0 && <VersionHistory view={view} />}
    </Card>
  )
}

function SignatureLine({ who, sig, now }: { who: string; sig: Signature | null; now: number }) {
  return (
    <div className={`sig ${sig ? "sig-done" : "sig-wait"}`}>
      <span className="sig-mark" aria-hidden>
        {sig ? "✓" : "…"}
      </span>
      <span className="sig-who">{who}</span>
      <span className="sig-state">{sig ? kst(sig.at, now) : "서명 대기"}</span>
    </div>
  )
}

function Delta({ now, base }: { now: number; base: number | undefined }) {
  if (base === undefined || base === now) return null
  const d = now - base
  return <span className={`delta ${d > 0 ? "delta-up" : "delta-down"}`}>{d > 0 ? `+${won(d)}` : `−${won(-d)}`}</span>
}

function PolicyBlock({ p, base, first, open }: { p: PolicyView; base: PolicyView | null; first: boolean; open: boolean }) {
  const { view, open: openAction, busy } = useProject()
  const { meta } = useApp()
  const now = view.now
  const proposed = p.status === "PROPOSED"
  const sign =
    proposed &&
    (findAction(view, "sign_policy", { kind: "policy", id: p.version }) ?? (first ? findAction(view, "sign_policy", null) : undefined))
  const s = p.summary
  const b = base?.summary
  const cmp = proposed && base ? b : undefined
  const mySig = view.viewer.role === "client" ? p.signatures.client : view.viewer.role === "contractor" ? p.signatures.contractor : null

  return (
    <article className={`policy ${proposed ? "policy-proposed" : ""}`} data-open={open}>
      <header className="policy-head">
        <div className="policy-title">
          <strong>v{p.version}</strong>
          <Chip tone={toneOf(POLICY_TONE, p.status)}>{label(POLICY_STATUS, p.status)}</Chip>
          <Chip tone="muted">{label(POLICY_KIND, p.kind)}</Chip>
        </div>
        <div className="policy-hash">
          <span className="muted small">해시</span> <CopyHash hash={p.hash} />
          {p.previous_hash && (
            <>
              <span className="muted small"> · 이전</span> <CopyHash hash={p.previous_hash} head={6} />
            </>
          )}
        </div>
      </header>

      <div className="sigs">
        <SignatureLine who={`클라이언트 ${view.parties.client.name}`} sig={p.signatures.client} now={now} />
        <SignatureLine who={`작업자 ${view.parties.contractor.name}`} sig={p.signatures.contractor} now={now} />
      </div>

      <section className="policy-sec">
        <h3>예산과 기간</h3>
        <dl className="kv kv-2">
          <div className="kv-row">
            <dt>프로젝트 예산</dt>
            <dd>
              <Money n={s.project_budget} /> {cmp && <Delta now={s.project_budget} base={cmp.project_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>마일스톤 예산</dt>
            <dd>
              <Money n={s.milestone_budget} /> {cmp && <Delta now={s.milestone_budget} base={cmp.milestone_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>경비 예산</dt>
            <dd>
              <Money n={s.expense_budget} /> {cmp && <Delta now={s.expense_budget} base={cmp.expense_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>초기 입금액</dt>
            <dd>
              <Money n={s.initial_funding} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>기간</dt>
            <dd>
              {s.starts_at ? kstDate(s.starts_at, now) : "활성화 시"} ~ {kstDate(s.ends_at, now)}
            </dd>
          </div>
        </dl>
        <dl className="kv kv-4 periods">
          <div className="kv-row">
            <dt>클라이언트 검토</dt>
            <dd>{duration(s.client_review_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>분쟁 해결</dt>
            <dd>{duration(s.resolver_review_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>증빙 제출</dt>
            <dd>{duration(s.evidence_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>경비 예약 유지</dt>
            <dd>{duration(s.reservation_seconds)}</dd>
          </div>
        </dl>
      </section>

      <section className="policy-sec">
        <h3>
          경비 규칙 <Chip tone="muted">{label(RULES_SOURCE, p.rules.source)}으로 작성</Chip>
        </h3>
        {p.rules.source === "words" && p.rules.words && (
          <blockquote className="words">
            <span className="muted small">원문</span>
            <p>{p.rules.words}</p>
          </blockquote>
        )}
        {p.rules.readback.length > 0 && (
          <ul className="readback">
            {p.rules.readback.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <div className="rule-facts">
          {p.rules.vendors.length > 0 && (
            <div>
              <span className="muted small">허용 공급자</span>
              <div className="chips">
                {p.rules.vendors.map((v) => (
                  <Chip key={v} tone="info">
                    {vendorName(meta, v)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <div className="rule-nums">
            {p.rules.max_per_purchase !== null && (
              <span>
                <span className="muted small">건별 한도</span> <Money n={p.rules.max_per_purchase} />
              </span>
            )}
            {p.rules.until !== null && (
              <span>
                <span className="muted small">사용 기한</span> {when(p.rules.until, now)}
              </span>
            )}
          </div>
          {p.rules.category_budgets && Object.keys(p.rules.category_budgets).length > 0 && (
            <div>
              <span className="muted small">카테고리별 예산</span>
              <div className="chips">
                {Object.entries(p.rules.category_budgets).map(([k, v]) => (
                  <Chip key={k} tone="muted">
                    {meta?.categories?.find((c) => c.id === k)?.name_ko ?? k} {won(v)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
        {Object.keys(p.rules.expressions ?? {}).length > 0 && (
          <details className="mini-fold">
            <summary>규칙 식 · 위임 해시</summary>
            <table className="table compact">
              <tbody>
                {Object.entries(p.rules.expressions).map(([k, v]) => (
                  <tr key={k}>
                    <th>{label(EXPRESSION_KO, k)}</th>
                    <td>
                      <code>{v}</code>
                    </td>
                  </tr>
                ))}
                <tr>
                  <th>위임 해시</th>
                  <td>
                    <CopyHash hash={p.rules.mandate_hash} />
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="policy-sec">
        <h3>마일스톤</h3>
        {p.milestones.length === 0 && <p className="muted small">마일스톤 없음</p>}
        <ol className="pms">
          {p.milestones.map((m) => {
            const isNew = proposed && base && !base.milestones.some((x) => x.id === m.id)
            return (
              <li key={m.id} className="pm">
                <div className="pm-head">
                  <strong>{m.title}</strong>
                  {isNew && <Chip tone="accent">추가</Chip>}
                  <Money n={m.amount} className="pm-amt" />
                </div>
                <div className="muted small">
                  착수 기한 {kstDate(m.start_by, now)} · 납기 {kstDate(m.due_at, now)} · 유예 {kstDate(m.grace_until, now)}까지
                </div>
                <ul className="pm-units">
                  {m.units.map((u) => (
                    <li key={u.id}>
                      <div className="pm-unit-head">
                        <span>{u.title}</span>
                        <Money n={u.amount} />
                      </div>
                      <ul className="criteria">
                        {u.criteria.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="policy-sec">
        <h3>침묵 시 결과 (최종 대체 결과)</h3>
        <p className="muted small">응답하지 않아도 일이 멈추지 않습니다. 기한이 지나면 아래 결과가 자동으로 적용됩니다. 서명 전에 확인하세요.</p>
        <FallbackTable p={p} />
      </section>

      {proposed && (
        <div className="sign-box">
          {sign ? (
            <>
              <p className="small">
                서명하면 v{p.version}의 해시 <CopyHash hash={p.hash} />에 동의합니다. 위의 침묵 시 결과에도 함께 동의하게 됩니다.
              </p>
              <button type="button" className="btn btn-primary btn-attn" disabled={busy} onClick={() => openAction(sign)}>
                {actionLabel(sign)}
              </button>
            </>
          ) : mySig ? (
            <p className="small">
              <strong>서명 완료.</strong> 상대방의 서명을 기다리고 있습니다.
            </p>
          ) : view.viewer.role === "resolver" ? (
            <p className="muted small">분쟁 해결자는 정책에 서명하지 않습니다. 양측이 서명한 기준과 금액 한도 안에서만 판단합니다.</p>
          ) : (
            <p className="muted small">지금은 서명할 수 없습니다.</p>
          )}
          {p.kind === "change_order" && (
            <Banner tone="info">두 당사자가 서명한 뒤, 클라이언트가 추가 금액을 입금해야 새 마일스톤이 예약됩니다. 기존 약정은 원래 정책 버전을 그대로 따릅니다.</Banner>
          )}
        </div>
      )}

      <details className="mini-fold">
        <summary>정책 원문 (해시 대상 문서)</summary>
        <pre className="doc-text">{JSON.stringify(p.doc, null, 2)}</pre>
      </details>
    </article>
  )
}

export function FallbackTable({ p }: { p: PolicyView }) {
  if (p.fallbacks.length === 0) return <p className="muted small">정의된 기본 결과가 없습니다.</p>
  return (
    <div className="table-wrap">
      <table className="table fallbacks">
        <thead>
          <tr>
            <th>상황</th>
            <th>침묵하면</th>
            <th>분쟁 해결자도 침묵하면</th>
          </tr>
        </thead>
        <tbody>
          {p.fallbacks.map((f, i) => (
            <tr key={i}>
              <td data-h="상황">{f.case}</td>
              <td data-h="침묵하면">{f.silence}</td>
              <td data-h="분쟁 해결자도 침묵하면">{f.resolver_silence ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VersionHistory({ view }: { view: ProjectView }) {
  return (
    <details className="policy-fold">
      <summary>버전 기록 ({view.versions.length})</summary>
      <ol className="versions">
        {view.versions.map((v) => (
          <li key={v.version}>
            <div className="version-head">
              <strong>v{v.version}</strong>
              <Chip tone={toneOf(POLICY_TONE, v.status)}>{label(POLICY_STATUS, v.status)}</Chip>
              <span className="muted small">{label(POLICY_KIND, v.kind)}</span>
              <CopyHash hash={v.hash} />
            </div>
            <div className="muted small">
              클라이언트 {v.signatures.client ? kst(v.signatures.client.at, view.now) : "미서명"} · 작업자{" "}
              {v.signatures.contractor ? kst(v.signatures.contractor.at, view.now) : "미서명"} · 예산 {won(v.summary.project_budget)}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}
