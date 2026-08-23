# Card → Crypto Payment Platform

Orchestration layer for card-funded fiat-to-crypto settlement: **Stripe's
fiat-to-crypto onramp** processes the card payment, payer KYC and conversion;
crypto lands in a Binance Entity Account; this platform creates orders, verifies
webhooks and keeps the record.

**Design source:** `transak_zebpay_card_to_crypto_simple_report_updated.md` (the
original report specified Transak; the onramp provider was later swapped for
Stripe — see [`docs/stripe-onramp-migration.md`](docs/stripe-onramp-migration.md))
**Status:** sandbox vertical slice. Not production-ready — see [Not built yet](#not-built-yet).
**Where to start:** [`docs/implementation-status.md`](docs/implementation-status.md) — what
exists, and the prioritised next steps with acceptance criteria.

> **This platform never touches card data, fiat, or private keys.** That boundary
> is the main security property of the design. Preserve it.

---

## Quick start

```bash
pnpm install
cp .env.example .env

# Generate the two PII secrets (see docs/pii-retention-policy.md)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # PII_MASTER_KEK
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # PII_BLIND_INDEX_PEPPER

pnpm db:up          # Postgres 16 on :55432
pnpm db:migrate
pnpm db:seed        # test merchant + approved payout destination

pnpm build
pnpm api:dev        # :3000
pnpm web:dev        # :3001
pnpm smoke          # 33 end-to-end assertions (starts its own Stripe stub)
pnpm check:erasure  # 12 PII erasure assertions
```

`pnpm verify` runs build, lint and both suites.

---

## Layout

```
apps/api                          NestJS + Fastify: orders, webhooks
apps/web                          Next.js storefront + BFF, hosts the onramp widget
packages/shared-types             money, order state machine.  Depends on nothing.
packages/database                 Drizzle schema, migrations, crypto-shredding, erasure
packages/providers/stripe-onramp  session creation, webhook verification, status mapping
docs/pii-retention-policy.md
docs/stripe-onramp-migration.md
scripts/smoke.mjs                 end-to-end guarantees
scripts/stripe-stub.mjs           stand-in for Stripe's onramp API
scripts/erasure-check.mjs         PII erasure guarantees
```

**Module boundaries are lint-enforced** (`eslint.config.mjs`): providers may not
import the database or each other; `shared-types` may import nothing. This is
what made replacing the onramp provider a one-package change rather than a
rewrite. Nx tags can take over later; the rule is what matters, not the tool.

---

## The decisions worth knowing

### Money is never a float
Fiat as integer minor units, crypto as integer base units, `decimals` stored per
asset **per network** (USDT is 6 decimals on Polygon, 18 on BSC — hardcoding it
is a real loss event). Amounts cross the API as decimal strings. `parseFloat` is
banned by lint.

### The webhook is the only source of truth
The onramp widget's own `onramp_session_updated` event is a UI signal. It never
marks an order complete. Only a signature-verified webhook advances state.

Verification handles the three things that actually break in production:
- **raw body** — Fastify parses JSON before the handler, so the HMAC must be
  computed over `req.rawBody`, not a re-serialization;
- **timestamp tolerance** — a valid signature is otherwise replayable forever;
- **constant-time compare** — `===` leaks the signature byte by byte.

Two Stripe specifics on top of that: the `t` in `Stripe-Signature` is in
**seconds**, and the header can carry **several `v1` signatures** while an
endpoint secret is being rolled. Accepting only the first turns every rotation
into an outage. Every scheme that is not `v1` is ignored — honouring `v0` would
be a downgrade attack.

### Deduplication is a database constraint, not application logic
`provider_events` is unique on `(provider, external_event_id)`. Insert first,
process after. A duplicate delivery is a normal, successful no-op.

### Orders move forward only
`RANK` gives every status a monotonic score; a late webhook can never move an
order backwards. Forward *skips* along the happy path are legal because providers
routinely omit intermediate states. Unknown provider statuses and genuinely
illegal transitions escalate to `MANUAL_REVIEW` — never silently applied, never
silently dropped.

### Post-settlement states exist
`DISPUTED` / `CHARGEBACK_RECEIVED` / `REVERSED` rank *above* `COMPLETED`. A card
dispute can land 120+ days after irreversible crypto delivery; an order model
that terminates at `COMPLETED` has nowhere to put it.

### The payout address is the crown jewel
Anyone who changes it redirects all settlement, irreversibly. `payout_destinations`
is an allowlist with maker-checker (DB-level CHECK that approver ≠ proposer) and
a cooling-off period before a destination becomes usable.

`lock_wallet_address=true` on every onramp session is the provider-side half of
that: it pins delivery to the address we pass and stops the payer substituting
their own. The webhook handler then re-checks the address Stripe actually
delivered to against the approved destination, and escalates a mismatch to
`MANUAL_REVIEW` rather than advancing the order — "should be impossible" is not
a control.

### PII is erasable without breaking the audit trail
Per-subject encryption keys; erasure destroys the key, not the row. Financial
records survive intact. Full reasoning in **`docs/pii-retention-policy.md`** —
read it before touching anything that stores customer data.

---

## Not built yet

Ordered by how much it matters:

1. **Reconciliation worker** — poll `GET /v1/crypto/onramp_sessions/:id` for
   non-terminal orders (`retrieveOnrampSession` is already implemented), drain the
   `outbox`, escalate on `DWELL_TIMEOUT_MS`, retry failed `provider_events`.
   The tables and timeouts exist; the worker does not. **Webhooks get lost. This
   is the largest functional gap.**
2. **Chargeback handling** — statuses and ranks exist; ingestion, reserve policy
   and liability allocation do not.
3. **Auth** — no authentication on any endpoint yet. Admin RBAC + 2FA outstanding.
4. **Quote lock** — `quote_id` / `quote_expires_at` exist but nothing sets them.
   Until then the crypto figure shown at checkout is indicative only.
5. Sumsub KYB, Brevo email, Polygon anchoring, `web` / `admin` apps.
6. Unit tests — the two script suites are integration-level; the money and state
   machine modules deserve fast unit coverage.

---

## Before production

**Nothing here should process a real card until these are settled.**

1. **Stripe onramp application approved.** Access is gated even for sandboxes:
   <https://dashboard.stripe.com/crypto-onramp/get-started>. Nothing here has
   been run against Stripe's real onramp API — only against `scripts/stripe-stub.mjs`.
2. **Written confirmation from Stripe and Binance** that payer ≠ beneficiary is
   permitted for a Binance Entity Account, naming the asset, network and
   geographies. This is a binary business risk and it is not an engineering task.
   The report sequences it in Phase 4; it belongs in Phase 0. Stripe is the
   *merchant of record* for onramp transactions and states that it assumes
   liability for fraud and disputes — get the boundary of that in writing too.
3. **Confirm the customer geographies you actually need.** Stripe's embedded
   onramp is available in the EU and the US only, and funds from USD and EUR
   only. Customers outside that footprint cannot pay through this flow at all —
   see [`docs/payment-gateway-2d-cards-sri-lanka.md`](docs/payment-gateway-2d-cards-sri-lanka.md).
4. **KEK moves to a KMS.** Env-var key material is local-dev only.
5. **Legal review** — FIU-IND / PMLA registration, §194S TDS treatment, FEMA
   characterisation of the inbound flow, and data residency. See §8 of the
   retention policy.
6. Secrets management, backups, monitoring, incident runbook.

---

## Notes

- Postgres runs on **55432**, not 5432/5433 — a local install commonly holds
  those and answers instead of the container, producing a confusing auth error.
- `fastify` is pinned via `pnpm.overrides`. Multiple copies in the tree make
  plugin type augmentation fail to compile.
- Never commit `.env`. Never log a decrypted PII value, a webhook secret, or a
  full wallet address.
