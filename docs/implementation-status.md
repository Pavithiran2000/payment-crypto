# Implementation Status & Next Steps

**Date:** 2026-07-31, revised 2026-08-23 (on-ramp provider swapped to MoonPay)
**Phase:** sandbox vertical slice complete
**Design source:** `transak_zebpay_card_to_crypto_simple_report_updated.md`
**Provider change:** [`moonpay-onramp-migration.md`](moonpay-onramp-migration.md) —
the original report specified Transak; the on-ramp leg now runs on MoonPay. That
document carries the credentials, the step-by-step setup and every
provider-specific decision. Read it first if anything below reads as stale.

Part 1 records what exists and why. Part 2 is the work queue, in priority order,
with enough detail to pick up cold.

---

# Part 1 — What Was Implemented

## 1.1 Scope

One working vertical slice:

```
create order → MoonPay buy quote → signed widget URL → framed widget → verified webhook → state transition → record
```

29 source files. Everything below was executed against a live Postgres, not just
written.

| Check | Command | Result |
|---|---|---|
| Build (all packages) | `pnpm build` | clean |
| Lint + module boundaries | `pnpm lint` | clean |
| End-to-end guarantees | `pnpm smoke` | **63 / 63** |
| PII erasure guarantees | `pnpm check:erasure` | **17 / 17** |

`pnpm verify` runs all four.

## 1.2 Layout

```
apps/api/                       NestJS 11 + Fastify 5
  src/config.ts                 fail-fast env validation at boot
  src/orders/                   creation, idempotency, checkout URL
  src/webhooks/                 verification, dedupe, state transitions

packages/shared-types/          depends on nothing (lint-enforced)
  src/money.ts                  integer money, no floats
  src/order-status.ts           statuses, ranks, transition rules, dwell timeouts

packages/database/
  src/schema.ts                 7 tables
  src/crypto-shred.ts           envelope encryption, blind index
  src/erasure.ts                erasure + retention sweep + legal hold
  src/migrate.ts                migration runner
  migrations/0000_*.sql         generated, reviewable

packages/providers/moonpay/
  src/config.ts                 credential validation, environment derivation
  src/mapping.ts                currency/network/status/stage translation
  src/widget.ts                 signed widget URLs, payer-IP hashing
  src/api.ts                    buy quote + transaction lookup
  src/webhook.ts                signature verification, event id derivation

scripts/smoke.mjs               63 end-to-end assertions
scripts/erasure-check.mjs       17 erasure assertions
scripts/seed.sql                test merchant + approved destination
docs/pii-retention-policy.md    the PII/AML resolution
```

## 1.3 Database

Seven tables, migrated and live:

| Table | Purpose |
|---|---|
| `orders` | the order + money + status. Unique on `(merchant_id, idempotency_key)` |
| `order_status_history` | append-only: what we believed, when, on which event |
| `provider_events` | inbound webhook ledger. **Unique on `(provider, external_event_id)`** |
| `outbox` | transactional outbox for emails / merchant webhooks / chain anchors |
| `data_subjects` | the erasure unit — holds the wrapped key, no PII |
| `payout_destinations` | allowlist with maker-checker + cooling-off |
| `merchants` | Sumsub applicant reference + KYB verdict only |

Constraints verified present in the generated SQL:

```sql
CONSTRAINT "approver_differs_from_proposer" CHECK (approved_by IS NULL OR approved_by <> proposed_by)
CONSTRAINT "erased_implies_no_dek"          CHECK ((erased_at IS NULL) = (dek_wrapped IS NOT NULL))
CONSTRAINT "fiat_amount_positive"           CHECK (fiat_amount > 0)
CREATE UNIQUE INDEX "provider_events_unique"      ON provider_events (provider, external_event_id);
CREATE UNIQUE INDEX "orders_idempotency_unique"   ON orders (merchant_id, idempotency_key);
CREATE UNIQUE INDEX "orders_provider_order_unique" ON orders (provider_order_id) WHERE provider_order_id IS NOT NULL;
```

