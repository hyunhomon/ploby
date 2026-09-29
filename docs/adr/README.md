# Architecture Decision Records

This directory records the target product and system architecture for SmartEscrow.

An ADR marked **Accepted - implementation pending** is binding for future design work but is not a claim that the current contracts or services implement it. The initial contracts predate several decisions below. Product copy and demos must distinguish current behavior from this target architecture.

## Product principle

SmartEscrow is a bilateral commitment system, not a client surveillance tool.

It protects the client from unauthorized spending and protects the contractor from pre-financing, silent payment delay, retroactive policy changes, and unpaid scope expansion. Neither party may unilaterally rewrite an accepted commitment.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-authority-and-payment-authorization.md) | Separate interpretation, authorization, execution, and dispute authority | Accepted - implementation pending |
| [0002](0002-policy-format-versioning-and-evaluation.md) | Use bilateral, immutable, versioned policies and signed change orders | Accepted - implementation pending |
| [0003](0003-evidence-and-audit-records.md) | Keep evidence private, grade its assurance, and anchor reproducible audit bundles | Accepted - implementation pending |
| [0004](0004-project-lifecycle-and-refunds.md) | Preserve accepted commitments through pause and close while guaranteeing refunds | Accepted - implementation pending |
| [0005](0005-purchase-commitments-and-settlement.md) | Reserve before spend, settle after evidence, and give every HOLD a deadline | Accepted - implementation pending |
| [0006](0006-project-assets-and-handover.md) | Record asset ownership and couple handover acceptance to a defined holdback | Accepted - implementation pending |
| [0007](0007-shared-expense-allocation-registry.md) | Enforce cross-project invoice allocation without publishing invoice contents | Accepted - implementation pending |

## Precedence and conventions

- These ADRs define the target architecture. Root-level `DECISIONS.md` records choices made for the current Phase 1 contracts. Where they differ, both documents remain true for their stated scope.
- ADRs are append-only decision history. A changed decision is updated before implementation starts; after implementation ships, a replacement ADR supersedes it.
- Amounts are integers in the settlement asset's base unit. Floating-point monetary values are prohibited.
- Unknown, unavailable, malformed, or invalid AI output never produces APPROVE.
- Every payable obligation is identified by an immutable commitment or settlement digest.
- Every HOLD has a class, deadline, and deterministic fallback. No state may wait indefinitely for client action.
- Existing commitments survive policy replacement, project pause, and project closing unless both parties cancel them or the defined dispute process rejects them.
- An uncommitted, post-spend reimbursement request has no automatic-payment guarantee.
