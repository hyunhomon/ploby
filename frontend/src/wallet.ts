import { L } from "./i18n"

interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

export interface WalletIntent {
  required: boolean
  signer?: string
  head?: string
  expires?: number
  typed_data?: { domain: { chainId: number }; message: Record<string, unknown>; [key: string]: unknown }
}

function provider(): Provider {
  const injected = (window as Window & { ethereum?: Provider }).ethereum
  if (!injected) throw new Error(L("브라우저 지갑을 연결해 주세요.", "Connect an Ethereum browser wallet to approve this action."))
  return injected
}

export async function connectWallet(): Promise<string> {
  const accounts = await provider().request({ method: "eth_requestAccounts" }) as string[]
  if (!accounts[0]) throw new Error(L("연결된 지갑이 없습니다.", "No wallet account connected."))
  return accounts[0]
}

export async function signIntent(intent: WalletIntent, project: string, role: string, operation: string) {
  if (!intent.required) return undefined
  const data = intent.typed_data
  if (!data || data.message.project !== project || data.message.role !== role || data.message.operation !== operation)
    throw new Error(L("승인 요청이 현재 작업과 다릅니다.", "The approval request does not match this action."))
  const address = await connectWallet()
  if (address.toLowerCase() !== intent.signer?.toLowerCase())
    throw new Error(L("이 역할에 등록된 지갑으로 전환해 주세요: ", "Switch to the wallet registered for this role: ") + intent.signer)
  const wallet = provider()
  const chainId = `0x${data.domain.chainId.toString(16)}`
  if (await wallet.request({ method: "eth_chainId" }) !== chainId)
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
  const signature = await wallet.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(data)] })
  return { signature, head: intent.head, expires: intent.expires }
}
