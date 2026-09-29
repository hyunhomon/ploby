# Ploby

**Declared function (GWDC 2026 Challenge B):** a contractor's AI expense agent spends a client's escrowed project budget only inside the policy both parties signed; code, not the model, decides; every stop is recorded, and any payment can be re-derived from the log and the chain alone.

Ploby is a bilateral project escrow (SmartEscrow): it pre-funds outsourced work and project expenses, uses AI to interpret supporting documents, and enforces accepted commitments with deterministic rules. The rules come from the Proof-Carrying Payments core in [`pcp/`](pcp/): a mandate language, `decide()`, two blind readings of the client's words compared by code, and a metered, cached Kiln client. The escrow built on it is [`escrow/`](escrow/); the spec is [`docs/pcp-escrow.md`](docs/pcp-escrow.md).

| Part | Where |
|---|---|
| Mandate language, words → mandate (two readings + readback), decisions, Kiln client | `pcp/`, `pipeline.json` (model per stage), `domains/escrow.json` (who may be paid) |
| Escrow: policy, bilateral signatures, hash-chained log, milestones, holds, close, audit | `escrow/policy.py`, `escrow/project.py` |
| AI stages: policy words, vendor documents | `escrow/ai.py`, `escrow/quotes/` |
| Chain: in-memory `SimEscrow`, `ExpenseEscrow` on Monad testnet | `escrow/ledger.py`, `escrow/chain_monad.py`, `script/deploy_monad.py`, `deployments/monad-testnet.json` |
| Demo driver, run records, viewer | `escrow/demo.py`, `runs/`, `web/index.html` |
| Offline invariants | `harness/check.py` |
| TypeScript API and UI sample (Base Sepolia, mock or live Kiln) | `backend/`, `frontend/` |

> **Legacy prototype warning:** the Solidity contract (`src/ExpenseEscrow.sol`) implements only the original Phase 1 expense demo. `release` pays the payee stored with the decision and cannot substitute another address, but the agent still chooses that payee when it records the decision. The contract has no withdraw (the closing refund is computed and logged off chain, not paid), keeps one `policyHash` per project (a changed policy is a new project), freezes every call after `stopProject`, and does not reserve milestone or expense funds on chain (the log does). Milestones are paid through the same `recordDecision(APPROVE)` + `release` path. Do not use it for real funds or represent it as the target SmartEscrow protocol.

The accepted target architecture is documented in [`docs/adr`](docs/adr/README.md): bilateral purchase commitments, settlement deadlines, policy versioning, refunds, asset handover, and shared-expense allocation that the current Phase 1 contract does not yet implement. For a human-readable introduction, start with [`docs/README.md`](docs/README.md).

## Who it is for, and what it solves

A cafe owner (the client) hires a freelance web contractor to renew the cafe's website: two milestones (M1 design 1,500,000, M2 responsive build 2,500,000) and up to 500,000 KRW of project expenses (hosting, domain, design tools, stock images) that the contractor's AI agent pays as vendor documents arrive. The owner does not want to approve every 24,200-won domain bill, and does not want to hand an AI a card with no limit either; the contractor wants to be paid when the work is accepted (or when the owner stays silent past the review window), not when the owner gets round to it. Both sign one policy in plain Korean; the escrow holds the deposit; every expense is decided against the signed rules, and anyone can later check every payment from the records.

## What the AI does, what code keeps

