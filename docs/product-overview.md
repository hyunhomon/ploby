# Product Overview

## One sentence

SmartEscrow turns outsourced work, project expenses, and scope changes into funded, deadline-backed commitments that neither the client nor contractor can rewrite alone.

## The problem

Outsourced projects usually rely on informal promises at the moments when money matters most.

- A contractor completes work and waits for the client to review or pay.
- A contractor pays a project expense personally and hopes it will be reimbursed.
- A client receives invoices but cannot tell whether they are in scope, duplicated, or fairly allocated.
- Additional work appears in chat without a corresponding budget or schedule change.
- Project accounts, domains, subscriptions, and licenses remain under the wrong party's control at close.

A conventional expense approval tool solves only the client's visibility problem. SmartEscrow treats payment assurance and client control as equal requirements.

## The product promise

### For the client

- Money is reserved only for accepted policies, milestones, vendors, payees, and limits.
- Work payment is tied to acceptance criteria defined before delivery.
- Expense settlement is tied to evidence and deterministic policy checks.
- Duplicate and over-allocated invoices are detected across participating projects.
- Project assets have an ownership and handover record.
- New commitments can be paused without cancelling obligations already made.

### For the contractor

- A milestone is funded and reserved before work starts.
- A project expense can be reserved before the contractor spends.
- The client cannot change policy retroactively or cancel an accepted commitment alone.
- Every review and HOLD has a deadline and known fallback.
- Client rejection opens a bounded dispute instead of becoming final non-payment.
- Out-of-scope requests become priced change orders rather than unpaid extra work.

## Two kinds of obligation

SmartEscrow keeps work compensation and project expenses separate.

### Work milestone

The client pre-funds a fixed amount against deliverables and acceptance criteria. The contractor begins after the amount is reserved, submits delivery evidence, and receives payment after acceptance, timeout, or bounded dispute resolution.

### Purchase commitment

The contractor requests approval before buying a project expense. Policy approval reserves the maximum reimbursable amount. After purchase, evidence is checked and the eligible amount is settled. If actual cost exceeds the cap, the promised amount is paid first and only the excess requires a change order.

When policy allows direct vendor payment, the commitment instead fixes an exact vendor address and amount and pays it before purchase completion; the later receipt reconciles the audit record without becoming a second payment approval.

An expense incurred without a commitment is a retroactive request. It can be approved, but client silence never turns it into guaranteed payment.

## Why blockchain is used

The blockchain provides a shared enforcement layer for facts that independent parties should be able to verify:

- project funds are present and reserved;
- a commitment cannot be rewritten after acceptance;
- deadlines and timeout outcomes are deterministic;
- payment cannot be redirected to another payee;
- the same invoice cannot be allocated above 100 percent across participating projects;
- settlement and refund history cannot be silently edited.

The blockchain does not decide whether a PDF is truthful, whether delivered work is good, or whether a real-world account transfer occurred. Evidence services, deterministic rules, participant attestations, and a bounded resolver handle those questions.

## MVP scope

The core demo targets one website-development project on Base Sepolia using MockUSDC. Its required path demonstrates:

1. Bilateral project policy acceptance.
2. One pre-funded work milestone.
3. One pre-purchase expense commitment.
4. Contractor-controlled submission and a client-review timeout.
5. APPROVE, HOLD, and BLOCK outcomes.
6. A signed change order for added scope.
7. Project closing and refund of unreserved funds.

The accepted architecture also supports evidence assurance and DKIM, project-asset handover, resolver outcomes, and shared-invoice allocation. These are secondary demonstration tracks, not dependencies of the core end-to-end demo. The team may add them after the required path is stable without weakening their ADR decisions.

Protocol v1 uses one client and one contractor identity per project. Organizations may use multisig or smart-account identities. A multi-contractor engagement uses separate project escrows so that funding, obligations, and disputes remain isolated.

## Explicit MVP trust assumptions

The MVP is not trustless.

- The policy signer is trusted to sign only validated deterministic evaluations.
- The resolver is trusted to apply accepted criteria within the disputed amount.
- The Evidence Attestation Service is trusted to normalize invoices and issue consistent private nullifiers.
- MockUSDC is a test asset, not a dollar or regulated stablecoin.

All three service roles are constrained: none can redirect payment, increase a commitment, change policy, or withdraw project funds.

## Out of scope for the MVP

- Production custody, money-transmission, KYC, AML, sanctions, and tax compliance.
- Fiat deposits or withdrawals.
- Multiple settlement assets within one project.
- Yield generation or investment of escrowed funds.
- General legal arbitration or appeals beyond the configured resolver.
- Private zero-knowledge invoice allocation; the MVP uses a trusted HMAC-based attestation service.
- Invoice line-item allocation across projects.
- Automatic truth verification for uploaded PDFs.
- A general-purpose freelance marketplace, reputation system, or messaging platform.

## Success criteria

The demo is successful when an observer can verify all of the following without trusting the UI alone:

- the contractor saw funded assurance before starting work or spending;
- the client could not be charged outside the accepted commitment;
- neither party could change the payee, amount cap, or policy version unilaterally;
- client silence produced the pre-agreed result;
- an out-of-scope request created no obligation until a change order was signed and funded;
- closing preserved valid obligations and refunded only unreserved funds.
