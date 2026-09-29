# ADR 0009: Work Milestones, Acceptance, and Scope Protection

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product, policy engine, and protocol

## Context

Expense reimbursement does not solve the contractor's largest payment risk: completing work and then waiting indefinitely for acceptance or payment. It also does not stop scope creep, where informal additional requests appear without corresponding budget or schedule changes.

The service therefore needs a funded work-payment obligation distinct from a purchase commitment. Acceptance must preserve the client's ability to reject missing deliverables without allowing silence or subjective dissatisfaction to become indefinite non-payment.

## Decision

The project policy contains pre-funded `MilestoneCommitment` records for service compensation. Each milestone binds scope, acceptance criteria, deliverable units, amount, payee, review deadline, and timeout behavior before work begins.

A contractor is not required to begin a milestone until its full maximum amount is funded and reserved. Client silence after a valid delivery submission results in payment according to the accepted milestone rules.

## Milestone payload

```text
MilestoneCommitment
- schemaVersion
- chainId
- projectEscrow
- projectId
- obligationId
- policyHash and policyVersion
- title
- deliverableUnits[]
  - unitId
  - acceptanceCriteria[]
  - amountBaseUnits
- contractorPayee
- settlementAsset
- maximumAmountBaseUnits
- startBy
- deliveryDueAt
- deliveryGracePeriodSeconds
- clientReviewPeriodSeconds
- resolverReviewPeriodSeconds
- requiredDeliveryEvidence[]
- assetHandoverRequirements[]
- cancellationTerms
- nonce
```

The sum of deliverable-unit amounts equals the milestone maximum. A milestone without separable units is one binary unit.

## Lifecycle

```text
PLANNED -> FUNDED_AND_RESERVED -> IN_PROGRESS -> DELIVERED
   |              |                   |             |
   -> CANCELLED   -> EXPIRED_UNUSED   -> DISPUTED   -> ACCEPTED -> PAID
                                                   -> PARTIAL  -> PAID
                                                   -> REJECTED
```

- `PLANNED` is not permission to start work.
- `FUNDED_AND_RESERVED` is the client's binding payment commitment and permission to start. If the contractor does not mark the milestone IN_PROGRESS by `startBy`, it becomes EXPIRED_UNUSED and releases the reservation.
- `IN_PROGRESS` records contractor start before any cancellation deadline.
- `DELIVERED` starts the client review clock after a schema-valid delivery manifest is submitted.
- `ACCEPTED`, `PARTIAL`, and `REJECTED` operate only on predefined deliverable units and their fixed amounts.
- `PAID` consumes the reservation and transfers the accepted amount.

## Acceptance and timeout

The client may accept units or object with a reason code tied to a predefined acceptance criterion. The client may not add a new criterion after delivery.

- Client acceptance releases accepted-unit amounts immediately.
- Client silence until the review deadline releases every submitted unit whose required evidence is present and has no deterministic integrity failure.
- Client objection opens resolver review; it is not a terminal rejection.
- The resolver decides each disputed unit as accepted or rejected using only the predefined criteria and submitted evidence.
- Resolver silence releases a disputed unit by timeout when all required delivery evidence was submitted; otherwise it rejects that unit by timeout.
- No resolver decision can increase the milestone amount or change the contractor payee.

Timeout transitions are permissionless and use chain time as defined in ADR 0005.

## Delivery deadline

The contractor may submit delivery through `deliveryDueAt + deliveryGracePeriodSeconds`. Protocol v1 applies no automatic late-payment penalty.

- Delivery submitted within that window follows normal review.
- If no valid delivery manifest exists when the grace period ends, the milestone enters `NON_DELIVERY` resolver review.
- The contractor may not cure after the grace period without a bilaterally signed schedule change.
- The resolver decides only whether evidence was submitted before the deadline and whether predefined completed units qualify under `cancellationTerms`.
- If the resolver deadline also passes with no qualifying delivery evidence, undelivered units are REJECTED_BY_TIMEOUT and their reservations return to available project funds.

This prevents an in-progress milestone from reserving funds forever while making the final submission deadline visible before work starts.

## Scope creep and change orders

When a requested task is outside the active milestone scope:

1. The system marks it `OUT_OF_SCOPE` and does not treat it as an accepted obligation.
2. The AI may draft a change order describing added deliverables, price, schedule, acceptance criteria, and affected policy rules.
3. The contractor has no obligation to perform the added work before the change order is signed by both parties and its additional amount is funded and reserved.
4. Chat messages, tickets, or verbal requests do not change scope unless their terms are incorporated into the signed change order.

Existing milestone commitments remain governed by their pinned policy version.

## Cancellation and termination

- Before `IN_PROGRESS`, the contractor may decline or cancel the milestone and release the full reservation.
- Before `IN_PROGRESS`, the client may cancel only under the milestone's signed cancellation terms.
- After `IN_PROGRESS`, the client cannot unilaterally erase the reservation.
- Early termination uses the predefined deliverable units: completed units are delivered and reviewed; unstarted units release their reservation.
- A partially completed binary milestone has no automatic pro-rata amount. The parties must sign a termination change order or use the resolver, who may award only a `terminationCompensationBaseUnits` amount already specified in `cancellationTerms`.
- Closing the project does not change these rules.

## Relationship to expenses and assets

- Work compensation uses milestone reservations; vendor costs and reimbursements use purchase commitments under ADR 0005.
- A milestone cannot hide reimbursable expenses unless the policy explicitly prices them into the milestone amount.
- Asset-handover holdback is a deliverable unit governed jointly by this ADR and ADR 0006.
- An expense dispute cannot delay an unrelated milestone, and a milestone dispute cannot delay an unrelated committed expense.

## Consequences

### Positive

- Main service fees, not only expenses, receive escrow protection.
- The contractor can see funded payment assurance before starting work.
- Silent acceptance delay has a deterministic outcome.
- Scope changes become priced and signed obligations.
- Partial acceptance is limited to amounts agreed in advance.

### Negative

- Projects must define meaningful acceptance criteria before work begins.
- Subjective creative work may require frequent resolver involvement.
- More project budget is reserved earlier.
- Poorly decomposed binary milestones are harder to resolve fairly.

## Rejected alternatives

### Cover expenses but leave service fees outside escrow

Rejected because it leaves the contractor's primary non-payment risk unresolved.

### Let the client add acceptance criteria during review

Rejected because it permits retroactive scope and payment changes.

### Let the resolver choose any fair-looking partial amount

Rejected because unconstrained discretion would replace agreed rules. Partial awards are limited to predefined unit amounts or a predefined termination cap.

### Treat informal messages as binding scope changes

Rejected because casual requests would create ambiguous obligations without confirmed budget or schedule.
