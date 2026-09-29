# ADR 0008: Contract Deployment, Isolation, and Migration

- Status: Accepted - implementation pending
- Date: 2026-09-29
- Owners: Protocol and operations

## Context

The initial contract stores multiple projects in one contract and gives an administrator limited signer rotation authority. The target design adds reservations, timeouts, milestones, refunds, disputes, and project-specific policy. A shared mutable contract would increase blast radius and make upgrade authority a hidden custody risk.

The architecture must decide whether contracts are upgradeable, how projects discover supported versions, how funds are isolated, and how an existing project moves when a new version is deployed.

## Decision

Each project uses its own immutable `ProjectEscrow` contract deployed by a versioned factory. Project funds and accounting are isolated from every other project. Logic is not upgradeable through a proxy.

Protocol v1 has exactly one client identity and one contractor identity per project. Either identity may be an EIP-1271 smart account or multisig. A client working with multiple independent contractors creates separate project escrows; one project's reservations and disputes never affect another contractor.

Shared cross-project state is limited to the `InvoiceAllocationRegistry` in ADR 0007 and versioned service-signer registries. Those contracts never custody project funds.

## Contracts

| Contract | Responsibility | Holds funds |
| --- | --- | --- |
| `EscrowFactory` | Deploy deterministic project escrows from approved immutable versions | No |
| `ProjectEscrow` | Hold one project's settlement asset and enforce policy, commitments, milestones, deadlines, disputes, close, and refunds | Yes |
| `ProtocolVersionRegistry` | Publish supported factory and implementation versions and deprecation notices | No |
| `ServiceSignerRegistry` | Publish active policy-signer, resolver, evidence-attestor, and emergency-admin keys by version | No |
| `InvoiceAllocationRegistry` | Enforce global invoice allocation capacity | No |

`ProjectEscrow` stores the client, contractor, resolver, settlement asset, active policy hash, accepted service-key versions, and accounting state. It has no generic delegate-call, arbitrary-call, owner-withdraw, or token-sweep function.

## Deployment and addresses

The factory uses CREATE2 with a salt derived from:

```text
client, contractor, projectNonce, implementationVersion
```

The predicted address is included in bilateral policy acceptance before deployment. Deployment succeeds only when the accepted parties, policy hash, settlement asset, and implementation version match the signed initialization payload.

The factory cannot initialize itself as client, contractor, resolver, or payee.

## Immutability and upgrades

- A deployed `ProjectEscrow` never changes implementation.
- A new protocol release deploys a new implementation and registers a new version.
- Deprecation prevents creation of new projects on an old version but does not alter existing projects.
- Service signer rotation follows ADR 0001 and does not upgrade contract logic.
- The administrator cannot move project funds or replace participant roles.

This favors explicit migration over proxy-admin power.

## Migration

Migration is project-specific and bilateral.

1. A new project escrow is predicted from an accepted target version and migration nonce.
2. Client and contractor sign an EIP-712 `MigrationIntent` containing old escrow, new escrow, target version, policy hash, settlement asset, balance, active obligations, and expiry.
3. Every active obligation is either completed before migration or included in the signed migration manifest with identical economic terms.
4. The old escrow enters `MIGRATING`, blocking new obligations.
5. The old escrow atomically transfers the migratable balance and emits the manifest hash.
6. The new escrow verifies the transfer and activates the migrated state.
7. The old escrow becomes `MIGRATED` and remains read-only.

The resolver cannot authorize migration. For a project with no contractor and no active obligation, the client may close and redeploy instead of migrating.

If either participant refuses migration, the old immutable contract continues under its accepted rules. Deprecation alone never forces migration.

## Emergency recovery

A security freeze under ADR 0004 provides time to publish a fixed version. Recovery still requires bilateral migration approval. The administrator may publish warnings, freeze within its bounded authority, rotate compromised service signers, and disable new deployments. It cannot sweep, redirect, or forcibly migrate project funds.

If an immutable contract has an unfixable defect and bilateral migration is unavailable, the parties use the contract's existing close, settlement, and refund paths to the extent they remain safe. The architecture deliberately does not introduce an administrator backdoor for this case.

## Chain and confirmation policy

- The target deployment chain is Base Sepolia for demo and Base mainnet only after security review.
- Backend state becomes final after the configured confirmation threshold; the demo uses two confirmations.
- A chain reorganization rolls back off-chain projections to the last canonical block and replays events.
- UI states distinguish `submitted`, `confirmed`, and `finalized` rather than presenting a pending transaction as complete.
- Contract deadlines use chain time; off-chain clocks are display aids only.

## Consequences

### Positive

- One project cannot consume or corrupt another project's escrow balance.
- No proxy administrator can silently change financial rules.
- Migration terms are visible and require both economic parties.
- Shared global contracts coordinate data without holding project funds.

### Negative

- Per-project deployment costs more gas.
- Fixing an immutable defect requires migration and participant coordination.
- Cross-project queries require an indexer rather than one contract read.

## Rejected alternatives

### One upgradeable proxy for all projects

Rejected because proxy-admin compromise or error would affect all funds and could rewrite accepted rules.

### One immutable multi-project escrow

Rejected because a shared balance and implementation create unnecessary cross-project blast radius.

### Administrator-forced migration

Rejected because it gives the administrator effective custody over project funds and obligations.

### Emergency token sweep

Rejected because a sweep function is indistinguishable from a custody backdoor.
