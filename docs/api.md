# Ploby API (MVP)

[`PROJECT_OVERVIEW.md`](../PROJECT_OVERVIEW.md) is the first-class reference for this contract: its product
principles, flows, decision order, HOLD table, roles and ledger (§1–§10), and its rule that **현재 구현** and
**목표 설계** are never mixed — `/api/meta.implementation` states which is which, and the UI shows it. UI copy
uses the overview's Korean terms (클라이언트, 작업자, 분쟁 해결자, 공급자, 카테고리, 건별 한도, 약정, 예약, 정산,
제출 통지, 변경 주문, 새 약정 일시정지, 종료).

The web app talks to one JSON API (`escrow/server.py`, port 3010; the Vite dev server proxies `/api`). The server runs the deterministic engine (`escrow/engine.py`) over the Proof-Carrying Payments core (`pcp/`). The model only reads text: expense-rule words, vendor documents, change-order requests. Code decides every state change.

This document is the contract between the engine and the UI. Money is an integer number of KRW (the demo settlement token, 1 unit = 1 KRW). Times are milliseconds since 1970 (UTC) on the **demo clock** (`now`), which the demo can move forward to show deadlines.

## Identities (demo)

Three fixed demo identities stand in for wallets. Every request names the acting role with `as`.

| role | Korean | name |
|---|---|---|
| `client` | 클라이언트 | 카페 온담 |
| `contractor` | 작업자 | 한결웹스튜디오 |
| `resolver` | 분쟁 해결자 | Ploby 분쟁 해결자 |

Signatures are HMAC-SHA256 with per-role demo keys held by the server; they stand in for wallet (EIP-712) signatures.

## Endpoints

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/meta` | | `{roles: [Party], vendors: [{id, name, category, category_ko}], categories: [{id, name_ko}], defaults: Periods, ai: {enabled, model}, implementation: {current: [str], target: [str]}}` |
| GET | `/api/clock` | | `{now, offset}` |
| POST | `/api/clock` | `{advance: seconds}` or `{reset: true}` | `{now, offset}` — then the keeper runs every due timeout |
| GET | `/api/samples` | | `[{id, name, kind: 'quote'|'receipt'|'delivery', text}]` sample documents |
| POST | `/api/documents` | `{name, text}` | `DocRef` (`id` = sha256 of the text) |
| GET | `/api/documents/{id}` | | `{id, name, text}` |
| POST | `/api/rules/compile` | `{words}` | `RulesCandidate` — the model's two blind readings of expense-rule words |
| GET | `/api/projects?as=role` | | `[ProjectSummary]` projects where the role is a party |
| POST | `/api/projects` | `{as: 'client', ...NewProject}` | `ProjectView` (status DRAFT, policy v1 PROPOSED) |
| GET | `/api/projects/{id}?as=role` | | `ProjectView` for that role |
| POST | `/api/projects/{id}/actions` | `{as, action, ...params}` | `{ok: true, result, view: ProjectView}` or HTTP 400 `{ok: false, error, code}` |
| POST | `/api/projects/{id}/agent` | `{as: 'contractor', task, offers: [document id]}` | `{ok: true, result: {task, plan, ai, tried: [{need, document, expense, result, rule, status}], stopped}, view}` — the purchase agent plans once (Kiln flow `agent`), then files requests (`escrow/agent.py`) |
| GET | `/api/projects/{id}/chain` | | `{chain: ChainStatus, onchain: {client, contractor, policy_hash, budget, funded, reserved, paid, refunded, paused, log_head, available} \| null, engine: {funded, reserved, paid, refunded, available}, match}` — read live from PlobyEscrow ([chain.md](chain.md)) |
| GET | `/api/projects/{id}/audit` | | the auditor's report (`python3 -m escrow.audit --json`): replay, policies, payments with what authorized them, stops, chain checks, verdict |

Every GET and POST first runs the keeper: every deadline that has passed on the demo clock applies its pre-agreed fallback, logged with `by: 'keeper'`.

### NewProject

```json
{
  "name": "카페 홈페이지 리뉴얼",
  "rules": {"mode": "form", "form": {"vendors": ["aws", "vercel", "gabia", "figma", "adobe-stock"],
                                      "budget": 500000, "max_per_purchase": 200000, "until": "2026-10-31",
                                      "category_budgets": {"hosting": 250000}}},       optional, per category id
  "milestones": [
    {"title": "디자인 시안", "start_by": "2026-10-03", "due_at": "2026-10-10", "grace_days": 2,
     "units": [{"title": "메인 시안", "criteria": ["데스크톱·모바일 시안 각 1종"], "amount": 1000000},
               {"title": "서브 페이지 시안", "criteria": ["메뉴·매장 안내 페이지"], "amount": 500000}]}
  ],
  "periods": {"client_review_hours": 72, "resolver_review_days": 7, "evidence_days": 7, "reservation_days": 7},
  "ends_at": "2026-12-31"
}
```

`rules.mode` is `form` (fields above) or `words`: `{"mode": "words", "words": "...", "candidate": "<id>", "pick": "writer"|"reader"}` using a `RulesCandidate` from `/api/rules/compile`. The expense budget is the rules' budget; the milestone budget is the sum of the milestones; the project budget and the initial funding are their sum. Dates are `YYYY-MM-DD` (KST); `start_by` and `due_at` mean the end of that day.

### RulesCandidate

```json
{"candidate": "c_ab12", "agree": true, "problems": [], "differences": [],
 "options": [{"source": "writer", "ok": true, "hash": "…", "readback": ["총 한도: 50만 원 …"], "expressions": {"budget": "50만", …}, "error": null},
             {"source": "reader", …}],
 "usage": {"calls": 2, "tokens": 6183, "cost_usd": 0.0005, "seconds": 7.4, "cached": true}}
