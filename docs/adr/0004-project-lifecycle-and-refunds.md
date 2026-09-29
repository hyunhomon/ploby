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
- A client pause affects all new purchase and milestone commitments.
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
| ACTIVE | Policy accepted and the policy's initial funding requirement met | Create commitments, submit evidence, deliver milestones, settle, amend policy, pause new commitments, or begin close |
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

`securityFreezeUntil` is a protocol-wide or contract-wide execution guard for signer compromise, contract vulnerability, or chain incident. `RECOVERY_ONLY` is a one-way terminal operating mode for a contract that cannot safely resume ordinary execution.

- Only the administrator multisig may activate it.
- One activation lasts at most 72 hours.
- Frozen seconds are accumulated per contract over a rolling 30-day window and may not exceed seven days, regardless of incident identifiers.
- It blocks new commitments and fund transfers, including existing settlements.
- It does not cancel or modify any obligation.
- Every affected client-review, resolver-review, commitment, and settlement deadline is extended by the exact freeze duration.
- Extending beyond 72 hours requires a new multisig action and public incident record.
- At an activation deadline, the multisig must already have recorded either a remediation-backed resume or a valid extension. Otherwise the contract's effective mode becomes `RECOVERY_ONLY`; the next state-changing call materializes that transition and cannot execute ordinary operations first.
- Before the seven-day rolling cap, the administrator multisig must either record a public remediation-report hash and resume ordinary operation or transition the affected contract to `RECOVERY_ONLY`.
- The contract never automatically resumes normal transfers merely because time elapsed. At the seven-day rolling cap, its effective mode becomes `RECOVERY_ONLY` if no remediation-backed resume was recorded.
- In `RECOVERY_ONLY`, new obligations, policy changes, and ordinary service-signed execution remain disabled. Dedicated recovery entrypoints allow the client to withdraw canonical `available`; existing obligations to settle through a new bilateral instruction, a resolver award within the original cap, or the original timeout fallback already authorized by both parties' policy signatures; and a quiescent project to migrate under [ADR 0008](0008-contract-deployment-and-migration.md). None of these recovery actions requires administrator approval.
- Recovery releases and refunds retain the original payee and client addresses. The administrator, resolver, and relayer cannot redirect them.
- Review and obligation deadlines remain paused until entry into `RECOVERY_ONLY`, then restart with the exact frozen duration added. They do not resume while the contract is known to be unsafe.
- Restoring signer service does not resume a client-paused project.

The security freeze is not available for commercial disputes.

## Closing behavior

1. Entering CLOSING stops new commitments immediately.
2. Unused reservations remain valid until their pre-spend expiry; the contractor may cancel them earlier.
3. Commitments against which the contractor spent before expiry remain payable under the pinned policy.
4. Submitted settlements and disputes continue through their normal deadlines.
5. The client may withdraw only canonical `available`.
6. Expired or cancelled unused reservations return to available balance.
7. When no active reservation, settlement, or dispute remains and every asset-register item is resolved under [ADR 0006](0006-project-assets-and-handover.md), the remaining balance is refundable and the project becomes CLOSED after withdrawal.

Closing never accelerates rejection of a valid obligation and never changes its policy version.

## Funding and accounting

The target architecture permits partial deposits and later top-ups. `projectBudgetBaseUnits` is a spending cap, not a requirement to deposit the entire budget at creation.

The project tracks:

```text
funded
expenseReserved
milestoneReserved
expenseReleased
milestoneReleased
released
refunded
migratedOut
released = expenseReleased + milestoneReleased
available = funded - expenseReserved - milestoneReserved - released - refunded - migratedOut
accountedSettlementBalance = funded - released - refunded - migratedOut
```

`migratedOut` is zero for every live project. It is set exactly once to the canonical available balance when a successful migration makes the source escrow read-only; it is never a fee, payment, or refund.

- A project activates only after the policy-defined initial funding amount is deposited.
- Deposits may not raise cumulative funded principal above the active project budget; increasing that cap requires a bilateral policy version.
- A purchase or milestone commitment is created only when its full maximum amount can be reserved from `available` and the relevant sub-budget.
- Expense capacity is `expenseBudgetBaseUnits - expenseReserved - expenseReleased`; milestone capacity is `milestoneBudgetBaseUnits - milestoneReserved - milestoneReleased`. No release may be counted against both sub-budgets.
- Top-ups are allowed only in DRAFT and ACTIVE. CLOSING cannot create new obligations, and every valid existing obligation is already fully reserved, so a top-up in CLOSING is rejected.
- The client cannot withdraw available funds while ACTIVE. Withdrawals begin only in CLOSING or CANCELLED.
- Escrowed funds earn no yield. The MVP charges no platform fee.
- Relayer gas is paid outside project escrow and is not deducted from contractor settlement.
- Accounting uses observed token balance changes and supports only allowlisted fixed-supply, non-rebasing, non-fee-on-transfer tokens.

## Refund destination and recovery

Protocol v1's `deposit` entrypoint accepts deposits and top-ups only from the recorded client identity; another caller reverts. Refunds return only to that same client identity. If the client is an EIP-1271 smart account or multisig, that account both funds the escrow and receives refunds.

An ERC-20 holder can bypass the entrypoint and transfer the settlement token directly to the contract, so the protocol does not claim such transfers can be prevented. They do not increment `funded` or `available` and cannot back an obligation. Anyone may call `returnUnaccountedSettlementToken`; it transfers only `tokenBalance - accountedSettlementBalance`, only to the recorded client, and changes no ledger counter. Closing and migration invoke it before their terminal transition. The UI warns that a direct token transfer is not a deposit and gives the sender no protocol refund claim. Other token types are unsupported and have no rescue function.

The client address is immutable within a v1 escrow. Changing client identity requires a bilateral migration under [ADR 0008](0008-contract-deployment-and-migration.md), which is available only after all active obligations are resolved. The policy signer, resolver, administrator, and relayer cannot change the refund destination.

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

### Allow an indefinite emergency freeze or automatic unsafe resume

Rejected because an administrator-controlled indefinite freeze recreates payment withholding, while automatic resume after a known vulnerability can lose funds. The bounded freeze therefore ends in either verified resume or participant-controlled `RECOVERY_ONLY` exits.

### Allow the backend signer to resume client pause

Rejected because a compromised signer must not override the client's control over new obligations.
