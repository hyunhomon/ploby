# ADR 0006: Project Assets, Custody, and Handover

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, backend, and protocol

## Context

Outsourced work often creates assets that outlive the expense: domains, cloud accounts, repositories, design workspaces, software licenses, certificates, API integrations, and subscriptions. Payment records alone do not establish who owns those assets, who currently controls them, or what must happen at project close.

Clients risk paying for assets that remain under contractor control. Contractors risk completing a handover while the client indefinitely withholds final payment. External account transfers are off-chain events, so a blockchain transaction cannot by itself make an AWS or domain transfer atomic.

## Decision

Every commitment is classified by asset treatment before budget is reserved. Asset-producing commitments create or update a private project asset register. A defined final-payment holdback is released against a handover attestation; unrelated expense settlements cannot be withheld for asset-transfer disputes.

## Asset treatments

| Treatment | Definition | Default ownership |
| --- | --- | --- |
| `CONSUMABLE` | Usage that leaves no transferable asset, such as API calls or consumed cloud compute | No continuing asset |
| `PROJECT_ASSET` | Domain, account, repository, license, dataset, or other asset acquired specifically for the project | Client beneficial ownership; contractor may be temporary custodian |
| `CONTRACTOR_TOOL` | Contractor-owned reusable tool or seat used to perform work | Contractor; the project pays only the agreed usage allocation |
| `SHARED_ASSET` | Subscription or infrastructure intentionally shared across projects | Ownership and allocation specified by policy; never presumed to transfer in full |

The LLM may suggest a treatment. The policy engine validates it, and the accepted commitment makes it authoritative. An ambiguous treatment produces HOLD before purchase.

## Asset register

The private canonical register contains:

```text
ProjectAsset
- schemaVersion
- projectId
- assetId
- obligationId
- assetType
- displayName
- ownershipTreatment
- beneficialOwner
- currentCustodian
- externalProvider
- externalIdentifierHash
- recurringCost
- renewalOrExpiryAt
- cancellationOwner
- requiredHandoverEvidence[]
- handoverDeadline
- status
```

The register is encrypted off-chain. Its canonical hash is included in project audit checkpoints. API keys, passwords, recovery codes, account IDs, and raw provider URLs are never stored on-chain or in the canonical public commitment.

## Handover workflow

```text
IDENTIFIED -> ACTIVE -> HANDOVER_REQUESTED -> EVIDENCE_SUBMITTED
                           |                    |            |
                           |                    -> ACCEPTED   -> DISPUTED
                           |                          |             |
                           |                          -> COMPLETE <-+
                           |
                           -> NON_HANDOVER -> late resolver acceptance -> COMPLETE
                                  |
                                  -> UNRESOLVED_NON_HANDOVER
```

1. The accepted policy or change order defines required handover evidence for each asset type.
2. The contractor transfers control through the external provider and submits the signed `SubmissionNotice` from [ADR 0001](0001-authority-and-payment-authorization.md), bound to the handover evidence manifest. Its on-chain timestamp starts the client review clock.
3. The client has the policy's client review period to accept or object with a reason code tied to a missing checklist item.
4. Valid client acceptance creates a `HandoverAttestation` and releases the predefined holdback.
5. Client silence or objection escalates to the project resolver.
6. The resolver has the policy's resolver period to validate the checklist and evidence.
7. If the resolver is also silent, the holdback is released by timeout only when every required evidence item was submitted before `handoverDeadline`, each item meets the policy's minimum assurance, and no item relies only on an E1 screenshot or image. Otherwise it is `REJECTED_BY_TIMEOUT`, the holdback reservation is released, and failed checklist items are recorded.

Unlike a capped expense claim, a handover claim does not auto-release solely because the notice bitmap is complete while the attestation service is unavailable. External control transfer cannot be inferred from the claimant's slot assertion. Protocol v1 therefore requires client acceptance, resolver acceptance, or a qualifying handover attestation; resolver silence without one rejects the holdback. This stricter fallback is fixed and cannot be weakened by project policy.

If no `SubmissionNotice` exists at `handoverDeadline`, any account may trigger `NON_HANDOVER` and start the resolver period. The contractor may submit a first notice and late evidence during that period, but the notice does not start or reset client review and only the resolver may accept it. If the resolver deadline passes without qualifying evidence, the contract records `REJECTED_BY_TIMEOUT`, releases the holdback reservation, and moves the asset to terminal `UNRESOLVED_NON_HANDOVER`. That immutable audit flag allows the project to close; it does not transfer the external asset or decide legal ownership outside Ploby.

A rejection cannot demand evidence that was not in the accepted checklist. The resolver cannot redirect the holdback or increase it.

## Payment coupling

The external asset transfer and blockchain payment are not technically atomic. Ploby provides conditional settlement:

- External control transfer occurs first.
- A client or resolver attestation confirms that the agreed evidence was supplied.
- The contract atomically consumes that attestation and releases the exact `handoverHoldbackBaseUnits`.

When a provider offers a cryptographically verifiable ownership API or signed credential, the policy may permit automatic attestation. Screenshots alone are E1 evidence and do not qualify for unattended automatic acceptance.

The holdback amount and payee are fixed by the accepted milestone or change order. Normal committed expense reimbursement is settled under [ADR 0005](0005-purchase-commitments-and-settlement.md) and cannot be delayed because a separate asset handover is incomplete.

## Subscriptions and recurring assets

For every recurring cost, the register identifies:

- billing owner and payment method owner;
- renewal date and cancellation deadline;
- transferability;
- whether the project should transfer, cancel, or continue the subscription at close;
- the party responsible for post-project charges.

When a recurring asset is shared across projects, each invoice uses the allocation registry in [ADR 0007](0007-shared-expense-allocation-registry.md). Asset classification alone does not authorize billing the full subscription to more than one project.

Entering CLOSING creates a handover checklist for all ACTIVE project and shared assets. The project cannot become CLOSED until each item is COMPLETE, CANCELLED, explicitly retained by the contractor under policy, resolved through dispute, or terminal `UNRESOLVED_NON_HANDOVER`. The last state preserves the failure record without locking the project forever.

## Consequences

### Positive

- Ownership expectations are defined when money is committed, not after a dispute.
- The client can verify delivery of project-controlled assets.
- The contractor receives a deadline-backed path to final payment after handover.
- Unrelated reimbursements cannot be held hostage to a final-delivery dispute.

### Negative

- Most ownership transfers still require human or provider-specific verification.
- Asset metadata and secrets require careful access control.
- Project closing may remain open while a handover dispute is resolved.

## Rejected alternatives

### Treat every paid subscription or account as client property

Rejected because contractor tools and legitimately shared infrastructure may be billed proportionally without full ownership transfer.

### Put credentials or account identifiers on-chain

Rejected because public immutable credential metadata creates security and privacy risk.

### Withhold all remaining project funds until handover

Rejected because it would let an unrelated asset dispute delay valid expense and milestone obligations.

### Claim the external transfer and payment are fully atomic

Rejected because external providers do not share the blockchain's transaction boundary. The system can atomically pay against an attestation, not atomically move the external account itself.
