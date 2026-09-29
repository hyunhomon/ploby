import { ANOMALY_FLAGS, type AnomalyFlag, type DocumentType, type Expense, type ProjectRelevance } from "../policy/types.js"

const RELEVANCE = new Set<ProjectRelevance>(["high", "medium", "low"])
const DOCUMENT_TYPES = new Set<DocumentType>(["invoice", "receipt", "quotation", "other"])
const FLAGS = new Set<string>(ANOMALY_FLAGS)

const EXPENSE_KEYS = [
  "vendor",
  "category",
  "amount",
  "currency",
  "purpose",
  "project_relevance",
  "document_type",
  "anomaly_flags",
  "rationale",
] as const

export function stripModelContent(content: string): string {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced?.[1] ?? withoutThink).trim()
}

export function extractJson(content: string): unknown {
  const stripped = stripModelContent(content)
  try {
    return JSON.parse(stripped) as unknown
  } catch {
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1)) as unknown
    throw new Error("response is not JSON")
  }
}

export function validateExpense(value: unknown): { ok: true; expense: Expense } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ["value must be an object"] }
  for (const key of Object.keys(value)) {
    if (!EXPENSE_KEYS.includes(key as (typeof EXPENSE_KEYS)[number])) errors.push(`unknown field ${key}`)
  }
  const vendor = readString(value, "vendor", errors)
  const category = readString(value, "category", errors)
  const purpose = readString(value, "purpose", errors)
  const currency = readString(value, "currency", errors)
  const rationale = readString(value, "rationale", errors)
  if (vendor !== undefined && (vendor.length === 0 || vendor.length > 80)) errors.push("vendor is empty or too long")
  if (category !== undefined && (category.length === 0 || category.length > 80)) errors.push("category is empty or too long")
  if (purpose !== undefined && purpose.length > 120) errors.push("purpose is too long")
  if (currency !== undefined && (currency.length === 0 || currency.length > 8)) errors.push("currency is empty or too long")
  if (rationale !== undefined && rationale.length > 200) errors.push("rationale is longer than 200 characters")

  const amount = value.amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    errors.push("amount must be a positive number")
  }
  const relevance = value.project_relevance
  if (typeof relevance !== "string" || !RELEVANCE.has(relevance as ProjectRelevance)) {
    errors.push("project_relevance must be high, medium, or low")
  }
  const documentType = value.document_type
  if (typeof documentType !== "string" || !DOCUMENT_TYPES.has(documentType as DocumentType)) {
    errors.push("document_type must be invoice, receipt, quotation, or other")
  }
  const flags = readFlags(value.anomaly_flags, errors)
  if (errors.length > 0 || vendor === undefined || category === undefined || purpose === undefined || currency === undefined || rationale === undefined || typeof amount !== "number" || flags === undefined) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    expense: {
      vendor,
      category,
      amount,
      currency,
      purpose,
      project_relevance: relevance as ProjectRelevance,
      document_type: documentType as DocumentType,
      anomaly_flags: flags,
      rationale,
    },
  }
}

export function validateClassification(value: unknown): { ok: true; project_relevance: ProjectRelevance; anomaly_flags: AnomalyFlag[]; rationale: string } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ["value must be an object"] }
  for (const key of Object.keys(value)) {
    if (!["project_relevance", "anomaly_flags", "rationale"].includes(key)) errors.push(`unknown field ${key}`)
  }
  const relevance = value.project_relevance
  if (typeof relevance !== "string" || !RELEVANCE.has(relevance as ProjectRelevance)) {
    errors.push("project_relevance must be high, medium, or low")
  }
  const rationale = readString(value, "rationale", errors)
  if (rationale !== undefined && rationale.length > 200) errors.push("rationale is longer than 200 characters")
  const flags = readFlags(value.anomaly_flags, errors)
  if (errors.length > 0 || rationale === undefined || flags === undefined) return { ok: false, errors }
  return { ok: true, project_relevance: relevance as ProjectRelevance, anomaly_flags: flags, rationale }
}

export function claimedAmount(text: string): number | null {
  const match = text.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usd|dollars)\b/i)
  const raw = match?.[1] ?? match?.[2]
  if (!raw) return null
  const amount = Number(raw)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

export function invoiceNumberFrom(text: string): string | null {
  const match = text.match(/(?:invoice|inv)\s*#?\s*([a-z0-9-]+)/i)
  return match?.[1]?.toLowerCase() ?? null
}

function readFlags(value: unknown, errors: string[]): AnomalyFlag[] | undefined {
  if (!Array.isArray(value)) {
    errors.push("anomaly_flags must be an array")
    return undefined
  }
  const flags: AnomalyFlag[] = []
  for (const flag of value) {
    if (typeof flag !== "string" || !FLAGS.has(flag)) {
      errors.push(`unknown anomaly flag ${String(flag)}`)
      return undefined
    }
    flags.push(flag as AnomalyFlag)
  }
  return flags
}

function readString(value: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const found = value[key]
  if (typeof found !== "string") {
    errors.push(`${key} must be a string`)
    return undefined
  }
  return found
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
