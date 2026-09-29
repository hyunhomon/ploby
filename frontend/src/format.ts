// Money and time formatting. Times are shown in KST whatever the browser's zone, and
// relative times are measured against the view's demo-clock `now`, never Date.now().

import type { DateStr, Ms } from "./types"
import { language, tr } from "./i18n"

const KST_OFFSET = 9 * 3600 * 1000
const DAY = 86400 * 1000
const HOUR = 3600 * 1000
const MINUTE = 60 * 1000
const WEEKDAY = {
  ko: ["일", "월", "화", "수", "목", "금", "토"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
}

const numberFormat = () => new Intl.NumberFormat(language() === "en" ? "en-US" : "ko-KR")

export function won(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—"
  const formatted = numberFormat().format(n)
  return language() === "en" ? `₩${formatted}` : `${formatted}원`
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—"
  return numberFormat().format(n)
}

/** Parse "1,500,000" / "150만" / "1억 2천만원" into an integer, or null. */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[,\s원₩]/g, "")
  if (t === "") return null
  if (/^\d+$/.test(t)) return Number(t)
  const m = t.match(/^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)천만)?(?:(\d+(?:\.\d+)?)만)?(?:(\d+(?:\.\d+)?)천)?(\d+)?$/)
  if (!m || m[0] === "") return null
  const [, eok, cheonman, man, cheon, rest] = m
  const total =
    (eok ? Number(eok) * 1e8 : 0) +
    (cheonman ? Number(cheonman) * 1e7 : 0) +
    (man ? Number(man) * 1e4 : 0) +
    (cheon ? Number(cheon) * 1e3 : 0) +
    (rest ? Number(rest) : 0)
  return Number.isFinite(total) ? Math.round(total) : null
}

interface KstParts {
  y: number
  mo: number
  d: number
  wd: string
  h: number
  mi: number
}

function parts(ms: Ms): KstParts {
  const t = new Date(ms + KST_OFFSET)
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    wd: WEEKDAY[language()][t.getUTCDay()],
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

function sameYear(y: number, ref?: Ms): boolean {
  const refYear = ref === undefined ? 2026 : parts(ref).y
  return y === refYear
}

/** "10월 13일 (화) 17:00" (with the year when it differs from `ref`'s). */
export function kst(ms: Ms | null | undefined, ref?: Ms): string {
  if (ms === null || ms === undefined) return "—"
  const p = parts(ms)
  if (language() === "en") {
    const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, p.mo - 1, 1)),
    )
    return `${month} ${p.d}${sameYear(p.y, ref) ? "" : `, ${p.y}`} (${p.wd}) ${pad(p.h)}:${pad(p.mi)}`
  }
  return `${sameYear(p.y, ref) ? "" : `${p.y}년 `}${p.mo}월 ${p.d}일 (${p.wd}) ${pad(p.h)}:${pad(p.mi)}`
}

/** "10월 13일 (화)" */
export function kstDate(ms: Ms | null | undefined, ref?: Ms): string {
  if (ms === null || ms === undefined) return "—"
  const p = parts(ms)
  if (language() === "en") {
    const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, p.mo - 1, 1)),
    )
    return `${month} ${p.d}${sameYear(p.y, ref) ? "" : `, ${p.y}`} (${p.wd})`
  }
  return `${sameYear(p.y, ref) ? "" : `${p.y}년 `}${p.mo}월 ${p.d}일 (${p.wd})`
}

/** Milliseconds (KST) for a 'YYYY-MM-DD' string at 00:00, or null. */
export function dateStrToMs(s: string): Ms | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET
}

/** 'YYYY-MM-DD' (KST) for milliseconds. */
export function msToDateStr(ms: Ms): DateStr {
  const p = parts(ms)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
}

/** A date-or-time value from the API: milliseconds show date and time, 'YYYY-MM-DD' shows the day. */
export function when(v: Ms | DateStr | null | undefined, ref?: Ms): string {
  if (v === null || v === undefined || v === "") return "—"
  if (typeof v === "number") return kst(v, ref)
  const ms = dateStrToMs(v)
  return ms === null ? v : tr("common.until", { date: kstDate(ms, ref) })
}

/** Date-input value for a date-or-time value (days in KST). */
export function toDateInput(v: Ms | DateStr | null | undefined): DateStr {
  if (v === null || v === undefined) return ""
  if (typeof v === "number") return msToDateStr(v)
  return v
}

function span(ms: number): string {
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const mi = Math.floor((ms % HOUR) / MINUTE)
  if (d > 0) return h > 0 ? `${tr("common.day", { count: d })} ${tr("common.hour", { count: h })}` : tr("common.day", { count: d })
  if (h > 0) return mi > 0 ? `${tr("common.hour", { count: h })} ${tr("common.minute", { count: mi })}` : tr("common.hour", { count: h })
  if (mi > 0) return tr("common.minute", { count: mi })
  return tr("common.lessThanMinute")
}

/** "2일 5시간 남음" / "기한 지남" */
export function timeLeft(at: Ms | null | undefined, now: Ms): string {
  if (at === null || at === undefined) return ""
  const diff = at - now
  if (diff <= 0) return tr("common.overdue")
  return tr("common.remaining", { span: span(diff) })
}

/** "3시간 전" / "방금" */
export function ago(at: Ms, now: Ms): string {
  const diff = now - at
  if (diff < MINUTE) return diff < 0 ? tr("common.later", { span: span(-diff) }) : tr("common.justNow")
  return tr("common.ago", { span: span(diff) })
}

/** Urgency for a deadline: overdue, within a day, or later. */
export function urgency(at: Ms | null | undefined, now: Ms): "over" | "soon" | "later" {
  if (at === null || at === undefined) return "later"
  const diff = at - now
  if (diff <= 0) return "over"
  if (diff <= DAY) return "soon"
  return "later"
}

/** A policy period in seconds: "72시간", "7일". */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—"
  if (seconds % 86400 === 0 && seconds >= 86400 * 2) return tr("common.day", { count: seconds / 86400 })
  if (seconds % 3600 === 0) return tr("common.hour", { count: seconds / 3600 })
  return span(seconds * 1000)
}

/** "0x26be03…531a" */
export function shortHash(h: string | null | undefined, head = 8, tail = 4): string {
  if (!h) return "—"
  if (h.length <= head + tail + 1) return h
  return `${h.slice(0, head)}…${h.slice(-tail)}`
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
}

export function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
}
