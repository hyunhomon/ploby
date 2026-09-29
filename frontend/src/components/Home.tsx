// A quiet project index: one next action, then the projects themselves.
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, errorText } from "../api"
import { PROJECT_STATUS, PROJECT_TONE, label, toneOf } from "../labels"
import type { ProjectSummary } from "../types"
import { Icon } from "./Icon"
import { Banner, Chip, Money, useApp } from "./ui"

const needsOf = (p: ProjectSummary) =>
  p.todo ?? p.needs_response ?? p.actions?.filter((a) => a.needs_response).length ?? 0
const filters = [
  { id: "all", label: "home.filterAll" },
  { id: "active", label: "home.filterActive" },
  { id: "draft", label: "home.filterDraft" },
  { id: "needs", label: "home.filterNeeds" },
] as const

export function Home({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation()
  const { role, navigate, nameOf } = useApp()
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<string>("all")

  useEffect(() => {
    let live = true
    setError(null)
    setItems(null)
    api
      .projects(role)
      .then((list) => live && setItems(Array.isArray(list) ? list : []))
      .catch((e) => {
        if (live) setError(errorText(e))
      })
    return () => {
      live = false
    }
  }, [role, refreshKey, retry])

  const needs = (items ?? []).reduce((total, p) => total + needsOf(p), 0)
  const waiting = (items ?? []).filter((p) => needsOf(p) > 0)
  const openAttention = () => {
    if (waiting.length === 1) {
      navigate(`#/p/${encodeURIComponent(waiting[0].id)}`)
      return
    }
    if (waiting.length > 1) {
      if (filter === "needs" && !query.trim()) navigate(`#/p/${encodeURIComponent(waiting[0].id)}`)
      else {
        setQuery("")
        setFilter("needs")
      }
      return
    }
    setFilter("all")
    setQuery("")
  }
  const matchesFilter = (p: ProjectSummary, id: string) =>
    id === "all" ||
    (id === "active" && ["ACTIVE", "CLOSING"].includes(p.status)) ||
    (id === "draft" && p.status === "DRAFT") ||
    (id === "needs" && needsOf(p) > 0)
  const visible = (items ?? []).filter(
    (p) =>
      matchesFilter(p, filter) &&
      `${p.name} ${p.parties?.client?.name ?? ""} ${p.parties?.contractor?.name ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  )

  return (
    <div className="page home">
      <section className="hero">
        <div>
          <p className="eyebrow">{t("home.workspace", { name: nameOf(role) })}</p>
          <h1>{t("home.title")}</h1>
          <p className="muted">{t("home.subtitle")}</p>
        </div>
        {role === "client" && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate("#/new")}>
            <Icon name="plus" size={18} /> {t("home.newProject")}
          </button>
        )}
      </section>

      {error ? (
        <Banner tone="bad" title={t("home.loadError")}>
          <p>{error}</p>
          <button className="btn" onClick={() => setRetry(retry + 1)}>
            {t("common.retry")}
          </button>
        </Banner>
      ) : items === null ? (
        <div className="home-skeleton" role="status" aria-label={t("home.loading")}>
          <div />
          <div />
          <div />
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`attention-strip ${needs === 0 ? "attention-clear" : ""}`}
            onClick={openAttention}
          >
            <span className="attention-icon">
              <Icon name={needs ? "clock" : "check"} size={22} />
            </span>
            <span>
              <strong>{needs ? t("home.attention", { count: needs }) : t("home.attentionClear")}</strong>
              <span className="attention-description">
                {needs ? t("home.attentionDescription") : t("home.attentionClearDescription")}
              </span>
            </span>
            <Icon name="arrow" size={18} />
          </button>

          <section className="projects-section" aria-label={t("home.list")}>
            <div className="project-toolbar">
              <div className="list-filters" aria-label={t("home.filterLabel")}>
                {filters.map((f) => (
                  <button type="button" key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                    {t(f.label)}
                    <span>{items.filter((p) => matchesFilter(p, f.id)).length}</span>
                  </button>
                ))}
              </div>
              <label className="project-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  placeholder={t("home.search")}
                  aria-label={t("home.search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            <ul className="project-list">
              {visible.map((p) => (
                <li key={p.id}>
                  <a className="project-row" href={`#/p/${encodeURIComponent(p.id)}`}>
                    <span className={`project-symbol ${p.status === "DRAFT" ? "project-symbol-draft" : ""}`}>
                      <Icon name="folder" size={24} />
                    </span>
                    <span className="project-identity">
                      <span className="pr-head">
                        <strong className="pr-name">{p.name}</strong>
                        <Chip tone={toneOf(PROJECT_TONE, p.status)}>{label(PROJECT_STATUS, p.status)}</Chip>
                        {p.paused && <Chip tone="warn">{t("common.paused")}</Chip>}
                      </span>
                      <span className="project-partner">
                        {role === "contractor" ? p.parties?.client?.name : p.parties?.contractor?.name}
                        {needsOf(p) > 0 && (
                          <span className="needs-label">
                            <span />
                            {t("home.needs", { count: needsOf(p) })}
                          </span>
                        )}
                      </span>
                    </span>
                    {p.ledger && (
                      <span className="project-budget">
                        <span>{t("home.budget")}</span>
                        <Money n={p.ledger.budget} />
                      </span>
                    )}
                    <Icon name="arrow" size={18} />
                  </a>
                </li>
              ))}
            </ul>
            {visible.length === 0 && (
              <div className="empty-state">
                <span className="empty-state-icon">
                  <Icon name="folder" size={28} />
                </span>
                <h2>{items.length === 0 ? t("home.firstProject") : t("home.noMatches")}</h2>
                <p className="muted">
                  {items.length === 0
                    ? role === "client"
                      ? t("home.clientEmpty")
                      : t("home.memberEmpty")
                    : t("home.changeSearch")}
                </p>
                {items.length > 0 && (
                  <button
                    className="btn"
                    onClick={() => {
                      setFilter("all")
                      setQuery("")
                    }}
                  >
                    {t("home.showAll")}
                  </button>
                )}
              </div>
            )}
            <p className="list-caption" role="status">
              {t("home.count", { count: visible.length })}
            </p>
          </section>
        </>
      )}
      <div className="home-note">
        <Icon name="shield" size={18} />
        <span>{t("home.escrowNotice")}</span>
      </div>
    </div>
  )
}
