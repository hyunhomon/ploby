# ADR 0007: Shared Expense Allocation Registry

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, evidence service, and protocol

## Context

A contractor may legitimately allocate one AWS invoice, Adobe subscription, or other shared expense across multiple client projects. Treating every cross-project duplicate as fraud rejects valid work. Allowing each client to reimburse 100 percent of the same invoice permits over-claiming.

Independent clients do not share a database administrator or trust each other with invoice contents. A shared registry can enforce aggregate allocation without revealing the underlying invoice or client identities. However, a simple hash of vendor, invoice number, and amount has low entropy and can be guessed.

## Decision

SmartEscrow uses a shared on-chain allocation registry. Each normalized invoice receives an opaque `invoiceNullifier`. Active and settled allocation basis points for that nullifier may never exceed 10,000.

The MVP nullifier is issued by a trusted Evidence Attestation Service. This is an explicit trust assumption. The blockchain provides neutral, atomic capacity enforcement across projects; it does not independently normalize or authenticate invoices.

## Normalized invoice identity

For the MVP, allocation is supported only for a whole invoice, not individual line items. The private canonical identity contains:

```text
InvoiceIdentity
- schemaVersion
- issuerIdentity
- issuerInvoiceNumber
- invoiceDate
- grossAmountMinorUnits
- ISO4217Currency
```

`issuerIdentity` is the verified vendor domain or vendor integration identifier, not a display name typed by the user. Unicode normalization, case handling, whitespace, date format, currency precision, and leading-zero rules are versioned by `schemaVersion`.

If a source lacks a stable issuer invoice number or verified issuer identity, it is not eligible for unattended cross-project allocation. It remains HOLD for manual resolution.

## Privacy-preserving MVP nullifier

The Evidence Attestation Service computes:

```text
invoiceNullifier = HMAC-SHA256(
  networkNullifierKey[keyVersion],
  canonicalInvoiceIdentity
)
```

It signs an attestation containing the nullifier, key version, evidence assurance level, gross amount commitment, source currency, requested allocation basis points, settlement asset, allocation cap in settlement-asset base units, and expiry. The allocation cap is the invoice share converted under the commitment's pinned FX rules. The contract verifies the service signature and never receives the canonical invoice identity, gross source amount, or HMAC key.

Using one network service makes the same invoice produce the same nullifier across tenants while resisting casual dictionary attacks against public registry values. The service can still see invoice metadata and must be treated as a trusted privacy boundary.

Key rotation creates a mapping attestation from an old nullifier to the replacement so existing allocation cannot be bypassed. Loss of the mapping key is an operational incident; allocation for affected invoices pauses until recovery.

## Registry entries

```text
InvoiceAllocation
- invoiceNullifier
- allocationId
- obligationIdCommitment
- allocationBps
- settlementAsset
- allocationCapBaseUnits
- status: RESERVED | SETTLED | RELEASED
- attestationKeyVersion
- createdAt
```

The public registry does not store client identity, project name, vendor, invoice number, amount, currency, or document location. `obligationIdCommitment` is an opaque commitment rather than the raw project obligation ID. A common relayer submits allocations so transaction sender is not intentionally used as client identity, although public-chain metadata privacy is not guaranteed.

## Allocation rules

- Allocation is reserved at the same time as a purchase commitment.
- `sum(RESERVED + SETTLED allocationBps) + newAllocationBps` must be at most 10,000.
- A 40 percent allocation to project A and 60 percent to project B is valid.
- A later allocation that would raise the total above 100 percent is rejected atomically.
- Expired or contractor-cancelled unused commitments change their allocation from RESERVED to RELEASED.
- Any positive monetary settlement changes the entire RESERVED allocation to SETTLED. A SETTLED allocation and all of its basis points are immutable, even if the payout was below its monetary cap.
- A zero-payment rejection, expiry, or pre-spend cancellation changes the entire allocation to RELEASED. Protocol v1 does not split one allocation between SETTLED and RELEASED; a project that wants finer capacity must create a smaller allocation before commitment.
- A project cannot register the same obligation allocation twice.
- One invoice may have at most one active allocation per project in the MVP. Multiple categories within the same project must be consolidated into that allocation.

The settlement contract enforces the signed `allocationCapBaseUnits`. The maximum eligible reimbursement for a project is the lower of:

```text
invoice gross amount * allocationBps / 10,000
purchase commitment maximum
policy-eligible actual amount
```

Rounding is down in invoice minor units and settlement-token base units. Any remainder stays unallocated rather than being assigned implicitly.

## Conflict behavior

- Capacity available: continue normal policy evaluation.
- Capacity exceeded for the same attested nullifier: BLOCK the new allocation before reservation. Existing valid allocations are unchanged.
- Mismatched normalization version or expired attestation: `POLICY_OR_SYSTEM_AMBIGUITY` HOLD.
- Probable duplicate without the same attested nullifier: risk signal and resolver review, not automatic fraud determination.
- A resolver may release an unused RESERVED allocation but cannot erase a SETTLED allocation or raise total capacity.

A project with a RESERVED allocation cannot migrate in protocol v1. It must settle, expire, or cancel the associated obligation and move the allocation to SETTLED or RELEASED first. SETTLED entries remain immutable in the shared registry and continue to reference the legacy opaque obligation commitment; they are not copied to a new project escrow.

## Why a blockchain registry

The registry is useful when multiple independent escrow operators or clients need one atomic allocation limit without appointing one client as database owner. Every participant can verify that the aggregate never exceeded 100 percent, while invoice contents remain off-chain.

A consortium database could provide similar functionality under one operator. SmartEscrow chooses the chain because financial settlement and allocation reservation can share an atomic, independently verifiable state transition. This is a coordination choice, not a claim that blockchain proves invoice truth.

## Future trust reduction

The production target is a vendor-issued signed invoice credential or zero-knowledge proof that derives the nullifier and proves allocation capacity without revealing invoice contents. That work is not required for the MVP and must not be implied by the HMAC-based design.

## Consequences

### Positive

- Legitimate shared costs can be split across clients.
- Aggregate reimbursement cannot exceed 100 percent for one normalized invoice.
- Clients do not need access to each other's identity or evidence.
- The blockchain has a concrete cross-tenant coordination role beyond audit logging.

### Negative

- The MVP trusts one attestation service for normalization, nullifier consistency, and privacy.
- Public metadata can still reveal timing and allocation patterns.
- Incorrect or adversarial normalization can create multiple nullifiers for one real invoice.
- Line-item allocation is not supported in the MVP.

## Rejected alternatives

### Put vendor, invoice number, and amount directly on-chain

Rejected because it reveals sensitive commercial data.

### Publish a plain hash of invoice identity

Rejected because low-entropy invoice fields are vulnerable to dictionary attacks.

### Block every invoice seen in another project

Rejected because legitimate shared expenses require allocation rather than binary duplicate treatment.

### Keep allocation independently in each tenant database

Rejected because no participant could verify the global aggregate or prevent concurrent over-allocation.
