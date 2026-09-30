# Ploby Documentation

Ploby is a bilateral project escrow. It protects clients from unauthorized spending and unverified delivery, while protecting contractors from unpaid work, pre-financed expenses, silent review delays, and retroactive scope changes.

## Start here

| Document | Audience | Purpose |
| --- | --- | --- |
| [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md) | Everyone (Korean) | The project's first-class reference, kept unchanged: purpose, flows, decisions, roles, ledger and target design (it uses the earlier product name, SmartEscrow) |
| [Product overview](product-overview.md) | Everyone | What the service solves, who it protects, and what the MVP includes |
| [How it works](how-it-works.md) | Product, design, and engineering | Step-by-step project, milestone, expense, dispute, and close flows |
| [System architecture](system-architecture.md) | Engineering and security | Components, trust boundaries, on-chain enforcement, and failure behavior |
| [Terminology](terminology.md) | Everyone | Canonical meaning of product and state-machine terms |
| [Architecture decisions](adr/README.md) | Engineering and reviewers | Normative decisions and rejected alternatives |
| [Kiln API notes](kiln-notes.md) | Backend engineering | Current model-provider integration notes |
| [Ploby on chain](chain.md) | Reviewers and engineering | PlobyEscrow on Monad testnet: what the contract enforces, how each log line becomes a call, what the engine reads, writes and settles |
| [Challenge B evidence](evidence.md) | Reviewers | Six purchase-agent runs, five pushed outside the line, each with its log line, decision and transaction, re-checkable with the auditor |
| [Demo script](demo.md) | Presenters (Korean) | The three-minute demo and expected questions |
| [Kiln usage and efficiency](efficiency.md) | Reviewers and engineering | Kiln token use and cost per flow, energy estimates with their sources, and how the design avoids unnecessary inference |
| [Ploby API](api.md) | Frontend and backend engineering | The contract between the engine (`escrow/`) and the web app (`frontend/`) |

## Document authority

The human-readable documents explain the product but do not replace the ADRs. If an explanatory document and an accepted ADR conflict, the ADR is authoritative and the explanatory document must be corrected.

`PROJECT_OVERVIEW.md` is the first-class reference and is not edited. As its §22 says, current behaviour is defined by the code and tests; the repository README and [api.md](api.md) describe the current implementation.

The current application decides every request in an off-chain deterministic engine (`escrow/`) with a signed, hash-chained log, and mirrors the money on Monad testnet through `src/PlobyEscrow.sol`: the contract holds the funds, pays only the contractor fixed at opening, never moves more than was funded, refuses new reservations while the client has paused, and records every decision with the log head of the line that made it ([chain.md](chain.md)). This is not the target architecture described here (an immutable per-project escrow that enforces the decisions themselves, with EIP-712 signatures), and it must not be used with real funds. The earlier `src/ExpenseEscrow.sol` is a legacy Phase 1 prototype that the application does not use; its implementation-specific choices are recorded in the repository root `DECISIONS.md`.
