# ADR 0001: Authority and Payment Authorization

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and protocol

## Context

SmartEscrow uses an LLM to extract meaning from contracts, expense requests, and evidence. A deterministic policy engine evaluates that structured input. The product claim is that AI interprets information while code controls permission.

The initial contract uses one backend `agent` address to record decisions and release funds. The payee is supplied only at release time. That design makes the signer a trusted spending authority and does not bind the recorded approval to the eventual recipient.

A bilateral escrow also requires constrained client authority. A client must be able to stop new obligations and respond to fraud, but must not cancel an expense after the contractor relied on an accepted commitment.

## Decision

AI interpretation, deterministic evaluation, transaction authorization, transaction submission, administration, and dispute resolution are separate logical authorities. The LLM has no wallet, signing key, contract write access, or ability to select the final decision.

Every fund-changing action commits to an immutable typed payload. The escrow releases only the exact asset, amount, payee, project, and obligation identified by that payload.

The MVP policy signer and resolver are explicitly trusted platform components. This is a disclosed centralization assumption. The service must not be described as trustless or fully non-custodial while those roles can affect settlement.

## Roles and limits

| Role | May | Must not |
| --- | --- | --- |
| Client | Fund a project, jointly accept policy versions and change orders, pause new commitments, review HOLDs, initiate close, receive refundable funds | Rewrite or revoke an accepted commitment, redirect a payment, or withhold indefinitely |
| Contractor | Jointly accept policy versions, request commitments, submit evidence, cancel an unused reservation, open a dispute, and initiate project close | Release funds, increase a commitment, or change its payee |
| LLM parser | Propose structured fields and classifications | Sign, approve, release, or decide a dispute |
| Policy engine | Apply versioned deterministic rules and generate a decision trace | Override a deterministic rule with model output |
| Policy signer | Sign schema-valid commitment and settlement envelopes produced by approved policy-engine code | Change payload fields after evaluation or act as administrator |
| Relayer | Submit signed payloads and pay gas | Change a signed payload or create authority by itself |
| Resolver | Decide only the disputed amount and reason codes within an existing obligation | Redirect the payee, exceed the disputed cap, edit policy, or take project funds |
| Administrator | Rotate compromised service signers and activate a bounded security freeze | Spend project funds, cancel obligations, or resolve commercial disputes |
| Escrow contract | Enforce signatures, exact payloads, state, deadlines, replay protection, reservations, and balance | Interpret natural language or evidence |

The policy signer, resolver, and administrator use separate keys. The administrator is a multisig before any non-demo deployment. Key rotation never changes or revives an existing obligation.

## Typed authorization payloads

The system uses two financial payloads defined in [ADR 0005](0005-purchase-commitments-and-settlement.md):

- `PurchaseCommitment`: reserves budget before the contractor spends.
- `SettlementIntent`: pays an eligible amount against that commitment.

Both payloads are domain-separated by `chainId` and `escrowContract` and bind at least:

```text
- projectId
- obligationId
- policyHash and policyVersion
- evidenceManifestHash, when evidence exists
- asset
- payee
- amountBaseUnits or maximumAmountBaseUnits
- nonce
- validUntil
```

The payee and settlement asset are fixed before authorization. For direct vendor payment, the payee is the vendor address registered in the commitment. For reimbursement, the payee is the contractor wallet registered by the accepted project policy. A relayer cannot substitute either value.

## Bilateral authority rules

- A policy or change order activates only after client and contractor signatures.
- Once a purchase commitment is accepted, the client cannot revoke it unilaterally.
- Pausing the project stops new commitments but does not stop eligible settlement of existing commitments.
- A global security freeze may temporarily delay execution under [ADR 0004](0004-project-lifecycle-and-refunds.md), but it preserves the obligation and extends its deadlines.
- HOLD resolution is scoped to an exact obligation digest. Client approval cannot modify amount, asset, or payee.
- Client rejection of a committed settlement is an objection that opens resolver review; it is not a unilateral terminal rejection.
- Resolver decisions are bounded by the existing commitment and cannot create a larger payment.
- BLOCK and REJECTED obligations are never payable.

## Key and service controls

For the MVP:

- Keys are held in the backend secret store and are never exposed to the LLM process, uploaded documents, prompts, or browser.
- The signing service accepts only a versioned, schema-valid evaluation result from the policy engine.
- The relayer accepts only a complete signed envelope and verifies it locally before submission.
- Every signing, rejection, rotation, and resolver action is audit-logged by obligation ID.
- The UI identifies the policy signer and resolver as trusted MVP components.

Before production use:

- Use an HSM or managed signing service for online keys.
- Put administrator authority behind a multisig and a bounded emergency procedure.
- Apply per-project and global value-rate circuit breakers.
- Prefer constrained smart accounts, client-signed permits, or on-chain payee and amount caps to reduce signer authority.

## Consequences

### Positive

- Payment destination substitution is prevented.
- Neither AI nor the relayer has financial authority.
- Client emergency controls cannot silently erase contractor commitments.
- Remaining MVP centralization is explicit and testable.

### Negative

- The current `PaymentDecision` and `release` interface do not satisfy this ADR.
- Multiple keys and bounded roles increase operational complexity.
- Production trust minimization requires more on-chain enforcement than the initial contract provides.

## Rejected alternatives

### Let the agent choose the payee during release

Rejected because the recorded approval would not authorize the actual destination.

### Give the LLM a wallet or transaction tool

Rejected because prompt injection and interpretation errors would become direct financial authority.

### Give the client unilateral cancellation authority

Rejected because a contractor could rely on a commitment, spend funds, and then lose the promised reimbursement.

### Require manual client approval for every settlement

Rejected as the default because client silence would recreate the payment-delay problem. Projects may opt into manual approval only if the timeout fallback remains explicit.
