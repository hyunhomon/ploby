# ADR 0004: Project Lifecycle and Refunds

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Product and protocol

## Context

The initial contract exposes a terminal-looking `stopProject` operation but provides no withdrawal path. As a result, stopping a project can freeze unspent funds indefinitely. The product concept also uses "pause", "revoke authorization", and "emergency stop" as if they were interchangeable, although they have different operational and financial consequences.

Pending HOLD and APPROVE decisions also need expiry rules so they cannot remain payable forever after project circumstances change.

## Decision

Project control will distinguish a reversible pause from a terminal close. Every terminal path provides a defined way to return unspent and unreserved funds to the client.

## Project states

```text
DRAFT -> ACTIVE <-> PAUSED -> CLOSING -> CLOSED
   |        |          |          |
   +--------+----------+----------+-> CANCELLED
```

| State | Meaning | Allowed financial actions |
| --- | --- | --- |
| DRAFT | Project exists but is not funded and policy acceptance may be incomplete | Fund, activate, or cancel |
| ACTIVE | New requests and eligible releases are allowed | Submit, decide, reserve, release, pause, or begin close |
| PAUSED | Emergency reversible freeze | Review history, reject pending items, resume, or begin close; no new approval or release |
| CLOSING | Terminal wind-down and pending-liability resolution | Reject or expire unresolved items and withdraw only unreserved funds |
| CLOSED | Final state after liabilities are resolved and refundable funds withdrawn | Read-only |
| CANCELLED | Final state for an unfunded project or a funded project with no remaining liabilities | Refund if funded, then read-only |

The existing `stopProject` behavior is not the target terminal close behavior. A later implementation must either redefine it as pause or replace it with explicit lifecycle operations.

## Decision lifecycle

```text
SUBMITTED -> APPROVED -> RELEASED
     |           |  \
     |           |   -> EXPIRED
     |           -> REVOKED
     -> HELD -> CLIENT_APPROVED -> RELEASED
          |             |
          -> REJECTED    -> EXPIRED
          -> EXPIRED
     -> BLOCKED
```

- APPROVE reserves the decision amount until release or expiry.
- HOLD reserves no budget until the client approves it, unless a project policy explicitly opts into reservations for review.
- Client approval of a HOLD creates a reservation for the exact payment intent.
- BLOCK and REJECTED are terminal.
- Decisions carry `validUntil`; expiration is deterministic and cannot be extended without a new decision.
- Pausing a project prevents release even for previously approved decisions.
- Resuming does not revive an expired decision.

## Closing and refund rules

1. The client initiates closing from ACTIVE or PAUSED.
2. New requests and new approvals stop immediately.
3. Existing HOLD requests are rejected or allowed to expire.
4. Existing approved reservations may be released during a configured closing grace period only if the project was not emergency-paused for suspected compromise.
5. After the grace period, unreleased reservations expire.
6. The client withdraws `deposited - released - activeReservations`.
7. When active reservations and escrow balance are zero, or the refundable balance has been withdrawn, the project becomes CLOSED.

For the hackathon MVP, the closing grace period may be zero and every unreleased decision may expire on close. This simpler behavior must be shown in the UI and demo script.

Refunds always go to the recorded client funding address. Changing the refund address requires a separate authenticated recovery flow and is out of scope for the MVP.

## Emergency behavior

- The client can pause immediately without cooperation from the agent.
- A contract administrator may pause a compromised global signer but cannot take project funds.
- A backend outage does not prevent the client from entering PAUSED or CLOSING.
- Signer rotation does not reactivate a paused project.
- A failed token transfer leaves accounting and the decision state unchanged.

## Consequences

### Positive

- Emergency response no longer implies permanent loss of access to funds.
- The UI can explain exactly which actions are available in each state.
- Approved but unreleased expenses cannot remain valid indefinitely.
- Refund accounting accounts for pending liabilities.

### Negative

- The contract and backend need explicit state-transition and reservation logic.
- Closing requires time and expiry handling.
- The current contract does not implement refunds, resume, closing, or decision expiry.

## Rejected alternatives

### Make stop permanent without a refund path

Rejected because unspent funds can become locked indefinitely.

### Allow immediate refund while approved decisions remain payable

Rejected because the same funds could be promised to a payee and returned to the client.

### Allow the backend agent to resume a client pause

Rejected because the emergency control must remain effective if the backend or signer is compromised.