## 1.4 Decisions made, and why

### Money is never a float
Fiat as integer minor units; crypto as integer base units; `decimals` stored per
asset **per network**. USDT is 6 decimals on Polygon and 18 on BSC — hardcoding it
is a real loss event. Amounts cross the API as decimal strings. `parseFloat` is
banned by lint rule.

### The webhook is the only source of truth
The browser's return from hosted checkout is a navigation event and never marks an
order complete. Verification handles the three things that actually break:

- **raw body** — Fastify parses JSON before the handler runs, so the HMAC is
  computed over `req.rawBody`; re-serialized JSON produces different bytes and
  never matches. App is created with `{ rawBody: true }`.
- **timestamp tolerance** — otherwise a valid signature is replayable forever.
- **constant-time compare** — `===` leaks a signature byte by byte.

Three MoonPay specifics on top of the general rules. Verification uses the
**webhook key** (`wk_...`), a different secret from the secret API key — crossing
them fails every check with no visible error. Only `Moonpay-Signature-V2` is
honoured; the legacy header is keyed differently and accepting it would be a
downgrade. And the tolerance is **one hour, not five minutes**: MoonPay retries
nine times with exponential backoff and does not document whether retries are
re-signed, so a short window risks rejecting legitimate retries forever. Replay is
really prevented by the dedupe constraint below; see §3.4 of the migration runbook.

**MoonPay events carry no event id.** The dedupe key is synthesised from `type` +
transaction `id` + `updatedAt`, which is MoonPay's own documented guidance.

### Deduplication is a database constraint
`provider_events` unique on `(provider, external_event_id)`. Insert first, process
after. A duplicate delivery is a normal, successful no-op. Never dedupe in
application logic.

### Orders move forward only
`RANK` gives each status a monotonic score; a late webhook can never move an order
backwards. Forward *skips* along the happy path are legal — providers routinely
omit intermediate states. Unknown statuses and genuinely illegal transitions go to
`MANUAL_REVIEW`; nothing is silently applied or silently dropped.

> **This was a real bug the smoke test caught.** The first version used a strict
> adjacency list, so `CREATED → PAYMENT_PENDING` was rejected as illegal and the
> first webhook dumped every order into `MANUAL_REVIEW`. Fixed to permit forward
> skips.

### Post-settlement states exist
`DISPUTED` / `CHARGEBACK_RECEIVED` / `REVERSED` rank **above** `COMPLETED`. A card
dispute can land 120+ days after irreversible crypto delivery; a model that
terminates at `COMPLETED` has nowhere to put it.

### The payout address is the crown jewel
Anyone who changes it redirects all settlement, irreversibly. `payout_destinations`
is an allowlist with DB-level maker-checker and a cooling-off period.
`disableWalletAddressForm=true` on the checkout URL stops the payer editing the
destination — without it a customer could redirect their own purchase.

### PII is erasable without breaking the audit trail
Per-subject AES-256 keys; erasure destroys the key, not the row. Full reasoning in
`docs/pii-retention-policy.md`.

## 1.5 Environment notes

- Postgres runs on **55432**. Not 5432/5433 — a local install commonly holds those
  and answers instead of the container, producing a confusing auth failure.
- `fastify` is pinned via `pnpm.overrides`. Multiple copies in the tree make plugin
  type augmentation fail to compile.
- pnpm workspaces, not Nx. For one app Nx is overhead; `nx init` drops in later and
  boundaries are lint-enforced meanwhile (verified: a provider importing
  `@pp/database` fails lint).
- Node 22 here; the report specified 24. Both LTS, no change needed. `tsx` runs
  TypeScript in dev because Node 22's type-stripping does not rewrite `.js`
  specifiers to `.ts`.

---

# Part 2 — What To Do Next

Ordered by consequence. **Step 0 runs in parallel with everything and is not an
engineering task.**

