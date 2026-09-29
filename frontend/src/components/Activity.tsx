// 할 일 (what the viewer must answer), 프로젝트 관리 (project-level controls), 다가오는 기한
// and 기록 (the hash-chained log).

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ago, kst, shortHash, urgency, won } from "../format"
import { ROLE_KO, caption, label } from "../labels"
import type { ProjectView, Role } from "../types"
import { Act, actionLabel, anchorOf, describeTarget, findAction, scrollToAnchor, useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, Empty, When } from "./ui"

export function TodoCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const { open, busy } = useProject()
  const [expanded, setExpanded] = useState(false)
  const mine = view.actions
    .filter((a) => a.needs_response)
    .sort((a, b) => (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER))
  return (
    <Card
      title={t("activity.todo")}
      id="sec-todo"
      className="todo-card"
      sub={mine.length > 0 ? t("activity.nearestFirst") : undefined}
      aside={mine.length > 0 ? <Chip tone="warn">{t("activity.count", { count: mine.length })}</Chip> : <Chip tone="ok">{t("activity.none")}</Chip>}
    >
      {mine.length === 0 ? (
        <Empty>{t("activity.emptyTodo")}</Empty>
      ) : (
        <ul className="todo">
          {(expanded ? mine : mine.slice(0, 3)).map((a, i) => (
            <li
              key={`${a.action}-${a.target?.kind}-${a.target?.id}-${i}`}
              className={`todo-item todo-${urgency(a.deadline, view.now)}`}
            >
              <div className="todo-main">
                <strong className="todo-label">{actionLabel(a)}</strong>
                <button type="button" className="linkish small" onClick={() => scrollToAnchor(anchorOf(a.target))}>
                  {describeTarget(view, a.target)}
                </button>
              </div>
              <div className="todo-when">
                {a.deadline ? <When at={a.deadline} now={view.now} /> : <span className="muted small">{t("activity.noDeadline")}</span>}
              </div>
              {a.fallback && (
                <details className="todo-fallback">
                  <summary>{t("activity.noResponse")}</summary>
                  <p>{caption(a.fallback)}</p>
                </details>
              )}
              <div className="todo-actions">
                <button type="button" className="btn btn-soft" disabled={busy} onClick={() => open(a)}>
                  {t("activity.review")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {mine.length > 3 && (
        <button type="button" className="show-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t("activity.collapse") : t("activity.showMore", { count: mine.length - 3 })}
        </button>
      )}
    </Card>
  )
}

const CAN: Record<Role, { can: string[]; cannot: string[] }> = {
  client: {
    can: ["deposit", "coSign", "pause", "holdReview", "close"],
    cannot: ["cannotCancel", "cannotAddress", "cannotHold"],
  },
  contractor: {
    can: ["coSign", "commitment", "evidence", "cancelUnused", "disputeClose"],
    cannot: ["cannotRelease", "cannotIncrease", "cannotPayee"],
  },
  resolver: {
    can: ["decide"],
    cannot: ["cannotPayee", "cannotCap", "cannotPolicy"],
  },
}

export function ControlsCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const role = view.viewer.role
  const rights = CAN[role]
  const any = ["deposit", "pause", "resume", "begin_close", "cancel_project", "withdraw"].some((n) =>
    findAction(view, n),
  )
  return (
    <Card title={t("activity.controls")} id="sec-controls">
      {view.paused && (
        <Banner tone="warn" title={t("activity.paused")}>
          {t("activity.pausedHelp")}
        </Banner>
      )}
      {view.status === "CLOSING" && (
        <Banner tone="info" title={t("activity.closing")}>
          {t("activity.closingHelp")}
        </Banner>
      )}
      <div className="controls">
        <Control
          name="deposit"
          help={t("activity.depositHelp", { needed: won(view.ledger.funding_needed ?? 0), room: won(view.ledger.deposit_room) })}
          primary
        />
        <Control name="pause" help={t("activity.pauseHelp")} />
        <Control name="resume" help={t("activity.resumeHelp")} />
        <Control
          name="begin_close"
          help={t("activity.closeHelp")}
          danger
        />
        <Control
          name="withdraw"
          help={t("activity.withdrawHelp", { amount: won(view.ledger.available) })}
          primary
        />
        <Control
          name="cancel_project"
          help={t("activity.cancelHelp")}
          danger
        />
        {!any && (
          <p className="muted small">{t("activity.noControls", { role: label(ROLE_KO, role) })}</p>
        )}
      </div>
      <details className="mini-fold">
        <summary>{t("activity.roleRights", { role: label(ROLE_KO, role) })}</summary>
        <div className="rights">
          <div>
            <h4>{t("activity.can")}</h4>
            <ul>
              {rights.can.map((x) => (
                <li key={x}>{t(`activity.rights.${x}`)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>{t("activity.cannot")}</h4>
            <ul className="cannot">
              {rights.cannot.map((x) => (
                <li key={x}>{t(`activity.rights.${x}`)}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="muted small">{t("activity.aiBoundary")}</p>
      </details>
    </Card>
  )
}

function Control({ name, help, primary, danger }: { name: string; help: string; primary?: boolean; danger?: boolean }) {
  const { view } = useProject()
  const a = findAction(view, name)
  if (!a) return null
  return (
    <div className="control">
      <Act name={name} variant={primary ? "primary" : danger ? "danger" : "default"} />
      <span className="muted small">{help}</span>
    </div>
  )
}

export function DeadlinesCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const role = view.viewer.role
  return (
    <Card title={t("activity.deadlines")} id="sec-deadlines" sub={t("activity.deadlineSub")}>
      {view.deadlines.length === 0 && <Empty>{t("activity.noDeadlines")}</Empty>}
      <ol className="timeline">
        {view.deadlines.map((d, i) => (
          <li key={i} className={`tl-item tl-${urgency(d.at, view.now)} ${d.owner === role ? "tl-mine" : ""}`}>
            <span className="tl-dot" aria-hidden />
            <div className="tl-body">
              <div className="tl-head">
                <strong>{caption(d.label)}</strong>
                <Chip tone={d.owner === role ? "accent" : "muted"}>
                  {d.owner === role ? t("activity.myTurn") : label(ROLE_KO, d.owner)}
                </Chip>
              </div>
              <button type="button" className="linkish small" onClick={() => scrollToAnchor(anchorOf(d.target))}>
                {describeTarget(view, d.target)}
              </button>
              <When at={d.at} now={view.now} />
              {d.fallback && <div className="clock-fallback">{t("activity.silence", { fallback: caption(d.fallback) })}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

export function LogCard({ view }: { view: ProjectView }) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const entries = [...view.log].reverse()
  const shown = all ? entries : entries.slice(0, 12)
  return (
    <Card
      title={t("activity.log")}
      id="sec-log"
      sub={t("activity.logSub")}
    >
      <div className="head-line small">
        <span className="muted">{t("activity.currentHead")}</span> <CopyHash hash={view.head} head={10} tail={6} />
      </div>
      {entries.length === 0 && <Empty>{t("activity.noLog")}</Empty>}
      <ol className="log">
        {shown.map((e) => (
          <li key={e.i} className={`log-item ${e.by === "keeper" ? "log-keeper" : ""}`}>
            <div className="log-meta">
              <span className="log-i">#{e.i}</span>
              <Chip tone={e.by === "keeper" ? "accent" : "muted"}>{label(ROLE_KO, e.by)}</Chip>
              <span className="small" title={kst(e.at, view.now)}>
                {kst(e.at, view.now)} · {ago(e.at, view.now)}
              </span>
            </div>
            <div className="log-text">{caption(e.text)}</div>
            <div className="log-foot">
              <code>{e.op}</code>
              <code className="muted" title={e.head}>
                {shortHash(e.head, 8, 4)}
              </code>
            </div>
          </li>
        ))}
      </ol>
      {entries.length > 12 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(!all)}>
          {all ? t("activity.recent") : t("activity.showAll", { count: entries.length })}
        </button>
      )}
    </Card>
  )
}
