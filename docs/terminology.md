# Terminology

These terms have one canonical meaning across product copy, UI, APIs, contracts, and tests.

## Parties and services

| Term | Meaning |
| --- | --- |
| Project | One bilateral engagement between exactly one client identity and one contractor identity in protocol v1 |
| Client | The party funding the project and receiving work or project assets |
| Contractor | The party performing work and requesting expense commitments |
| Payee | The exact wallet receiving one settlement; contractor for reimbursement or work, vendor for direct payment |
| Resolver | The policy-selected neutral role that decides bounded disputes using predefined criteria |
| LLM parser | Untrusted service that extracts structured meaning from natural language and documents |
| Policy engine | Deterministic service that applies the pinned project policy |
| Policy signer | Constrained service key that signs validated commitment and settlement envelopes |
| Relayer | Convenience service that submits already-authorized transactions and pays gas |
| Evidence Attestation Service | Trusted MVP service that verifies evidence signals and produces consistent private invoice nullifiers |
| Project escrow | One immutable contract that holds and accounts for only one project's settlement asset |

## Agreements and identifiers

| Term | Meaning |
| --- | --- |
| Project policy | Immutable, versioned, bilaterally signed financial and workflow rules |
| Change order | A proposed new policy version for additional scope, budget, schedule, or criteria; non-binding until signed and funded |
| Project ID | Deterministic identifier for one client-contractor project escrow |
| Obligation ID | Unique identifier for one expense or milestone commitment |
| Commitment | A funded, immutable promise to pay under stated conditions |
| Reservation | Funds removed from available budget to back a commitment |
| Settlement | Transfer of an eligible amount to the committed payee |
| Retroactive request | Expense submitted after spending without a prior purchase commitment; no timeout payment guarantee |

## Obligation types

| Term | Meaning |
| --- | --- |
| Purchase commitment | Pre-spend expense authorization with reserved maximum settlement amount |
| Milestone commitment | Pre-funded service payment tied to deliverables and acceptance criteria |
| Delivery grace period | Final pre-agreed period after a milestone due time during which a delivery manifest may still be submitted |
| Settlement intent | Typed authorization to consume a reservation and pay an exact eligible amount |
| Handover holdback | Predefined milestone unit released after project-asset handover evidence is accepted |

## Decisions

| Term | Meaning |
| --- | --- |
| APPROVE | All mandatory rules pass and the request may reserve or settle |
| HOLD | No mandatory rule has produced an immediate final result, but review, evidence, or dispute resolution is required |
| BLOCK | A deterministic mandatory rule failed; the current request cannot create or settle an obligation |
| REJECTED | A previously held or disputed amount reached a terminal non-payment result |
| RELEASED_BY_TIMEOUT | A pre-agreed deadline elapsed and the deterministic fallback released payment |
| OUT_OF_SCOPE | The request is not authorized by the active policy and may be converted into a non-binding change-order draft |

## HOLD classes

| Class | Meaning |
| --- | --- |
| CLIENT_REVIEW | Business objection without an objective policy or integrity failure |
| POLICY_OR_SYSTEM_AMBIGUITY | Evidence and payable facts are valid, but deterministic evaluation is temporarily unavailable or ambiguous |
| EVIDENCE_DEFECT | Required evidence is missing, corrupt, or below policy assurance |
| INTEGRITY_RISK | Post-commitment evidence-signature issue, probable duplicate, or supported fraud signal requires resolver review; an exact invoice-allocation excess is BLOCK instead |
| EXCESS_AMOUNT | Eligible actual cost exceeds the committed maximum |

## Evidence

| Level | Meaning |
| --- | --- |
| E0 | Assertion only; no independent document evidence |
| E1 | Preserved uploaded file whose issuer is not authenticated |
| E2 | Original email whose aligned DKIM signature validates |
| E3 | Vendor API record or vendor-signed verifiable credential |
| Evidence manifest | Canonical list and digest of evidence submitted for one request |
| Decision bundle | Canonical audit record containing structured input, policy, rule results, versions, reasons, and outcome |
| Invoice nullifier | Opaque stable identifier used to coordinate allocation without publishing invoice contents |

## Project controls

| Term | Meaning |
| --- | --- |
| Pause new commitments | Client control that prevents new obligations but does not delay existing settlement |
| Security freeze | Administrator-multisig incident control that temporarily pauses all transfers, extends deadlines, and cannot cancel obligations |
| Closing | Project state that stops new obligations while existing obligations and asset handover finish |
| Refundable | Funded amount that is neither released nor reserved and may be returned during closing or cancellation |
| Migration | Bilaterally approved move from one immutable project escrow version to another |

## Asset treatments

| Term | Meaning |
| --- | --- |
| CONSUMABLE | Project usage with no continuing transferable asset |
| PROJECT_ASSET | Client-beneficial asset for which the contractor may be temporary custodian |
| CONTRACTOR_TOOL | Contractor-owned reusable tool for which the project buys only agreed usage |
| SHARED_ASSET | Subscription or infrastructure intentionally allocated across projects |
