# ADR 0004: Project Lifecycle, Pause, Close, and Refunds

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and protocol

## Context

The initial contract exposes `stopProject` but has no refund path. It also freezes release of previously approved decisions. That allows emergency control to erase the practical value of a contractor's payment assurance and can lock unspent funds indefinitely.

The product previously used pause, stop, revoke, close, and emergency freeze as if they were interchangeable. They require different authority and financial effects.

## Decision

Project lifecycle, new-commitment pause, and protocol security freeze are separate concepts.

- Project lifecycle determines whether new obligations may be created and whether the project is winding down.
- A client pause affects only new purchase commitments.
- A bounded security freeze may delay all execution while a compromised signer or contract issue is contained, but it cannot cancel obligations.
- Closing preserves existing commitments and returns only funds that are neither released nor reserved.

## Lifecycle states

```text
DRAFT -> ACTIVE -> CLOSING -> CLOSED
   \         \
    -> CANCELLED
```

| State | Entry condition | Allowed actions |
| --- | --- | --- |
| DRAFT | Project created; funding or bilateral policy acceptance incomplete | Fund, accept policy, activate, or cancel |
| ACTIVE | Policy accepted and required funding available | Create commitments, submit evidence, settle, amend policy, pause new commitments, or begin close |
| CLOSING | Either client or contractor initiates close | No new commitments; existing obligations settle, expire, cancel bilaterally, or resolve through dispute; unreserved funds may be refunded |
| CLOSED | No active obligations or reservations remain and refundable funds were withdrawn | Read-only audit access |
| CANCELLED | DRAFT project cancelled, or ACTIVE project with no active obligation cancelled bilaterally | Refund funded balance, then read-only audit access |

An ACTIVE project cannot jump to CANCELLED while an active commitment exists. It enters CLOSING instead.

## Pause of new commitments

`newCommitmentsPaused` is a project flag controlled by the client.

When true:

- new commitment requests cannot be accepted;
- bilaterally signed policy amendments may activate, but no new commitment may be created until the project resumes;
- existing commitments may receive evidence, resolve HOLD, and settle normally;
- existing deadlines continue to run;
- the contractor may cancel an unused reservation;
- the client may resume or begin closing.

The client cannot use pause to cancel, delay, or change an existing commitment. A reason code is recorded for every pause and resume.

## Security freeze

`securityFreezeUntil` is a protocol-wide or contract-wide execution guard for signer compromise, contract vulnerability, or chain incident.

- Only the administrator multisig may activate it.
- One activation lasts at most 72 hours.
- All activations for one incident have a cumulative maximum of seven days; changing the incident identifier does not reset the cap while the same root cause remains unresolved.
- It blocks new commitments and fund transfers, including existing settlements.
- It does not cancel or modify any obligation.
- Every affected client-review, resolver-review, commitment, and settlement deadline is extended by the exact freeze duration.
- Extending beyond 72 hours requires a new multisig action and public incident record.
- Before the seven-day cumulative cap, the protocol must resume or offer a recovery contract migration that each project's client and contractor approve. The administrator cannot migrate a project unilaterally.
- At the cumulative cap, the freeze expires automatically for projects that did not approve migration; administrator safety authority does not become an indefinite custody right.
- Restoring signer service does not resume a client-paused project.

The security freeze is not available for commercial disputes.

## Closing behavior

1. Entering CLOSING stops new commitments immediately.
2. Unused reservations remain valid until their pre-spend expiry; the contractor may cancel them earlier.
3. Commitments against which the contractor spent before expiry remain payable under the pinned policy.
4. Submitted settlements and disputes continue through their normal deadlines.
5. The client may withdraw only `funded - released - activeReservations`.
6. Expired or cancelled unused reservations return to available balance.
7. When no active reservation, settlement, or dispute remains and every asset-register item is resolved under [ADR 0006](0006-project-assets-and-handover.md), the remaining balance is refundable and the project becomes CLOSED after withdrawal.

Closing never accelerates rejection of a valid obligation and never changes its policy version.

## Refund destination and recovery

Refunds go to the recorded funding address by default. A refund address may change only through a separately signed recovery payload from the client and the configured recovery authority. The policy signer and resolver cannot change it.

The MVP may omit address recovery, in which case the funding address is immutable and the UI must warn the client before funding.

## Failure guarantees

- A backend outage does not prevent the client from pausing new commitments or beginning close through the contract.
- A client cannot prevent settlement by remaining silent; ADR 0005 timeout rules apply.
- A failed token transfer leaves reservation, accounting, and settlement state unchanged.
- No terminal path may leave funds without an identified owner or active obligation.
- If a token is unsupported, fee-on-transfer, rebasing, paused, or otherwise incompatible, the project cannot activate with that asset.

## Consequences

### Positive

- Client emergency control and contractor payment assurance coexist.
- Accepted commitments survive pause and project wind-down.
- Unreserved funds always have a defined refund path.
- A genuine security incident can temporarily halt loss without erasing obligations.

### Negative

- Closing may remain open until valid commitments and disputes resolve.
- Reservation accounting and deadline extensions add contract state.
- The current contract does not implement these states, refunds, or bounded freeze behavior.

## Rejected alternatives

### Freeze every existing commitment when the client stops the agent

Rejected because the client could revoke costs after the contractor relied on an accepted commitment.

### Refund the entire balance immediately on close

Rejected because reserved funds are already promised to existing obligations.

### Allow an indefinite emergency freeze

Rejected because an administrator-controlled indefinite freeze recreates payment withholding.

### Allow the backend signer to resume client pause

Rejected because a compromised signer must not override the client's control over new obligations.
