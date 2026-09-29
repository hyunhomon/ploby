# SmartEscrow Documentation

SmartEscrow is a bilateral project escrow. It protects clients from unauthorized spending and unverified delivery, while protecting contractors from unpaid work, pre-financed expenses, silent review delays, and retroactive scope changes.

## Start here

| Document | Audience | Purpose |
| --- | --- | --- |
| [Product overview](product-overview.md) | Everyone | What the service solves, who it protects, and what the MVP includes |
| [How it works](how-it-works.md) | Product, design, and engineering | Step-by-step project, milestone, expense, dispute, and close flows |
| [System architecture](system-architecture.md) | Engineering and security | Components, trust boundaries, on-chain enforcement, and failure behavior |
| [Terminology](terminology.md) | Everyone | Canonical meaning of product and state-machine terms |
| [Architecture decisions](adr/README.md) | Engineering and reviewers | Normative decisions and rejected alternatives |
| [Kiln API notes](kiln-notes.md) | Backend engineering | Current model-provider integration notes |

## Document authority

The human-readable documents explain the product but do not replace the ADRs. If an explanatory document and an accepted ADR conflict, the ADR is authoritative and the explanatory document must be corrected.

The current Solidity contracts are an initial Phase 1 implementation. They do not yet implement the complete target architecture described here. Current implementation-specific choices are recorded in the repository root `DECISIONS.md`.
