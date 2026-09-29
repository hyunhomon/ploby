import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isAddress, type Hex } from "viem"
import { buildApp } from "./app.js"
import { Bus } from "./bus.js"
import { DisabledChain } from "./chain/types.js"
import { ViemChain } from "./chain/viem.js"
import { Db } from "./db.js"
import { LiveKilnClient } from "./kiln/live.js"
import { MockKilnClient } from "./kiln/mock.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
loadEnv(path.join(root, ".env"))

const port = Number(process.env.PORT ?? 3010)
const databasePath = process.env.DATABASE_PATH ?? path.join(root, "backend/data/smartescrow.db")
mkdirSync(path.dirname(databasePath), { recursive: true })

const kilnMode = process.env.KILN_MODE ?? (process.env.KILN_API_KEY ? "live" : "mock")
const kiln = kilnMode === "live"
  ? new LiveKilnClient({
    baseUrl: process.env.KILN_BASE_URL ?? "https://api.bricksum.com/v1",
    apiKey: required("KILN_API_KEY"),
    model: process.env.KILN_MODEL ?? "qwen3-32b",
  })
  : new MockKilnClient()

const escrow = process.env.ESCROW_ADDRESS ?? ""
const usdc = process.env.USDC_ADDRESS ?? ""
const agentKey = process.env.AGENT_PRIVATE_KEY ?? ""
const clientKey = process.env.CLIENT_PRIVATE_KEY ?? ""
const chain = escrow && usdc && agentKey && clientKey
  ? new ViemChain({
    rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
    escrowAddress: hexAddress(escrow, "ESCROW_ADDRESS"),
    usdcAddress: hexAddress(usdc, "USDC_ADDRESS"),
    agentPrivateKey: hexKey(agentKey, "AGENT_PRIVATE_KEY"),
    clientPrivateKey: hexKey(clientKey, "CLIENT_PRIVATE_KEY"),
  })
  : new DisabledChain()

const app = buildApp({
  db: Db.open(databasePath),
  kiln,
  chain,
  bus: new Bus(),
  today: () => new Date().toISOString().slice(0, 10),
})

await app.listen({ port, host: "0.0.0.0" })
console.info(`smartescrow backend on :${port} kiln=${kiln.source} chain=${chain.enabled}`)

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when KILN_MODE=live`)
  return value
}

function hexAddress(value: string, name: string): Hex {
  if (!isAddress(value)) throw new Error(`${name} is not an address`)
  return value
}

function hexKey(value: string, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 0x private key`)
  return value as Hex
}

function loadEnv(file: string): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}
