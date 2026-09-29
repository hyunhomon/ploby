// The one JSON API (docs/api.md). With `?fixture=1` in the URL every call is answered by
// src/dev/fixture.ts instead, so the UI can be checked without the server.

import type {
  ActionOk,
  Clock,
  Doc,
  DocRef,
  Meta,
  NewProject,
  ProjectSummary,
  ProjectView,
  Role,
  RulesCandidate,
  Sample,
} from "./types"

export class ApiError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type ActionParams = Record<string, unknown>

export interface Backend {
  meta(): Promise<Meta>
  clock(): Promise<Clock>
  moveClock(body: { advance: number } | { reset: true }): Promise<Clock>
  samples(): Promise<Sample[]>
  uploadDocument(name: string, text: string): Promise<DocRef>
  document(id: string): Promise<Doc>
  compileRules(words: string): Promise<RulesCandidate>
  projects(as: Role): Promise<ProjectSummary[]>
  createProject(project: NewProject): Promise<ProjectView>
  project(id: string, as: Role): Promise<ProjectView>
  act(id: string, as: Role, action: string, params: ActionParams): Promise<ActionOk>
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError("서버에 연결할 수 없습니다. 백엔드(127.0.0.1:3010)가 실행 중인지 확인하세요.", "network", 0)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = data as { error?: unknown; code?: unknown } | null
    const message =
      err && typeof err.error === "string"
        ? err.error
        : res.status === 502 || res.status === 504
          ? "서버에 연결할 수 없습니다. 백엔드(127.0.0.1:3010)가 실행 중인지 확인하세요."
          : `서버 오류 (HTTP ${res.status})`
    const code = err && typeof err.code === "string" ? err.code : `http_${res.status}`
    throw new ApiError(message, code, res.status)
  }
  if (data === null && text !== "") throw new ApiError("서버 응답을 읽을 수 없습니다.", "parse", res.status)
  return data as T
}

const q = (role: Role) => `as=${encodeURIComponent(role)}`

const http: Backend = {
  meta: () => call("GET", "/api/meta"),
  clock: () => call("GET", "/api/clock"),
  moveClock: (body) => call("POST", "/api/clock", body),
  samples: () => call("GET", "/api/samples"),
  uploadDocument: (name, text) => call("POST", "/api/documents", { name, text }),
  document: (id) => call("GET", `/api/documents/${encodeURIComponent(id)}`),
  compileRules: (words) => call("POST", "/api/rules/compile", { words }),
  projects: (as) => call("GET", `/api/projects?${q(as)}`),
  createProject: (project) => call("POST", "/api/projects", { as: "client", ...project }),
  project: (id, as) => call("GET", `/api/projects/${encodeURIComponent(id)}?${q(as)}`),
  act: (id, as, action, params) =>
    call("POST", `/api/projects/${encodeURIComponent(id)}/actions`, { ...params, as, action }),
}

function fixtureWanted(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("fixture") === "1"
  } catch {
    return false
  }
}

export const FIXTURE = fixtureWanted()

let backend: Backend = http

/** Resolve the backend once: the fixture module is loaded only in fixture mode. */
export async function initBackend(): Promise<void> {
  if (FIXTURE) {
    const mod = await import("./dev/fixture")
    backend = mod.fixtureBackend
  }
}

export const api: Backend = {
  meta: () => backend.meta(),
  clock: () => backend.clock(),
  moveClock: (b) => backend.moveClock(b),
  samples: () => backend.samples(),
  uploadDocument: (n, t) => backend.uploadDocument(n, t),
  document: (id) => backend.document(id),
  compileRules: (w) => backend.compileRules(w),
  projects: (as) => backend.projects(as),
  createProject: (p) => backend.createProject(p),
  project: (id, as) => backend.project(id, as),
  act: (id, as, a, p) => backend.act(id, as, a, p),
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