```

## ProjectView

```text
ProjectView = {
  id, name, status: 'DRAFT'|'ACTIVE'|'CLOSING'|'CLOSED'|'CANCELLED', paused: bool, now, created_at,
  viewer: Party,                                  the role this view was built for
  parties: {client: Party, contractor: Party, resolver: Party},
  policy: PolicyView | null,                      the ACTIVE version (null while DRAFT)
  proposals: [PolicyView],                        PROPOSED versions waiting for signatures
  versions: [PolicyView],                         every version, oldest first
  ledger: Ledger,
  milestones: [Milestone],
  expenses: [Expense],
  change_orders: [ChangeOrder],
  actions: [Action],                              what the viewer may do now (the UI renders these)
  deadlines: [Deadline],                          running clocks, soonest first, every role
  log: [LogEntry],                                oldest first
  head                                            the log's hash head
}
Party = {role, name, address}
```

### PolicyView

```text
PolicyView = {
  version, hash, previous_hash, status: 'PROPOSED'|'ACTIVE'|'SUPERSEDED'|'WITHDRAWN',
  kind: 'initial'|'change_order', change_order_id,
  signatures: {client: {sig, at} | null, contractor: {sig, at} | null},
  summary: {project_budget, expense_budget, milestone_budget, initial_funding, starts_at, ends_at,
            client_review_seconds, resolver_review_seconds, evidence_seconds, reservation_seconds},
  rules: {source: 'form'|'words', words, readback: [str], expressions: {name: str}, mandate_hash,
          vendors: [id], max_per_purchase, until},
  milestones: [{id, title, amount, start_by, due_at, grace_until, units: [{id, title, criteria: [str], amount}]}],
  fallbacks: [{case, silence, resolver_silence}],   Korean text shown before signing (what silence does)
  doc                                              the canonical policy document that was hashed
}
```

### Ledger (ADR 0004)

```text
Ledger = {budget, expense_budget, milestone_budget,
          funded, expense_reserved, milestone_reserved, expense_released, milestone_released,
          released, refunded, migrated_out, available,   available = funded - reserved - released - refunded - migrated_out
          expense_capacity, milestone_capacity,        sub-budget left to reserve
          deposit_room,                                how much more the client may deposit now (the policy budget cap)
          funding_needed}                              what a deposit must add so everything signed is funded
