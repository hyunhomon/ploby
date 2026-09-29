// 할 일 (what the viewer must answer), 프로젝트 관리 (project-level controls), 다가오는 기한
// and 기록 (the hash-chained log).

import { useState } from "react"
import { ago, kst, shortHash, urgency, won } from "../format"
import { ROLE_KO, label } from "../labels"
import type { ProjectView, Role } from "../types"
import { Act, actionLabel, anchorOf, describeTarget, findAction, scrollToAnchor, useProject } from "./projectCtx"
import { Banner, Card, Chip, CopyHash, Empty, When } from "./ui"

export function TodoCard({ view }: { view: ProjectView }) {
  const { open, busy } = useProject()
  const [expanded, setExpanded] = useState(false)
  const mine = view.actions
    .filter((a) => a.needs_response)
    .sort((a, b) => (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER))
  return (
    <Card
      title="확인할 일"
      id="sec-todo"
      className="todo-card"
      sub={mine.length > 0 ? "가까운 기한부터 확인하세요." : undefined}
      aside={mine.length > 0 ? <Chip tone="warn">{mine.length}건</Chip> : <Chip tone="ok">없음</Chip>}
    >
      {mine.length === 0 ? (
        <Empty>지금은 확인할 일이 없어요. 기한과 진행 내역은 ‘기록’에서 볼 수 있어요.</Empty>
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
                {a.deadline ? <When at={a.deadline} now={view.now} /> : <span className="muted small">기한 없음</span>}
              </div>
              {a.fallback && (
                <details className="todo-fallback">
                  <summary>기한 내 응답하지 않으면</summary>
                  <p>{a.fallback}</p>
                </details>
              )}
              <div className="todo-actions">
                <button type="button" className="btn btn-soft" disabled={busy} onClick={() => open(a)}>
                  확인하기
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {mine.length > 3 && (
        <button type="button" className="show-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "접기" : `확인할 일 ${mine.length - 3}개 더 보기`}
        </button>
      )}
    </Card>
  )
}

const CAN: Record<Role, { can: string[]; cannot: string[] }> = {
  client: {
    can: ["입금", "정책 공동 수락", "새 약정 일시정지", "HOLD 검토", "종료 시작"],
    cannot: ["수락된 약정 취소", "지급 주소 변경", "무기한 지급 보류"],
  },
  contractor: {
    can: ["정책 공동 수락", "약정 요청", "증빙 제출", "미사용 예약 취소", "분쟁·종료 시작"],
    cannot: ["자금 직접 해제", "약정 증액", "수취인 변경"],
  },
  resolver: {
    can: ["기존 의무와 분쟁 금액 안에서 결정"],
    cannot: ["수취인 변경", "금액 상한 초과", "정책 수정"],
  },
}

export function ControlsCard({ view }: { view: ProjectView }) {
  const role = view.viewer.role
  const rights = CAN[role]
  const any = ["deposit", "pause", "resume", "begin_close", "cancel_project", "withdraw"].some((n) =>
    findAction(view, n),
  )
  return (
    <Card title="프로젝트 관리" id="sec-controls">
      {view.paused && (
        <Banner tone="warn" title="새 약정 일시정지 중">
          새 약정만 막혀 있습니다. 이미 수락된 약정의 제출·검수·정산은 계속 진행됩니다.
        </Banner>
      )}
      {view.status === "CLOSING" && (
        <Banner tone="info" title="종료 중 (새 약정 불가)">
          기존 약정과 분쟁이 끝나고 미예약 잔액이 환불되면 종료(CLOSED)됩니다.
        </Banner>
      )}
      <div className="controls">
        <Control
          name="deposit"
          help={`입금 필요 ${won(view.ledger.funding_needed ?? 0)} · 최대 입금 가능 ${won(view.ledger.deposit_room)}`}
          primary
        />
        <Control name="pause" help="새 약정만 멈춥니다. 기존 약정은 계속 진행·지급됩니다." />
        <Control name="resume" help="새 약정을 다시 허용합니다." />
        <Control
          name="begin_close"
          help="새 약정이 불가해지고, 기존 약정은 끝까지 처리됩니다. 예약되지 않은 금액만 환불됩니다."
          danger
        />
        <Control
          name="withdraw"
          help={`예약되지 않은 가용 잔액 ${won(view.ledger.available)}만 환불받을 수 있습니다.`}
          primary
        />
        <Control
          name="cancel_project"
          help="초안(DRAFT)에서만 가능합니다. 입금된 금액은 환불받을 수 있게 됩니다."
          danger
        />
        {!any && (
          <p className="muted small">지금 {label(ROLE_KO, role)}이(가) 할 수 있는 프로젝트 관리 작업이 없습니다.</p>
        )}
      </div>
      <details className="mini-fold">
        <summary>{label(ROLE_KO, role)}의 권한</summary>
        <div className="rights">
          <div>
            <h4>할 수 있는 일</h4>
            <ul>
              {rights.can.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>할 수 없는 일</h4>
            <ul className="cannot">
              {rights.cannot.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="muted small">AI는 필드 추출과 분류 제안만 합니다. 서명·승인·지급·분쟁 결정은 하지 않습니다.</p>
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
  const role = view.viewer.role
  return (
    <Card title="다가오는 기한" id="sec-deadlines" sub="모든 역할의 시계 · 빠른 순">
      {view.deadlines.length === 0 && <Empty>흐르고 있는 기한이 없습니다.</Empty>}
      <ol className="timeline">
        {view.deadlines.map((d, i) => (
          <li key={i} className={`tl-item tl-${urgency(d.at, view.now)} ${d.owner === role ? "tl-mine" : ""}`}>
            <span className="tl-dot" aria-hidden />
            <div className="tl-body">
              <div className="tl-head">
                <strong>{d.label}</strong>
                <Chip tone={d.owner === role ? "accent" : "muted"}>
                  {d.owner === role ? "내 차례" : label(ROLE_KO, d.owner)}
                </Chip>
              </div>
              <button type="button" className="linkish small" onClick={() => scrollToAnchor(anchorOf(d.target))}>
                {describeTarget(view, d.target)}
              </button>
              <When at={d.at} now={view.now} />
              {d.fallback && <div className="clock-fallback">침묵 시: {d.fallback}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

export function LogCard({ view }: { view: ProjectView }) {
  const [all, setAll] = useState(false)
  const entries = [...view.log].reverse()
  const shown = all ? entries : entries.slice(0, 12)
  return (
    <Card
      title="기록"
      id="sec-log"
      sub="모든 상태 변경은 해시 체인 로그에 남습니다. 기한 자동 처리는 ‘타임아웃 실행 (keeper)’로 표시됩니다."
    >
      <div className="head-line small">
        <span className="muted">현재 헤드</span> <CopyHash hash={view.head} head={10} tail={6} />
      </div>
      {entries.length === 0 && <Empty>기록이 없습니다.</Empty>}
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
            <div className="log-text">{e.text}</div>
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
          {all ? "최근 12개만" : `모두 보기 (${entries.length})`}
        </button>
      )}
    </Card>
  )
}
