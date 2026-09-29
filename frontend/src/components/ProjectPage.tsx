// The project page: one ProjectView for the current role. Every button goes through `run`,
// which posts the action and replaces the view with the server's answer.

import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { ApiError, api, errorText, type ActionParams } from "../api"
import { shortHash } from "../format"
import { ERROR_CODE_KO, PROJECT_STATUS, PROJECT_STATUS_HELP, PROJECT_TONE, ROLE_KO, label, toneOf } from "../labels"
import type { Action, ProjectView } from "../types"
import { ControlsCard, DeadlinesCard, LogCard, TodoCard } from "./Activity"
import { ChangeOrdersSection } from "./ChangeOrders"
import { ActionDialog } from "./Dialogs"
import { ExpensesSection } from "./Expenses"
import { LedgerCard } from "./Ledger"
import { MilestonesSection } from "./Milestones"
import { PolicyCard } from "./Policy"
import {
  ProjectContext,
  actionLabel,
  findAction,
  scrollToAnchor,
  targetParams,
  type Preset,
  type ProjectCtx,
} from "./projectCtx"
import { Icon } from "./Icon"
import { Banner, Chip, CopyHash, Modal, Money, useApp } from "./ui"

const NAV = [
  ["overview", "요약"],
  ["work", "작업"],
  ["expenses", "경비"],
  ["policy", "계약"],
  ["changes", "변경 요청"],
  ["activity", "기록"],
  ["manage", "관리"],
] as const
function currentTab() {
  const tab = new URLSearchParams(window.location.hash.split("?")[1]).get("tab")
  return NAV.some(([key]) => key === tab) ? tab! : "overview"
}

