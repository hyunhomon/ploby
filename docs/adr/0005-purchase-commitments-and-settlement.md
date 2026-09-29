# ADR 0005: Purchase Commitments, Settlement, and HOLD Deadlines

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, policy engine, and protocol

## Context

A reimbursement-only flow still requires the contractor to finance project costs and hope for later approval. A client-controlled HOLD without a deadline recreates the common failure mode of payment delay by silence.

The system must distinguish a cost approved before purchase from an expense submitted after the contractor spent without a commitment. It must also handle final amounts that differ because of quantity, foreign exchange, tax, or payment fees.

## Decision

The primary expense flow is `Reserve -> Spend -> Settle`.

An accepted `PurchaseCommitment` reserves project budget and is a binding promise to pay according to its pinned terms. A `SettlementIntent` consumes all or part of that reservation after required evidence is submitted. Every HOLD has a machine-readable class, a deadline, and a deterministic fallback.

Post-spend expenses without a prior commitment are supported only as `RETROACTIVE_REQUEST`. They require explicit approval and never gain automatic payment from client silence.

## Commitment payload

```text
PurchaseCommitment
- schemaVersion
- chainId
- escrowContract
- projectId
- obligationId
- requestId
- policyHash and policyVersion
- paymentMode: DIRECT_VENDOR | REIMBURSEMENT
- category
- vendorId
- payee
- settlementAsset
- maximumSettlementBaseUnits
- sourceQuoteAmount and sourceCurrency, when applicable
- fxQuoteReference, when applicable
- permittedTaxBaseUnits
- permittedFeeBaseUnits
- evidenceRequirements
- assetTreatment
- reservationExpiresAt
- nonce
```

The obligation ID is unique within a project. The typed commitment digest is the financial identity used by signatures, evidence, allocation, dispute, and settlement records.

## Commitment lifecycle

```text
REQUESTED -> RESERVED -> SPEND_REPORTED -> EVIDENCE_SUBMITTED -> SETTLED
     |           |              |                  |
     -> BLOCKED  -> EXPIRED      -> DISPUTED        -> PARTIALLY_SETTLED
                 -> CANCELLED        |                         |
                                    -> REJECTED                 -> CLOSED
                                    -> SETTLED
```

- `REQUESTED`: no funds are promised or reserved.
- `RESERVED`: policy passed, the commitment is signed, and budget is reserved atomically.
- `SPEND_REPORTED`: the contractor reports that the committed purchase occurred before reservation expiry.
- `EVIDENCE_SUBMITTED`: required evidence is linked to the obligation.
- `PARTIALLY_SETTLED`: the undisputed amount was paid while an excess or separate portion remains unresolved.
- `SETTLED`, `REJECTED`, `EXPIRED`, `CANCELLED`, and `CLOSED` are terminal for the relevant amount.

Before spend, the contractor may cancel the reservation and release its budget. The client cannot cancel it unilaterally. An unused reservation expires at `reservationExpiresAt`. A timely spend report prevents pre-spend expiry, but the contractor must submit evidence within the policy's evidence-submission period. Missing that deadline moves the obligation to `EVIDENCE_DEFECT`; it does not silently cancel the commitment because the spend may already have occurred.

## Reservation accounting

Creating a commitment atomically requires:

```text
maximumSettlementBaseUnits <= available project budget
```

and then:

```text
reserved += maximumSettlementBaseUnits
available -= maximumSettlementBaseUnits
```

Settlement moves the paid amount from reserved to released. Closing the obligation releases any unused reservation. No other request can consume reserved funds.

## Settlement amount

For a valid committed expense:

```text
eligibleActual = verified base price
               + policy-permitted tax
               + policy-permitted payment fee

committedPayable = min(eligibleActual, maximumSettlementBaseUnits)
excess = max(eligibleActual - maximumSettlementBaseUnits, 0)
```

- If actual eligible cost is lower than the reservation, pay the lower amount and release the remainder.
- If it is equal, settle the reservation in full.
- If it is higher, settle the undisputed `committedPayable` without waiting for excess approval. The excess requires a signed change order or separate commitment and is never auto-paid.
- An ineligible item, personal charge, penalty, or fee excluded by policy is not part of `eligibleActual`.

This prevents a small overage from delaying the amount already promised to the contractor.

## Foreign currency and fees

The MVP settles only in the project's configured token. A foreign-currency commitment must include:

- ISO source currency and quoted source amount;
- named FX source and quote identifier;
- quote timestamp and expiry;
- maximum settlement-token amount;
- separately capped tax and payment fee;
- rounding mode: round up to one settlement base unit for reservation, round down for payout calculation before applying the maximum.

The maximum settlement amount is the contractor's guaranteed cap, not an estimate the client may later reduce. If actual cost exceeds it, the committed portion remains payable and the excess follows the change-order path.

## Payment modes

### Direct vendor payment

The committed payee is the vendor. Settlement transfers directly to that address. A vendor invoice or quote satisfying the policy may be sufficient pre-payment evidence. Post-payment receipt evidence updates the audit record but does not redirect the payment.