```

### Milestone (ADR 0009)

```text
Milestone = {
  id, title, version, status, amount, start_by, due_at, grace_until,
  units: [{id, title, criteria: [str], amount,
           status: 'PLANNED'|'RESERVED'|'CLAIMED'|'DISPUTED'|'PAID'|'RELEASED_BY_TIMEOUT'|'REJECTED'|'NOT_DELIVERED'|'RETURNED',
           reason}],
  submission: {at, units: [id], note, documents: [DocRef]} | null,
  review_deadline, resolver_deadline,
  objections: [{unit, criterion, reason_code: 'NOT_MET'|'MISSING'|'DEFECTIVE', reason, at}],
  paid, returned
}
status: 'PLANNED'              signed but not yet funded (a change order waiting for the deposit)
        'FUNDED_AND_RESERVED'  money reserved: the contractor may start
        'IN_PROGRESS'          started
        'DELIVERED'            submitted; the client's review clock runs
        'DISPUTED'             objected units with the resolver
        'NON_DELIVERY'         nothing submitted by due + grace; with the resolver
        'PAID' | 'PARTIAL' | 'REJECTED' | 'EXPIRED_UNUSED' | 'CANCELLED'   final
```

### Expense (ADR 0005)

```text
Expense = {
  id, kind: 'COMMITMENT'|'RETROACTIVE', status, hold_class, version (the policy version it pins),
  vendor, vendor_name, category, category_ko, item,
  payment_mode: 'REIMBURSEMENT', payee (the contractor's address from the policy), assurance: 'E0'|'E1'|'E2'|'E3',
  quote: {amount, fee, total, document: DocRef, reading: Reading, manifest_hash},
  maximum, reserved, expires_at, spent_at, evidence_deadline,
  receipt: {document: DocRef, claimed, reading: Reading, eligible, at, manifest_hash, supplements: [DocRef]} | null,
  review_deadline, resolver_deadline,
  paid, excess, excess_paid,
  settlement: {payee, amount, asset, at} | null,
  timeout: 'RELEASED_BY_TIMEOUT'|'ESCALATED_BY_TIMEOUT'|'REJECTED_BY_TIMEOUT'|null,
  decision: {result: 'APPROVE'|'HOLD'|'BLOCK', reason, rules: [Rule]},
  out_of_scope: bool,                              blocked by the vendor or category list: a change order may cover it
  resolution: {by, accept, reason} | null
}
Rule = {rule, label, ok: true|false|null, detail, kind: 'mandatory'|'risk'|'evidence'}
       in the overview's §6 order: allocation (the same document again = invoice allocation over 100%), state,
       window, payment_mode, vendor, category, payee, per_purchase, expense_budget, category_budget, funds (mandatory: a failure is
       BLOCK); evidence (the reading could not be trusted: HOLD); probable_duplicate, split_pattern,
       price_anomaly (risk signals: HOLD, never BLOCK, never APPROVE)
status: 'HOLD_REVIEW'         request held for the client (no promise yet); silence -> EXPIRED
        'BLOCKED'             a mandatory rule failed
        'RESERVED'            committed: money reserved until expires_at
        'SPEND_REPORTED'      bought; the evidence clock runs
        'EVIDENCE_SUBMITTED'  receipt in; the client's clock runs. hold_class CLIENT_REVIEW: approve or object,
                              silence pays. EVIDENCE_DEFECT / INTEGRITY_RISK / POLICY_OR_SYSTEM_AMBIGUITY: the
                              client cannot approve (cannot waive a mandatory rule), only escalate; silence
                              escalates (ESCALATED_BY_TIMEOUT); the contractor may supplement evidence
        'DISPUTED'            with the resolver (hold_class says what resolver silence does)
        'RETRO_REVIEW'        retroactive request; silence -> REJECTED
        'SETTLED' | 'PARTIALLY_SETTLED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'   final
hold_class: 'CLIENT_REVIEW'|'POLICY_OR_SYSTEM_AMBIGUITY'|'EVIDENCE_DEFECT'|'INTEGRITY_RISK'|'EXCESS_AMOUNT'|null
Reading = {ok, source: 'ai'|'manual'|'unavailable', fields: {}, problems: [str], model,
           usage: {tokens, cost_usd, seconds, cached}, generation_ids: [str]}   (never the model's reasoning)
DocRef = {id, name}
```

### ChangeOrder (ADR 0002, 0009)

```text
ChangeOrder = {
  id, status: 'DRAFT'|'PROPOSED'|'SIGNED'|'FUNDED'|'WITHDRAWN', by, text,
  draft: {title, amount, start_by, due_at, grace_days, units: [{title, criteria: [str], amount}], note,
          expense_budget_delta, covers_excess},      a milestone (units non-empty) and/or more expense budget;
                                                     covers_excess: the expense whose excess this pays once funded
  policy_version, ai: {ok, problems, usage}
}
DRAFT: non-binding, editable. PROPOSED: a new policy version waiting for both signatures.
SIGNED: active version, its milestone PLANNED until the client's deposit covers it. FUNDED: reserved.
```

### Action, Deadline, LogEntry

```text
Action   = {action, target: {kind: 'project'|'policy'|'milestone'|'expense'|'change_order', id} | null,
            label, deadline | null, fallback | null, needs_response: bool}
Deadline = {target: {kind, id}, label, at, owner: role, fallback}
LogEntry = {i, at, by: role|'keeper'|'relayer', op, text, head, chain?: [ChainResult]}
ChainResult = {line, n, call: 'open'|'fund'|'accept'|'pause'|'decide'|'settle'|'refund', args, tx | null, url | null,
               ok, error | null, block | null}      # a relayer 'chain' line: the tx that mirrors log line `line`
ChainStatus = {enabled, network, chain_id, contract, contract_url, token, pending, sent, refused}
AgentTask = {id: 'A1', task, offers: [DocRef], plan: {needs: [{need, offers: [document id], why}], skip: [{offer, why}]},
             ai: {ok, problems, usage, model}, at, line, requests: [{expense, need, try, document, status, result, rule}]}
```

`ProjectView` also carries `chain: ChainStatus` and `agent_tasks: [AgentTask]`; an `Expense` filed by the agent carries
`via: {task, need, why, try}`, and expenses and milestones carry the `chain` results that mirror them. With chain writes
on, a request's line keeps what the contract said before the decision in `inputs.chain` (`{paused, available}` or
`{skipped}`); it can only make the `state` and `funds` rules stricter.

## Actions

`POST /api/projects/{id}/actions` with `{as, action, ...params}`. The server refuses an action the role may not take now (HTTP 400, `code` = `forbidden` | `state` | `invalid` | `deadline`).

| action | role | params | effect |
|---|---|---|---|
| `sign_policy` | client, contractor | `version` | sign a PROPOSED version; both signatures activate it |
| `deposit` | client | `amount` | fund up to `deposit_room`; a DRAFT project activates once both signed and `initial_funding` is in (every milestone is reserved then); a signed change order's milestone is reserved once `available` covers it |
| `cancel_project` | client | | DRAFT only: CANCELLED, the funded balance becomes withdrawable |
| `pause` / `resume` | client | `reason` | new commitments refused while paused; existing ones continue |
| `begin_close` | client, contractor | | ACTIVE -> CLOSING: no new commitments; existing ones finish |
| `withdraw` | client | `amount` (optional, default all `available`) | CLOSING or CANCELLED only |
| `start_milestone` | contractor | `milestone` | FUNDED_AND_RESERVED -> IN_PROGRESS, before `start_by` |
| `cancel_milestone` | contractor | `milestone` | before IN_PROGRESS: reservation returns |
| `submit_delivery` | contractor | `milestone`, `units: [id]`, `note`, `documents: [id]` | submission notice; review clock starts (until due + grace) |
| `review_delivery` | client | `milestone`, `accept: [unit]`, `object: [{unit, criterion, reason_code, reason}]` | accepted units paid now; objected units go to the resolver; units left alone are paid at the deadline |
| `resolve_milestone` | resolver | `milestone`, `decisions: [{unit, accept, reason}]` | decides disputed (or non-delivered) units |
| `request_commitment` | contractor | `document`, optional `manual: {vendor, amount, fee, item}` | AI reads the quote; rules decide APPROVE (reserve) / HOLD / BLOCK |
| `retroactive_request` | contractor | `document`, optional `manual` | spent without a commitment: client review, silence rejects |
| `answer_request` | client | `expense`, `approve: bool`, `reason` | HOLD_REVIEW -> RESERVED or REJECTED; RETRO_REVIEW -> SETTLED or REJECTED |
| `cancel_reservation` | contractor | `expense` | RESERVED -> CANCELLED |
| `report_spend` | contractor | `expense` | RESERVED -> SPEND_REPORTED before `expires_at` |
| `submit_receipt` | contractor | `expense`, `document`, `claimed` | submission notice; AI reads the receipt; the HOLD class follows ADR 0005 |
| `supplement_evidence` | contractor | `expense`, `document` | EVIDENCE_DEFECT only: re-read; a clean reading makes it CLIENT_REVIEW; no deadline moves |
| `review_settlement` | client | `expense`, `approve: bool`, `reason` | CLIENT_REVIEW only: approve pays now, objection goes to the resolver |
| `escalate_settlement` | client | `expense`, `reason` | EVIDENCE_DEFECT / INTEGRITY_RISK / AMBIGUITY: send to the resolver now (the client cannot waive it) |
| `resolve_expense` | resolver | `expense`, `accept: bool`, `reason` | DISPUTED: pay the committed payable or reject |
| `draft_change_order` | client, contractor | `text`, optional `covers_excess` | OUT_OF_SCOPE request or an overage -> AI drafts a non-binding change order |
| `edit_change_order` | client, contractor | `change_order`, `draft` | DRAFT only |
| `propose_change_order` | client, contractor | `change_order` | creates the next policy version (PROPOSED) |
| `withdraw_change_order` | client, contractor | `change_order` | DRAFT or PROPOSED |
| `run_timeouts` | any | | apply every due deadline now (the keeper also does this on each request) |

## Deadlines and what silence does

| Clock | Starts | Length (demo policy) | Silence |
|---|---|---|---|
| Milestone start | activation | until `start_by` | EXPIRED_UNUSED, reservation returns |
| Delivery | start | until `due_at` + grace | NON_DELIVERY -> resolver; resolver silence rejects, reservation returns |
| Client review of a delivery | submission | 72 h | claimed units paid (RELEASED_BY_TIMEOUT) |
| Resolver review of a delivery | objection | 7 days | disputed units paid (claims complete, no defect attested) |
| Held request | request | 72 h | EXPIRED (no promise was made) |
| Reservation | reservation | 7 days | EXPIRED unless spend was reported |
| Evidence | spend report | 7 days | EVIDENCE_DEFECT -> resolver |
| Client review of a receipt | receipt | 72 h | CLIENT_REVIEW: settled (RELEASED_BY_TIMEOUT); other classes: escalated (ESCALATED_BY_TIMEOUT) |
| Resolver review of an expense | escalation | 7 days | by class: CLIENT_REVIEW pays, AMBIGUITY pays min(claimed, cap), EVIDENCE_DEFECT and INTEGRITY_RISK reject |
| Retroactive request | request | 72 h | REJECTED |
