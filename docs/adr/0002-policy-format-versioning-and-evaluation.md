# ADR 0002: Policy Format, Versioning, and Evaluation

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and policy engine

## Context

The product turns an agreed project budget into enforceable spending rules. A hash alone proves that some bytes existed, but it does not define how policy bytes are serialized, which currency and token an amount refers to, who accepted a policy, or which version applies to an in-flight request.

Natural-language contracts may be used to draft a policy, but ambiguous language must not silently become financial authority.

## Decision

Policies will be immutable, versioned JSON documents validated against a published schema. The canonical policy bytes will use JSON Canonicalization Scheme (RFC 8785), encoded as UTF-8, and the on-chain `policyHash` will be `keccak256(canonicalPolicyBytes)`.

The AI may propose a policy draft. It cannot activate a policy. A policy becomes active only after schema validation and explicit acceptance by the client and contractor.

## Required policy fields

```text
ProjectPolicy
- schemaVersion
- projectId
- version
- chainId
- escrowContract
- assetAddress
- assetDecimals
- projectBudgetBaseUnits
- paymentMode
- contractorWallet
- allowedCategories[]
- categoryBudgets[]
- allowedPayees[]
- maxTransactionBaseUnits
- startsAt
- endsAt
- reviewWindowSeconds
- releaseWindowSeconds
- rules[]
- createdAt
```

All monetary values are non-negative integer strings in token base units. Display values such as `$200` or `KRW 300,000` are presentation data and are not evaluated. The MVP supports one settlement asset per project and performs no foreign-exchange conversion.

## Versioning

- Policy versions increase monotonically within a project.
- An accepted policy is immutable.
- A change creates a new document, version, hash, and acceptance record.
- Each expense request pins the policy version and hash that were active when the request was submitted.
- Later policy amendments do not retroactively approve a previously blocked request.
- Emergency revocation may prevent future release under an old policy, but it cannot rewrite the historic evaluation record.
- A request may be resubmitted under a new policy only with a new request ID linked to the previous request.

The acceptance record contains the project ID, policy version, policy hash, participant addresses, and signatures. For the hackathon demo, the UI may simulate contractor acceptance, but demo data must label the simulation.

## Evaluation semantics

Policy evaluation is deterministic for a validated structured expense. The engine evaluates rules in the following classes:

1. Integrity and authorization: project, policy hash, request ID, signer, evidence manifest, and payee registration.
2. Time: policy active period, request date, and decision expiry.
3. Scope and allowlists: project relevance, category, payment mode, and payee/vendor.
4. Amount: transaction limit, category budget, project budget, funded balance, and prior committed spend.
5. Risk signals: exact duplicate, probable duplicate, price anomaly, request splitting, and inconsistent evidence.

The output contains individual rule results and a final decision:

| Condition | Decision |
| --- | --- |
| A deterministic mandatory rule is violated | BLOCK |
| All mandatory rules pass and there are no unresolved risk signals | APPROVE |
| Evidence is incomplete, ambiguous, inconsistent, or anomalous | HOLD |
| AI, OCR, schema validation, or policy evaluation fails | HOLD |

Risk models may recommend HOLD but cannot override a deterministic BLOCK or produce APPROVE by themselves.

Every decision records stable machine-readable reason codes. Human-readable explanations are derived from reason codes and evaluation details; they are not the source of truth.

## Budget accounting

The policy engine distinguishes:

- `released`: settled payments.
- `reserved`: approved decisions not yet released.
- `available`: funded balance minus released and reserved amounts.

An approval reserves budget until it is released, rejected, expired, or revoked. This prevents two concurrent approvals from independently passing against the same remaining budget.

## Consequences

### Positive

- The same policy produces the same hash across services.
- Requests remain auditable after policy changes.
- Currency, token, and rounding ambiguity are removed.
- AI-generated terms require human acceptance before gaining authority.

### Negative

- Policy editing requires a migration and re-acceptance flow.
- Budget reservations add state beyond settled spending.
- RFC 8785 support must be consistent across implementation languages.

## Rejected alternatives

### Hash arbitrary JSON produced by the UI

Rejected because whitespace, key order, and number formatting would produce inconsistent hashes.

### Apply the latest policy to every pending request

Rejected because a later change could retroactively alter the conditions under which an expense was submitted.

### Let AI resolve ambiguous contract terms automatically

Rejected because ambiguity must be surfaced to the parties before it becomes spending authority.
