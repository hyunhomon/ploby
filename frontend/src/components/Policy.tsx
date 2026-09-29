// 정책: the active version and every PROPOSED version, with signatures, rules, milestones and
// the fallbacks table (what silence does) shown before the sign button.

import { useTranslation } from "react-i18next"
import { duration, kst, kstDate, when, won } from "../format"
import { POLICY_KIND, POLICY_STATUS, POLICY_TONE, ROLE_KO, RULES_SOURCE, EXPRESSION_KO, caption, label, toneOf } from "../labels"
import type { PolicyView, ProjectView, Signature } from "../types"
import { actionLabel, findAction, useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, Empty, Money, useApp, vendorName } from "./ui"

export function PolicyCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const active = view.policy
  const proposals = view.proposals
  return (
    <Card
      title={t("contract.title")}
      id="sec-policy"
      sub={t("contract.sub")}
      aside={active ? <Chip tone="ok">{t("contract.inForce", { version: active.version })}</Chip> : <Chip tone="warn">{t("contract.beforeSign")}</Chip>}
    >
      {proposals.map((p, i) => (
        <PolicyBlock key={`p${p.version}`} p={p} base={active} first={i === 0} open />
      ))}
      {active &&
        (proposals.length > 0 ? (
          <details className="policy-fold">
            <summary>{t("contract.viewActive", { version: active.version })}</summary>
            <PolicyBlock p={active} base={null} first={false} open />
          </details>
        ) : (
          <PolicyBlock p={active} base={null} first={false} open />
        ))}
      {!active && proposals.length === 0 && <Empty>{t("contract.empty")}</Empty>}
      {view.versions.length > 0 && <VersionHistory view={view} />}
    </Card>
  )
}

function SignatureLine({ who, sig, now }: { who: string; sig: Signature | null; now: number }) {
  const { t } = useTranslation()
  return (
    <div className={`sig ${sig ? "sig-done" : "sig-wait"}`}>
      <span className="sig-mark" aria-hidden>
        {sig ? "✓" : "…"}
      </span>
      <span className="sig-who">{who}</span>
      <span className="sig-state">{sig ? kst(sig.at, now) : t("contract.awaiting")}</span>
    </div>
  )
}

function Delta({ now, base }: { now: number; base: number | undefined }) {
  if (base === undefined || base === now) return null
  const d = now - base
  return <span className={`delta ${d > 0 ? "delta-up" : "delta-down"}`}>{d > 0 ? `+${won(d)}` : `−${won(-d)}`}</span>
}

