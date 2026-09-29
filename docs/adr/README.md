# Architecture Decision Records

This directory records decisions that define the SmartEscrow product and trust model before the implementation is expanded beyond the initial contracts.

An ADR marked **Accepted - implementation pending** is the target design. It does not mean the current contracts or services already implement the decision. Any known gap is called out in the ADR and must be closed before the relevant feature is represented as production-ready.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-authority-and-payment-authorization.md) | Separate AI interpretation from payment authority and bind releases to an immutable payment intent | Accepted - implementation pending |
| [0002](0002-policy-format-versioning-and-evaluation.md) | Use immutable, versioned, canonical policies with deterministic evaluation semantics | Accepted - implementation pending |
| [0003](0003-evidence-and-audit-records.md) | Keep evidence private off-chain and anchor canonical manifests and decision bundles on-chain | Accepted - implementation pending |
| [0004](0004-project-lifecycle-and-refunds.md) | Define reversible pause, terminal close, expiry, and refund behavior | Accepted - implementation pending |

## ADR conventions

- ADRs are append-only decision history. Superseded decisions remain in the repository and link to their replacements.
- Product claims and diagrams must distinguish current behavior from accepted target behavior.
- Amounts are integers in the token's base unit. Floating-point monetary values are not permitted.
- Unknown, unavailable, or invalid AI output never produces an automatic approval.
- A future implementation change that contradicts an accepted ADR must first update or supersede that ADR.