---

## Step 0 — Provider approval (start now, blocks production)

**Why first:** this is a binary business risk. Standard on-ramp terms assume
delivery to the KYC'd payer's *own* wallet. Payer ≠ beneficiary to a corporate
exchange account is exactly what AML controls flag. If MoonPay says no, most of
the roadmap below is wasted. The original report sequences this in Phase 4 — that
is backwards.

MoonPay's own gate is **KYB**, which takes weeks and blocks live keys. Sandbox
keys are self-serve and issued on signup, so building can start immediately — but
sandbox access answers **none** of the questions below. It tells you nothing about
whether the model is permitted in production.

**Get answers in writing, from both MoonPay and Binance:**

- [ ] May the payer and the receiving wallet owner be different parties?
- [ ] May the beneficiary be a corporate entity holding a Binance Entity Account?
- [ ] Which payer geographies are supported for this pattern?
- [ ] Which asset and network, exactly?
- [ ] Per-transaction and monthly limits for a corporate beneficiary?
- [ ] **Who bears chargeback liability?** ← the one with real money attached
- [ ] What sender/beneficiary information must accompany each transfer (Travel Rule)?

**Also confirm the settlement asset** while you have their attention. MoonPay
lists both `usdc_polygon` and `usdt_polygon` as live; the storefront defaults to
USDC/Polygon because Polygon's fee is a fraction of Ethereum's and USDC has the
wider geographic availability. Note `usdc_polygon` is unavailable in Canada and
restricted in the US Virgin Islands; `usdt_polygon` adds New York.

**And ask whether webhook retries are re-signed with a fresh timestamp.** It is
the one open question in the verification path — see §3.4 of the migration
runbook. The full question list is §8 of that document.

**Done when:** written confirmation on file naming the entity, asset, network and
geographies. Record it in `docs/provider-approval.md`.

---

## Step 1 — Reconciliation worker  ⭐ highest engineering priority

**Why:** webhooks get lost, delayed and misrouted. In production payments,
reconciliation catches more real problems than the webhook handler does. Every
table it needs already exists; the worker does not. **This is the largest
functional gap in the system.**

### Build

Create `apps/worker/` as a second entrypoint sharing the same packages.

Four jobs, all idempotent, all safe to run concurrently:

| Job | Interval | Behaviour |
|---|---|---|
| `pollStalledOrders` | 5 min | For orders non-terminal past `DWELL_TIMEOUT_MS[status]`, call `retrieveOnrampSession(cfg, order.providerOrderId)` — already implemented — and apply the result through the *same* transition path as a webhook. `parseOnrampEvent()` accepts a bare session object precisely so this path produces the same shape as the webhook path. |
| `retryFailedEvents` | 2 min | `provider_events WHERE processed_at IS NULL AND attempts < 10` — re-drive `WebhooksService.process()`. Exponential backoff on `attempts`. |
| `drainOutbox` | 30 s | `outbox WHERE published_at IS NULL AND available_at <= now()` — dispatch, set `published_at`. Backoff and dead-letter after N attempts. |
| `sweepRetention` | daily | `sweepExpiredSubjects()` — already implemented in `packages/database/src/erasure.ts`. |

### Critical implementation notes

**Claim rows with `FOR UPDATE SKIP LOCKED`** so multiple worker instances never
process the same row:

```ts
const batch = await tx
  .select()
  .from(outbox)
  .where(and(isNull(outbox.publishedAt), lte(outbox.availableAt, sql`now()`)))
  .orderBy(outbox.availableAt)
  .limit(50)
  .for('update', { skipLocked: true });
```

**Reuse `WebhooksService.process()`** for polled results. Do not write a second
transition path — two paths diverge and one of them will be wrong.

**Alert, don't just log,** when an order sits in `MANUAL_REVIEW` or when
`drainOutbox` dead-letters. Silent stalls are how money goes missing.

### Acceptance criteria