function PolicyBlock({
  p,
  base,
  first,
  open,
}: {
  p: PolicyView
  base: PolicyView | null
  first: boolean
  open: boolean
}) {
  const { t } = useTranslation()
  const { view, open: openAction, busy } = useProject()
  const { meta } = useApp()
  const now = view.now
  const proposed = p.status === "PROPOSED"
  const sign =
    proposed &&
    (findAction(view, "sign_policy", { kind: "policy", id: p.version }) ??
      (first ? findAction(view, "sign_policy", null) : undefined))
  const s = p.summary
  const b = base?.summary
  const cmp = proposed && base ? b : undefined
  const mySig =
    view.viewer.role === "client"
      ? p.signatures.client
      : view.viewer.role === "contractor"
        ? p.signatures.contractor
        : null

  return (
    <article className={`policy ${proposed ? "policy-proposed" : ""}`} data-open={open}>
      <header className="policy-head">
        <div className="policy-title">
          <strong>v{p.version}</strong>
          <Chip tone={toneOf(POLICY_TONE, p.status)}>{label(POLICY_STATUS, p.status)}</Chip>
          <Chip tone="muted">{label(POLICY_KIND, p.kind)}</Chip>
        </div>
        <div className="policy-hash">
          <span className="muted small">{t("contract.hash")}</span> <CopyHash hash={p.hash} />
          {p.previous_hash && (
            <>
              <span className="muted small"> · {t("contract.previous")}</span> <CopyHash hash={p.previous_hash} head={6} />
            </>
          )}
        </div>
      </header>

      <div className="sigs">
        <SignatureLine who={`${label(ROLE_KO, "client")} ${view.parties.client.name}`} sig={p.signatures.client} now={now} />
        <SignatureLine who={`${label(ROLE_KO, "contractor")} ${view.parties.contractor.name}`} sig={p.signatures.contractor} now={now} />
      </div>

      <section className="policy-sec">
        <h3>{t("contract.budgetPeriod")}</h3>
        <dl className="kv kv-2">
          <div className="kv-row">
            <dt>{t("contract.projectBudget")}</dt>
            <dd>
              <Money n={s.project_budget} /> {cmp && <Delta now={s.project_budget} base={cmp.project_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.milestoneBudget")}</dt>
            <dd>
              <Money n={s.milestone_budget} /> {cmp && <Delta now={s.milestone_budget} base={cmp.milestone_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.expenseBudget")}</dt>
            <dd>
              <Money n={s.expense_budget} /> {cmp && <Delta now={s.expense_budget} base={cmp.expense_budget} />}
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.initial")}</dt>
            <dd>
              <Money n={s.initial_funding} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.period")}</dt>
            <dd>
              {s.starts_at ? kstDate(s.starts_at, now) : t("contract.onActivation")} ~ {kstDate(s.ends_at, now)}
            </dd>
          </div>
        </dl>
        <dl className="kv kv-4 periods">
          <div className="kv-row">
            <dt>{t("contract.clientReview")}</dt>
            <dd>{duration(s.client_review_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.resolver")}</dt>
            <dd>{duration(s.resolver_review_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.evidence")}</dt>
            <dd>{duration(s.evidence_seconds)}</dd>
          </div>
          <div className="kv-row">
            <dt>{t("contract.holdReservation")}</dt>
            <dd>{duration(s.reservation_seconds)}</dd>
          </div>
        </dl>
      </section>

      <section className="policy-sec">
        <h3>
          {t("contract.expenseRules")} <Chip tone="muted">{t("contract.writtenAs", { source: label(RULES_SOURCE, p.rules.source) })}</Chip>
        </h3>
        {p.rules.source === "words" && p.rules.words && (
          <blockquote className="words">
            <span className="muted small">{t("contract.original")}</span>
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
              <span className="muted small">{t("contract.vendors")}</span>
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
                <span className="muted small">{t("contract.perPurchase")}</span> <Money n={p.rules.max_per_purchase} />
              </span>
            )}
            {p.rules.until !== null && (
              <span>
                <span className="muted small">{t("contract.until")}</span> {when(p.rules.until, now)}
              </span>
            )}
          </div>
          {p.rules.category_budgets && Object.keys(p.rules.category_budgets).length > 0 && (
            <div>
              <span className="muted small">{t("contract.categoryBudgets")}</span>
              <div className="chips">
                {Object.entries(p.rules.category_budgets).map(([k, v]) => (
                  <Chip key={k} tone="muted">
                    {caption(meta?.categories?.find((c) => c.id === k)?.name_ko ?? k)} {won(v)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
        {Object.keys(p.rules.expressions ?? {}).length > 0 && (
          <details className="mini-fold">
            <summary>{t("contract.expressions")}</summary>
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
                  <th>{t("contract.mandate")}</th>
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
        <h3>{t("contract.milestones")}</h3>
        {p.milestones.length === 0 && <p className="muted small">{t("contract.noMilestones")}</p>}
        <ol className="pms">
          {p.milestones.map((m) => {
            const isNew = proposed && base && !base.milestones.some((x) => x.id === m.id)
            return (
              <li key={m.id} className="pm">
                <div className="pm-head">
                  <strong>{m.title}</strong>
                  {isNew && <Chip tone="accent">{t("contract.added")}</Chip>}
                  <Money n={m.amount} className="pm-amt" />
                </div>
                <div className="muted small">
                  {t("contract.schedule", {
                    start: kstDate(m.start_by, now),
                    due: kstDate(m.due_at, now),
                    grace: kstDate(m.grace_until, now),
                  })}
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
        <h3>{t("contract.silenceTitle")}</h3>
        <p className="muted small">{t("contract.silenceBody")}</p>
        <FallbackTable p={p} />
      </section>

      {proposed && (
        <div className="sign-box">
          {sign ? (
            <>
              <p className="small">{t("contract.signAgrees", { version: p.version, hash: p.hash.slice(0, 12) + "…" })}</p>
              <button
                type="button"
                className="btn btn-primary btn-attn"
                disabled={busy}
                onClick={() => openAction(sign)}
              >
                {actionLabel(sign)}
              </button>
            </>
          ) : mySig ? (
            <p className="small">
              <strong>{t("contract.signed")}</strong> {t("contract.waitingOther")}
            </p>
          ) : view.viewer.role === "resolver" ? (
            <p className="muted small">
              {t("contract.resolverNote")}
            </p>
          ) : (
            <p className="muted small">{t("contract.cannotSign")}</p>
          )}
          {p.kind === "change_order" && (
            <Banner tone="info">{t("contract.changeNote")}</Banner>
          )}
        </div>
      )}

      <details className="mini-fold">
        <summary>{t("contract.sourceDoc")}</summary>
        <pre className="doc-text">{JSON.stringify(p.doc, null, 2)}</pre>
      </details>
    </article>
  )
}

export function FallbackTable({ p }: { p: PolicyView }) {
  const { t } = useTranslation()
  if (p.fallbacks.length === 0) return <p className="muted small">{t("contract.noFallbacks")}</p>
  return (
    <div className="table-wrap">
      <table className="table fallbacks">
        <thead>
          <tr>
            <th>{t("contract.situation")}</th>
            <th>{t("contract.ifSilent")}</th>
            <th>{t("contract.ifResolverSilent")}</th>
          </tr>
        </thead>
        <tbody>
          {p.fallbacks.map((f, i) => (
            <tr key={i}>
              <td data-h={t("contract.situation")}>{caption(f.case)}</td>
              <td data-h={t("contract.ifSilent")}>{caption(f.silence)}</td>
              <td data-h={t("contract.ifResolverSilent")}>{f.resolver_silence ? caption(f.resolver_silence) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VersionHistory({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  return (
    <details className="policy-fold">
      <summary>{t("contract.history", { count: view.versions.length })}</summary>
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
              {t("contract.historyLine", {
                client: label(ROLE_KO, "client"),
                clientState: v.signatures.client ? kst(v.signatures.client.at, view.now) : t("contract.unsigned"),
                contractor: label(ROLE_KO, "contractor"),
                contractorState: v.signatures.contractor ? kst(v.signatures.contractor.at, view.now) : t("contract.unsigned"),
                amount: won(v.summary.project_budget),
              })}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}
