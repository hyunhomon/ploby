// A quiet project index: one next action, then the projects themselves.
import { useEffect, useState } from "react"
import { api, errorText } from "../api"
import { PROJECT_STATUS, PROJECT_TONE, label, toneOf } from "../labels"
import type { ProjectSummary } from "../types"
import { Icon } from "./Icon"
import { Banner, Chip, Money, useApp } from "./ui"

const needsOf = (p: ProjectSummary) =>
  p.todo ?? p.needs_response ?? p.actions?.filter((a) => a.needs_response).length ?? 0
const filters = [
  { id: "all", label: "전체" },
  { id: "active", label: "진행 중" },
  { id: "draft", label: "준비 중" },
  { id: "needs", label: "확인 필요" },
] as const

export function Home({ refreshKey }: { refreshKey: number }) {
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
          <p className="eyebrow">{nameOf(role)}의 워크스페이스</p>
          <h1>내 프로젝트</h1>
          <p className="muted">함께하는 일, 약속한 대금. 한곳에서 관리하세요.</p>
        </div>
        {role === "client" && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate("#/new")}>
            <Icon name="plus" size={18} />새 프로젝트
          </button>
        )}
      </section>

      {error ? (
        <Banner tone="bad" title="프로젝트를 불러오지 못했어요">
          <p>{error}</p>
          <button className="btn" onClick={() => setRetry(retry + 1)}>
            다시 시도
          </button>
        </Banner>
      ) : items === null ? (
        <div className="home-skeleton" role="status" aria-label="프로젝트 불러오는 중">
          <div />
          <div />
          <div />
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`attention-strip ${needs === 0 ? "attention-clear" : ""}`}
            onClick={() => setFilter(needs ? "needs" : "all")}
          >
            <span className="attention-icon">
              <Icon name={needs ? "clock" : "check"} size={22} />
            </span>
            <span>
              <strong>{needs ? `확인할 일이 ${needs}건 있어요` : "지금 확인할 일을 모두 마쳤어요"}</strong>
              <span className="attention-description">
                {needs ? "검토와 서명이 필요한 프로젝트를 확인하세요." : "프로젝트가 진행되면 이곳에서 알려드릴게요."}
              </span>
            </span>
            <Icon name="arrow" size={18} />
          </button>

          <section className="projects-section" aria-label="프로젝트 목록">
            <div className="project-toolbar">
              <div className="list-filters" aria-label="프로젝트 필터">
                {filters.map((f) => (
                  <button type="button" key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                    {f.label}
                    <span>{items.filter((p) => matchesFilter(p, f.id)).length}</span>
                  </button>
                ))}
              </div>
              <label className="project-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  placeholder="프로젝트 검색"
                  aria-label="프로젝트 검색"
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
                        {p.paused && <Chip tone="warn">일시정지</Chip>}
                      </span>
                      <span className="project-partner">
                        {role === "contractor" ? p.parties?.client?.name : p.parties?.contractor?.name}
                        {needsOf(p) > 0 && (
                          <span className="needs-label">
                            <span />
                            확인 {needsOf(p)}건
                          </span>
                        )}
                      </span>
                    </span>
                    {p.ledger && (
                      <span className="project-budget">
                        <span>프로젝트 예산</span>
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
                <h2>{items.length === 0 ? "첫 프로젝트를 시작해 보세요" : "일치하는 프로젝트가 없어요"}</h2>
                <p className="muted">
                  {items.length === 0
                    ? role === "client"
                      ? "작업 범위와 대금을 정하고, 함께할 작업자와 약속하세요."
                      : "참여하는 프로젝트가 생기면 이곳에 표시돼요."
                    : "검색어나 필터를 바꿔보세요."}
                </p>
                {items.length > 0 && (
                  <button
                    className="btn"
                    onClick={() => {
                      setFilter("all")
                      setQuery("")
                    }}
                  >
                    전체 프로젝트 보기
                  </button>
                )}
              </div>
            )}
            <p className="list-caption" role="status">
              프로젝트 {visible.length}개
            </p>
          </section>
        </>
      )}
      <div className="home-note">
        <Icon name="shield" size={18} />
        <span>대금 지급은 서로 합의한 조건에 따라 진행돼요.</span>
      </div>
    </div>
  )
}
