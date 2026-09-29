// The project page's shared state: the current view, the action runner, and helpers that
// render an action only when the server listed it in `view.actions`.

import { createContext, useContext, type ReactNode } from "react"
import type { ActionParams } from "../api"
import { ACTION_KO, label } from "../labels"
import type { Action, Deadline, ProjectView, Target, TargetKind } from "../types"

/** Values a dialog can be opened with (e.g. an out-of-scope item for a change-order draft). */
export interface Preset {
  text?: string
  approve?: boolean
  /** draft_change_order: the expense whose excess the order covers. */
  covers_excess?: string
}

export interface ProjectCtx {
  view: ProjectView
  busy: boolean
  run: (action: Action, params?: ActionParams) => Promise<boolean>
  open: (action: Action, preset?: Preset) => void
}

export const ProjectContext = createContext<ProjectCtx | null>(null)

export function useProject(): ProjectCtx {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error("ProjectContext missing")
  return ctx
}

export type TargetRef = { kind: TargetKind; id: string | number } | null

function sameTarget(a: Target | null, b: TargetRef): boolean {
  if (b === null || b.kind === "project") return a === null || a.kind === "project"
  return a !== null && a.kind === b.kind && String(a.id) === String(b.id)
}

/** The server-listed action with this name on this target, if the viewer may take it now. */
export function findAction(view: ProjectView, name: string, target: TargetRef = null): Action | undefined {
  return view.actions.find((a) => a.action === name && sameTarget(a.target, target))
}

export function actionsFor(view: ProjectView, target: TargetRef): Action[] {
  return view.actions.filter((a) => sameTarget(a.target, target))
}

export function actionLabel(a: Action): string {
  return a.label || label(ACTION_KO, a.action)
}

/** The params that name an action's target (docs/api.md, "Actions"). */
export function targetParams(a: Action, view: ProjectView): ActionParams {
  const t = a.target
  if (t === null || t.kind === "project") {
    if (a.action === "sign_policy" && view.proposals.length > 0) return { version: view.proposals[0].version }
    return {}
  }
  switch (t.kind) {
    case "milestone":
      return { milestone: t.id }
    case "expense":
      return { expense: t.id }
    case "change_order":
      return { change_order: t.id }
    case "policy": {
      const n = Number(t.id)
      return { version: Number.isFinite(n) ? n : t.id }
    }
    default:
      return {}
  }
}

export function deadlinesFor(view: ProjectView, target: TargetRef): Deadline[] {
  if (!target) return []
  return view.deadlines.filter(
    (d) => d.target && d.target.kind === target.kind && String(d.target.id) === String(target.id),
  )
}

/** A button for an action, rendered only if the server offers it. */
export function Act({
  name,
  target = null,
  variant = "default",
  children,
  preset,
}: {
  name: string
  target?: TargetRef
  variant?: "primary" | "default" | "danger" | "ghost"
  children?: ReactNode
  preset?: Preset
}) {
  const { view, open, busy } = useProject()
  const a = findAction(view, name, target)
  if (!a) return null
  const cls =
    variant === "primary"
      ? "btn btn-primary"
      : variant === "danger"
        ? "btn btn-danger"
        : variant === "ghost"
          ? "btn btn-ghost"
          : "btn"
  return (
    <button
      type="button"
      className={`${cls} ${a.needs_response ? "btn-attn" : ""}`}
      disabled={busy}
      onClick={() => open(a, preset)}
    >
      {children ?? actionLabel(a)}
    </button>
  )
}

/** Target description for an action or deadline: "마일스톤 · 디자인 시안". */
export function describeTarget(view: ProjectView, t: Target | null): string {
  if (!t || t.kind === "project") return "프로젝트"
  const id = String(t.id)
  switch (t.kind) {
    case "milestone": {
      const m = view.milestones.find((x) => x.id === id)
      return `마일스톤 · ${m ? m.title : id}`
    }
    case "expense": {
      const e = view.expenses.find((x) => x.id === id)
      return `경비 · ${e ? [e.vendor_name ?? e.vendor, e.item].filter(Boolean).join(" ") || id : id}`
    }
    case "change_order": {
      const c = view.change_orders.find((x) => x.id === id)
      return `변경 주문 · ${c?.draft?.title || (c?.draft?.covers_excess ? `초과분 ${c.draft.covers_excess}` : id)}`
    }
    case "policy":
      return `정책 v${id}`
    default:
      return id
  }
}

/** DOM id of the card for a target, for scrolling from the to-do list and deadlines. */
export function anchorOf(t: Target | null): string {
  if (!t || t.kind === "project") return "sec-controls"
  if (t.kind === "policy") return "sec-policy"
  return `${t.kind}-${String(t.id)}`
}

export function scrollToAnchor(anchor: string) {
  const el = document.getElementById(anchor)
  if (!el || el.closest("[hidden]")) {
    const tab =
      anchor.startsWith("milestone-") || anchor === "sec-milestones"
        ? "work"
        : anchor.startsWith("expense-") || anchor === "sec-expenses"
          ? "expenses"
          : anchor.startsWith("change_order-") || anchor === "sec-changes"
            ? "changes"
            : anchor === "sec-policy"
              ? "policy"
              : anchor === "sec-log" || anchor === "sec-deadlines"
                ? "activity"
                : "manage"
    window.location.hash = `${window.location.hash.split("?")[0]}?tab=${tab}&target=${encodeURIComponent(anchor)}`
    return
  }
  // Reveal a collapsed record before moving focus to it.
  let parent: HTMLElement | null = el
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
    parent = parent.parentElement
  }
  el.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    block: "start",
  })
  el.tabIndex = -1
  el.focus({ preventScroll: true })
  el.classList.remove("flash")
  void el.offsetWidth
  el.classList.add("flash")
}
