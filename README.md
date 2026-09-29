A Smart Escrow system that uses AI to interpret project contracts, budgets, and financial evidence, and releases only expenses that comply with pre-agreed conditions.

Phase 1 is the Base Sepolia contracts only. The API, UI, and demo evidence table are not built yet.

## Quickstart

```shell
forge test
```

Deploy to Base Sepolia when you have a funded deployer key and the backend signer address. This does not run as part of `forge test`.

```shell
export ESCROW_AGENT=0xYourBackendSigner
forge script script/Deploy.s.sol:Deploy \
  --rpc-url base_sepolia \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

`ESCROW_AGENT` is the only address allowed to record decisions and release payments. The key you broadcast with becomes the contract owner and can rotate that signer with `setAgent`.

Amounts are MockUSDC base units. 6 decimals, so $200 is `200000000`.

## Demo evidence

Not run yet. The four cases in spec section 16 get a Basescan link, policy checks, and token counts after Phase 4.

## Limitations

- Policy enforcement lives in backend code. The contract enforces release conditions (recorded APPROVE, or a client-approved HOLD, remaining budget, project not stopped). It does not check category, vendor, scope, or duplicates.
- AI may misparse documents. Misinterpretation fails safe to HOLD.
- Demo tokens are test assets (MockUSDC on Base Sepolia).
- The model is Qwen3-32B via Kiln. The track replaced gpt-oss-120b.
