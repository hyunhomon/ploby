// Shared UI pieces: app context, chips, money, times, cards, dialogs, document picker.

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { api, errorText } from "../api"
import { Icon } from "./Icon"
import { num, parseAmount, shortHash, timeLeft, kst, urgency } from "../format"
import type { Tone } from "../labels"
import type { DocRef, Meta, Ms, Role, Sample, SampleKind } from "../types"

// ---------------------------------------------------------------- context

export type ToastKind = "ok" | "error" | "info"

export interface AppCtx {
  role: Role
  meta: Meta | null
  now: Ms
  notify: (kind: ToastKind, text: string) => void
  navigate: (hash: string) => void
  openDoc: (doc: DocRef) => void
  /** The demo identity's name for a role (from GET /api/meta roles). */
  nameOf: (role: Role) => string
  /** A slot in the demo clock toolbar where a page can put its own demo-only buttons. */
  clockSlot: HTMLElement | null
}

export const AppContext = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("AppContext missing")
  return ctx
}

export function vendorName(meta: Meta | null, id: string): string {
  return meta?.vendors.find((v) => v.id === id)?.name ?? id
}

// ---------------------------------------------------------------- small pieces

export function Chip({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  )
}

export function Money({ n, className }: { n: number | null | undefined; className?: string }) {
  return (
    <span className={`money ${className ?? ""}`}>
      {n === null || n === undefined ? "—" : num(n)}
      <span className="unit">원</span>
    </span>
  )
}

/** Absolute KST time and a relative "n일 남음" / "기한 지남" chip. */
export function When({ at, now, relative = true }: { at: Ms | null | undefined; now: Ms; relative?: boolean }) {
  if (at === null || at === undefined) return <span className="muted">—</span>
  const u = urgency(at, now)
  return (
    <span className="when">
      <span className="when-abs">{kst(at, now)}</span>
      {relative && <span className={`when-rel when-${u}`}>{timeLeft(at, now)}</span>}
    </span>
  )
}

export function Banner({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <div className="banner-title">{title}</div>}
      {children && <div className="banner-body">{children}</div>}
    </div>
  )
}

export function Card({
  title,
  id,
  aside,
  children,
  className,
  sub,
}: {
  title?: ReactNode
  id?: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  sub?: ReactNode
}) {
  return (
    <section className={`card ${className ?? ""}`} id={id}>
      {(title || aside) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {aside && <div className="card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CopyHash({
  hash,
  head = 8,
  tail = 4,
}: {
  hash: string | null | undefined
  head?: number
  tail?: number
}) {
  const { notify } = useApp()
  if (!hash) return <span className="muted">—</span>
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash)
      notify("ok", "해시를 복사했습니다")
    } catch {
      notify("info", hash)
    }
  }
  return (
    <button type="button" className="hash" onClick={copy} title={`${hash} (눌러서 복사)`}>
      {shortHash(hash, head, tail)}
      <Icon name="copy" size={12} />
    </button>
  )
}

export function DocLink({ doc }: { doc: DocRef | null | undefined }) {
  const { openDoc } = useApp()
  if (!doc) return <span className="muted">문서 없음</span>
  return (
    <button type="button" className="doclink" onClick={() => openDoc(doc)} title={doc.id}>
      <Icon name="document" size={16} /> {doc.name || shortHash(doc.id)}
    </button>
  )
}

// ---------------------------------------------------------------- form fields

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  error?: string | null
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

