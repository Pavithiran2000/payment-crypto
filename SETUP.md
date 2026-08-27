# First-Time Setup — `payment-platform`

Everything you need to go from a fresh `git clone` to a working local checkout flow (API + web, both dev servers, Postgres running, a real order created and tracked).

This monorepo has two runnable apps:

- `apps/api` — NestJS payment gateway (orders, webhooks, MoonPay on-ramp integration) — port **3000**
- `apps/web` — Next.js storefront (BFF routes call the API server-side) — port **3001**

plus shared packages under `packages/*` that both depend on.

---

## 0. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | >= 22.11.0 | `node -v` |
| pnpm | 9.12.0 (pinned via `packageManager`) | `pnpm -v` — if missing: `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Docker Desktop | any recent | `docker --version` — must be **running**, not just installed |
| psql client | any | `psql --version` — only needed for the seed step; comes with any Postgres client install |

Windows note: run these steps from PowerShell or Git Bash. Docker Desktop must be started manually (it does not auto-start) before step 2.

---

## 1. Install dependencies

From the repo root:

```bash
pnpm install
```

This installs and links all workspace packages (`apps/*`, `packages/*`, `packages/providers/*`) in one pass — `apps/web` gets `@pp/shared-types` linked in as a real local package, not a copy.

---

## 2. Start Postgres

```bash
pnpm db:up
```

This runs `docker compose up -d postgres`, which starts a `pp-postgres` container on `localhost:55432` (deliberately not 5432/5433, to avoid colliding with a locally-installed Postgres). Data persists in the `pp-pgdata` Docker volume across restarts.

Verify it's healthy:

```bash
docker ps
# STATUS column should show "healthy" for pp-postgres after ~10-15s
```

If `docker compose` fails immediately, Docker Desktop's engine isn't running — start Docker Desktop and retry.

---

## 3. Configure environment variables

### 3a. API (`payment-platform/.env`)

Copy the template:

```bash
cp .env.example .env
```

Then fill in `.env`:

```dotenv
# --- database ---
DATABASE_URL=postgresql://pp:pp_local_dev@localhost:55432/payment_platform
DB_POOL_MAX=10
DB_SSL=false

# --- PII key material (local dev only — never reuse in production) ---
PII_MASTER_KEK=<generate, see below>
PII_BLIND_INDEX_PEPPER=<generate, see below>

# --- MoonPay fiat-to-crypto on-ramp ---
# THREE DIFFERENT keys, all from https://dashboard.moonpay.com -> Developers.
# All three must be from the same environment or the API refuses to boot.
MOONPAY_PUBLISHABLE_KEY=<pk_test_... public, goes in the widget URL>
MOONPAY_SECRET_KEY=<sk_test_... signs widget URLs; never sent to MoonPay>
MOONPAY_WEBHOOK_KEY=<wk_test_... verifies webhooks; NOT the secret key>
MOONPAY_WIDGET_MODE=embedded
MOONPAY_REQUIRE_IP_MATCH=false
# Local only: `pnpm smoke` runs a stub of MoonPay's API on this port so the
# suite works without MoonPay credentials. Remove it once you have real keys.
MOONPAY_API_BASE_URL=http://127.0.0.1:4599
WEB_BASE_URL=http://localhost:3001

# --- retention ---
AML_RETENTION_DAYS=1825

PORT=3000

# --- API auth ---
PAYMENT_API_KEY=<any long random string>
```

Generate the two PII secrets (each run gives you one value — run it twice):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`PAYMENT_API_KEY` can be any random string — it's a shared secret between `apps/web`'s server-side BFF and `apps/api`; it just has to match what you put in `apps/web/.env.local` in the next step. Generate one the same way if you don't have a preference.

**The three MoonPay keys are not interchangeable**, and the failure mode for
crossing them is silent — `MOONPAY_WEBHOOK_KEY` (`wk_`) verifies webhooks, and
using the secret key there makes every event fail verification with no error
other than 400s in MoonPay's webhook log. Sandbox keys are issued on signup;
production keys are gated on KYB, which takes weeks. Full detail in
[`docs/moonpay-onramp-migration.md`](docs/moonpay-onramp-migration.md).

Until you have keys, leave `MOONPAY_API_BASE_URL` pointing at the local stub
(`scripts/moonpay-stub.mjs`, started automatically by `pnpm smoke`, or run it
yourself with `node scripts/moonpay-stub.mjs`). The stub answers the quote and
transaction-lookup calls so the whole order flow works end to end; only MoonPay's
own payment UI is absent. Once you have real keys, delete `MOONPAY_API_BASE_URL`
— the API refuses that override outright if the keys are live ones.

### 3b. Web (`payment-platform/apps/web/.env.local`)

```bash
cp apps/web/.env.example apps/web/.env.local
```

Fill in `apps/web/.env.local`:

```dotenv
PAYMENT_API_URL=http://localhost:3000
PAYMENT_API_KEY=<same value as apps/api's PAYMENT_API_KEY above>
PAYMENT_MERCHANT_ID=11111111-1111-1111-1111-111111111111
```

`PAYMENT_MERCHANT_ID` must match the merchant seeded in step 5 — use the value above as-is unless you edit `scripts/seed.sql`. None of these three variables are prefixed `NEXT_PUBLIC_`, so they never reach the browser bundle; they're only read inside Next.js Route Handlers.

---

## 4. Run database migrations

```bash
pnpm db:migrate
```

This runs Drizzle migrations against `DATABASE_URL` from `.env`, creating all tables (`merchants`, `orders`, `payout_destinations`, etc.).

---

## 5. Seed local data

```bash
pnpm db:seed
```

This runs `scripts/seed.mjs`, which loads `DATABASE_URL` from `.env` automatically (via `dotenv/config`) and spawns `psql -d <url> -f scripts/seed.sql` directly — no shell variable export needed, and it works the same on Windows/macOS/Linux. It's safe to re-run; the seed data uses `ON CONFLICT DO NOTHING`.

This inserts one pre-approved test merchant (`Acme Test Merchant Pvt Ltd`, id `11111111-1111-1111-1111-111111111111`) and one pre-approved payout destination (USDT on Polygon, settling to a Binance Entity Account address). The storefront is currently wired to offer only this one crypto/network combination — see `apps/web/src/lib/payment-config.ts` — because it's the only payout destination that exists.

---

## 6. Start both apps

Two terminals, both from the repo root:

```bash
# terminal 1
pnpm api:dev
```

```bash
# terminal 2
pnpm web:dev
```

- API: http://localhost:3000
- Web: http://localhost:3001

---

## 7. Walk through a real checkout

1. Open http://localhost:3001/products, pick a product, set a price/quantity/currency.
2. Continue to checkout, fill in the contact/billing form, submit.
3. `apps/web`'s `/api/checkout` Route Handler validates the input, recomputes the total server-side, and calls `POST /orders` on the API with the `X-API-Key` header. The API takes a MoonPay buy quote, persists the order, and returns `/checkout/onramp/<reference>`.
4. That page builds a **signed MoonPay widget URL** server-side — pinned to the merchant's approved wallet address, with the amount and asset locked, and bound to the payer's IP — and frames it. The customer's card details and identity documents go to MoonPay, never to this site.
5. `redirectURL` returns the customer to `/orders/<reference>`, which polls `GET /api/orders/<reference>` every 4 seconds until the order reaches a terminal state (`COMPLETED`, `PAYMENT_FAILED`, …) — driven entirely by MoonPay's signed webhook hitting `POST /webhooks/moonpay`, never by the browser.

Against the stub, step 4 builds a URL against the real sandbox widget, but the
publishable key is a placeholder, so the frame shows an error instead of a payment
form. Everything either side of it — order creation, the quote, URL signing,
webhook verification, state transitions — is exercised in full.

Try the same walk through the **donation** flow at http://localhost:3001/donate.
It is the identical rail: same quote, same signed URL, same webhook, same state
machine.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `pnpm db:migrate` hangs / `ECONNREFUSED` on 55432 | Docker Desktop isn't running, or `pnpm db:up` never completed — run `docker ps` to confirm `pp-postgres` is `healthy` |
| `pnpm db:seed` errors with "DATABASE_URL is not set" | No `.env` at the repo root, or it's missing the `DATABASE_URL` line — see step 3a |
| `pnpm db:seed` errors "psql was not found on PATH" | Install the PostgreSQL client tools (`psql`) and ensure they're on PATH |
| API starts but immediately throws a config error | A required env var in `apps/api/.env` (`.env` at repo root) is missing — check against `.env.example`, especially `PAYMENT_API_KEY`, `PII_MASTER_KEK`, `PII_BLIND_INDEX_PEPPER` |
| Web's `/api/checkout` returns 401 from the API | `PAYMENT_API_KEY` differs between `.env` (api) and `apps/web/.env.local` (web) — they must match exactly |
| API refuses to boot: "keys are from different environments" | A mixed set, e.g. `pk_live_` with `wk_test_`. Take all three from the same MoonPay dashboard environment |
| `POST /api/checkout` returns an amount error | MoonPay enforces a per-currency minimum (20 USD/EUR/GBP, 35 AUD, 7000 LKR). Its message is passed through verbatim |
| Order creation fails with a connection error | `MOONPAY_API_BASE_URL` points at the stub but the stub is not running — start it with `node scripts/moonpay-stub.mjs`, or remove the variable to use the real API |
| Payment page loads but the widget shows an error | Expected against the stub: the placeholder publishable key is not one MoonPay knows. Needs real sandbox credentials |
| Order status page never leaves "Processing" | MoonPay webhooks need a publicly reachable HTTPS URL — on localhost you will not receive them. Tunnel with `cloudflared tunnel --url http://localhost:3000` and register `https://…/webhooks/moonpay` in the dashboard |
| Webhook returns 400 "signature verification failed" | Almost always the **wrong key**: verification uses `MOONPAY_WEBHOOK_KEY` (`wk_`), not `MOONPAY_SECRET_KEY` (`sk_`). They are not interchangeable |
| Widget shows "Unverified Connection" | `allowedIpAddress` does not match the IP MoonPay observes — your proxy is not setting `X-Forwarded-For`. Only relevant when IP matching is on (always, in live) |
| Sandbox transaction fails at delivery | `usdc_polygon` has no sandbox testnet liquidity. Rehearse on USDC (Ethereum) — see §4.2 of the migration runbook |
| `pnpm install` fails on Windows with symlink errors | Run your shell as Administrator, or enable Windows Developer Mode (Settings → Privacy & Security → For developers) |

---

## Everyday commands (after first-time setup)

```bash
pnpm db:up        # start Postgres (if stopped)
pnpm api:dev       # run the API
pnpm web:dev       # run the web app
pnpm build         # build all packages
pnpm typecheck     # typecheck all packages
pnpm lint          # lint all packages
pnpm db:down       # stop Postgres (data persists in the Docker volume)
```
