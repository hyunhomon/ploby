# ADR 0002: Policy Format, Versioning, and Evaluation

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and policy engine

## Context

The project policy is the shared financial agreement between client and contractor. A hash proves that some bytes existed but does not define their serialization, currency, acceptance, amendment rules, or applicability to an in-flight obligation.

Natural-language contracts may be used to draft policy terms, but ambiguous language must not silently gain financial authority. Unilateral policy changes would also allow a client to invalidate costs that the contractor already committed to under an earlier agreement.

## Decision

Policies are immutable, versioned JSON documents validated against a published schema. Canonical policy bytes use JSON Canonicalization Scheme (RFC 8785), encoded as UTF-8. The on-chain `policyHash` is `keccak256(canonicalPolicyBytes)`.

The LLM may draft a policy or change order. It cannot activate one. A version activates only after schema validation and signatures from both the client and contractor.

## Required policy fields

```text
ProjectPolicy
- schemaVersion
- projectId
- version
- previousPolicyHash
- chainId
- escrowContract
- clientAddress
- contractorAddress
- resolverAddress
- settlementAssetAddress
- settlementAssetDecimals
- projectBudgetBaseUnits
- paymentMode: DIRECT_VENDOR | REIMBURSEMENT
- allowedCategories[]
- categoryBudgets[]
- allowedPayees[]
- maxTransactionBaseUnits
- startsAt
- endsAt
- clientReviewPeriodSeconds
- resolverReviewPeriodSeconds
- evidenceSubmissionPeriodSeconds
- reservationValidityRangeSeconds
- evidenceRequirements
- foreignCurrencyRules
- assetOwnershipRules
- rules[]
- createdAt
```

All monetary values are non-negative integer strings in settlement-asset base units. Floating-point values are invalid. The MVP supports one settlement asset per project and performs no implicit foreign-exchange conversion.

Every policy must specify a resolver, client review period, resolver review period, evidence-submission period, and evidence minimum. The demo policy uses a 72-hour client review period, a seven-day resolver period, and a seven-day evidence-submission period after spend is reported. Future policies may set different values only within schema-defined safety bounds: 24 hours to seven days for client review, one to fourteen days for resolver review, and one to thirty days for evidence submission.

## Acceptance and activation

The acceptance payload contains the project ID, policy version, policy hash, previous policy hash, participant addresses, and expiry. Client and contractor sign the same payload.

A policy is active only when:

1. The schema and all referenced rule versions are supported.
2. Both participant signatures are valid.
3. `previousPolicyHash` matches the current active version, except for version 1.
4. The settlement asset and escrow contract match the project.
5. The policy effective time has arrived.

The platform may simulate contractor acceptance in a hackathon demo only when the UI and demo data label it as simulated. It is not equivalent to a bilateral production acceptance.

## Versioning and non-retroactivity

- Versions increase monotonically within a project.
- An accepted version is immutable.
- An amendment creates a new document, hash, and bilateral acceptance record.
- A purchase commitment pins the policy hash and version active when it was issued.
- Policy replacement, payee removal, project pause, and project closing do not alter an existing commitment.
- Emergency signer revocation prevents new signatures but does not cancel valid obligations.
- A request rejected under an older policy may be resubmitted under a new policy only with a new request or obligation ID linked to the old one.

## Change orders

An out-of-scope client request is not treated only as an expense violation. The system produces two separate outputs:

1. The current payment or reservation request is BLOCKED under the active policy.
2. A non-binding `ChangeOrderDraft` is generated with the proposed scope, deliverables, budget delta, schedule delta, payees, and policy-rule changes.

The draft has no financial effect. It becomes a new policy version only after client and contractor signatures. Work performed before activation is uncommitted unless a prior commitment covers it. The UI must not present an unsigned change order as approved scope.

## Deterministic evaluation order

The policy engine evaluates a validated request in this order:

1. Identity and integrity: project, participants, policy, obligation ID, signatures, evidence manifest, payee, and replay status.
2. Project state: active dates, pause flags, close state, and security freeze.
3. Scope and allowlists: deliverable relevance, category, payment mode, vendor, and payee.
4. Amount and capacity: transaction cap, category budget, project budget, active reservations, and available funded balance.
5. Evidence assurance: minimum assurance level and required fields.
6. Risk signals: allocation conflict, exact duplicate, probable duplicate, price anomaly, splitting pattern, and inconsistent evidence.

The output contains every rule result and one final result:

| Condition | Result |
| --- | --- |
| A deterministic mandatory rule is violated | BLOCK |
| All mandatory rules pass and no unresolved risk signal exists | APPROVE or RESERVE, depending on the request type |
| Evidence is ambiguous, incomplete, inconsistent, or anomalous | HOLD with a class defined in ADR 0005 |
| AI, OCR, schema validation, policy loading, or evaluator execution fails | HOLD or no decision; never APPROVE |

Risk models may recommend HOLD. They cannot override a deterministic BLOCK or independently produce APPROVE.

## Budget accounting

The system distinguishes:

- `released`: completed settlements.
- `reserved`: active purchase commitments not fully settled.
- `available`: funded balance minus released and reserved amounts.

Creating a commitment atomically increases `reserved`. Partial settlement decreases the reservation by the settled amount and releases any unused remainder when the obligation closes. Concurrent requests evaluate against `available`, preventing double commitment of the same funds.

## Foreign currency

Display and source invoice currencies are metadata. Authorization always uses a maximum amount in settlement-asset base units. A foreign-currency commitment records the quote amount, ISO currency code, FX source, quote timestamp, quote expiry, fee cap, tax treatment, and maximum settlement amount. Detailed settlement behavior is defined by [ADR 0005](0005-purchase-commitments-and-settlement.md).

## Consequences

### Positive

- The same accepted policy produces the same hash across services.
- Neither party can change rules retroactively.
- Scope expansion becomes a priced bilateral change instead of informal unpaid work.
- Currency, token, timeout, and resolver behavior are explicit.

### Negative

- Policy editing requires a version transition and two signatures.
- Budget reservations and version-pinned obligations add state.
- RFC 8785 and typed-signature support must match across implementation languages.

## Rejected alternatives

### Hash arbitrary UI JSON

Rejected because whitespace, key order, and number formatting would produce inconsistent hashes.

### Apply the latest policy to every pending request

Rejected because a later change could invalidate a cost already accepted under the prior policy.

### Let the client edit policy unilaterally

Rejected because it turns the escrow into a unilateral control mechanism.

### Let AI resolve ambiguous contract terms automatically

Rejected because ambiguity must be accepted by both parties before it becomes spending authority.
