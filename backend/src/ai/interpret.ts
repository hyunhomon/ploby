import { claimedAmount, extractJson, validateClassification, validateExpense } from "./schema.js"
import type { KilnClient, KilnResult } from "../kiln/types.js"
import type { Expense, Policy } from "../policy/types.js"

const PARSE_SYSTEM = `You extract one expense from a contractor request and any document text.
Reply with one JSON object and no other text. Do not wrap it in markdown.
Use US dollars as a number, not cents and not token base units.
If the expense is not in the allowed categories, keep a literal category such as "Electronics" and set project_relevance to "low".
Do not force an out-of-scope purchase into an allowed category.
Schema:
{"vendor":"string","category":"string","amount":number,"currency":"string","purpose":"string","project_relevance":"high|medium|low","document_type":"invoice|receipt|quotation|other","anomaly_flags":["duplicate_evidence|budget_splitting|abnormal_pricing|unusual_pattern"],"rationale":"<=200 chars"}`

const CLASSIFY_SYSTEM = `You classify a parsed expense against the project policy.
Reply with one JSON object and no other text:
{"project_relevance":"high|medium|low","anomaly_flags":["duplicate_evidence|budget_splitting|abnormal_pricing|unusual_pattern"],"rationale":"<=200 chars"}
Use project_relevance "low" when the expense is outside the allowed categories.
Add abnormal_pricing when the amount is far above a normal cost for that category.
Add duplicate_evidence only when the text says the same invoice was already submitted.`

export type RecordedCall = {
  flow: "parse" | "classify"
  result: KilnResult
}

export type Interpretation = {
  expense: Expense
  fallback: boolean
  calls: RecordedCall[]
}

export async function interpret(input: {
  kiln: KilnClient
  requestText: string
  documentText: string
  policy: Policy
}): Promise<Interpretation> {
  const calls: RecordedCall[] = []
  const baseUser = [
    `Request:\n${input.requestText}`,
    `Document:\n${input.documentText || "(none)"}`,
    `Allowed categories: ${input.policy.allowed_categories.join(", ")}`,
    `Allowed vendors: ${input.policy.allowed_vendors.join(", ")}`,
    `Currency: ${input.policy.currency}`,
  ].join("\n\n")

  const parsed = await askExpense(input.kiln, baseUser, calls)
  if (!parsed) return { expense: fallbackExpense(input.requestText), fallback: true, calls }

  const classified = await askClassification(input.kiln, `${baseUser}\n\nParsed:\n${JSON.stringify(parsed)}`, calls)
  if (!classified) return { expense: fallbackExpense(input.requestText), fallback: true, calls }

  const merged = validateExpense({
    ...parsed,
    project_relevance: classified.project_relevance,
    anomaly_flags: classified.anomaly_flags,
    rationale: classified.rationale,
  })
  if (!merged.ok) return { expense: fallbackExpense(input.requestText), fallback: true, calls }
  return { expense: merged.expense, fallback: false, calls }
}

export function fallbackExpense(text: string): Expense {
  return {
    vendor: "unknown",
    category: "unknown",
    amount: claimedAmount(text) ?? 1,
    currency: "USD",
    purpose: "unparsed",
    project_relevance: "low",
    document_type: "other",
    anomaly_flags: [],
    rationale: "AI output invalid",
  }
}

async function askExpense(kiln: KilnClient, user: string, calls: RecordedCall[]): Promise<Expense | null> {
  let errors = ["response was not valid"]
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await kiln.complete({ flow: "parse", system: PARSE_SYSTEM, user: promptFor(user, attempt, errors) })
    calls.push({ flow: "parse", result })
    const checked = read(() => validateExpense(extractJson(result.content)))
    if (checked.ok) return checked.expense
    errors = checked.errors
  }
  return null
}

async function askClassification(
  kiln: KilnClient,
  user: string,
  calls: RecordedCall[],
): Promise<{ project_relevance: Expense["project_relevance"]; anomaly_flags: Expense["anomaly_flags"]; rationale: string } | null> {
  let errors = ["response was not valid"]
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await kiln.complete({ flow: "classify", system: CLASSIFY_SYSTEM, user: promptFor(user, attempt, errors) })
    calls.push({ flow: "classify", result })
    const checked = read(() => validateClassification(extractJson(result.content)))
    if (checked.ok) {
      return {
        project_relevance: checked.project_relevance,
        anomaly_flags: checked.anomaly_flags,
        rationale: checked.rationale,
      }
    }
    errors = checked.errors
  }
  return null
}

function promptFor(user: string, attempt: number, errors: string[]): string {
  if (attempt === 0) return user
  return `${user}\n\nThe previous JSON failed validation:\n${errors.map((error) => `- ${error}`).join("\n")}\nReply with one JSON object and no other text.`
}

function read<T extends { ok: boolean; errors?: string[] }>(run: () => T): T | { ok: false; errors: string[] } {
  try {
    return run()
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "response is not JSON"] }
  }
}
