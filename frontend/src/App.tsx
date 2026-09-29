// Shell: top bar with the role switcher (stands in for wallet login), the demo clock
// toolbar, a tiny hash router (#/, #/new, #/p/{id}), toasts and the 구현 범위 panel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, errorText, FIXTURE } from "./api"
import { Home } from "./components/Home"
import { NewProject } from "./components/NewProject"
import { ProjectPage } from "./components/ProjectPage"
import { AppContext, DocViewer, Modal, type AppCtx, type ToastKind } from "./components/ui"
import { kst } from "./format"
import { LANGUAGES, tr, type AppLanguage } from "./i18n"
import { ROLE_KO, ROLE_NAME, ROLES, label } from "./labels"
import type { Clock, DocRef, Meta, Role } from "./types"

const ROLE_KEY = "ploby.role"

/** `#/p/…?as=contractor` pins a window to a role (two windows side by side share localStorage). */
function roleInUrl(): Role | null {
  const r = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("as")
  return r === "client" || r === "contractor" || r === "resolver" ? r : null
}

function loadRole(): Role {
  const pinned = roleInUrl()
  if (pinned) return pinned
  try {
    const r = window.localStorage.getItem(ROLE_KEY)
    if (r === "client" || r === "contractor" || r === "resolver") return r
  } catch {
    /* storage unavailable */
  }
  return "client"
}

function saveRole(r: Role) {
  try {
    window.localStorage.setItem(ROLE_KEY, r)
  } catch {
    /* storage unavailable */
  }
}

type Route = { page: "home" } | { page: "new" } | { page: "project"; id: string }

