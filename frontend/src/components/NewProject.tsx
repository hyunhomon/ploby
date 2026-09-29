// 새 프로젝트: the client drafts the policy (expense rules, milestones, periods). The server
// answers with a DRAFT project whose v1 waits for both signatures and the initial funding.

import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, errorText } from "../api"
import { num, parseAmount, shortHash, sum, usd, won } from "../format"
import { RULES_SOURCE, caption, label } from "../labels"
import type { NewMilestone, NewProject as NewProjectT, Periods, RulesCandidate, RulesSource, Vendor } from "../types"
import { Banner, Card, Chip, Field, Money, MoneyInput, Segmented, useApp } from "./ui"

interface UnitDraft {
  title: string
  criteria: string
  amount: number | null
}

interface MsDraft {
  title: string
  start_by: string
  due_at: string
  grace_days: number
  units: UnitDraft[]
}

const DEFAULT_PERIODS: Periods = {
  client_review_hours: 72,
  resolver_review_days: 7,
  evidence_days: 7,
  reservation_days: 7,
}

const DEMO_MILESTONES: MsDraft[] = [
  {
    title: "디자인 시안",
    start_by: "2026-10-03",
    due_at: "2026-10-10",
    grace_days: 2,
    units: [
      { title: "메인 시안", criteria: "데스크톱·모바일 시안 각 1종", amount: 1_000_000 },
      { title: "서브 페이지 시안", criteria: "메뉴·매장 안내 페이지", amount: 500_000 },
    ],
  },
  {
    title: "반응형 퍼블리싱",
    start_by: "2026-10-12",
    due_at: "2026-10-31",
    grace_days: 3,
    units: [
      {
        title: "반응형 웹 퍼블리싱",
        criteria:
          "메인·메뉴·매장 안내 페이지 모바일·태블릿·데스크톱 대응\n시안과 같은 레이아웃·색상\n배포된 URL에서 확인 가능",
        amount: 2_500_000,
      },
    ],
  },
]

const DEMO_WORDS =
  "홈페이지 리뉴얼 경비는 AWS나 Vercel 호스팅, 가비아 도메인, Figma, Adobe Stock에서만 결제. 총 50만원, 부가세 포함 한 건에 20만원 이하, 10월 31일까지."

function toMilestone(m: MsDraft): NewMilestone {
  return {
    title: m.title.trim(),
    start_by: m.start_by,
    due_at: m.due_at,
    grace_days: m.grace_days,
    units: m.units.map((u) => ({
      title: u.title.trim(),
      criteria: u.criteria
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean),
      amount: u.amount ?? 0,
    })),
  }
}

