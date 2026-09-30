// 새 프로젝트: the client drafts the policy (expense rules, milestones, periods). The server
// answers with a DRAFT project whose v1 waits for both signatures and the initial funding.

import { useEffect, useMemo, useState } from "react"
import { api, errorText } from "../api"
import { num, parseAmount, shortHash, sum, usd, won } from "../format"
import { RULES_SOURCE, label } from "../labels"
import { L } from "../i18n"
import { connectWallet } from "../wallet"
import type { NewMilestone, NewProject as NewProjectT, Periods, Role, RulesCandidate, RulesSource, Vendor } from "../types"
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
  const { role, meta, navigate, notify } = useApp()
  const [step, setStep] = useState(0)
  const steps = ["기본 정보", "경비 규칙", "작업과 대금", "확인 및 생성"]
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
  const [walletMode, setWalletMode] = useState(false)
  const [wallets, setWallets] = useState<Record<Role, string>>({ client: "", contractor: "", resolver: "" })

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
      name:
        meta?.categories?.find((c) => c.id === id)?.name_ko ??
        meta?.vendors.find((v) => v.category === id)?.category_ko ??
        id,
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
  if (!name.trim()) problems.push("프로젝트 이름을 입력하세요")
  if (!endsAt) problems.push("프로젝트 종료일을 정하세요")
  if (walletMode) {
    if (Object.values(wallets).some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a.trim())))
      problems.push(L("세 당사자의 지갑 주소를 입력하세요", "Enter all three party wallet addresses"))
    else if (new Set(Object.values(wallets).map((a) => a.trim().toLowerCase())).size !== 3)
      problems.push(L("당사자마다 다른 지갑을 사용하세요", "Use a different wallet for each party"))
  }
  const basicProblemCount = problems.length
  if (mode === "form") {
    if (vendors.length === 0) problems.push("허용 공급자를 하나 이상 고르세요")
    if (!budget || budget <= 0) problems.push("경비 예산을 입력하세요")
    if (!maxPer || maxPer <= 0) problems.push("건별 한도를 입력하세요")
    if (budget && maxPer && maxPer > budget) problems.push("건별 한도가 경비 예산보다 큽니다")
    if (!until) problems.push("경비 사용 기한을 정하세요")
    for (const c of chosenCategories) {
      const v = catBudgets[c.id]
      if (v !== null && v !== undefined && budget && v > budget) problems.push(`${c.name} 예산이 경비 예산보다 큽니다`)
    }
  } else {
    if (!candidate) problems.push("경비 규칙 문장을 AI로 읽어 두 해석을 확인하세요")
    else if (!chosen) problems.push("두 해석 중 하나를 고르세요")
    else if (!chosen.ok) problems.push("고른 해석에 오류가 있습니다")
  }
  const rulesProblemCount = problems.length
  milestones.forEach((m, i) => {
    const n = `마일스톤 ${i + 1}`
    if (!m.title.trim()) problems.push(`${n}: 제목이 비어 있습니다`)
    if (!m.start_by || !m.due_at) problems.push(`${n}: 착수 기한과 납기를 정하세요`)
    if (m.start_by && m.due_at && m.start_by > m.due_at) problems.push(`${n}: 착수 기한이 납기보다 늦습니다`)
    if (m.due_at && endsAt && m.due_at > endsAt) problems.push(`${n}: 납기가 프로젝트 종료일보다 늦습니다`)
    if (m.units.length === 0) problems.push(`${n}: 납품 단위가 없습니다`)
    m.units.forEach((u, j) => {
      if (!u.title.trim()) problems.push(`${n} 단위 ${j + 1}: 이름이 비어 있습니다`)
      if (!u.criteria.trim()) problems.push(`${n} 단위 ${j + 1}: 인수 기준이 없습니다`)
      if (!u.amount || u.amount <= 0) problems.push(`${n} 단위 ${j + 1}: 금액이 없습니다`)
    })
  })
  const workProblemCount = problems.length
  const problemStep = (index: number) =>
    index < basicProblemCount ? 0 : index < rulesProblemCount ? 1 : index < workProblemCount ? 2 : 3
  if (Object.values(periods).some((v) => !(v > 0))) problems.push("기한 설정은 모두 0보다 커야 합니다")

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
      ...(walletMode ? { wallets: Object.fromEntries(Object.entries(wallets).map(([r, a]) => [r, a.trim()])) as Record<Role, string> } : {}),
    }
    setSubmitting(true)
    try {
      const view = await api.createProject(body)
      notify("ok", "프로젝트 초안을 만들었습니다. 양측 서명과 초기 입금이 필요합니다.")
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
        <Banner tone="info" title="새 프로젝트는 클라이언트만 만들 수 있습니다">
          위의 역할 전환에서 ‘클라이언트’를 고르세요. 작업자는 만들어진 정책을 검토하고 서명합니다.
        </Banner>
        <button type="button" className="btn" onClick={() => navigate("#/")}>
          목록으로
        </button>
      </div>
    )
  }

  return (
    <div className="page newproject">
      <button type="button" className="linkish small back" onClick={() => navigate("#/")}>
        ← 프로젝트 목록
      </button>
      <p className="eyebrow">새 프로젝트 · {step + 1} / 4</p>
      <h1 id="step-heading" tabIndex={-1}>
        {
          ["어떤 일을 함께하나요?", "경비 기준을 정해주세요", "작업과 대금을 나눠주세요", "마지막으로 확인해주세요"][
            step
          ]
        }
      </h1>
      <p className="muted">양측이 조건에 서명하고 대금이 입금되면 프로젝트가 시작돼요.</p>

      <nav className="wizard-steps" aria-label="프로젝트 생성 단계">
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
            <Card title="기본 정보">
              <div className="grid-2">
                <Field label="프로젝트 이름">
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="프로젝트 종료일" hint="이날이 끝날 때까지 (KST)">
                  <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </Field>
              </div>
              <details className="mini-fold">
                <summary>{L("승인 방식", "Approval method")} · {walletMode ? "Wallet" : "Demo"}</summary>
                <label className="check">
                  <input type="checkbox" checked={walletMode} disabled={!meta?.wallet?.available} onChange={(e) => setWalletMode(e.target.checked)} />
                  {L("각 당사자의 지갑으로 승인", "Require each party’s wallet approval")}
                </label>
                <p className="muted small">{L("지갑 승인에서는 정책 서명과 예치·중지 등 각 행동을 지갑에서 확인합니다. 테스트 자금은 릴레이어가 예치하며, 정책 판정은 서버가 담당합니다.", "Wallet approval asks each party to sign policies and actions such as funding and pausing. A relayer funds the test escrow. Policy decisions still run on the server.")}</p>
                {!meta?.wallet?.available && <p className="muted small">{L("지갑 검증을 사용할 수 없는 서버입니다. 데모 서명으로 진행합니다.", "This server does not have wallet verification enabled. Demo signatures remain available.")}</p>}
                {walletMode && <div className="stack">
                  {([['client', L('클라이언트', 'Client')], ['contractor', L('작업자', 'Contractor')], ['resolver', L('분쟁 해결자', 'Resolver')]] as [Role, string][]).map(([r, title]) => (
                    <Field key={r} label={title + ' wallet'}>
                      <input value={wallets[r]} placeholder="0x…" onChange={(e) => setWallets((w) => ({ ...w, [r]: e.target.value }))} />
                      <button className="btn btn-ghost btn-sm" type="button" onClick={async () => {
                        try { const address = await connectWallet(); setWallets((w) => ({ ...w, [r]: address })) }
                        catch (e) { notify('error', errorText(e)) }
                      }}>{L('연결된 지갑 주소 사용', 'Use connected wallet')}</button>
                    </Field>
                  ))}
                </div>}
              </details>
            </Card>
          </div>
          <div hidden={step !== 1}>
            <Card title="경비 규칙" sub="어디에서, 얼마까지 사용할 수 있는지 정해주세요.">
              <Segmented
                value={mode}
                onChange={setMode}
                label="작성 방식"
                options={[
                  { value: "form", label: "양식으로" },
                  { value: "words", label: "문장으로 (AI가 읽기)" },
                ]}
              />
              {mode === "form" ? (
                <div className="form-rules">
                  <fieldset className="fieldset">
                    <legend>허용 공급자</legend>
                    {groups.length === 0 && (
                      <p className="muted small">공급자 목록을 불러오지 못했습니다 (/api/meta).</p>
                    )}
                    <div className="vendor-groups">
                      {groups.map(([cat, list]) => (
                        <div key={cat} className="vendor-group">
                          <div className="vendor-cat">{cat}</div>
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
                    <Field label="경비 예산">
                      <MoneyInput value={budget} onChange={setBudget} />
                    </Field>
                    <Field label="건별 한도" hint="부가세·수수료 포함 한 건">
                      <MoneyInput value={maxPer} onChange={setMaxPer} />
                    </Field>
                    <Field label="경비 사용 기한">
                      <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                    </Field>
                  </div>
                  {chosenCategories.length > 0 && (
                    <details className="mini-fold">
                      <summary>카테고리별 예산 (선택)</summary>
                      <p className="muted small">
                        비워 두면 경비 예산 안에서 카테고리 제한이 없습니다. 정하면 ‘카테고리 예산 잔여’ 규칙이 약정마다
                        검사됩니다.
                      </p>
                      <div className="grid-3">
                        {chosenCategories.map((c) => (
                          <Field key={c.id} label={c.name}>
                            <MoneyInput
                              value={catBudgets[c.id] ?? null}
                              onChange={(n) => setCatBudgets((s) => ({ ...s, [c.id]: n }))}
                              placeholder="제한 없음"
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
                    <Banner tone="warn">AI가 꺼져 있어 문장 규칙을 읽을 수 없습니다. 양식을 사용하세요.</Banner>
                  )}
                  <Field label="경비 규칙 (평소 말투로)">
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
                      {compiling ? "AI가 두 번 읽는 중…" : "AI로 읽기"}
                    </button>
                    <span className="muted small">
                      모델이 서로 모르게 두 번 읽고, 두 해석을 비교합니다{meta?.ai.model ? ` (${meta.ai.model})` : ""}.
                    </span>
                  </div>
                  <Banner tone="info">AI가 규칙 초안을 읽었지만, 효력은 두 당사자가 서명한 뒤에만 생깁니다</Banner>
                  {candidate && <CandidateView c={candidate} pick={pick} onPick={setPick} />}
                </div>
              )}
            </Card>
          </div>
          <div hidden={step !== 2}>
            <Card title="작업과 대금" sub="작업별 금액과 검수 기준을 미리 합의해요.">
              <div className="stack">
                {milestones.map((m, i) => (
                  <div className="ms-edit" key={i}>
                    <div className="ms-edit-head">
                      <strong>마일스톤 {i + 1}</strong>
                      <Money n={msTotals[i]} />
                      <span className="pr-spacer" />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                      >
                        삭제
                      </button>
                    </div>
                    <div className="grid-4">
                      <Field label="제목">
                        <input value={m.title} onChange={(e) => setMs(i, { title: e.target.value })} />
                      </Field>
                      <Field label="착수 기한">
                        <input
                          type="date"
                          value={m.start_by}
                          onChange={(e) => setMs(i, { start_by: e.target.value })}
                        />
                      </Field>
                      <Field label="납기">
                        <input type="date" value={m.due_at} onChange={(e) => setMs(i, { due_at: e.target.value })} />
                      </Field>
                      <Field label="유예 (일)">
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
                            <Field label={`납품 단위 ${k + 1}`}>
                              <input value={u.title} onChange={(e) => setUnit(i, k, { title: e.target.value })} />
                            </Field>
                            <Field label="금액">
                              <MoneyInput value={u.amount} onChange={(n) => setUnit(i, k, { amount: n })} />
                            </Field>
                          </div>
                          <Field label="인수 기준" hint="한 줄에 기준 하나">
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
                              납품 단위 삭제
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setMs(i, { units: [...m.units, { title: "", criteria: "", amount: null }] })}
                      >
                        + 납품 단위 추가
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
                  + 마일스톤 추가
                </button>
              </div>
            </Card>
          </div>
          <div hidden={step !== 3}>
            <Card title="기한 설정" sub="기한 내 응답이 없을 때 적용할 조건이에요.">
              <div className="grid-4">
                <PeriodField
                  label="클라이언트 검토"
                  unit="시간"
                  value={periods.client_review_hours}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, client_review_hours: v }))}
                  hint="침묵 시 제출 단위·영수증 지급"
                />
                <PeriodField
                  label="분쟁 해결"
                  unit="일"
                  value={periods.resolver_review_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, resolver_review_days: v }))}
                  hint="침묵 시 HOLD 유형별 결과"
                />
                <PeriodField
                  label="증빙 제출"
                  unit="일"
                  value={periods.evidence_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, evidence_days: v }))}
                  hint="구매 보고 뒤 영수증 기한"
                />
                <PeriodField
                  label="경비 예약 유지"
                  unit="일"
                  value={periods.reservation_days}
                  onChange={(v) => (setPeriodsTouched(true), setPeriods({ ...periods, reservation_days: v }))}
                  hint="구매 보고가 없으면 만료"
                />
              </div>
            </Card>
          </div>
        </div>

        <aside className="wizard-side" hidden={step !== 3}>
          <Card title="프로젝트 예산" className="sticky-card">
            <p className="review-project-name">{name || "이름 없는 프로젝트"}</p>
            <dl className="kv totals-kv">
              <div className="kv-row">
                <dt>경비 예산</dt>
                <dd>
                  {mode === "words" && wordsBudget === null ? (
                    <span className="muted small">규칙 확정 후 계산</span>
                  ) : (
                    <Money n={expenseBudget} />
                  )}
                </dd>
              </div>
              <div className="kv-row">
                <dt>작업 대금</dt>
                <dd>
                  <Money n={milestoneBudget} />
                </dd>
              </div>
              <div className="kv-row kv-strong">
                <dt>총예산 · 초기 입금액</dt>
                <dd>
                  <Money n={projectBudget} />
                </dd>
              </div>
            </dl>
            <p className="muted small">입금 후 작업 대금 {won(milestoneBudget)}이 예약돼요.</p>
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
              {submitting ? "만드는 중…" : "프로젝트 초안 만들기"}
            </button>
            <p className="muted small">만든 뒤에도 서명 전까지는 효력이 없습니다.</p>
          </Card>
        </aside>
      </div>
      <div className="wizard-navigation">
        <button type="button" className="btn" onClick={() => (step > 0 ? goStep(step - 1) : navigate("#/"))}>
          {step === 0 ? "취소" : "이전"}
        </button>
        {step < 3 && (
          <button type="button" className="btn btn-primary" onClick={() => goStep(step + 1)}>
            다음 단계
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
  return (
    <div className="candidate">
      <div className="row-wrap">
        {c.agree ? <Chip tone="ok">두 해석 일치</Chip> : <Chip tone="warn">두 해석이 다름 — 직접 고르세요</Chip>}
        <span className="muted small">후보 {c.candidate}</span>
      </div>
      {c.differences.length > 0 && (
        <div>
          <span className="muted small">다른 부분</span>
          <ul className="problems">
            {c.differences.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {c.problems.length > 0 && (
        <div>
          <span className="muted small">문제</span>
          <ul className="problems">
            {c.problems.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="readings" role="radiogroup" aria-label="해석 선택">
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
              {o.ok ? <Chip tone="ok">읽기 성공</Chip> : <Chip tone="bad">오류</Chip>}
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
        {c.usage.calls !== undefined && <span>호출 {c.usage.calls}회</span>}
        {c.usage.tokens !== undefined && <span>토큰 {num(c.usage.tokens)}</span>}
        {c.usage.cost_usd !== undefined && <span>비용 {usd(c.usage.cost_usd)}</span>}
        {c.usage.seconds !== undefined && <span>{c.usage.seconds.toFixed(1)}초</span>}
        {c.usage.cached && <Chip tone="muted">캐시</Chip>}
      </div>
    </div>
  )
}
