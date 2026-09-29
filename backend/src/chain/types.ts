export type DecisionCode = 1 | 2 | 3

export type ChainRecord = {
  projectId: `0x${string}`
  evidenceHash: `0x${string}`
  policyHash: `0x${string}`
  amountBase: bigint
  decision: DecisionCode
  payee: `0x${string}`
}

export interface ChainWriter {
  readonly enabled: boolean
  readonly clientAddress: `0x${string}` | null
  createAndFund(input: { projectId: `0x${string}`; policyHash: `0x${string}`; budgetBase: bigint }): Promise<{ createTx: string; depositTx: string }>
  recordDecision(input: ChainRecord): Promise<string>
  release(input: { projectId: `0x${string}`; evidenceHash: `0x${string}`; payee: `0x${string}`; amountBase: bigint }): Promise<string>
  approveHold(input: { projectId: `0x${string}`; evidenceHash: `0x${string}` }): Promise<string>
  rejectHold(input: { projectId: `0x${string}`; evidenceHash: `0x${string}` }): Promise<string>
  stopProject(projectId: `0x${string}`): Promise<string>
}

export class DisabledChain implements ChainWriter {
  readonly enabled = false
  readonly clientAddress = null
  async createAndFund(): Promise<never> { throw new Error("chain is not configured") }
  async recordDecision(): Promise<never> { throw new Error("chain is not configured") }
  async release(): Promise<never> { throw new Error("chain is not configured") }
  async approveHold(): Promise<never> { throw new Error("chain is not configured") }
  async rejectHold(): Promise<never> { throw new Error("chain is not configured") }
  async stopProject(): Promise<never> { throw new Error("chain is not configured") }
}

/** In-memory chain for tests. After stopProject, recordDecision throws, matching the contract. */
export class MemoryChain implements ChainWriter {
  readonly enabled = true
  readonly clientAddress = null
  stopped = false
  records: ChainRecord[] = []
  releases: Array<{ evidenceHash: `0x${string}`; payee: `0x${string}`; amountBase: bigint }> = []
  approvals: string[] = []
  rejections: string[] = []

  async createAndFund(): Promise<{ createTx: string; depositTx: string }> {
    return { createTx: "0xcreate", depositTx: "0xdeposit" }
  }

  async recordDecision(input: ChainRecord): Promise<string> {
    if (this.stopped) throw new Error("project stopped")
    this.records.push(input)
    return `0xrecord${this.records.length}`
  }

  async release(input: { projectId: `0x${string}`; evidenceHash: `0x${string}`; payee: `0x${string}`; amountBase: bigint }): Promise<string> {
    if (this.stopped) throw new Error("project stopped")
    this.releases.push(input)
    return `0xrelease${this.releases.length}`
  }

  async approveHold(input: { projectId: `0x${string}`; evidenceHash: `0x${string}` }): Promise<string> {
    this.approvals.push(input.evidenceHash)
    return "0xapprove"
  }

  async rejectHold(input: { projectId: `0x${string}`; evidenceHash: `0x${string}` }): Promise<string> {
    this.rejections.push(input.evidenceHash)
    return "0xreject"
  }

  async stopProject(): Promise<string> {
    this.stopped = true
    return "0xstop"
  }
}
