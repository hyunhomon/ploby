# ADR 0003: Evidence and Audit Records

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, backend, and protocol

## Context

Invoices, receipts, contracts, and transaction records may contain personal, commercial, or tax-sensitive data. Publishing those documents on a public blockchain or public content network would conflict with privacy and deletion requirements.

At the same time, a document hash alone is insufficient to reconstruct why a payment was approved. An auditor also needs the request, extracted fields, applicable policy, rule results, decision reason, and settlement reference.

Duplicate detection has two different meanings: exact byte reuse and probable reuse of visually or semantically equivalent documents. The second is uncertain and must not be treated as deterministic proof of fraud.

## Decision

Raw evidence will be stored encrypted off-chain. The blockchain will receive only non-sensitive identifiers and cryptographic commitments to a canonical evidence manifest and decision bundle.

Public IPFS is not the default evidence store. A private object store with per-project access control, encryption at rest, transport encryption, retention controls, and access logs is the MVP storage model.

## Evidence manifest

Each expense request has one canonical `EvidenceManifest`:

```text
EvidenceManifest
- schemaVersion
- projectId
- requestId
- submittedBy
- submittedAt
- files[]
  - fileId
  - sha256
  - mediaType
  - sizeBytes
  - documentType
- requestTextSha256
```

The raw file digest uses SHA-256 for interoperability with storage and document tooling. The manifest is canonicalized with RFC 8785, and `evidenceManifestHash` is `keccak256(canonicalManifestBytes)` for the on-chain commitment.

Filenames, invoice numbers, vendor names, free text, storage URLs, and personal data are not placed on-chain.

## Decision bundle

The auditable unit is a `DecisionBundle`, not an isolated decision code:

```text
DecisionBundle
- schemaVersion
- requestId
- evidenceManifestHash
- structuredExpense
- policyHash
- policyVersion
- ruleResults[]
- riskSignals[]
- finalDecision
- reasonCodes[]
- parserProvider
- parserModel
- parserConfigurationVersion
- policyEngineVersion
- paymentIntent
- decidedAt
```

The canonical decision bundle is retained off-chain. Its `keccak256` hash is included in the signed decision envelope and anchored on-chain. Model reasoning traces are not stored as an audit artifact. Only validated inputs, outputs, versions, rule results, and usage metadata needed for reproducibility are retained.

## Duplicate and anomaly handling

- Exact duplicate file hash within the same project: BLOCK if the earlier request was released or is still active; otherwise HOLD for review.
- Exact duplicate file hash across projects: HOLD and notify authorized reviewers. Cross-project metadata must not be exposed to unrelated clients.
- Similar image, OCR text, invoice number, vendor, or amount: risk signal only, resulting in HOLD.
- A duplicate detector cannot produce APPROVE.
- Resubmission after correction uses a new request ID and references the prior request.

The backend maintains a global exact-hash index for abuse detection. On-chain replay protection remains scoped to the project and request ID.

## Access and retention

- Client and assigned contractor can access evidence for their project according to project roles.
- Operational support access is time-limited and logged.
- Signed URLs are short-lived and are never written to the chain or permanent logs.
- Evidence retention is configurable by jurisdiction and project agreement.
- Deletion removes encrypted blobs and keys where legally permitted; immutable on-chain hashes remain and are disclosed as such before submission.
- Logs must avoid copying raw document text unless required for a documented debugging workflow.

## Verification

An auditor with authorized access can:

1. Hash the raw files and match the evidence manifest.
2. Canonicalize and hash the manifest.
3. Validate the policy hash and participant acceptance.
4. Re-run the deterministic policy rules using the stored engine version.
5. Validate the signed payment intent and its on-chain consumption.
6. Match the release event to the intended asset, payee, and amount.

This proves record integrity and decision reproducibility. It does not prove that an invoice describes a real-world transaction. The product must not claim otherwise.

## Consequences

### Positive

- Sensitive documents are not made permanently public.
- An audit can reconstruct the inputs and deterministic reasoning behind a payment.
- Exact duplicates and probable duplicates have appropriately different treatment.
- Storage providers can change without changing the commitment format.

### Negative

- Auditability depends on retaining and granting access to off-chain artifacts.
- Key management and deletion workflows become operational requirements.
- Global duplicate detection requires strict tenant isolation.

## Rejected alternatives

### Store invoices directly on-chain or on public IPFS

Rejected because sensitive financial documents would become public and effectively undeletable.

### Store only the raw document hash

Rejected because the policy, extraction, rule results, software versions, and actual payment intent would remain unverifiable.

### Automatically block every probable duplicate

Rejected because legitimate recurring invoices and resubmissions can share fields or visual structure.