- **AI (Kiln, qwen3-32b)** reads text and nothing else: the policy words into a PCP mandate (a writer and a blind reader, compared by what they allow), and each vendor document into fields (vendor text, amount, fee, total, units). It never sees the rules' outcome, never picks a payee, never sends a transaction.
- **Code** keeps everything that moves money: the checks that the fields appear in the document and add up (`escrow/ai.py`), the vendor → registry id → payee address mapping (the document's account numbers are never read), the decision (`pcp/mandate.py decide` on the signed mandate: vendor list, per-purchase limit, total budget, deadline, stop), milestones and review timeouts, the hash-chained log, the chain calls, the refund, and the audit.
- **People**: both parties sign the policy hash; the client deposits, approves or rejects a HOLD, accepts a milestone (or stays silent), and can stop the agent at any time. Each of these actions is a signed log line.

## How the design avoids inference

The policy is compiled once per signed version: 2 Kiln calls when the two readings agree (as in both runs below), plus a reread of both with reasoning on only when they differ. Each vendor document costs one call. Decisions, holds, milestones, timeouts, the stop, the refund and the audit use no model at all: they are code over the signed mandate and the log. Kiln responses are cached by `pcp/kiln.py` (by exact request, in `harness/runs/cache/`), so a rerun of the same story costs $0; the fixed system prompts come first so the prefix cache serves them.

## What the chain enforces, and what only code enforces

`createProject` is called with **budget = the whole deposit** (4,500,000 in the story: M1 + M2 + the 500,000 expense budget). So the chain does **not** enforce the 500,000 expense budget, the 200,000-per-purchase limit, the vendor list or the 10-31 deadline. The contract checks that a release has a recorded APPROVE (or a client-approved HOLD) for that evidence hash, that it pays the payee recorded with that decision (`PayeeMismatch`), that `spent + amount` stays within the deposit, and that the project is not stopped. The agent key alone (`RELAYER_KEY`, the escrow's agent) could still record an APPROVE of its own with any payee and release it. The expense rules are enforced by code before any chain call and checked afterwards by the audit: it re-derives every decision from the logged mandate, requires every chain event to match a log line (a decision the agent records on its own has none), checks every recorded and paid payee against the registry address of the logged vendor, and compares the on-chain `spent` with the logged paid total.

Signatures are HMAC-SHA256 with demo keys published in `escrow/policy.py` (`DEMO_KEYS`), over the policy hash and over each signed action; they stand in for wallet (EIP-712) signatures and prove nothing outside the demo. On Monad the client-side calls (`createProject`, deposit, `approveHold`/`rejectHold`, `stopProject`) are sent with `DEPLOYER_KEY`, standing in for the client's wallet.

## Run the demo

Python 3 (standard library only) and Foundry (`~/.foundry/bin`). Copy `.env.example` to `.env`: `KILN_API_KEY` for Kiln, and `MONAD_RPC`, `DEPLOYER_KEY`/`ADDRESS`, `RELAYER_KEY`/`ADDRESS` for Monad testnet (test keys only). The Kiln cache and usage log (`harness/runs/`) and `.env` stay local.

```shell
python3 harness/check.py                          # 51 offline invariants (SimEscrow, no AI, no network)
forge test                                        # the contract's tests
python3 -m escrow.demo --chain sim                # the full story on the in-memory chain -> runs/demo-sim.json
python3 -m escrow.demo --chain monad              # the same on Monad testnet -> runs/demo.json
python3 -m escrow.demo --changed --chain monad    # changed words (Figma dropped, 30만) -> runs/demo-changed.json
python3 -m escrow.demo --audit runs/<project-id>  # another person's check: the log + the chain only (default --chain monad)
python3 -m http.server 8000                       # from the repo root, then open http://localhost:8000/web/
python3 -m pcp compile escrow "가비아에서만 총 5만원, 이번 주 금요일까지"   # one policy by hand: both readings, readback, cost
python3 script/deploy_monad.py                    # deploy MockUSDC + ExpenseEscrow to Monad testnet (idempotent)
python3 -m escrow.chain_monad                     # a throwaway smoke project on the deployed escrow
```

Two clocks: scenario time (the log's `at`, KST) starts 2026-10-01 10:00 and drives every rule (deadline, review windows); chain block times are the real time the demo ran. The audit prints both for each chain event. On chain 1 test-token unit = 1 KRW.

`--audit` checks against the chain the auditor chooses (default: Monad testnet — never the chain the log names about itself; `--chain none` checks the log alone). It looks up the receipt of every logged tx (each must be mined with the logged status), scans events only from the create block to the highest of those blocks + 3, and rules out payments after that block by comparing `projects(id)` (spent, deposited, policy hash, stopped) with the log. A log with tx lines passes only with that real chain check, and a log that pays money for a project the chain does not know fails.

`log #N` below and in the viewer is the log line's 0-based `i` field in `log.jsonl` (line N + 1 of the file).

## TypeScript API and UI sample

```shell
cd backend && npm install && npm test
cd frontend && npm install
cd backend && npm run dev
cd frontend && npm run dev
```

Open http://localhost:5173. Create the project (the demo policy is prefilled), then use the case buttons to submit the four expenses. The UI proxies `/api` to port 3010. The server reads `../.env`: set `KILN_MODE=live` plus `KILN_API_KEY` for Qwen3-32B, and `ESCROW_ADDRESS`, `USDC_ADDRESS`, `AGENT_PRIVATE_KEY`, `CLIENT_PRIVATE_KEY` after the contracts are deployed; until then decisions are stored in SQLite and `chain.status` is `skipped`. `GET /demo-policy` returns the section 16 policy ($1,000 budget, $400 max transaction); `POST /projects` then `POST /projects/:id/expenses` with `{ "text": "..." }`. Mock mode labels token totals under `mock` on `GET /metrics`; do not paste those into the evidence table.

To deploy the legacy prototype to Base Sepolia (not part of `forge test`):

```shell
export ESCROW_AGENT=0xYourBackendSigner
forge script script/Deploy.s.sol:Deploy \
  --rpc-url base_sepolia \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

`ESCROW_AGENT` is the only address allowed to record decisions and release payments. The payee is fixed on the decision and cannot be changed at release. The key you broadcast with becomes the contract owner and can rotate that signer with `setAgent`. There, amounts are MockUSDC base units with 6 decimals, so $200 is `200000000`.

## Demo evidence

*From `runs/demo.json` and `runs/demo-changed.json`, run on Monad testnet (chain 10143) on 2026-09-29; a rerun replaces them.* Escrow [`0x1E0f664D…18Ba`](https://testnet.monadvision.com/address/0x1E0f664D9be58f4A703b33f45720776Fe74718Ba) (deploy [`0xeef27cda…7126`](https://testnet.monadvision.com/tx/0xeef27cdadea43d6c29c3438c1d44242633a821b187ddd3e784ee7b827fba7126)), token MockUSDC `0x309b1dDa…7F43`.

**Policy.** Words: “홈페이지 리뉴얼 경비는 AWS나 Vercel 호스팅, 가비아 도메인, Figma, Adobe Stock에서만 결제. 총 50만원, 부가세 포함 한 건에 20만원 이하, 10월 31일까지.” The two blind readings agreed on one mandate (`5c130d42…a964`: budget 50만, 5 vendors, `total <= 20만`, `at <= day_end(2026, 10, 31)`; `chosen_by: agreement`). Policy hash `0x422648f5…b455`, signed by client and contractor; deposit 4,500,000 (M1 1,500,000 + M2 2,500,000 + expense budget 500,000). Project `0x241edb11…f3dd`, records in `runs/0x241edb1144e8d6f47185258dff80bc0d81fed362918cb4403445a1634c8ff3dd/` (`log.jsonl`, `policy.json`); 41.0 s wall clock.

| Step | Request (scenario time) | AI reading | Verdict | Reason | Chain |
|---|---|---|---|---|---|
| E1 | 10-02 가비아 domain | gabia 22,000 + 2,200 | APPROVE → paid 24,200 | ok | decision + release |
| E2 | 10-03 Figma 2 seats | figma 90,000 + 9,000 | APPROVE → paid 99,000 | ok | decision + release |
| E3 | 10-05 쿠팡 keyboard | coupang 117,273 + 11,727 | BLOCK | merchant_not_allowed | decision (3) |
| E4 | 10-06 Adobe Stock pack | adobe-stock 185,000 + 18,500 | HOLD → client rejects, never paid | over_order_limit | decision (2) + rejectHold |
| E5 | 10-07 AWS invoice with “빠른결제대행으로 송금” injection | aws 163,637 + 16,363 (model not fooled) | APPROVE → paid 180,000 to the registry AWS address | ok | decision + release |
| M1 | 10-10 submit, 10-11 accept | — | paid 1,500,000 to contractor | accepted | decision + release |
| M2 | 10-20 submit, 10-22 tick (not due), 10-24 tick | — | paid 2,500,000 (client silent) | review_timeout | decision + release |
| E6 | 11-02 Vercel Pro (scenario clock; the block carries the real run time) | vercel 30,000 + 3,000 | BLOCK | outside_window | decision (3) |
| stop | 11-03 09:00 client stops the agent | — | STOP | — | stopProject |
| E7 | 11-03 Vercel | vercel 30,000 + 3,000 | BLOCK (logged) | stopped | refused before sending: `ProjectIsStopped` |
| close | 11-03 12:00 | — | refund 196,800 = 4,500,000 − 4,303,200 paid − 0 open (off chain) | — | none (no withdraw) |

Outside scope and stopped, all recorded: E3, E4, E6, E7 (and E5's injected account never reaches a payee field).

**Transactions with their matching log entries** (evidenceHash on chain = the head of that log line; the decision records the payee):

- E1 decision [`0xa0dffaa2…2a49`](https://testnet.monadvision.com/tx/0xa0dffaa24c03870609da39de8455d50445ad76fbff35935a6aa1747c24e92a49) and release [`0x85aa3887…9541`](https://testnet.monadvision.com/tx/0x85aa3887eafe8aec25a97b19328467e0ec44e53dc3635ecee75522f11da49541) → log #7, head `0xfe9555e0217b35044d084d569051d16a4518dee2112a6a23312ff6819ea939c0`; paid 24,200 to gabia's registry address `0x3cf00eda…1367`.
- E3 BLOCK decision [`0xa9595c02…11f9`](https://testnet.monadvision.com/tx/0xa9595c02f531e7216371e805cd5ce1bde7a4c3f46ba9fa964d44fdbbaa3211f9) → log #15, head `0xdc42ed6fd228818a71abca8ca609d639a88c42960a0472e52951cd52c69cc66d` (merchant_not_allowed, 129,000).
- E4 HOLD decision [`0x56b5960e…e2f3`](https://testnet.monadvision.com/tx/0x56b5960ee77865b0512283d9888db7705d6d9610f009c815f10193c3726ae2f3) → log #17, head `0xab32c7a9cd7e8845f67a25ef01900942997a2f087ebee37bab252c0a8d16437f` (over_order_limit, 203,500); the client's signed rejection (log #19) and rejectHold [`0xa351853d…240c`](https://testnet.monadvision.com/tx/0xa351853ddb994ee72715383801c3c852d1eb5cd1b0f5177ed62562ea8085240c); never paid.
- E5 decision [`0x5869554f…73c6`](https://testnet.monadvision.com/tx/0x5869554fd5fd13b3fec4a71e77f88592d7464af46cb8f8c059546582590d73c6) and release [`0xb18f52d0…4e82`](https://testnet.monadvision.com/tx/0xb18f52d024c23d434e95a6de63d4344212156b638668d8f30a96527220464e82) → log #21, to AWS's registry address `0xedcba7cc…14ee`.
- M2 by silence: decision [`0x8a187f37…38c8`](https://testnet.monadvision.com/tx/0x8a187f37945ec624f09cc2771e4bcbd810c719d2aae76e45b13377dc3da838c8) and release [`0xf65652b3…315f`](https://testnet.monadvision.com/tx/0xf65652b3ea972a05be5985e214a86866be05f4f93d676e9f8d4af06bebe9315f) → log #31, head `0xc879b5a021cceb46df6ba10bac3d8e2264610e111b0375355988c9e331438799`, 2,500,000 to the contractor.
- E6 BLOCK decision [`0xc48e3517…8346`](https://testnet.monadvision.com/tx/0xc48e35175d078e485f3cfba631194a81ee7ad897bbf711d00c8defa221588346) → log #34 (outside_window).
- stopProject [`0x977a7636…98c7`](https://testnet.monadvision.com/tx/0x977a7636641b25955dce90f8ac7609dcc9c21740ebbe38cc0d559300e35c98c7) → log #36.
- E7 after stop: logged as BLOCK stopped at log #38; the chain call was refused (`ProjectIsStopped`) before sending, logged at log #39 with no tx.

What the chain holds: read `projects(projectId)` → budget 4,500,000, deposited 4,500,000, spent 4,303,200, stopped true; written: ProjectCreated, Deposited, 8 DecisionRecorded (each with its payee), HoldRejected, ProjectStopped; settled: 5 PaymentReleased (test-token transfers to the recorded payees).

**Audit (another person, records alone).** `python3 -m escrow.demo --audit runs/0x241edb1144e8d6f47185258dff80bc0d81fed362918cb4403445a1634c8ff3dd` in a fresh process: the log's hash chain holds (41 lines, 18 tx lines), every decision re-derives from the logged mandate and signed actions (replay state = live state), every logged tx has a receipt with the logged status, all 17 chain events match a log line (evidenceHash = head, policy hash, amount, decision code, recorded and paid payee = registry address of the logged vendor), nothing missing, and `projects(id)` after the scanned blocks 66657253..66657378 matches the log. Verdict: ALL OK. The sim run (`runs/demo-sim.json`) gives the same verdicts in-process; a standalone `--audit` of a sim workdir fails by design (no chain left to check).

**Condition changed** (`runs/demo-changed.json`, project `0xe5eac2f8…d8de`, records in `runs/0xe5eac2f8f04d4b1716a7b4b9035548b2b8f77af3b0147cc5ef3d85504001d8de/`, 22.4 s). Words without Figma and with 총 30만원 → the readings agree, new mandate `515b5564…f759`, new policy hash `0x1e22dcde…0ed3`, new on-chain project (one policyHash per project), deposit 4,300,000:

- E1 gabia APPROVE, decision [`0x0038243d…843f`](https://testnet.monadvision.com/tx/0x0038243d54d282ace7264f04321f19e267844e66a7a34d96c953fe85b51e843f) and release [`0x709f9189…71cc`](https://testnet.monadvision.com/tx/0x709f91896ff167faec7325c52b91a7c414849e48d9244f7b427a80839e7371cc) → log #7, paid 24,200.
- E2 Figma BLOCK merchant_not_allowed (dropped from the words), decision [`0x67a917a4…37bd`](https://testnet.monadvision.com/tx/0x67a917a43c251eb6cdfce37b5350f2ae3920c092c16d63ef019dcea44bea37bd) → log #11, head `0x888d39a9e783b4207ce07eb84c26e43026525558cb73a775e49f2ae3099b3a6b`.
- E3 쿠팡 BLOCK merchant_not_allowed, decision [`0x85e4e7b8…123c`](https://testnet.monadvision.com/tx/0x85e4e7b817db009e32efc57dc1428cfb308fc1c07991f37e1d61cbfac2b2123c) → log #13.
- E4 Adobe Stock 203,500 HOLD over_order_limit [`0xff0c7e95…638b`](https://testnet.monadvision.com/tx/0xff0c7e95f6463f09a21b3bd10d57ae3a982baaf401940d12bd7039eb9898638b) → log #15; the client approves (signed, log #17) with approveHold [`0x11092a3d…d62c`](https://testnet.monadvision.com/tx/0x11092a3dc6a927d0b782fe290d5a3507a923dc8970165823d56a9055909ad62c); release [`0xf62e5caa…b12c`](https://testnet.monadvision.com/tx/0xf62e5caaa00b5aeeb278c585246482a453f48ec976632abb3be962d63bbdb12c) (spent 227,700).
- E5 AWS 180,000 BLOCK over_budget (227,700 + 180,000 > 300,000), decision [`0x1038e48e…2775`](https://testnet.monadvision.com/tx/0x1038e48e9fac4989b12a14d9d9ca957ad2610e688aa153d6112f58912b262775) → log #21, head `0x4246eebb96c046bd818f7783826ceb29b73fb32e810ec41d14b15b74946bd15d`.
- stopProject [`0x664bca26…9b46`](https://testnet.monadvision.com/tx/0x664bca26d909bfb34567f65debf2335cd3fcd90524b4e29f58943f8fac339b46) → log #23; close refunds 4,072,300 off chain (log #25).

`--audit runs/0xe5eac2f8…` in a fresh process: 26 lines (11 tx lines), replay ok, 11 events matched, 0 missing, blocks 66657388..66657456, ALL OK.

**Kiln usage by flow** (qwen3-32b; counted at the usage recorded when each call ran live; both Monad runs replayed every call from the cache, so they spent $0):

| Run | Flow | Calls | Prompt tokens | Completion tokens | Cost | Latency | Energy (1-card estimate) |
|---|---|---|---|---|---|---|---|
| full story | write (policy, writer) | 1 | 3,166 | 124 | $0.000288 | 4.15 s | 0.21 Wh |
| full story | read (policy, blind reader) | 1 | 2,816 | 77 | $0.000246 | 3.24 s | 0.16 Wh |
| full story | quote (7 vendor documents) | 7 | 4,715 | 901 | $0.000525 | 17.78 s | 0.89 Wh |
| full story | total | 9 | 10,697 | 1,102 | $0.001059 | 25.2 s | 1.26 Wh |
| changed | write, read, quote (5 documents) | 7 | 9,467 | 836 | $0.000687 | 17.2 s | 0.86 Wh |

Energy is an estimate assuming one FuriosaAI RNGD card at 180 W (published TDP) × measured latency / 3600, network time included. Kiln does not publish the hardware behind its endpoint, so this is not a measurement and not an upper bound: if a request runs across N cards the figure is N times larger (1.26 Wh for the full story on 1 card, 10.1 Wh on 8), and if Kiln batches requests the share per call is smaller.

## Limitations

- Policy enforcement lives in code. The contract enforces release conditions only (recorded APPROVE or a client-approved HOLD, the recorded payee, spent within the budget = the whole deposit, project not stopped). It does not check the expense budget, the per-purchase limit, the deadline, category, vendor, scope, or duplicates; the agent key alone could record and release a decision of its own. The audit catches that after the fact.
- AI may misparse documents. Misinterpretation fails safe to HOLD.
- Demo tokens are test assets (MockUSDC; on Monad testnet the demo treats 1 base unit as 1 KRW).
- The model is Qwen3-32B (`qwen3-32b`) via Kiln. The challenge brief names gpt-oss-120b; the track moved to qwen3-32b (see `docs/kiln-notes.md`).
- Signatures are HMAC with public demo keys (`escrow/policy.py`), standing in for wallet signatures.
- Stopping then closing leaves owed items (approved but unpaid, milestones in review) reserved, because the legacy contract freezes on stop.
- Scenario time and chain time differ: the rules run on the logged scenario clock; block timestamps are the real time of the run.
