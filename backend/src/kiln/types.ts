export type KilnFlow = "parse" | "classify"

export type KilnUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number | null
  costUsd: number | null
  generationId: string | null
}

export type KilnResult = {
  content: string
  model: string
  usage: KilnUsage
  latencyMs: number
  source: "kiln" | "mock"
}

export interface KilnClient {
  readonly source: "kiln" | "mock"
  complete(input: { flow: KilnFlow; system: string; user: string }): Promise<KilnResult>
}
