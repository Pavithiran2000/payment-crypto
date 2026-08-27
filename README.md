# Card → Crypto Payment Platform

Orchestration layer for card-funded fiat-to-crypto settlement: **MoonPay's
on-ramp** processes the card payment, payer KYC and conversion; crypto lands in a
Binance Entity Account; this platform creates orders, verifies webhooks and keeps
the record.

**Design source:** `transak_zebpay_card_to_crypto_simple_report_updated.md` (the
original report specified Transak; the on-ramp provider is now MoonPay — see
[`docs/moonpay-onramp-migration.md`](docs/moonpay-onramp-migration.md) for the
credentials, the step-by-step setup and every provider-specific decision)
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
pnpm smoke          # 63 end-to-end assertions (starts its own MoonPay stub)
pnpm check:erasure  # 17 PII erasure assertions
```

`pnpm verify` runs build, lint and both suites.

---

## Layout

```
apps/api                          NestJS + Fastify: orders, webhooks
apps/web                          Next.js storefront + BFF, frames the on-ramp widget, donations
packages/shared-types             money, order state machine.  Depends on nothing.
packages/database                 Drizzle schema, migrations, crypto-shredding, erasure
packages/providers/moonpay        signed widget URLs, quotes, webhook verification, mapping
docs/moonpay-onramp-migration.md  credentials + step-by-step runbook.  Start here.
docs/pii-retention-policy.md
scripts/smoke.mjs                 end-to-end guarantees
scripts/moonpay-stub.mjs          stand-in for MoonPay's REST API
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
The customer's return from MoonPay is a navigation event. It never marks an order
complete. Only a signature-verified webhook advances state.

Verification handles the three things that actually break in production:
- **raw body** — Fastify parses JSON before the handler, so the HMAC must be
  computed over `req.rawBody`, not a re-serialization;
- **timestamp tolerance** — a valid signature is otherwise replayable forever;
- **constant-time compare** — `===` leaks the signature byte by byte.

Three MoonPay specifics on top of that: verification uses the **webhook key**
(`wk_...`), not the secret API key — crossing them fails every check silently;
only `Moonpay-Signature-V2` is honoured, because the legacy header is keyed
differently and accepting it would be a downgrade; and the replay window is an
hour rather than five minutes, because MoonPay does not document whether its nine
backoff retries are re-signed. Replay is really prevented by the dedupe
constraint below. See §3.4 of the migration runbook.

**MoonPay events carry no event id.** The dedupe key is synthesised from
`type` + transaction `id` + `updatedAt`, which is MoonPay's own guidance.

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

**URL signing is the provider-side half of that.** MoonPay takes the deposit
address in a query parameter, so the query string is the security boundary: every
widget URL is HMAC-signed with the secret key, and MoonPay refuses to load a URL
carrying `walletAddress` without a valid signature. That, plus `lockAmount` and a
pinned `currencyCode`, is what stops a payer editing our address — or the amount,
or the asset — out of the URL bar. Signed URLs are also bound to a hash of the
payer's IP and are never stored, only rebuilt per request.

The webhook handler then re-checks the address MoonPay actually delivered to
against the approved destination, and escalates a mismatch to `MANUAL_REVIEW`
rather than advancing the order — "should be impossible" is not a control.

### PII is erasable without breaking the audit trail
Per-subject encryption keys; erasure destroys the key, not the row. Financial
records survive intact. Full reasoning in **`docs/pii-retention-policy.md`** —
read it before touching anything that stores customer data.

---

## Not built yet

Ordered by how much it matters:

1. **Reconciliation worker** — poll `GET /v1/transactions/ext/:reference` for
   non-terminal orders (`fetchTransactionByExternalId` is already implemented),
   drain the `outbox`, escalate on `DWELL_TIMEOUT_MS`, retry failed
   `provider_events`. The tables and timeouts exist; the worker does not.
   **Webhooks get lost. This is the largest functional gap.**
2. **Chargeback handling** — statuses and ranks exist; ingestion, reserve policy
   and liability allocation do not.
3. **Auth** — `/orders*` is behind `ApiKeyGuard`, but that is a single shared
   secret between `apps/web` and `apps/api`, not a multi-tenant model. Per-merchant
   keys, admin RBAC and 2FA are all outstanding.
4. **Quote lock** — `crypto_amount_quoted` and `quote_expires_at` are now
   populated from MoonPay's buy quote at order creation, but nothing *enforces*
   the expiry: checkout on a stale quote is not yet refused, and the figure
   remains indicative until MoonPay re-quotes inside the widget.
5. Sumsub KYB, Brevo email, Polygon anchoring, `web` / `admin` apps.
6. Unit tests — the two script suites are integration-level; the money and state
   machine modules deserve fast unit coverage.

---

## Before production

**Nothing here should process a real card until these are settled.**

1. **MoonPay KYB approved and live keys issued.** Sandbox keys are self-serve;
   production keys are gated on business verification and take weeks. Nothing
   here has been run against MoonPay's real API — only against
   `scripts/moonpay-stub.mjs`.
2. **Written confirmation from MoonPay and Binance** that payer ≠ beneficiary is
   permitted for a Binance Entity Account, naming the asset, network and
   geographies. This is a binary business risk and it is not an engineering task.
   The report sequences it in Phase 4; it belongs in Phase 0. **Get the
   chargeback-liability boundary in writing** — it is the question with real money
   attached. Full list in §8 of the migration runbook.
3. **Confirm the customer geographies you actually need.** MoonPay's footprint is
   far wider than the previous provider's — this platform now offers USD, EUR,
   GBP, AUD and LKR — but `usdc_polygon` is unavailable in Canada and restricted
   in some US states. See
   [`docs/payment-gateway-2d-cards-sri-lanka.md`](docs/payment-gateway-2d-cards-sri-lanka.md).
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