export function ProjectPage({
  id,
  refreshKey,
  onNow,
}: {
  id: string
  refreshKey: number
  onNow: (now: number) => void
}) {
  const { role, notify, navigate, clockSlot } = useApp()
  const [view, setView] = useState<ProjectView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState(currentTab)
  const [locationKey, setLocationKey] = useState(window.location.hash)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  useEffect(() => {
    const onHash = () => {
      setTab(currentTab())
      setLocationKey(window.location.hash)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  useEffect(() => {
    if (!view) return
    const target = new URLSearchParams(window.location.hash.split("?")[1]).get("target")
    if (target && document.getElementById(target)) scrollToAnchor(target)
  }, [locationKey, view])
  const [dialog, setDialog] = useState<{ action: Action; preset?: Preset } | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .project(id, role)
      .then((v) => {
        if (!live) return
        setView(v)
        onNow(v.now)
      })
      .catch((e) => {
        if (live) setError(errorText(e))
      })
    return () => {
      live = false
    }
  }, [id, role, refreshKey, onNow])

  useEffect(() => setDialog(null), [role])

  const run = useCallback(
    async (a: Action, params: ActionParams = {}) => {
      if (!view) return false
      setBusy(true)
      try {
        const res = await api.act(view.id, role, a.action, { ...targetParams(a, view), ...params })
        setView(res.view)
        onNow(res.view.now)
        notify("ok", `${actionLabel(a)} 완료`)
        return true
      } catch (e) {
        if (e instanceof ApiError && e.code === "fixture") notify("info", e.message)
        else {
          const code = e instanceof ApiError ? ERROR_CODE_KO[e.code] : undefined
          notify("error", `${code ? `[${code}] ` : ""}${errorText(e)}`)
        }
        return false
      } finally {
        setBusy(false)
      }
    },
    [view, role, notify, onNow],
  )

  const ctx = useMemo<ProjectCtx | null>(
    () => (view ? { view, busy, run, open: (action, preset) => setDialog({ action, preset }) } : null),
    [view, busy, run],
  )

  if (error && !view) {
    return (
      <div className="page">
        <Banner tone="bad" title="프로젝트를 불러오지 못했습니다">
          {error}
        </Banner>
        <button type="button" className="btn" onClick={() => navigate("#/")}>
          목록으로
        </button>
      </div>
    )
  }
  if (!view || !ctx) return <div className="page loading">불러오는 중…</div>

  const timeouts = findAction(view, "run_timeouts")

  return (
    <ProjectContext.Provider value={ctx}>
      <div className="page project">
        <ProjectHeader view={view} />
        {error && <Banner tone="bad">{error}</Banner>}
        <nav className="section-nav" aria-label="프로젝트 메뉴">
          {NAV.map(([key, text]) => (
            <a
              key={key}
              className="nav-chip"
              href={`#/p/${encodeURIComponent(id)}?tab=${key}`}
              aria-current={tab === key ? "page" : undefined}
            >
              {text}
              {key === "overview" && view.actions.some((a) => a.needs_response) && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="project-content">
          {tab === "overview" && (
            <>
              <section className="balance-card" aria-label="대금 요약">
                <div className="balance-main">
                  <span className="balance-label">
                    <Icon name="shield" size={18} />
                    지급을 위해 예약된 대금
                  </span>
                  <Money n={view.ledger.milestone_reserved + view.ledger.expense_reserved} />
                  <button className="linkish small" onClick={() => setLedgerOpen(true)}>
                    자금 내역 <Icon name="arrow" size={14} />
                  </button>
                </div>
                <dl className="balance-details">
                  <div>
                    <dt>지급 완료</dt>
                    <dd>
                      <Money n={view.ledger.released} />
                    </dd>
                  </div>
                  <div>
                    <dt>가용 잔액</dt>
                    <dd>
                      <Money n={view.ledger.available} />
                    </dd>
                  </div>
                </dl>
              </section>
              <TodoCard view={view} />
              <div className="overview-links">
                <a href={`#/p/${encodeURIComponent(id)}?tab=work`}>
                  작업 진행 보기 <Icon name="arrow" size={16} />
                </a>
                <a href={`#/p/${encodeURIComponent(id)}?tab=activity`}>
                  다가오는 기한과 기록 <Icon name="arrow" size={16} />
                </a>
              </div>
            </>
          )}
          {tab === "work" && <MilestonesSection view={view} />}
          {tab === "expenses" && <ExpensesSection view={view} />}
          {tab === "policy" && <PolicyCard view={view} />}
          {/* Keep unsaved change-request edits when switching tabs. */}
          <div className="project-panel" hidden={tab !== "changes"}>
            <ChangeOrdersSection view={view} />
          </div>
          {tab === "activity" && (
            <>
              <DeadlinesCard view={view} />
              <LogCard view={view} />
            </>
          )}
          {tab === "manage" && (
            <>
              <ControlsCard view={view} />
              <ProjectDetails view={view} />
            </>
          )}
        </div>
      </div>
      {ledgerOpen && (
        <Modal title="자금 내역" onClose={() => setLedgerOpen(false)}>
          <LedgerCard view={view} />
        </Modal>
      )}
      {dialog && <ActionDialog action={dialog.action} preset={dialog.preset} onClose={() => setDialog(null)} />}
      {clockSlot &&
        timeouts &&
        createPortal(
          <button
            type="button"
            className="clock-btn clock-secondary"
            disabled={busy}
            onClick={() => run(timeouts)}
            title="기한이 지난 모든 시계에 사전 합의된 침묵 시 결과를 지금 적용합니다 (누구나 실행 가능)"
          >
            경과한 기한 처리
          </button>,
          clockSlot,
        )}
    </ProjectContext.Provider>
  )
}

function ProjectHeader({ view }: { view: ProjectView }) {
  const { navigate } = useApp()
  return (
    <header className="project-head">
      <button type="button" className="linkish small back" onClick={() => navigate("#/")}>
        ← 프로젝트 목록
      </button>
      <div className="project-title">
        <h1>{view.name}</h1>
        <Chip tone={toneOf(PROJECT_TONE, view.status)} title={label(PROJECT_STATUS_HELP, view.status)}>
          {label(PROJECT_STATUS, view.status)}
        </Chip>
        {view.paused && <Chip tone="warn">새 약정 일시정지</Chip>}
      </div>
      <p className="project-subtitle">
        {view.parties.client?.name} <span aria-hidden="true">·</span> {view.parties.contractor?.name}
      </p>
    </header>
  )
}

function ProjectDetails({ view }: { view: ProjectView }) {
  return (
    <section className="card project-details">
      <h2 className="card-title">프로젝트 정보</h2>
      <p className="muted small status-help">{label(PROJECT_STATUS_HELP, view.status)}</p>
      <div className="parties">
        {(["client", "contractor", "resolver"] as const).map((r) => {
          const p = view.parties[r]
          return (
            <div key={r} className={`party ${view.viewer.role === r ? "party-me" : ""}`}>
              <span className="party-role">
                {label(ROLE_KO, r)}
                {view.viewer.role === r && " (나)"}
              </span>
              <span className="party-name">{p?.name}</span>
              {p?.address && <CopyHash hash={p.address} head={6} tail={4} />}
            </div>
          )
        })}
      </div>
      <div className="impl-badges">
        <span className="impl-badge" title="에스크로 컨트랙트가 자금을 집행하는 부분은 아직 목표 설계입니다.">
          체인 집행: 목표 설계 (현재는 서명된 해시 체인 로그)
        </span>
        <span className="muted small">
          프로젝트 {view.id} · 로그 헤드 {shortHash(view.head, 8, 4)}
        </span>
      </div>
    </section>
  )
}
