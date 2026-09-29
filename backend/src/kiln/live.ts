import type { KilnClient, KilnResult, KilnUsage } from "./types.js"

export type LiveKilnConfig = {
  baseUrl: string
  apiKey: string
  model: string
}

export class LiveKilnClient implements KilnClient {
  readonly source = "kiln" as const
  private modelsChecked = false

  constructor(private readonly config: LiveKilnConfig) {}

  async complete(input: { flow: "parse" | "classify"; system: string; user: string }): Promise<KilnResult> {
    await this.assertModelServed()
    const started = Date.now()
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        max_tokens: 2048,
        temperature: 0,
      }),
    })
    const latencyMs = Date.now() - started
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`Kiln ${response.status} on ${input.flow}: ${raw.slice(0, 400)}`)
    }
    const body = JSON.parse(raw) as {
      model?: string
      choices?: Array<{ message?: { content?: string | null } }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        cost?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }
    const content = body.choices?.[0]?.message?.content ?? ""
    const usage = readUsage(body.usage, response.headers.get("x-neocloud-generation-id"))
    console.info(`kiln flow=${input.flow} latencyMs=${latencyMs} prompt=${usage.promptTokens} completion=${usage.completionTokens}`)
    return { content, model: body.model ?? this.config.model, usage, latencyMs, source: "kiln" }
  }

  private async assertModelServed(): Promise<void> {
    if (this.modelsChecked) return
    const response = await fetch(`${this.config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    })
    if (!response.ok) throw new Error(`Kiln GET /models failed: ${response.status}`)
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id))
    if (!ids.includes(this.config.model)) {
      throw new Error(`Kiln model ${this.config.model} is not served. GET /models returned: ${ids.join(", ") || "(empty)"}`)
    }
    this.modelsChecked = true
  }
}

function readUsage(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  completion_tokens_details?: { reasoning_tokens?: number }
} | undefined, generationId: string | null): KilnUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    costUsd: typeof usage?.cost === "number" ? usage.cost : null,
    generationId,
  }
}
