# Ploby on chain

Current implementation: Ploby's engine decides every request off chain; **PlobyEscrow** on Monad testnet holds the client's money and enforces what the engine's operator key must never be able to do. The target design (an immutable per-project `ProjectEscrow` that enforces the decisions themselves, with EIP-712 signatures) is in [`docs/adr`](adr/README.md) and is not implemented.

| | Address | Explorer |
| --- | --- | --- |
| PlobyEscrow | `0x0c54143Ba8480c9C041E27C5FDed6e13B2541762` | [monadvision](https://testnet.monadvision.com/address/0x0c54143Ba8480c9C041E27C5FDed6e13B2541762) |
| tKRW (test token, 0 decimals, 1 unit = 1 KRW) | `0xE73a03D814434987f33f5E2b6b51c1dD8A44af58` | [monadvision](https://testnet.monadvision.com/address/0xE73a03D814434987f33f5E2b6b51c1dD8A44af58) |
| Demo client wallet (opens, funds, pauses) | `0xD51bb0f75beBCb03EE5B40f1f0a04a5BA060F845` | |
| Operator = Ploby's engine (decides, settles, refunds) | `0x90eB1b3A44A86B64181d62A7d73e026f04F15BDC` | |

Chain id 10143. Deployment record: [`deployments/monad-testnet.json`](../deployments/monad-testnet.json); deploy script: [`script/deploy_ploby.py`](../script/deploy_ploby.py); contract: [`src/PlobyEscrow.sol`](../src/PlobyEscrow.sol) with 12 Foundry tests in [`test/PlobyEscrow.t.sol`](../test/PlobyEscrow.t.sol).

## What the contract enforces

Even with the operator key, nobody can:

- pay anyone but the contractor the client fixed when opening the project (`settle` always pays `p.contractor`), or refund anyone but the client;
- reserve, pay or refund more than the client funded (`InsufficientFunds`), or pay an expense or milestone more than was reserved for it (`OverReserved`);
- make a new reservation while the client has paused the project (`ProjectPaused`) — the client's stop, which is the client's own transaction;
- record a decision under a policy hash the client has not accepted (`PolicyMismatch`);
- apply the same call twice (`AlreadyApplied`: every call is keyed by the log line it mirrors).

HOLD and BLOCK decisions move no money but are still `decide` calls, so a stop is an on-chain event, not a silence.

## From the log to the chain

The chain mirrors the engine's ledger. [`escrow/chain.py`](../escrow/chain.py) compares the project's money before and after each log line and names the calls that make the chain agree (`calls`):

| Change in the log | Call | Signed by |
| --- | --- | --- |
| first deposit | `open(project, contractor, policyHash, budget)` then `fund` | client wallet |
| more deposits | `fund(amount)` | client wallet |
| a change order's policy version takes effect | `acceptPolicy(policyHash, budget)` | client wallet |
| pause / resume | `setPaused(bool)` | client wallet |
| a request is decided: APPROVE reserves; HOLD, BLOCK record | `decide(ref, decision, rule, amount, policyHash)` | operator |
| a milestone is reserved, a HOLD approved, a retroactive claim or an overage paid | `decide(ref, APPROVE, …)` for the missing reservation | operator |
| a settlement, a unit paid, a reservation returned | `settle(ref, pay, returned)` | operator |
| unreserved money returned to the client | `refund(amount)` | operator |

Every call carries the **log head right after its line** and its number `n` within that line. So the chain anchors the hash-chained log, each event (`Decided`, `Settled`, …) names its exact line, and the contract refuses a call applied twice.

One worker sends the calls in log order. Before sending, it estimates each call: a call the contract would refuse is not sent, and the refusal (the custom error's name) is logged. Each result is written back as a `chain` line signed by the relayer. It sits in the log next to the line it mirrors, with the tx hash and an explorer link. When the server starts, calls the log implies but has no result for are sent again. That is safe because the contract refuses duplicates.

## What the engine reads, writes and settles

- **Reads.** Before a purchase request is decided, the engine reads the contract's `paused` flag and `available` balance (`Store.onchain`). The values go into the request line's inputs, so a replay never needs the network. They can only make the `state` and `funds` rules stricter: a client who pauses directly on chain still stops the agent. When calls of the project are still in flight, the engine's own state is the newer one and is used alone.
- **Writes.** Every decision, including HOLD and BLOCK, becomes a `decide` event with the rule that decided it (`per_purchase`, `vendor`, `state`, `window`, `price_anomaly`, …).
- **Settles.** Payments to the contractor (`settle`) and refunds to the client (`refund`) move tKRW. The contractor's balance on the explorer is the receipt anyone can see.

## Checking it

`python3 -m escrow.audit <project>` reads each tx the log names from the public RPC (no keys). It checks that the receipt succeeded, that the event is the one the line implies (same log head, ref, amounts, decision, rule, policy hash, payee), and that the contract's `funded/reserved/paid/refunded` equal the replayed ledger. `harness/check.py` runs the same mapping offline over every scenario through a Python model of the contract's rules.

## Limits

- The engine decides; the contract does not recompute the rules. A stolen operator key could record an out-of-policy APPROVE and pay it, but only to the contractor and only within funded money. The target design removes this with bilateral EIP-712 signatures verified on chain.
- The demo client wallet and the operator key are held by the server (`.env`), like the demo HMAC keys for the log.
- Testnet only; tKRW is an open-mint test token.
