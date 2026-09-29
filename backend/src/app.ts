import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify"
import type { Bus } from "./bus.js"
import type { ChainWriter } from "./chain/types.js"
import type { Db } from "./db.js"
import { newProjectId, policyHashOf, usdToBase } from "./domain/ids.js"
import type { KilnClient } from "./kiln/types.js"
import { demoPolicy, type Policy } from "./policy/types.js"
import { approveHold, HttpError, rejectHold, stopProject, submitExpense, type Deps } from "./service.js"

export type AppDeps = Deps

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(cors, { origin: true })
  app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
    request.log.error(error)
    return reply.code(500).send({ error: "internal error" })
  })

  app.get("/health", async () => ({ ok: true, kiln: deps.kiln.source, chain: deps.chain.enabled }))
  app.get("/metrics", async () => deps.db.metrics())
  app.get("/demo-policy", async () => demoPolicy)

  app.post("/projects", async (request) => {
    const body = request.body as { name?: string; clientAddress?: string; payeeAddress?: string; policy?: unknown }
    if (!body?.name?.trim()) throw new HttpError(400, "name is required")
    const clientAddress = address(body.clientAddress, "clientAddress")
    const payeeAddress = address(body.payeeAddress, "payeeAddress")
    if (deps.chain.clientAddress && deps.chain.clientAddress.toLowerCase() !== clientAddress.toLowerCase()) {
      throw new HttpError(400, "clientAddress does not match CLIENT_PRIVATE_KEY")
    }
    const policy = assertPolicy(body.policy)
    const id = newProjectId()
    const hash = policyHashOf(policy)
    let createTx: string | null = null
    let depositTx: string | null = null
    if (deps.chain.enabled) {
      try {
        const funded = await deps.chain.createAndFund({ projectId: id, policyHash: hash, budgetBase: usdToBase(policy.project_budget) })
        createTx = funded.createTx
        depositTx = funded.depositTx
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : "chain error")
      }
    }
    const createdAt = (deps.now ?? (() => new Date().toISOString()))()
    deps.db.insertProject({
      id,
      name: body.name.trim(),
      client_address: clientAddress,
      payee_address: payeeAddress,
      budget_usd: policy.project_budget,
      policy_hash: hash,
      status: "active",
      created_at: createdAt,
      policy,
      createTx,
      depositTx,
    })
    return { id, policyHash: hash, createTx, depositTx, chain: deps.chain.enabled }
  })

  app.get("/projects/:id", async (request) => {
    const { id } = request.params as { id: string }
    const project = deps.db.getProject(id)
    const policy = deps.db.getPolicy(id)
    if (!project || !policy) throw new HttpError(404, "project not found")
    return { ...project, policy }
  })

  app.post("/projects/:id/expenses", async (request) => {
    const { id } = request.params as { id: string }
    const submitted = await readExpense(request)
    return submitExpense(deps, id, submitted)
  })

  app.get("/projects/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!deps.db.getProject(id)) throw new HttpError(404, "project not found")
    reply.hijack()
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    for (const decision of deps.db.recentDecisions(id)) {
      send({ type: "decision", projectId: id, expenseRequestId: decision.expense_request_id, outcome: decision.outcome, reason: decision.reason, chainStatus: decision.chain_status })
    }
    const unsubscribe = deps.bus.subscribe(id, send)
    request.raw.on("close", () => unsubscribe())
  })

  app.get("/projects/:id/holds", async (request) => {
    const { id } = request.params as { id: string }
    if (!deps.db.getProject(id)) throw new HttpError(404, "project not found")
    return deps.db.listHolds(id)
  })

  app.post("/holds/:id/approve", async (request) => {
    const { id } = request.params as { id: string }
    return approveHold(deps, id)
  })

  app.post("/holds/:id/reject", async (request) => {
    const { id } = request.params as { id: string }
    return rejectHold(deps, id)
  })

  app.post("/projects/:id/stop", async (request) => {
    const { id } = request.params as { id: string }
    return stopProject(deps, id)
  })

  app.get("/projects/:id/spending", async (request) => {
    const { id } = request.params as { id: string }
    const project = deps.db.getProject(id)
    if (!project) throw new HttpError(404, "project not found")
    const spending = deps.db.spending(id)
    return {
      budget: project.budget_usd,
      released: spending.released,
      pendingHolds: spending.pendingHolds,
      remaining: project.budget_usd - spending.released - spending.pendingHolds,
      settlements: spending.settlements,
    }
  })

  return app
}

async function readExpense(request: FastifyRequest): Promise<{ text: string; filename: string | null; file: Buffer }> {
  const contentType = request.headers["content-type"] ?? ""
  if (contentType.includes("application/json")) {
    const body = request.body as { text?: string; documentText?: string; filename?: string }
    const text = body.text ?? ""
    const file = Buffer.from(body.documentText ?? "", "utf8")
    return { text, filename: body.filename ?? (file.length > 0 ? "document.txt" : null), file }
  }
  let text = ""
  let filename: string | null = null
  let file: Buffer = Buffer.alloc(0)
  for await (const part of request.parts()) {
    if (part.type === "file") {
      file = await part.toBuffer()
      filename = part.filename ?? "upload"
    } else if (part.fieldname === "text") {
      text = String(part.value ?? "")
    }
  }
  return { text, filename, file }
}

function assertPolicy(value: unknown): Policy {
  if (!value || typeof value !== "object") throw new HttpError(400, "policy is required")
  const policy = value as Policy
  if (typeof policy.project_budget !== "number" || policy.project_budget <= 0) throw new HttpError(400, "project_budget must be positive")
  if (typeof policy.max_transaction !== "number" || policy.max_transaction <= 0) throw new HttpError(400, "max_transaction must be positive")
  if (typeof policy.currency !== "string" || policy.currency.length === 0) throw new HttpError(400, "currency is required")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy.deadline ?? "")) throw new HttpError(400, "deadline must be YYYY-MM-DD")
  if (!Array.isArray(policy.allowed_categories) || policy.allowed_categories.length === 0) throw new HttpError(400, "allowed_categories is required")
  if (!Array.isArray(policy.allowed_vendors) || policy.allowed_vendors.length === 0) throw new HttpError(400, "allowed_vendors is required")
  return policy
}

function address(value: string | undefined, label: string): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new HttpError(400, `${label} must be an 0x address`)
  return value as `0x${string}`
}

export type { Db, KilnClient, ChainWriter, Bus }
