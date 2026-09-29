// Home: the current role's projects with status, money and how many things wait for them.

import { useEffect, useState } from "react"
import { api, errorText, FIXTURE } from "../api"
import { kst, timeLeft, won } from "../format"
import { PROJECT_STATUS, PROJECT_STATUS_HELP, PROJECT_TONE, ROLE_INTRO, ROLE_KO, label, toneOf } from "../labels"
import type { ProjectSummary } from "../types"
import { Banner, Chip, Empty, useApp } from "./ui"

export function Home({ refreshKey }: { refreshKey: number }) {
  const { role, navigate, now, nameOf } = useApp()
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .projects(role)
      .then((list) => live && setItems(Array.isArray(list) ? list : []))
      .catch((e) => {
        if (!live) return
        setError(errorText(e))
        setItems([])
      })
    return () => {
      live = false
    }
  }, [role, refreshKey])

  return (
    <div className="page home">
      <section className="hero">
        <div>
          <p className="eyebrow">
            {label(ROLE_KO, role)} · {nameOf(role)}
          </p>
          <h1>내 프로젝트</h1>
          <p className="muted">{ROLE_INTRO[role]}</p>
        </div>
        {role === "client" && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate("#/new")}>
            + 새 프로젝트
          </button>
        )}
      </section>

      {error && (
        <Banner tone="bad" title="프로젝트 목록을 불러오지 못했습니다">
          {error}
          {!FIXTURE && (
            <p className="small">
              백엔드 없이 화면만 보려면 주소 끝에 <code>?fixture=1</code>을 붙이세요.
            </p>
          )}
        </Banner>
      )}

      {items === null && <p className="muted loading">불러오는 중…</p>}
      {items !== null && items.length === 0 && !error && (
        <Empty>{role === "client" ? "아직 프로젝트가 없습니다. ‘새 프로젝트’로 정책을 만들어 작업자에게 서명을 요청하세요." : "참여 중인 프로젝트가 없습니다."}</Empty>
      )}

      <ul className="project-list">
        {(items ?? []).map((p) => {
          const needs = p.todo ?? p.needs_response ?? (p.actions ? p.actions.filter((a) => a.needs_response).length : 0)
          const l = p.ledger
          return (
            <li key={p.id}>
              <button type="button" className="project-row" onClick={() => navigate(`#/p/${encodeURIComponent(p.id)}`)}>
                <div className="pr-head">
                  <strong className="pr-name">{p.name}</strong>
                  <Chip tone={toneOf(PROJECT_TONE, p.status)} title={label(PROJECT_STATUS_HELP, p.status)}>
                    {label(PROJECT_STATUS, p.status)}
                  </Chip>
                  {p.paused && <Chip tone="warn">새 약정 일시정지</Chip>}
                  <span className="pr-spacer" />
                  {needs > 0 ? <Chip tone="warn">응답 필요 {needs}건</Chip> : <Chip tone="muted">응답할 일 없음</Chip>}
                </div>
                {p.parties && (
                  <div className="muted small">
                    {(["client", "contractor"] as const)
                      .map((r) => (p.parties?.[r] ? `${label(ROLE_KO, r)} ${p.parties[r]?.name}` : null))
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
                {l && (
                  <div className="pr-money">
                    <span>
                      <span className="muted">예산</span> {won(l.budget)}
                    </span>
                    <span>
                      <span className="muted">예치</span> {won(l.funded)}
                    </span>
                    <span>
                      <span className="muted">예약</span> {won((l.milestone_reserved ?? 0) + (l.expense_reserved ?? 0))}
                    </span>
                    <span>
                      <span className="muted">지급</span> {won(l.released)}
                    </span>
                    <span>
                      <span className="muted">가용</span> {won(l.available)}
                    </span>
                  </div>
                )}
                {p.next_deadline && (
                  <div className="small">
                    <span className="muted">다음 기한</span> {p.next_deadline.label} · {kst(p.next_deadline.at, now)} ({timeLeft(p.next_deadline.at, now)})
                  </div>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
