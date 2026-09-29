# ADR 0003: Evidence Assurance and Audit Records

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, backend, and protocol

## Context

Invoices, receipts, contracts, emails, and transaction records may contain personal, commercial, tax, or credential data. They must not be published to a public blockchain or public content network.

A file hash alone is also not enough to explain a settlement. An auditor needs the accepted commitment, evidence, extraction, policy version, rule results, decision, resolver actions, and payment reference.

AI cannot prove that a PDF is authentic. Stronger signals such as an original DKIM-signed email or vendor API receipt can improve evidence assurance, but they still do not prove project relevance by themselves.

## Decision

Raw evidence is encrypted and stored off-chain. On-chain records contain non-sensitive identifiers and cryptographic commitments to canonical manifests, decision bundles, and financial obligations.

The MVP uses a private object store with per-project authorization, encryption at rest and in transit, retention controls, and access logs. Public IPFS is not an evidence store.

## Evidence manifest

Each request has one canonical manifest:

```text
EvidenceManifest
- schemaVersion
- projectId
- requestId
- obligationId
- submittedBy
- submittedAt
- files[]
  - fileId
  - sha256
  - mediaType
  - sizeBytes
  - documentType
  - assuranceLevel
- requestTextSha256
- emailVerification, when applicable
- vendorCredential, when applicable
```

Raw file digests use SHA-256 for interoperability with document tooling. The manifest uses RFC 8785 canonical JSON, and `evidenceManifestHash` is `keccak256(canonicalManifestBytes)`.

Filenames, invoice numbers, vendor names, email addresses, free text, storage URLs, and personal data are never placed on-chain.

## Evidence assurance levels

| Level | Evidence | Meaning | Automatic settlement eligibility |
| --- | --- | --- | --- |
| E0 | Natural-language assertion only | No independent document evidence | Never |
| E1 | Uploaded PDF, image, or screenshot | Bytes are preserved, but origin is unverified | Only if the bilateral policy explicitly permits E1 for that category |
| E2 | Original raw email with valid aligned DKIM verification | The signing domain authenticated the preserved message body | Eligible when the policy accepts the sender domain and all other rules pass |
| E3 | Vendor API receipt or vendor-signed verifiable credential | Vendor-origin record verified through an approved integration | Eligible when all other rules pass |

Assurance is one policy input, not a final decision. E2 and E3 do not prove that a purchase was necessary, allocated correctly, or used for the project.

### DKIM verification

DKIM verification accepts the original RFC 822 message, not a screenshot or copied email body. The verification record stores:

- signing domain and selector;
- signature and body-hash result;
- From-domain alignment result;
- signed-header list;
- verification timestamp;
- public-key fingerprint and retrieval result;
- verifier version.

Forwarding or mailing-list modification may invalidate DKIM. Invalid or absent DKIM downgrades the evidence; it does not prove fraud. A valid signature proves domain-authenticated message content, not payment ownership or project relevance.

## Decision bundle

The auditable unit is a canonical `DecisionBundle`:

```text
DecisionBundle
- schemaVersion
- projectId
- requestId
- obligationId
- evidenceManifestHash
- evidenceAssuranceSummary
- structuredExpense
- policyHash and policyVersion
- purchaseCommitmentHash, when present
- ruleResults[]
- riskSignals[]
- holdClass, when present
- finalDecision
- reasonCodes[]
- parserProvider and model
- parserConfigurationVersion
- policyEngineVersion
- resolverDecision, when present
- settlementIntentHash, when present
- decidedAt
```

The bundle is retained off-chain, and its `keccak256` hash is included in the signed financial payload and anchored on-chain. Private model reasoning traces are not stored. Validated inputs, structured outputs, versions, rule results, reason codes, and metering data required for reproducibility are retained.

## Duplicate and allocation behavior

- The same request or obligation cannot settle twice.
- Reusing the same evidence within one project is BLOCKED when it would duplicate an active or settled claim.
- Reusing an invoice across projects is not automatically fraud because a shared cost may be legitimately allocated.
- Cross-project invoice capacity is decided by the allocation registry in [ADR 0007](0007-shared-expense-allocation-registry.md).
- Similar OCR text, image layout, vendor, amount, or invoice number is only a risk signal and produces HOLD, never an automatic fraud determination.
- Corrected evidence uses a new request ID linked to the previous request; it does not overwrite history.

## Access and retention

- Client and assigned contractor access evidence according to project roles.
- Resolver access is limited to evidence necessary for an active dispute and ends after the dispute retention period.
- Operational support access is time-limited, approved, and logged.
- Signed storage URLs are short-lived and never written to permanent logs or the blockchain.
- Retention is configured by jurisdiction and project agreement.
- Deletion removes encrypted blobs and encryption keys where legally permitted. Immutable on-chain hashes remain, and users are informed of that before submission.
- Logs do not contain raw documents, invoice contents, email bodies, or credentials.

## Audit verification

An authorized auditor can:

1. Hash raw evidence and match the manifest.
2. Reproduce email or vendor-credential verification.
3. Canonicalize and hash the manifest and decision bundle.
4. Validate bilateral policy acceptance and the pinned policy version.
5. Re-run deterministic rules using the stored engine version.
6. Verify commitment, resolver, allocation, and settlement signatures.
7. Match the settlement event to the authorized asset, payee, and amount.

This proves record integrity and process reproducibility. It does not prove every real-world statement inside an invoice.

## Consequences

### Positive

- Sensitive documents are not permanently public.
- Evidence strength is explicit instead of being guessed by the LLM.
- A settlement can be reconstructed from commitment through payment.
- Legitimate shared invoices are separated from duplicate over-claims.

### Negative

- Auditability depends on retaining and granting access to off-chain artifacts.
- DKIM, vendor integrations, key retention, and verifier versioning add operational work.
- Global duplicate and allocation checks require tenant-isolated infrastructure.

## Rejected alternatives

### Store evidence on-chain or on public IPFS

Rejected because sensitive financial documents would become public and effectively undeletable.

### Treat uploaded PDFs as authenticated evidence

Rejected because preserving bytes does not authenticate their issuer.

### Treat every cross-project duplicate as fraud

Rejected because shared subscriptions and infrastructure costs may be validly allocated across projects.

### Store model chain-of-thought as the explanation

Rejected because explanations must rely on validated fields, deterministic rule results, and stable reason codes.