- [ ] An order stuck in `PAYMENT_PENDING` past its dwell timeout is polled and either advanced or escalated to `MANUAL_REVIEW`.
- [ ] A webhook whose processing threw is retried and succeeds.
- [ ] Two worker instances running simultaneously never double-dispatch an outbox row.
- [ ] `sweepRetention` erases a subject whose `retention_until` has passed and skips one under `legal_hold`.
- [ ] Extend `scripts/smoke.mjs`: create an order, apply *no* webhook, run the poller, assert escalation.

---

## Step 2 — Authentication and authorisation

**Why:** no endpoint is authenticated today. This blocks deploying anywhere
reachable — including a demo URL.

### Build

- **Merchant API keys** for `POST /orders`. Store `sha256(key)`, never the key.
  Prefix keys (`pk_live_`, `pk_test_`) so leaked keys are greppable in logs.
- **Admin auth** — session or JWT, **2FA mandatory** (TOTP), for the future admin app.
- **RBAC** — at minimum `admin`, `operator`, `viewer`. Only `operator`+ may resolve
  `MANUAL_REVIEW`.
- **Maker-checker enforcement in the service layer** for `payout_destinations`.
  The DB CHECK stops proposer == approver; the service must also enforce that both
  are authenticated admins and that `active_from` respects the cooling-off period.
- **Per-merchant rate limit** on `POST /orders`, tighter than the global 100/min —
  the endpoint is otherwise usable for card testing and enumeration.
- **Audit log** for every admin action: who, what, when, from where.

### Acceptance criteria

- [ ] `POST /orders` without a valid key returns 401.
- [ ] A merchant cannot read another merchant's order by reference.
- [ ] Approving a payout destination as its proposer is rejected.
- [ ] A destination is unusable before `active_from`.
- [ ] Admin login without 2FA is refused.

> **Leave `/webhooks/moonpay` unauthenticated.** It is authenticated by signature.
> Do not put an API-key check in front of it.

---

## Step 3 — Chargeback handling

**Why:** the card leg is reversible for 120+ days; the crypto leg is irreversible
the moment it settles. Statuses and ranks exist; ingestion and policy do not.
Step 0's liability answer determines how much of this you need.

### Build

- `chargebacks` table: provider reference, reason code, amount, received/due dates,
  evidence-submitted timestamp, outcome.
- Ingest dispute webhooks → `DISPUTED` → `CHARGEBACK_RECEIVED` → `REVERSED`.
- **Set `legal_hold = true` on the data subject automatically** when an order
  enters any of those states — erasure must not destroy evidence mid-dispute.
- If liability lands on you: a rolling reserve per merchant, plus a delivery-delay
  window for high-risk orders (new merchant, large amount, mismatched geography).
- Operator UI to attach evidence.

### Acceptance criteria

- [ ] A dispute on a `COMPLETED` order transitions it forward, never backward.
- [ ] Erasure is refused with `legal-hold` while a dispute is open.
- [ ] Reserve balance is visible per merchant and reconciles against settled orders.

---

## Step 4 — Quote lock

**Why:** `crypto_amount_quoted` and `quote_expires_at` are now populated from
MoonPay's buy quote at order creation, but nothing *enforces* the expiry. Until it
does, the crypto figure shown at checkout is indicative only — and the gap between
quote and delivery is a dispute waiting to happen.

### Build

- **Done:** `GET /v3/currencies/{code}/buy_quote` at order creation, persisting
  `crypto_amount_quoted` and `quote_expires_at`. MoonPay returns no quote id, so
  `quote_id` stays NULL — a locked quote needs MoonPay's Platform API.
- Reject checkout on an expired quote; require re-quote.
- **Surface the fee breakdown.** MoonPay's quote response carries `feeAmount`,
  `networkFeeAmount`, `extraFeeAmount` and `totalAmount` separately — the split is
  what the customer will ask about, so show it rather than only the net. The
  provider already parses all four; nothing renders them yet.
