# Three-minute demo script

Setup: `python3 -m escrow.server`, `cd frontend && npm run dev`, then `python3 harness/demo_setup.py` (prints a signed, funded project and one link per role). Open the client and contractor links in two windows side by side; `&as=` pins each window's role. Switch the UI to English with the language selector at the top right. Views refresh every ten seconds. The recorded runs are in [`evidence.md`](evidence.md).

Rehearse once with the default task and the seven offers. Kiln answers are cached per exact request (`harness/runs/cache`), so on stage the same plan and readings replay at no cost, even if the venue network or Kiln is unstable (the usage line then says cached). Chain calls retry in order when the network drops. The default task text follows the UI language; rehearse in the language you will present in, since a different task text is a new (live) Kiln call and the agent may plan differently.

| Time | Screen | What to say |
| --- | --- | --- |
| 0:00–0:20 | Home | "The trouble starts after you hand money to an AI. Payment rails record who paid whom, not who allowed it or on what terms. Ploby lets an AI purchasing agent only *request* purchases; a policy both parties signed decides, and a contract moves the money." |
| 0:20–0:45 | Client · Overview · **On-chain escrow** card | "The client signed the policy and funded it. That deposit is a Monad testnet transaction, and the on-chain balances match the engine's ledger exactly. The contract pays only the contractor wallet written in the policy." |
| 0:45–1:35 | Contractor · Expenses · **Purchase agent** | Keep the default task and all seven offers, then "Hand it to the agent". "One Kiln call makes the plan. The rules answer each request. The domain is **APPROVE**. The 40-image pack is within the cap before VAT, but over 200,000 won with VAT: **BLOCK**. The agent then files its plan's next offer, the 10-image pack, and gets **APPROVE**: the engine's answer drives the agent's next step. Coupang is not on the list: **BLOCK**. The AWS invoice carries an injected order to change the payee. The agent was fooled, but the price anomaly made it a **HOLD**, and the payee can't change anyway." Click a tx link under a request to show the `Decided` event on the explorer. |
| 1:35–2:05 | Client · Manage · **Pause new commitments** → Contractor · run the agent again | "The client stops it. That is a transaction from the client's own wallet. The agent's next request doesn't vanish: it is a **BLOCK (project state)** in the log and on chain, and the agent stops the task." |
| 2:05–2:40 | **Verify** tab → Verify now (or `python3 -m escrow.audit …` in a terminal) | "This doesn't trust our server. It recomputes everything from the log file and the public chain: every signature and the hash chain, a replay of the log, which policy and rules allowed each payment and who approved it, each transaction's event against its log line, and the contract's balances against the ledger." |
| (if time) | Terminal `python3 harness/tamper.py` | "Change one amount in the log and the auditor names that line. Re-sign it with our public demo key and it still fails: the log heads and the amount anchored on chain don't match. That is what the chain guarantees." |
| 2:40–3:00 | [`efficiency.md`](efficiency.md) table | "Zero model calls decide money. Rules are compiled once per project, each document is read once and cached. Tokens and energy per flow are in this table. The AI only interprets; rules and a contract move the money." |

## Before presenting

1. `git pull`, and `.env` with `KILN_API_KEY`, `DEPLOYER_KEY` and `RELAYER_KEY` (chain keys from the web3 teammate).
2. The `python3 -m escrow.server` start line shows `Kiln on` and `chain Monad testnet 0x0c54…`.
3. `cd frontend && npm run dev`, then open the two links `python3 harness/demo_setup.py` prints, and pick English.
4. Rehearse once with the default task and seven offers to fill the cache. Check the operator's gas with `python3 -c "from escrow import chain; print(chain.Rail(write=False).gas('operator'))"` (the worker tops it up below 0.3 MON).
5. Keep an explorer tab open on the PlobyEscrow address.
6. No network? Present from [`evidence.md`](evidence.md) (its table and tx links), the README screenshots and `python3 harness/tamper.py --offline`. The results are the same.

## Expected questions

- **What if your operator key is stolen?** It could record an out-of-policy decision, but it cannot pay anyone but the contractor or move more than was funded, and the client can pause on chain at any time. Enforcing the decisions themselves on chain (EIP-712, a per-project ProjectEscrow) is the target design.
- **Shouldn't the agent know the rules?** It may, but nobody needs to trust it. Whatever the agent believes, code reads the vendor's document itself and decides. In our run the agent picked the injected invoice and the policy caught it.
- **Why not gpt-oss-120b?** The organizers changed the challenge model and Kiln returns 404 for gpt-oss-120b. Every stage runs `qwen3-32b`, routed per stage in `pipeline.json`.
- **What if the model fails?** A failed reading is a HOLD, a failed plan files nothing. Nothing is ever approved automatically.
