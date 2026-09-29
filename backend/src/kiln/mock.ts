import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { KilnClient, KilnFlow, KilnResult } from "./types.js"

const fixturesDir = fileURLToPath(new URL("../../fixtures/kiln/", import.meta.url))

export function selectFixture(flow: KilnFlow, userText: string): string {
  const text = userText.toLowerCase()
  if (text.includes("gaming") || text.includes("console")) return `${flow}-console.json`
  if (text.includes("500")) return `${flow}-over-limit.json`
  if (text.includes("1023")) return `${flow}-invoice-1023.json`
  return `${flow}-aws.json`
}

/** Replays recorded JSON. Metrics from this client are mock data, not Kiln evidence. */
export class MockKilnClient implements KilnClient {
  readonly source = "mock" as const

  async complete(input: { flow: KilnFlow; system: string; user: string }): Promise<KilnResult> {
    const started = Date.now()
    const file = selectFixture(input.flow, input.user)
    const body = JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8")) as {
      model: string
      choices: Array<{ message: { content: string } }>
      usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        cost?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }
    return {
      content: body.choices[0]?.message.content ?? "",
      model: body.model,
      usage: {
        promptTokens: body.usage.prompt_tokens,
        completionTokens: body.usage.completion_tokens,
        totalTokens: body.usage.total_tokens,
        reasoningTokens: body.usage.completion_tokens_details?.reasoning_tokens ?? null,
        costUsd: body.usage.cost ?? null,
        generationId: null,
      },
      latencyMs: Date.now() - started,
      source: "mock",
    }
  }
}
