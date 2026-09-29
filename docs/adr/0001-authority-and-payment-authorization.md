# ADR 0001: Authority and Payment Authorization

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and protocol

## Context

SmartEscrow uses an LLM to extract meaning from contracts, expense requests, and evidence. A deterministic policy engine then evaluates the structured expense. The product claim is that AI interprets information while code controls permission.

The initial contract uses one backend `agent` address for both recording a decision and releasing funds. A release supplies the payee at execution time, while the recorded decision commits only to the project, evidence, policy, amount, decision code, and timestamp. This makes the backend signer a trusted spending authority and allows it to choose a payee that was not part of the recorded decision.

It is important to state the trust boundary honestly. An LLM is not trusted, but an online service that can sign arbitrary release transactions is still financially trusted even when it is called an agent.

## Decision

We will separate AI interpretation, deterministic policy evaluation, transaction authorization, and contract execution into distinct logical roles. The LLM will never have access to a blockchain signing key.

Every releasable decision will commit to an immutable `PaymentIntent`. The contract must only release the exact asset, amount, and payee committed by that intent.

The MVP backend policy signer remains a trusted component with authority up to the remaining funded project budget. This is an explicit MVP trust assumption, not a claim of trustlessness. Production designs must reduce that authority with client-signed permits or on-chain enforceable limits before the system is presented as non-custodial or trust-minimized.

## Roles

| Role | Authority |
| --- | --- |
| Client | Creates and funds a project, accepts policy versions, manages project payees, resolves HOLD requests, pauses or closes the project, and withdraws refundable funds |
| Contractor | Submits expense requests and evidence; cannot release escrowed funds |
| LLM parser | Produces an untrusted structured extraction; has no signing key and no direct contract access |
| Policy engine | Applies deterministic rules to validated input and produces a decision trace; has no custody key |
| Policy signer | Signs a validated decision envelope after schema and policy checks; cannot alter fields after signing |
| Transaction relayer | Submits signed envelopes and pays gas; cannot change the signed payment intent |
| Escrow contract | Enforces signer authority, intent integrity, replay protection, project state, expiry, and available balance before transfer |

The policy signer and contract administrator use different keys. The administrator can rotate a compromised signer but cannot silently rewrite an existing decision.

## Payment intent

A decision must commit to at least the following fields:

```text
PaymentIntent
- chainId
- escrowContract
- projectId
- requestId
- evidenceManifestHash
- policyHash
- policyVersion
- asset
- payee
- amountBaseUnits
- decision: APPROVE | HOLD | BLOCK
- reasonCodes[]
- nonce
- validUntil
```

The canonical intent digest is domain-separated by chain and escrow contract. A request ID is unique within a project, and a nonce or consumed digest prevents replay.

The asset and payee are fixed before policy evaluation. A relayer cannot provide a different payee during release. For direct vendor payments, the payee must be registered in the active policy or project payee registry. For reimbursements, the payee must be the contractor wallet registered for that project. The MVP must support one payment mode per project; mixed direct-payment and reimbursement behavior is out of scope until the accounting rules are specified.

## Decision behavior

- `APPROVE` may be released automatically while the decision is valid and the project is active.
- `HOLD` is never releasable until the client explicitly approves the exact decision digest. Client approval cannot modify the amount, asset, or payee.
- `BLOCK` is never releasable.
- Parser failure, model failure, schema failure, missing evidence, policy mismatch, or signer uncertainty results in HOLD or no decision, never APPROVE.
- A released, rejected, expired, or superseded decision cannot be reused.

## Key controls

For the MVP:

- The policy signer key is stored only in the backend secret store and is never exposed to the LLM process or browser.
- Signer rotation is recorded on-chain.
- All signing attempts, including rejected attempts, are logged with a request ID.
- The relayer accepts only a complete, schema-valid, signed envelope.
- The UI labels the backend signer as a trusted MVP component.

Before production use:

- Prefer per-payment client permits, a constrained smart account, or on-chain caps and payee allowlists.
- Use a multisig for administrator authority.
- Apply rate limits and per-project circuit breakers to reduce loss from signer compromise.

## Consequences

### Positive

- The product claim "AI interprets, code authorizes" becomes testable.
- Payment destination substitution is prevented.
- HOLD approval is scoped to one exact payment rather than a mutable request.
- The centralization that remains in the MVP is documented instead of hidden.

### Negative

- The decision schema and contract interface are larger.
- Payee registration and payment-mode selection add onboarding steps.
- The current `PaymentDecision` and `release` interface do not satisfy this ADR and will require a later contract change.

## Rejected alternatives

### Let the agent choose the payee during release

Rejected because the recorded approval would not authorize the actual destination of funds.

### Give the LLM a wallet or transaction tool

Rejected because prompt injection, parsing errors, and model behavior would become direct financial authority.

### Require manual client approval for every expense

Rejected as the default because it removes the automatic release value proposition. It remains a valid project-level safety mode.
