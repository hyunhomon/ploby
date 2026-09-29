import { createHash } from "node:crypto"
import { keccak256, toBytes, type Hex } from "viem"

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function newProjectId(): Hex {
  return keccak256(toBytes(crypto.randomUUID()))
}

export function evidenceHash(documentHash: string, expenseId: string): Hex {
  return keccak256(toBytes(`${documentHash}:${expenseId}`))
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function policyHashOf(policy: unknown): Hex {
  return keccak256(toBytes(canonicalJson(policy)))
}

export function usdToBase(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}