export function NewProject() {
  const { t } = useTranslation()
  const { role, meta, navigate, notify } = useApp()
  const [step, setStep] = useState(0)
  const steps = [t("wizard.steps.basic"), t("wizard.steps.rules"), t("wizard.steps.work"), t("wizard.steps.confirm")]
  const goStep = (next: number) => {
    setStep(next)
    window.scrollTo(0, 0)
    requestAnimationFrame(() => document.getElementById("step-heading")?.focus())
  }
  const [name, setName] = useState("카페 온담 홈페이지 리뉴얼")
  const [endsAt, setEndsAt] = useState("2026-12-31")
  const [mode, setMode] = useState<"form" | "words">("form")
  const [vendors, setVendors] = useState<string[]>(["aws", "vercel", "gabia", "figma", "adobe-stock"])
  const [budget, setBudget] = useState<number | null>(500_000)
  const [maxPer, setMaxPer] = useState<number | null>(200_000)
  const [until, setUntil] = useState("2026-10-31")
  const [catBudgets, setCatBudgets] = useState<Record<string, number | null>>({})
  const [words, setWords] = useState(DEMO_WORDS)
  const [candidate, setCandidate] = useState<RulesCandidate | null>(null)
  const [pick, setPick] = useState<RulesSource | "">("")
  const [compiling, setCompiling] = useState(false)
  const [milestones, setMilestones] = useState<MsDraft[]>(DEMO_MILESTONES)
  const [periods, setPeriods] = useState<Periods>(meta?.defaults ?? DEFAULT_PERIODS)
  const [periodsTouched, setPeriodsTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (meta?.defaults && !periodsTouched) setPeriods(meta.defaults)
  }, [meta, periodsTouched])

  const groups = useMemo(() => {
    const g = new Map<string, Vendor[]>()
    for (const v of meta?.vendors ?? []) {
      const k = v.category_ko || v.category
      g.set(k, [...(g.get(k) ?? []), v])
    }
    return [...g.entries()]
  }, [meta])

  // categories of the chosen vendors, for the optional per-category budgets
  const chosenCategories = useMemo(() => {
    const ids: string[] = []
    for (const v of meta?.vendors ?? []) if (vendors.includes(v.id) && !ids.includes(v.category)) ids.push(v.category)
    return ids.map((id) => ({
      id,
      name: caption(
        meta?.categories?.find((c) => c.id === id)?.name_ko ??
          meta?.vendors.find((v) => v.category === id)?.category_ko ??
          id,
      ),
    }))
  }, [meta, vendors])
  const categoryBudgets = Object.fromEntries(
    chosenCategories.filter((c) => (catBudgets[c.id] ?? 0) > 0).map((c) => [c.id, catBudgets[c.id] as number]),
  )

  const chosen = candidate?.options.find((o) => o.source === pick) ?? null
  const wordsBudget = chosen?.expressions?.budget ? parseAmount(chosen.expressions.budget) : null
  const expenseBudget = mode === "form" ? (budget ?? 0) : (wordsBudget ?? 0)
  const msTotals = milestones.map((m) => sum(m.units.map((u) => u.amount ?? 0)))
  const milestoneBudget = sum(msTotals)
  const projectBudget = expenseBudget + milestoneBudget

  const problems: string[] = []
  if (!name.trim()) problems.push(t("wizard.needName"))
  if (!endsAt) problems.push(t("wizard.needEnds"))
  const basicProblemCount = problems.length
  if (mode === "form") {
    if (vendors.length === 0) problems.push(t("wizard.needVendor"))
    if (!budget || budget <= 0) problems.push(t("wizard.needBudget"))
    if (!maxPer || maxPer <= 0) problems.push(t("wizard.needPer"))
    if (budget && maxPer && maxPer > budget) problems.push(t("wizard.perOver"))
    if (!until) problems.push(t("wizard.needUntil"))
    for (const c of chosenCategories) {
      const v = catBudgets[c.id]
      if (v !== null && v !== undefined && budget && v > budget) problems.push(t("wizard.catOver", { name: c.name }))
    }
  } else {
    if (!candidate) problems.push(t("wizard.needRead"))
    else if (!chosen) problems.push(t("wizard.needPick"))
    else if (!chosen.ok) problems.push(t("wizard.pickError"))
  }
  const rulesProblemCount = problems.length
  milestones.forEach((m, i) => {
    const n = t("wizard.milestone", { n: i + 1 })
    if (!m.title.trim()) problems.push(t("wizard.emptyTitle", { name: n }))
    if (!m.start_by || !m.due_at) problems.push(t("wizard.needDates", { name: n }))
    if (m.start_by && m.due_at && m.start_by > m.due_at) problems.push(t("wizard.dateOrder", { name: n }))
    if (m.due_at && endsAt && m.due_at > endsAt) problems.push(t("wizard.afterProject", { name: n }))
    if (m.units.length === 0) problems.push(t("wizard.noUnits", { name: n }))
    m.units.forEach((u, j) => {
      if (!u.title.trim()) problems.push(t("wizard.unitName", { name: n, n: j + 1 }))
      if (!u.criteria.trim()) problems.push(t("wizard.unitCriteria", { name: n, n: j + 1 }))
      if (!u.amount || u.amount <= 0) problems.push(t("wizard.unitAmount", { name: n, n: j + 1 }))
    })
  })
  const workProblemCount = problems.length
  const problemStep = (index: number) =>
    index < basicProblemCount ? 0 : index < rulesProblemCount ? 1 : index < workProblemCount ? 2 : 3
  if (Object.values(periods).some((v) => !(v > 0))) problems.push(t("wizard.periodsPositive"))

  const compile = async () => {
    setCompiling(true)
    setCandidate(null)
    setPick("")
    try {
      const c = await api.compileRules(words)
      setCandidate(c)
      if (c.agree) {
        const ok = c.options.find((o) => o.ok)
        if (ok) setPick(ok.source)
      }
    } catch (e) {
      notify("error", errorText(e))
    } finally {
      setCompiling(false)
    }
  }

  const submit = async () => {
    if (problems.length > 0 || submitting) return
    const body: NewProjectT = {
      name: name.trim(),
      rules:
        mode === "form"
          ? {
              mode: "form",
              form: {
                vendors,
                budget: budget ?? 0,
                max_per_purchase: maxPer ?? 0,
                until,
                ...(Object.keys(categoryBudgets).length > 0 ? { category_budgets: categoryBudgets } : {}),
              },
            }
          : { mode: "words", words, candidate: candidate?.candidate ?? "", pick: (pick || "writer") as RulesSource },
      milestones: milestones.map(toMilestone),
      periods,
      ends_at: endsAt,
    }
    setSubmitting(true)
    try {
      const view = await api.createProject(body)
      notify("ok", t("wizard.created"))
      navigate(`#/p/${encodeURIComponent(view.id)}`)
    } catch (e) {
      notify("error", errorText(e))
    } finally {
      setSubmitting(false)
    }
  }

  const setMs = (i: number, patch: Partial<MsDraft>) =>
    setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const setUnit = (i: number, k: number, patch: Partial<UnitDraft>) =>
    setMilestones((ms) =>
      ms.map((m, j) => (j === i ? { ...m, units: m.units.map((u, l) => (l === k ? { ...u, ...patch } : u)) } : m)),
    )

  if (role !== "client") {
    return (
      <div className="page">
        <Banner tone="info" title={t("wizard.clientOnlyTitle")}>
          {t("wizard.clientOnlyBody")}
        </Banner>
        <button type="button" className="btn" onClick={() => navigate("#/")}>
          {t("project.backToList")}
        </button>
      </div>
    )
  }

  return (
    <div className="page newproject">
      <button type="button" className="linkish small back" onClick={() => navigate("#/")}>
        ← {t("project.projectList")}
      </button>
      <p className="eyebrow">{t("wizard.progress", { step: step + 1, total: 4 })}</p>
      <h1 id="step-heading" tabIndex={-1}>
        {[t("wizard.titles.work"), t("wizard.titles.rules"), t("wizard.titles.pay"), t("wizard.titles.confirm")][step]}
      </h1>
      <p className="muted">{t("wizard.lead")}</p>

      <nav className="wizard-steps" aria-label={t("wizard.stepsLabel")}>
        {steps.map((title, i) => (
          <button type="button" key={title} aria-current={step === i ? "step" : undefined} onClick={() => goStep(i)}>
            <span>{i + 1}</span>
            {title}
          </button>
        ))}
      </nav>
      <div className={`wizard wizard-step-${step}`}>
        <div className="wizard-main">
          <div hidden={step !== 0}>
            <Card title={t("wizard.basicTitle")}>
              <div className="grid-2">
                <Field label={t("wizard.name")}>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label={t("wizard.ends")} hint={t("wizard.endsHint")}>
                  <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </Field>
              </div>
            </Card>
          </div>
          <div hidden={step !== 1}>
            <Card title={t("wizard.rulesTitle")} sub={t("wizard.rulesSub")}>
              <Segmented
                value={mode}
                onChange={setMode}
                label={t("wizard.mode")}
                options={[
                  { value: "form", label: t("wizard.form") },
                  { value: "words", label: t("wizard.words") },
                ]}
              />
              {mode === "form" ? (
                <div className="form-rules">
                  <fieldset className="fieldset">
                    <legend>{t("wizard.vendors")}</legend>
                    {groups.length === 0 && <p className="muted small">{t("wizard.vendorsMissing")}</p>}
                    <div className="vendor-groups">
                      {groups.map(([cat, list]) => (
                        <div key={cat} className="vendor-group">
                          <div className="vendor-cat">{caption(cat)}</div>
                          {list.map((v) => (
                            <label key={v.id} className="check check-inline">
                              <input
                                type="checkbox"
                                checked={vendors.includes(v.id)}
                                onChange={() =>
                                  setVendors((s) => (s.includes(v.id) ? s.filter((x) => x !== v.id) : [...s, v.id]))
                                }
                              />
                              <span>{v.name}</span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid-3">
                    <Field label={t("wizard.budget")}>
                      <MoneyInput value={budget} onChange={setBudget} />
                    </Field>
                    <Field label={t("wizard.per")} hint={t("wizard.perHint")}>
                      <MoneyInput value={maxPer} onChange={setMaxPer} />
                    </Field>
                    <Field label={t("wizard.until")}>
                      <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                    </Field>
                  </div>
                  {chosenCategories.length > 0 && (
                    <details className="mini-fold">
                      <summary>{t("wizard.catOptional")}</summary>
                      <p className="muted small">{t("wizard.catHelp")}</p>
                      <div className="grid-3">
                        {chosenCategories.map((c) => (
                          <Field key={c.id} label={c.name}>
                            <MoneyInput
                              value={catBudgets[c.id] ?? null}
                              onChange={(n) => setCatBudgets((s) => ({ ...s, [c.id]: n }))}
                              placeholder={t("wizard.noCap")}
                            />
                          </Field>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ) : (
                <div className="words-rules">
                  {meta && !meta.ai.enabled && (
                    <Banner tone="warn">{t("wizard.aiOff")}</Banner>
                  )}
                  <Field label={t("wizard.wordsLabel")}>
                    <textarea
                      rows={4}
                      value={words}
                      onChange={(e) => {
                        setWords(e.target.value)
                        setCandidate(null)
                        setPick("")
                      }}
                    />
                  </Field>
                  <div className="row-wrap">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={compile}
                      disabled={compiling || !words.trim()}
                    >
                      {compiling ? t("wizard.reading") : t("wizard.read")}
                    </button>
                    <span className="muted small">
                      {t("wizard.compare", { model: meta?.ai.model ? ` (${meta.ai.model})` : "" })}
                    </span>
                  </div>
                  <Banner tone="info">{t("wizard.aiEffect")}</Banner>
                  {candidate && <CandidateView c={candidate} pick={pick} onPick={setPick} />}
                </div>
              )}
            </Card>
          </div>
          <div hidden={step !== 2}>
            <Card title={t("wizard.workTitle")} sub={t("wizard.workSub")}>
              <div className="stack">
                {milestones.map((m, i) => (
                  <div className="ms-edit" key={i}>
                    <div className="ms-edit-head">
                      <strong>{t("wizard.milestone", { n: i + 1 })}</strong>
                      <Money n={msTotals[i]} />
                      <span className="pr-spacer" />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                      >
                        {t("wizard.remove")}
                      </button>
                    </div>
                    <div className="grid-4">
                      <Field label={t("wizard.itemTitle")}>
                        <input value={m.title} onChange={(e) => setMs(i, { title: e.target.value })} />
                      </Field>
                      <Field label={t("wizard.startBy")}>
                        <input
                          type="date"
                          value={m.start_by}
                          onChange={(e) => setMs(i, { start_by: e.target.value })}
                        />
                      </Field>
                      <Field label={t("wizard.due")}>
                        <input type="date" value={m.due_at} onChange={(e) => setMs(i, { due_at: e.target.value })} />
                      </Field>
                      <Field label={t("wizard.grace")}>
                        <input
                          type="number"
                          min={0}
                          value={m.grace_days}
                          onChange={(e) => setMs(i, { grace_days: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </Field>
                    </div>
                    <div className="units-edit">
                      {m.units.map((u, k) => (
                        <div className="unit-edit" key={k}>
                          <div className="grid-2">
                            <Field label={t("wizard.unit", { n: k + 1 })}>
                              <input value={u.title} onChange={(e) => setUnit(i, k, { title: e.target.value })} />
                            </Field>
                            <Field label={t("wizard.amount")}>
                              <MoneyInput value={u.amount} onChange={(n) => setUnit(i, k, { amount: n })} />
                            </Field>
                          </div>
                          <Field label={t("wizard.criteria")} hint={t("wizard.criteriaHint")}>
                            <textarea
                              rows={2}
                              value={u.criteria}
                              onChange={(e) => setUnit(i, k, { criteria: e.target.value })}
                            />
                          </Field>
                          {m.units.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setMs(i, { units: m.units.filter((_, l) => l !== k) })}
                            >
                              {t("wizard.removeUnit")}
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setMs(i, { units: [...m.units, { title: "", criteria: "", amount: null }] })}
                      >
                        {t("wizard.addUnit")}
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setMilestones((ms) => [
                      ...ms,
                      {
                        title: "",
                        start_by: "",
                        due_at: "",
                        grace_days: 2,
                        units: [{ title: "", criteria: "", amount: null }],
                      },
                    ])
                  }
                >
                  {t("wizard.addMilestone")}
                </button>
              </div>
            </Card>
          </div>
          <div hidden={step !== 3}>
            <Card title={t("wizard.periodsTitle")} sub={t("wizard.periodsSub")}>
              <div className="grid-4">
                <PeriodField
                  label={t("wizard.clientReview")}
                  unit={t("wizard.hours")}
                  value={periods.client_review_hours}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, client_review_hours: v }))}
                  hint={t("wizard.clientHint")}
                />
                <PeriodField
                  label={t("wizard.resolver")}
                  unit={t("wizard.days")}
                  value={periods.resolver_review_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, resolver_review_days: v }))}
                  hint={t("wizard.resolverHint")}
                />
                <PeriodField
                  label={t("wizard.evidence")}
                  unit={t("wizard.days")}
                  value={periods.evidence_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, evidence_days: v }))}
                  hint={t("wizard.evidenceHint")}
                />
                <PeriodField
                  label={t("wizard.hold")}
                  unit={t("wizard.days")}
                  value={periods.reservation_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, reservation_days: v }))}
                  hint={t("wizard.holdHint")}
                />
              </div>
            </Card>
          </div>
        </div>

        <aside className="wizard-side" hidden={step !== 3}>
          <Card title={t("wizard.budgetCard")} className="sticky-card">
            <p className="review-project-name">{name || t("wizard.unnamed")}</p>
            <dl className="kv totals-kv">
              <div className="kv-row">
                <dt>{t("wizard.budget")}</dt>
                <dd>
                  {mode === "words" && wordsBudget === null ? (
                    <span className="muted small">{t("wizard.pendingRules")}</span>
                  ) : (
                    <Money n={expenseBudget} />
                  )}
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t("wizard.workPay")}</dt>
                <dd>
                  <Money n={milestoneBudget} />
                </dd>
              </div>
              <div className="kv-row kv-strong">
                <dt>{t("wizard.totalDeposit")}</dt>
                <dd>
                  <Money n={projectBudget} />
                </dd>
              </div>
            </dl>
            <p className="muted small">{t("wizard.afterDeposit", { amount: won(milestoneBudget) })}</p>
            {problems.length > 0 && (
              <ul className="problems">
                {problems.map((p, i) => (
                  <li key={i}>
                    <button type="button" className="linkish" onClick={() => goStep(problemStep(i))}>
                      {p} →
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={problems.length > 0 || submitting}
              onClick={submit}
            >
              {submitting ? t("wizard.creating") : t("wizard.create")}
            </button>
            <p className="muted small">{t("wizard.noEffect")}</p>
          </Card>
        </aside>
      </div>
      <div className="wizard-navigation">
        <button type="button" className="btn" onClick={() => (step > 0 ? goStep(step - 1) : navigate("#/"))}>
          {step === 0 ? t("wizard.cancel") : t("wizard.previous")}
        </button>
        {step < 3 && (
          <button type="button" className="btn btn-primary" onClick={() => goStep(step + 1)}>
            {t("wizard.next")}
          </button>
        )}
      </div>
    </div>
  )
}

function PeriodField({
  label: l,
  unit,
  value,
  onChange,
  hint,
}: {
  label: string
  unit: string
  value: number
  onChange: (v: number) => void
  hint: string
}) {
  return (
    <Field label={`${l} (${unit})`} hint={hint}>
      <input type="number" min={1} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
    </Field>
  )
}

function CandidateView({
  c,
  pick,
  onPick,
}: {
  c: RulesCandidate
  pick: RulesSource | ""
  onPick: (s: RulesSource) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="candidate">
      <div className="row-wrap">
        {c.agree ? <Chip tone="ok">{t("wizard.agree")}</Chip> : <Chip tone="warn">{t("wizard.differ")}</Chip>}
        <span className="muted small">{t("wizard.candidate", { id: c.candidate })}</span>
      </div>
      {c.differences.length > 0 && (
        <div>
          <span className="muted small">{t("wizard.diffs")}</span>
          <ul className="problems">
            {c.differences.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {c.problems.length > 0 && (
        <div>
          <span className="muted small">{t("wizard.issues")}</span>
          <ul className="problems">
            {c.problems.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="readings" role="radiogroup" aria-label={t("wizard.pickAria")}>
        {c.options.map((o) => (
          <label
            key={o.source}
            className={`reading-opt ${pick === o.source ? "reading-on" : ""} ${o.ok ? "" : "reading-bad"}`}
          >
            <span className="reading-opt-head">
              <input
                type="radio"
                name="pick"
                checked={pick === o.source}
                disabled={!o.ok}
                onChange={() => onPick(o.source)}
              />
              <strong>{label(RULES_SOURCE, o.source)}</strong>
              {o.ok ? <Chip tone="ok">{t("wizard.readOk")}</Chip> : <Chip tone="bad">{t("wizard.readBad")}</Chip>}
              {o.hash && <code className="tiny">{shortHash(o.hash, 8, 4)}</code>}
            </span>
            {o.error && <span className="field-error">{o.error}</span>}
            <ul className="readback">
              {o.readback.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </label>
        ))}
      </div>
      <div className="usage">
        {c.usage.calls !== undefined && <span>{t("wizard.calls", { count: c.usage.calls })}</span>}
        {c.usage.tokens !== undefined && <span>{t("wizard.tokens", { count: num(c.usage.tokens) })}</span>}
        {c.usage.cost_usd !== undefined && <span>{t("wizard.cost", { amount: usd(c.usage.cost_usd) })}</span>}
        {c.usage.seconds !== undefined && <span>{t("wizard.seconds", { n: c.usage.seconds.toFixed(1) })}</span>}
        {c.usage.cached && <Chip tone="muted">{t("wizard.cached")}</Chip>}
      </div>
    </div>
  )
}