- On settlement, store `crypto_amount_settled` and record the delta.

### Acceptance criteria

- [ ] Opening checkout on an expired quote is refused with a clear error.
- [ ] Quoted vs settled amounts are both persisted and the delta is queryable.
- [ ] The checkout page states the quote is indicative until payment confirms.

---

## Step 5 — Supporting integrations

Independent of each other; sequence to taste.

### 5a. Sumsub merchant KYB
Applicant creation, webhook for verdicts, `merchants.kyb_status` transitions.
**Store the applicant ID and verdict only — never the documents.** That boundary
is what keeps Tier-2 data out of your database.

### 5b. Brevo transactional email
Driven entirely by the `outbox` — never send inline from a request handler.
Templates: payment initiated / confirmed / failed, crypto sent, receipt, delayed.
**Never email KYC documents, card data, API keys or full wallet addresses.**

### 5c. Polygon audit anchoring
Lowest value of the three; do it last.

- Hash **Tier-0 fields only**. Hashing a record containing an email puts an
  unerasable commitment to personal data on a public chain — see §7 of the
  retention policy. Add a test that fails if any Tier-1+ column reaches the
  anchoring function.
- Unaddressed operational load: a hot key for gas on your server (the one key you
  said you would never hold), nonce management under concurrency, RPC failure,
  chain reorgs, MATIC balance monitoring.
- **Design the record format for batching now**, even if you anchor singly at
  first. Retrofitting Merkle batching changes the schema and the verification tool.

---

## Step 6 — Test coverage

The two script suites are integration-level and need a database. Add fast unit
tests (Vitest) for the pure logic:

- [ ] `money.ts` — `parseDecimal` rejects floats, exponents and excess precision; round-trips exactly; rejects negative fiat.
- [ ] `order-status.ts` — every entry in `ALLOWED` is reachable; no transition escapes `RANK`; forward skips legal, backward moves never.
- [ ] `webhook.ts` — signature mismatch, expired timestamp, `alg` confusion (`alg:none` must be rejected), malformed JWS.
- [ ] `crypto-shred.ts` — encrypt/decrypt round-trip; wrong DEK fails; blind index is stable and case-insensitive.

Then wire CI: `pnpm verify` on every PR, with Postgres as a service container.

---

## Step 7 — Frontend

`apps/web` (Next.js checkout + merchant dashboard) and `apps/admin`.

The one rule that matters: **the success page must not mark the order complete.**
It polls `GET /orders/:reference` and renders whatever the webhook-driven record
says. Show `PENDING` honestly rather than optimistically showing success.

---

## Before any live payment

Independent of the roadmap above:

1. Written provider approval on file (Step 0).
2. Live webhook signing scheme confirmed; unused branch deleted.
3. **KEK moved to a KMS.** Env-var key material is local-dev only.
4. Legal review: FIU-IND / PMLA registration, §194S TDS treatment, FEMA
   characterisation of the inbound flow, data residency. See §8 of the retention
   policy.
5. Secrets manager, automated backups with a tested restore, error monitoring,
   incident runbook.
6. Start with one merchant, one currency, one asset, one network, low amounts,
   manual review on every transaction.

---

## Suggested order

```
Step 0  ──────────────────────────────────────────►  (parallel, starts today)

Step 1 (reconciliation)  →  Step 2 (auth)  →  Step 4 (quote lock)  →  Step 3 (chargebacks)
                                                                            │
                                        Step 6 (unit tests + CI) ───────────┤
                                                                            ▼
                                                        Step 5 (Sumsub / Brevo / Polygon)
                                                                            │
                                                                            ▼
                                                                    Step 7 (frontend)
```

Step 1 first because it is the largest correctness gap and everything it needs is
already in place. Step 2 next because it blocks deploying anywhere reachable.

Chargebacks (Step 3) may jump ahead of quote lock depending on what Step 0 says
about liability.
