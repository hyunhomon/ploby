import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import type { ChainRecord, ChainWriter } from "./types.js"

const escrowAbi = parseAbi([
  "function createProject(bytes32 projectId, bytes32 policyHash, uint256 budget)",
  "function deposit(bytes32 projectId)",
  "function recordDecision((bytes32 projectId, bytes32 evidenceHash, bytes32 policyHash, uint256 amount, uint8 decision, uint256 timestamp) decision, address payee)",
  "function release(bytes32 projectId, bytes32 evidenceHash, address payee, uint256 amount)",
  "function approveHold(bytes32 projectId, bytes32 evidenceHash)",
  "function rejectHold(bytes32 projectId, bytes32 evidenceHash)",
  "function stopProject(bytes32 projectId)",
])

const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
])

export type ViemChainConfig = {
  rpcUrl: string
  escrowAddress: Hex
  usdcAddress: Hex
  agentPrivateKey: Hex
  clientPrivateKey: Hex
}

export class ViemChain implements ChainWriter {
  readonly enabled = true
  readonly clientAddress: Hex
  private readonly publicClient
  private readonly agent
  private readonly client
  private readonly escrow: Hex
  private readonly usdc: Hex

  constructor(config: ViemChainConfig) {
    this.escrow = config.escrowAddress
    this.usdc = config.usdcAddress
    this.clientAddress = privateKeyToAccount(config.clientPrivateKey).address
    this.publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) })
    this.agent = createWalletClient({
      account: privateKeyToAccount(config.agentPrivateKey),
      chain: baseSepolia,
      transport: http(config.rpcUrl),
    })
    this.client = createWalletClient({
      account: privateKeyToAccount(config.clientPrivateKey),
      chain: baseSepolia,
      transport: http(config.rpcUrl),
    })
  }

  async createAndFund(input: { projectId: Hex; policyHash: Hex; budgetBase: bigint }): Promise<{ createTx: string; depositTx: string }> {
    const mintTx = await this.send(this.agent, {
      address: this.usdc,
      abi: usdcAbi,
      functionName: "mint",
      args: [this.client.account.address, input.budgetBase],
    })
    await this.send(this.client, {
      address: this.usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [this.escrow, input.budgetBase],
    })
    const createTx = await this.send(this.client, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "createProject",
      args: [input.projectId, input.policyHash, input.budgetBase],
    })
    const depositTx = await this.send(this.client, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "deposit",
      args: [input.projectId],
    })
    void mintTx
    return { createTx, depositTx }
  }

  async recordDecision(input: ChainRecord): Promise<string> {
    return this.send(this.agent, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "recordDecision",
      args: [{
        projectId: input.projectId,
        evidenceHash: input.evidenceHash,
        policyHash: input.policyHash,
        amount: input.amountBase,
        decision: input.decision,
        timestamp: 0n,
      }, input.payee],
    })
  }

  async release(input: { projectId: Hex; evidenceHash: Hex; payee: Hex; amountBase: bigint }): Promise<string> {
    return this.send(this.agent, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "release",
      args: [input.projectId, input.evidenceHash, input.payee, input.amountBase],
    })
  }

  async approveHold(input: { projectId: Hex; evidenceHash: Hex }): Promise<string> {
    return this.send(this.client, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "approveHold",
      args: [input.projectId, input.evidenceHash],
    })
  }

  async rejectHold(input: { projectId: Hex; evidenceHash: Hex }): Promise<string> {
    return this.send(this.client, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "rejectHold",
      args: [input.projectId, input.evidenceHash],
    })
  }

  async stopProject(projectId: Hex): Promise<string> {
    return this.send(this.client, {
      address: this.escrow,
      abi: escrowAbi,
      functionName: "stopProject",
      args: [projectId],
    })
  }

  private async send(wallet: typeof this.agent, args: Parameters<typeof this.agent.writeContract>[0]): Promise<string> {
    const hash = await wallet.writeContract(args)
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`)
    return hash
  }
}