function parseHash(): Route {
  const h = window.location.hash.replace(/^#/, "")
  const m = h.match(/^\/p\/([^?]+)(?:\?.*)?$/)
  if (m) {
    try {
      return { page: "project", id: decodeURIComponent(m[1]) }
    } catch {
      return { page: "home" }
    }
  }
  if (h === "/new") return { page: "new" }
  return { page: "home" }
}

interface Toast {
  id: number
  kind: ToastKind
  text: string
}

const STEPS: [string, number][] = [
  ["app.addHour", 3600],
  ["app.addDay", 86400],
  ["app.addThreeDays", 3 * 86400],
  ["app.addWeek", 7 * 86400],
]

function offsetText(offset: number): string {
  // The contract gives `offset` without a unit; the demo clock uses milliseconds everywhere.
  const ms = Math.abs(offset)
  if (ms < 60_000) return ""
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const parts = [d ? tr("common.day", { count: d }) : "", h ? tr("common.hour", { count: h }) : ""]
    .filter(Boolean)
    .join(" ")
  return parts ? `${offset < 0 ? "−" : "+"}${parts}` : ""
}

export function App() {
  const { t, i18n } = useTranslation()
  const [role, setRoleState] = useState<Role>(loadRole)
  const [route, setRoute] = useState<Route>(parseHash)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [clock, setClock] = useState<Clock | null>(null)
  const [viewNow, setViewNow] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [doc, setDoc] = useState<DocRef | null>(null)
  const [clockBusy, setClockBusy] = useState(false)
  const [implOpen, setImplOpen] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [clockSlot, setClockSlot] = useState<HTMLElement | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastId.current
    setToasts((t) => [...t.slice(-3), { id, kind, text }])
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === "error" ? 9000 : kind === "info" ? 7000 : 3500,
    )
  }, [])

  useEffect(() => {
    const on = () => {
      setRoute(parseHash())
      window.scrollTo(0, 0)
    }
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])

  useEffect(() => {
    api
      .meta()
      .then(setMeta)
      .catch(() => setMeta(null))
    api
      .clock()
      .then(setClock)
      .catch(() => setClock(null))
  }, [])

  const setRole = (r: Role) => {
    setRoleState(r)
    saveRole(r)
    if (roleInUrl()) {
      const [path, query = ""] = window.location.hash.split("?")
      const q = new URLSearchParams(query)
      q.set("as", r)
      window.history.replaceState(null, "", `${path}?${q.toString()}`)
    }
  }

  const navigate = useCallback((hash: string) => {
    if (window.location.hash === hash) setRoute(parseHash())
    else window.location.hash = hash
  }, [])

  const moveClock = async (body: { advance: number } | { reset: true }) => {
    setClockBusy(true)
    try {
      const c = await api.moveClock(body)
      setClock(c)
      setViewNow(null)
      setTick((t) => t + 1)
    } catch (e) {
      notify("error", errorText(e))
    } finally {
      setClockBusy(false)
    }
  }

  const onNow = useCallback((now: number) => setViewNow(now), [])
  const now = viewNow ?? clock?.now ?? Date.now()

  const nameOf = useCallback((r: Role) => meta?.roles?.find((p) => p.role === r)?.name ?? ROLE_NAME[r], [meta])

  const ctx = useMemo<AppCtx>(
    () => ({ role, meta, now, notify, navigate, openDoc: setDoc, nameOf, clockSlot }),
    [role, meta, now, notify, navigate, nameOf, clockSlot],
  )

  return (
    <AppContext.Provider value={ctx}>
      <div className="app" data-role={role}>
        <a
          className="skip-link"
          href="#main-content"
          onClick={(e) => {
            e.preventDefault()
            document.getElementById("main-content")?.focus()
          }}
        >
          {t("app.skip")}
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <a className="brand" href="#/" aria-label={t("app.home")}>
              <span className="brand-mark" aria-hidden="true">
                p
              </span>
              <span className="brand-name">
                ploby<span className="brand-period">.</span>
              </span>
            </a>
            <nav className="global-nav" aria-label={t("app.mainMenu")}>
              <a href="#/" aria-current={route.page !== "new" ? "page" : undefined}>
                {t("app.projects")}
              </a>
            </nav>
            <div className="account-tools">
              <button
                type="button"
                className="demo-toggle"
                aria-expanded={demoOpen}
                aria-controls="demo-tools"
                onClick={() => setDemoOpen(!demoOpen)}
              >
                <span className="demo-dot" />
                <span className="desktop-only">{t("app.demoTools")}</span>
                <span className="mobile-only">Demo</span>
              </button>
              <label className="language-select">
                <span className="sr-only">{t("common.language")}</span>
                <select
                  value={(i18n.resolvedLanguage ?? i18n.language).startsWith("en") ? "en" : "ko"}
                  onChange={(e) => void i18n.changeLanguage(e.target.value as AppLanguage)}
                  aria-label={t("common.language")}
                >
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language === "ko" ? t("common.korean") : t("common.english")}
                    </option>
                  ))}
                </select>
              </label>
              <div className="account">
                <span className="avatar" aria-hidden="true">
                  {nameOf(role).slice(0, 1)}
                </span>
                <label className="role-select">
                  <span className="account-name">{nameOf(role)}</span>
                  <span className="sr-only">{t("app.demoRole")}</span>
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option value={r} key={r}>
                        {label(ROLE_KO, r)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </div>
        </header>

        <div className="democlock" id="demo-tools" hidden={!demoOpen} role="region" aria-label={t("app.demoClock")}>
          <div className="democlock-inner">
            <span className="demo-tag">{t("app.demoOnly")}</span>
            <span className="democlock-label">{t("app.demoClock")}</span>
            <strong className="democlock-now">{clock ? kst(clock.now) : viewNow ? kst(viewNow) : "—"}</strong>
            {clock && offsetText(clock.offset) && (
              <span className="democlock-offset">({offsetText(clock.offset)})</span>
            )}
            <span className="democlock-btns">
              {STEPS.map(([key, s]) => (
                <button
                  key={key}
                  type="button"
                  className="clock-btn"
                  disabled={clockBusy}
                  onClick={() => moveClock({ advance: s })}
                >
                  {t(key)}
                </button>
              ))}
              <button
                type="button"
                className="clock-btn clock-reset"
                disabled={clockBusy}
                onClick={() => moveClock({ reset: true })}
              >
                {t("app.reset")}
              </button>
            </span>
            <span className="democlock-extra" ref={setClockSlot} />
            {FIXTURE && <span className="demo-tag demo-fixture">{t("app.fixture")}</span>}
          </div>
        </div>

        <main className="main" id="main-content" tabIndex={-1}>
          {route.page === "home" && <Home key={role} refreshKey={tick} />}
          {route.page === "new" && <NewProject />}
          {route.page === "project" && (
            <ProjectPage key={`${route.id}-${role}`} id={route.id} refreshKey={tick} onNow={onNow} />
          )}
        </main>

        <footer className="footer">
          <button type="button" className="linkish" onClick={() => setImplOpen(true)}>
            {t("app.serviceInfo")}
          </button>
          <span className="muted small">{t("app.demoNotice")}</span>
        </footer>

        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`toast toast-${t.kind}`}
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              role={t.kind === "error" ? "alert" : "status"}
            >
              {t.text}
            </button>
          ))}
        </div>

        {doc && <DocViewer doc={doc} onClose={() => setDoc(null)} />}
        {implOpen && <ImplementationPanel meta={meta} onClose={() => setImplOpen(false)} />}
      </div>
    </AppContext.Provider>
  )
}

function ImplementationPanel({ meta, onClose }: { meta: Meta | null; onClose: () => void }) {
  const { t } = useTranslation()
  const impl = meta?.implementation
  return (
    <Modal title={t("app.implementationTitle")} onClose={onClose} wide>
      <p className="muted small">{t("app.implementationDescription")}</p>
      {!impl ? (
        <p className="muted">{t("app.implementationUnavailable")}</p>
      ) : (
        <div className="impl">
          <section>
            <h3>
              <span className="impl-dot impl-current" aria-hidden /> {t("app.currentImplementation")}
            </h3>
            <ul>
              {impl.current.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3>
              <span className="impl-dot impl-target" aria-hidden /> {t("app.targetDesign")}
            </h3>
            <ul>
              {impl.target.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  )
}