/** A KRW amount input that shows thousands separators and accepts "150만". */
export function MoneyInput({
  value,
  onChange,
  placeholder,
  id,
  autoFocus,
}: {
  value: number | null
  onChange: (n: number | null) => void
  placeholder?: string
  id?: string
  autoFocus?: boolean
}) {
  const [text, setText] = useState(value === null ? "" : num(value))
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) {
      last.current = value
      setText(value === null ? "" : num(value))
    }
  }, [value])
  return (
    <span className="money-input">
      <input
        id={id}
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value)
          const n = parseAmount(e.target.value)
          last.current = n
          onChange(n)
        }}
        onBlur={() => {
          if (value !== null) setText(num(value))
        }}
      />
      <span className="money-input-unit">원</span>
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: ReactNode; tone?: Tone }[]
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
        e.preventDefault()
        const index = options.findIndex((o) => o.value === value)
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : (index + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length
        onChange(options[next].value)
        e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus()
      }}
    >
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={`seg ${value === o.value ? `seg-on seg-${o.tone ?? "accent"}` : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- dialog

const modalStack: symbol[] = []

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const me = Symbol("modal")
    modalStack.push(me)
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== me) return
      if (e.key === "Escape") {
        e.preventDefault()
        closeRef.current()
      }
      if (e.key === "Tab") {
        const focusable = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first) {
          e.preventDefault()
          ref.current?.focus()
          return
        }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    // Focus the dialog title area first, so opening a payment dialog never primes a confirmation.
    ref.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      modalStack.splice(modalStack.indexOf(me), 1)
      document.body.style.overflow = prev
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- documents

let samplesPromise: Promise<Sample[]> | null = null

export function useSamples(): Sample[] {
  const [samples, setSamples] = useState<Sample[]>([])
  useEffect(() => {
    let live = true
    if (!samplesPromise) {
      samplesPromise = api.samples().catch(() => {
        samplesPromise = null
        return []
      })
    }
    samplesPromise.then((s) => {
      if (live) setSamples(Array.isArray(s) ? s : [])
    })
    return () => {
      live = false
    }
  }, [])
  return samples
}

/**
 * Pick a sample document or paste text; "문서 첨부" uploads it (POST /api/documents) and
 * hands back the DocRef.
 */
export function DocPicker({
  kinds,
  onAttach,
  cta = "문서 첨부",
}: {
  kinds: SampleKind[]
  onAttach: (doc: DocRef) => void
  cta?: string
}) {
  const { notify } = useApp()
  const samples = useSamples().filter((s) => kinds.includes(s.kind))
  const [sampleId, setSampleId] = useState("")
  const [name, setName] = useState("")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)

  const pick = (id: string) => {
    setSampleId(id)
    const s = samples.find((x) => x.id === id)
    if (s) {
      setName(s.name)
      setText(s.text)
    }
  }

  const attach = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const doc = await api.uploadDocument(name.trim() || "붙여넣은 문서", text)
      onAttach(doc)
      setSampleId("")
      setName("")
      setText("")
    } catch (e) {
      notify("error", errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="docpicker">
      {samples.length > 0 && (
        <Field label="샘플 문서에서 고르기">
          <select value={sampleId} onChange={(e) => pick(e.target.value)}>
            <option value="">— 직접 붙여넣기 —</option>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="문서 이름">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 가비아 도메인 견적서" />
      </Field>
      <Field
        label="문서 내용 (텍스트)"
        hint="견적서·영수증·납품 설명을 텍스트로 붙여넣습니다. 첨부하면 내용의 해시가 기록됩니다."
      >
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="mono-area" />
      </Field>
      <div className="row-end">
        <button type="button" className="btn" onClick={attach} disabled={busy || !text.trim()}>
          {busy ? "첨부 중…" : cta}
        </button>
      </div>
    </div>
  )
}

export function AttachedDocs({ docs, onRemove }: { docs: DocRef[]; onRemove?: (id: string) => void }) {
  if (docs.length === 0) return null
  return (
    <ul className="attached">
      {docs.map((d) => (
        <li key={d.id}>
          <DocLink doc={d} />
          <code className="tiny">{shortHash(d.id, 10, 4)}</code>
          {onRemove && (
            <button type="button" className="icon-btn" onClick={() => onRemove(d.id)} aria-label="첨부 빼기">
              <Icon name="close" size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function DocViewer({ doc, onClose }: { doc: DocRef; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .document(doc.id)
      .then((d) => live && setText(d.text))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [doc.id])
  return (
    <Modal title={doc.name || "문서"} onClose={onClose} wide>
      <p className="muted small">
        문서 ID(sha256) <code className="tiny break">{doc.id}</code>
      </p>
      {error && <Banner tone="bad">{error}</Banner>}
      {text === null && !error && <p className="muted">불러오는 중…</p>}
      {text !== null && <pre className="doc-text">{text}</pre>}
    </Modal>
  )
}