### Reimbursement

The committed payee is the contractor wallet accepted in the policy. Settlement requires evidence of the eligible purchase at the configured assurance level. The vendor name in evidence does not become the blockchain payee.

A project selects one default mode. A commitment may use the other mode only when the active policy explicitly permits it.

## HOLD classes and deadlines

The policy's `clientReviewPeriodSeconds` starts when a settlement envelope passes basic identity, signature, and schema validation. Missing or insufficient evidence does not prevent the clock from starting; it produces `EVIDENCE_DEFECT`. The client must approve or reject with reason codes before the deadline. Silence invokes the following fallback:

| HOLD class | When used | Client-deadline fallback | Resolver-deadline fallback |
| --- | --- | --- | --- |
| `CLIENT_REVIEW` | Client preference or business review with no objective rule failure | Silence: auto-settle. Explicit objection: escalate to resolver | Auto-settle the committed payable amount |
| `POLICY_OR_SYSTEM_AMBIGUITY` | Parser, policy-engine, or infrastructure result is unavailable or ambiguous after a valid commitment | Escalate to resolver | Auto-settle the committed payable amount |
| `EVIDENCE_DEFECT` | Required evidence is missing, corrupt, or below the accepted assurance level | Escalate to resolver | Reject with evidence-defect reason; release reservation |
| `INTEGRITY_RISK` | Post-commitment invalid evidence signature, probable duplicate, or supported fraud signal that requires adjudication | Escalate to resolver | Reject with integrity-risk reason; release reservation |
| `EXCESS_AMOUNT` | Eligible actual cost exceeds the commitment | Settle committed payable immediately; excess remains unpaid | Excess is rejected unless a bilateral change order is signed |

`INTEGRITY_RISK` cannot be selected solely because the client objects. It requires a deterministic verifier or policy-engine reason code included in the decision bundle. A client-only objection is `CLIENT_REVIEW`.

An exact new allocation that would make an attested invoice exceed 100 percent is not a disputable HOLD: the new commitment is BLOCKED before reservation. `INTEGRITY_RISK` applies when a non-capacity integrity issue appears after a commitment already exists or when similarity is probable rather than exact.

`POLICY_OR_SYSTEM_AMBIGUITY` is valid only when the evidence meets the policy's minimum assurance and the asset, payee, and eligible actual amount are determinable. If those facts cannot be established, the class is `EVIDENCE_DEFECT`; system failure cannot manufacture a payable amount.

For a valid prior commitment, client rejection is never terminal by itself. It opens resolver review and preserves the reservation. `EVIDENCE_DEFECT` can return to evaluation when the contractor supplies the missing evidence. The client cannot waive a mandatory evidence or integrity rule; only a policy-compliant re-evaluation or bounded resolver decision can settle it. Retroactive requests are the exception: because no prior promise exists, explicit client rejection or client timeout is terminal.

The resolver period starts on escalation. The resolver can approve or reject only the disputed amount and must provide reason codes. It cannot change the payee or exceed the commitment maximum. Every timeout transition is recorded with `RELEASED_BY_TIMEOUT`, `ESCALATED_BY_TIMEOUT`, or `REJECTED_BY_TIMEOUT` as applicable.

Deadlines use the destination chain's `block.timestamp`. After a deadline, `executeTimeout(obligationId)` is permissionless and deterministic. The platform keeper normally submits it and pays gas, but the client, contractor, resolver, or any third party may submit the same transition. A backend outage therefore cannot suppress a timeout outcome.

The demo policy uses 72 hours for client review and seven days for resolver review. The UI shows exact deadlines in absolute time and displays the fallback before either party signs the policy.

## Retroactive requests

An expense incurred without a valid prior commitment is labeled `RETROACTIVE_REQUEST`.

- No budget was promised at spend time.
- It enters HOLD for explicit client approval.
- Client silence at the review deadline rejects it; there is no automatic release.
- Client approval creates and immediately settles a bounded commitment if budget remains.
- A client request for out-of-scope work is handled through a signed change order, not a retroactive expense workaround.

This distinction is visible in the UI so the contractor knows whether payment is guaranteed before spending.

## Consequences

### Positive

- The contractor no longer has to rely on post-spend goodwill for committed costs.
- Client silence cannot delay an objectively compliant settlement indefinitely.
- Overages do not block the amount already promised.
- The system distinguishes promised costs from discretionary reimbursements.

### Negative

- Reservations reduce available budget before cash is transferred.
- Resolver operations become a required platform function.
- FX, tax, and fee rules must be configured before purchase.
- Incorrect commitment configuration can reserve funds until cancellation or expiry.

## Rejected alternatives

### Approve only after a receipt is uploaded

Rejected because the contractor still finances the client's project expense.

### Let every HOLD wait indefinitely for the client

Rejected because silence would be an effective payment-denial mechanism.

### Auto-pay every HOLD on timeout

Rejected because missing evidence and deterministic integrity failures require a safe resolution path.

### Delay the entire settlement when actual cost exceeds the cap

Rejected because the undisputed committed amount is already owed.
