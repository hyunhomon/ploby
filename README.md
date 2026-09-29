A bilateral Smart Escrow system that pre-funds outsourced work and project expenses, uses AI to interpret supporting documents, and enforces accepted commitments with deterministic rules.

Phase 1 is the Base Sepolia contracts only. The API, UI, and demo evidence table are not built yet.

> **Legacy prototype warning:** the current Solidity contracts implement only the original Phase 1 expense demo. `release` pays the payee stored with the decision and cannot substitute another address. The agent still chooses that payee when it records the decision. The contracts do not provide refunds after `stopProject`, reserve milestone or expense funds, or implement the accepted target architecture. Do not use the current deployment script for real funds or represent it as the target SmartEscrow protocol.

The accepted target architecture is documented in [`docs/adr`](docs/adr/README.md). Those ADRs include bilateral purchase commitments, settlement deadlines, policy versioning, refunds, asset handover, and shared-expense allocation that the current Phase 1 contracts do not yet implement.

For a human-readable introduction, start with [`docs/README.md`](docs/README.md), then read the product overview, end-to-end flows, system architecture, and terminology guide.

## Quickstart

```shell
forge test
```

Deploy the legacy prototype to Base Sepolia only when reproducing the original Phase 1 demo. This does not run as part of `forge test`.

```shell
export ESCROW_AGENT=0xYourBackendSigner
forge script script/Deploy.s.sol:Deploy \
  --rpc-url base_sepolia \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

`ESCROW_AGENT` is the only address allowed to record decisions and release payments. The payee is fixed on the decision and cannot be changed at release. The key you broadcast with becomes the contract owner and can rotate that signer with `setAgent`.

Amounts are MockUSDC base units. 6 decimals, so $200 is `200000000`.

## Demo evidence

Not run yet. The four cases in spec section 16 get a Basescan link, policy checks, and token counts after Phase 4.

## Limitations

- Policy enforcement lives in backend code. The contract enforces release conditions (recorded APPROVE, or a client-approved HOLD, remaining budget, project not stopped). It does not check category, vendor, scope, or duplicates.
- AI may misparse documents. Misinterpretation fails safe to HOLD.
- Demo tokens are test assets (MockUSDC on Base Sepolia).
- The model is Qwen3-32B via Kiln. The track replaced gpt-oss-120b.
