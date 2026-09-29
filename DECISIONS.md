# Decisions

Implementation assumptions made where the initial spec is silent. Newest first.

## 2026-09-29 — Payee bound at record time

`recordDecision` takes the payee and stores it on that decision. APPROVE and HOLD require a non-zero payee. BLOCK may record `address(0)` because it cannot be paid. `release` reverts `PayeeMismatch` when the caller passes a different address. `approveHold` and `rejectHold` have no payee argument, so client review cannot redirect the payment.

The agent still chooses the payee when it records the decision. This is not ADR 0001: the target binds the payee in a bilateral commitment before the backend signs. This entry supersedes the part of item 5 that let `release` treat the caller's payee as the destination.

This file describes the legacy Phase 1 contracts and is not an implementation plan. Accepted target architecture is recorded in [`docs/adr`](docs/adr/README.md). Where a Phase 1 choice conflicts with an ADR, this file remains the description of legacy behavior and the ADR is the required direction for future implementation. In particular, the target design uses isolated project escrows, pre-funded work milestones, bilateral purchase commitments, deadline-backed settlement, and refunds.

## 2026-09-29 — Phase 1 contracts

1. **Amounts are MockUSDC base units (6 decimals).** $1 = 1_000_000. The contract has no dollar math.
2. **Decision codes.** `1` APPROVE, `2` HOLD, `3` BLOCK. `0` reverts. The spec says `uint8 decision` and does not assign numbers.
3. **Who the client is.** `createProject` is permissionless. `msg.sender` is stored as that project's client. Only that address can `deposit`, `stopProject`, `approveHold`, and `rejectHold`.
4. **Who the agent is.** `recordDecision` and `release` are restricted to `agent`, the backend signer set in the constructor. The deployer (`owner`) may call `setAgent` to rotate that signer. The spec says release is backend-only and does not say who may record a decision; recording is restricted the same way so a third party cannot write the audit log.
5. **`release` takes `evidenceHash`.** The brief lists `release(projectId, payee, amount)`. Two recorded expenses can share an amount, so the contract cannot tell which decision authorizes a payment without the evidence hash. Signature used: `release(projectId, evidenceHash, payee, amount)`. The amount must equal the recorded amount. The payee must equal the address stored by `recordDecision` (see the entry above).
6. **A HOLD is payable only after `approveHold`.** The client calls `approveHold`. The agent still calls `release`. `rejectHold` is not in the brief. It exists so a client rejection cannot be paid later. The decision record is kept either way.
7. **`deposit(projectId)` pulls the full unfunded budget.** The specified signature has no amount. The client must approve and hold `budget` base units. A second deposit reverts.
8. **Timestamp in `PaymentDecision` is replaced with `block.timestamp`.** The backend cannot backdate the log. Calldata timestamp is ignored.
9. **`policyHash` on a decision must match the hash stored at `createProject`.** There is no policy-update function in this phase.
10. **Duplicate decision hash.** `keccak256(abi.encode(projectId, evidenceHash))`. The same evidence cannot be decided twice on one project, including a second call that flips APPROVE to BLOCK.
11. **Budget is enforced on `release`, not on `recordDecision`.** An APPROVE larger than the remaining budget can be logged and still cannot be paid (`OverBudget`). `spent + amount > deposited` reverts `InsufficientDeposit`. This matches "the contract enforces release conditions, not the full policy."
12. **`stopProject` freezes the project.** After it, `recordDecision`, `release`, `deposit`, `approveHold`, and `rejectHold` revert. Unspent tokens stay in the contract. No withdraw function in this phase; the demo token is MockUSDC.
13. **No OpenZeppelin.** `MockUSDC` is a small ERC-20. `nonReentrant` is a one-slot lock on `deposit` and `release`.
14. **Deploy script refuses every chain except Base Sepolia (84532).**
