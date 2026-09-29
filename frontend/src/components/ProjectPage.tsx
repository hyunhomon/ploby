// The project page: one ProjectView for the current role. Every button goes through `run`,
// which posts the action and replaces the view with the server's answer.

import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
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
  ["overview", "project.tabs.overview"],
  ["work", "project.tabs.work"],
  ["expenses", "project.tabs.expenses"],
  ["policy", "project.tabs.policy"],
  ["changes", "project.tabs.changes"],
  ["activity", "project.tabs.activity"],
  ["manage", "project.tabs.manage"],
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
  const { t } = useTranslation()
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

  useEffect(() => {
    if (view?.chain?.status !== "confirming") return
    const timer = window.setInterval(() => {
      api
        .project(id, role)
        .then((v) => {
          setView(v)
          onNow(v.now)
        })
        .catch(() => {})
    }, 4000)
    return () => window.clearInterval(timer)
  }, [view?.chain?.status, id, role, onNow])

  const run = useCallback(
    async (a: Action, params: ActionParams = {}) => {
      if (!view) return false
      setBusy(true)
      try {
        const res = await api.act(view.id, role, a.action, { ...targetParams(a, view), ...params })
        setView(res.view)
        onNow(res.view.now)
        notify("ok", t("project.actionDone", { action: actionLabel(a) }))
        return true
      } catch (e) {
        if (e instanceof ApiError && e.code === "fixture") notify("info", e.message)
        else {
          const code = e instanceof ApiError ? label(ERROR_CODE_KO, e.code) : undefined
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
        <Banner tone="bad" title={t("project.loadError")}>
          {error}
        </Banner>
        <button type="button" className="btn" onClick={() => navigate("#/")}>
          {t("project.backToList")}
        </button>
      </div>
    )
  }
  if (!view || !ctx) return <div className="page loading">{t("common.loading")}</div>

  const timeouts = findAction(view, "run_timeouts")

  return (
    <ProjectContext.Provider value={ctx}>
      <div className="page project">
        <ProjectHeader view={view} />
        <ChainBanner
          view={view}
          onView={(v) => {
            setView(v)
            onNow(v.now)
          }}
        />
        {error && <Banner tone="bad">{error}</Banner>}
        <nav className="section-nav" aria-label={t("project.menu")}>
          {NAV.map(([key, text]) => (
            <a
              key={key}
              className="nav-chip"
              href={`#/p/${encodeURIComponent(id)}?tab=${key}`}
              aria-current={tab === key ? "page" : undefined}
            >
              {t(text)}
              {key === "overview" && view.actions.some((a) => a.needs_response) && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="project-content">
          {tab === "overview" && (
            <>
              <section className="balance-card" aria-label={t("project.balanceSummary")}>
                <div className="balance-main">
                  <span className="balance-label">
                    <Icon name="shield" size={18} />
                    {t("project.reserved")}
                  </span>
                  <Money n={view.ledger.milestone_reserved + view.ledger.expense_reserved} />
                  <button className="linkish small" onClick={() => setLedgerOpen(true)}>
                    {t("project.ledger")} <Icon name="arrow" size={14} />
                  </button>
                </div>
                <dl className="balance-details">
                  <div>
                    <dt>{t("project.released")}</dt>
                    <dd>
                      <Money n={view.ledger.released} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("project.available")}</dt>
                    <dd>
                      <Money n={view.ledger.available} />
                    </dd>
                  </div>
                </dl>
              </section>
              <ChainCard view={view} />
              <TodoCard view={view} />
              <div className="overview-links">
                <a href={`#/p/${encodeURIComponent(id)}?tab=work`}>
                  {t("project.viewWork")} <Icon name="arrow" size={16} />
                </a>
                <a href={`#/p/${encodeURIComponent(id)}?tab=activity`}>
                  {t("project.deadlinesAndLog")} <Icon name="arrow" size={16} />
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
        <Modal title={t("project.ledger")} onClose={() => setLedgerOpen(false)}>
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
            title={t("project.applyTimeoutsHelp")}
          >
            {t("project.applyTimeouts")}
          </button>,
          clockSlot,
        )}
    </ProjectContext.Provider>
  )
}

function ProjectHeader({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const { navigate } = useApp()
  return (
    <header className="project-head">
      <button type="button" className="linkish small back" onClick={() => navigate("#/")}>
        ← {t("project.projectList")}
      </button>
      <div className="project-title">
        <h1>{view.name}</h1>
        <Chip tone={toneOf(PROJECT_TONE, view.status)} title={label(PROJECT_STATUS_HELP, view.status)}>
          {label(PROJECT_STATUS, view.status)}
        </Chip>
        {view.paused && <Chip tone="warn">{t("project.paused")}</Chip>}
      </div>
      <p className="project-subtitle">
        {view.parties.client?.name} <span aria-hidden="true">·</span> {view.parties.contractor?.name}
      </p>
    </header>
  )
}

function chainBadge(view: ProjectView, t: (key: string) => string): string {
  if (!view.chain?.enabled) return t("project.chainOff")
  if (view.chain.status === "confirming" && !view.chain.depositTx) return t("project.chainConfirming")
  if (view.chain.status === "confirming") return t("project.chainRecording")
  if (view.chain.status === "error") return t("project.chainErrorTitle")
  return t("project.chainTarget")
}

function ChainBanner({ view, onView }: { view: ProjectView; onView: (view: ProjectView) => void }) {
  const { t } = useTranslation()
  const { role } = useApp()
  const [busy, setBusy] = useState(false)
  const chain = view.chain
  if (!chain?.enabled) return null
  const confirming = chain.status === "confirming"
  const failed = !confirming && (chain.status === "error" || !!chain.error)
  if (!confirming && !failed) return null
  const explorer = chain.explorer || "https://sepolia.basescan.org"
  const tx = chain.lastTx && /^0x[0-9a-fA-F]{64}$/.test(chain.lastTx) ? chain.lastTx : null
  const retry = async () => {
    setBusy(true)
    try {
      onView(await api.retryChain(view.id, role))
    } finally {
      setBusy(false)
    }
  }
  if (confirming) {
    return (
      <Banner tone="info" title={chain.depositTx ? t("project.chainRecording") : t("project.chainConfirming")} />
    )
  }
  return (
    <Banner tone="warn" title={t("project.chainErrorTitle")}>
      <p>{chain.error}</p>
      {tx && (
        <a href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer">
          {t("project.chainLastTx")} {shortHash(tx, 6, 4)}
        </a>
      )}
      <div>
        <button type="button" className="btn btn-soft btn-sm" disabled={busy} onClick={() => void retry()}>
          {busy ? t("dialogs.working") : t("project.chainRetry")}
        </button>
      </div>
    </Banner>
  )
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

function ChainCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const chain = view.chain
  if (!chain?.enabled) return null
  const explorer = chain.explorer || "https://sepolia.basescan.org"
  const steps: { key: string; label: string; hash: string | null; wait: string }[] = [
    {
      key: "mint",
      label: t("project.chainMint"),
      hash: chain.mintTx && TX_HASH.test(chain.mintTx) ? chain.mintTx : null,
      wait: t("project.chainNotSent"),
    },
    {
      key: "approve",
      label: t("project.chainApprove"),
      hash: chain.approveTx && TX_HASH.test(chain.approveTx) ? chain.approveTx : null,
      wait: t("project.chainNotSent"),
    },
    {
      key: "create",
      label: t("project.chainCreate"),
      hash: chain.createTx && TX_HASH.test(chain.createTx) ? chain.createTx : null,
      wait: chain.createTx === "already-created" ? t("project.chainAlready") : t("project.chainWhenStart"),
    },
    {
      key: "deposit",
      label: t("project.chainDepositStep"),
      hash: chain.depositTx && TX_HASH.test(chain.depositTx) ? chain.depositTx : null,
      wait: t("project.chainWhenStart"),
    },
  ]
  for (const [id, rec] of Object.entries(chain.expenses ?? {})) {
    for (const [label, hash] of [
      [t("project.chainDecision"), rec.recordTx],
      [t("project.chainHold"), rec.approveTx],
      [t("project.chainReject"), rec.rejectTx],
      [t("project.chainRelease"), rec.releaseTx],
    ] as const) {
      if (hash && TX_HASH.test(hash)) steps.push({ key: `${id}-${label}`, label: `${id} · ${label}`, hash, wait: "" })
    }
  }
  const accounts = [
    [t("project.chainContract"), chain.escrow],
    [t("project.chainUsdc"), chain.usdc],
    [t("project.chainClient"), chain.client],
    [t("project.chainPayee"), chain.payee || chain.payeeWallet || null],
  ] as const
  return (
    <section className="card chain-card">
      <h2 className="card-title">{t("project.chainCard")}</h2>
      <p className="muted small">{t("project.chainCardSub")}</p>
      <ol className="chain-steps">
        {steps.map((step) => (
          <li key={step.key}>
            <span className={step.hash ? "chain-done" : undefined}>{step.label}</span>
            {step.hash ? (
              <a href={`${explorer}/tx/${step.hash}`} target="_blank" rel="noreferrer">
                {t("project.chainViewTx")}
              </a>
            ) : (
              <span className="muted small">{step.wait}</span>
            )}
          </li>
        ))}
      </ol>
      <div className="chain-accounts">
        {accounts.map(([label, address]) =>
          address ? (
            <a key={label} href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
              {label}
            </a>
          ) : null,
        )}
      </div>
    </section>
  )
}

function ProjectDetails({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  return (
    <section className="card project-details">
      <h2 className="card-title">{t("project.details")}</h2>
      <p className="muted small status-help">{label(PROJECT_STATUS_HELP, view.status)}</p>
      <div className="parties">
        {(["client", "contractor", "resolver"] as const).map((r) => {
          const p = view.parties[r]
          return (
            <div key={r} className={`party ${view.viewer.role === r ? "party-me" : ""}`}>
              <span className="party-role">
                {label(ROLE_KO, r)}
                {view.viewer.role === r && ` (${t("common.me")})`}
              </span>
              <span className="party-name">{p?.name}</span>
              {p?.address && <CopyHash hash={p.address} head={6} tail={4} />}
            </div>
          )
        })}
      </div>
      <div className="impl-badges">
        <span className="impl-badge" title={view.chain?.enabled ? t("project.chainTitle") : t("project.chainOffTitle")}>
          {chainBadge(view, t)}
        </span>
        <span className="muted small">
          {t("project.logHead", { id: view.id, head: shortHash(view.head, 8, 4) })}
        </span>
      </div>
    </section>
  )
}
