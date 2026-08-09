# Getting Started — Setup, Credentials & Sandbox Testing

A beginner-friendly walkthrough for running `payment-platform` locally and testing it end to
end. Written assuming you have never run this project before.

---

## 1. What this application is (30 seconds)

Two apps talk to each other:

- **`apps/api`** (NestJS, port `3000`) — the payment gateway. Creates orders, builds a Transak
  checkout link, and listens for Transak's signed webhook to know when a payment actually happened.
- **`apps/web`** (Next.js, port `3001`) — the storefront. Its server-side code (never the browser)
  calls `apps/api` to create orders and check status.

Both share one Postgres database.

---

## 2. Prerequisites (install once)

| Tool | Version needed | Check with |
|---|---|---|
| Node.js | ≥ 22.11.0 | `node -v` |
| pnpm | 9.x | `pnpm -v` |
| PostgreSQL (server + `psql` client) | any recent version, reachable on a port you choose | `psql --version` |

This repo is already configured to use a **local Postgres install** (not Docker). If you don't
have Postgres yet, install "PostgreSQL" for your OS and note the port it listens on and the
password you set for the `postgres` superuser during install.

---

## 3. Credentials & secrets you need to gather

Nothing here talks to real money. Everything below is either generated locally or a **free
Transak sandbox/staging** credential — there is no cost and no live financial risk.

### 3.1 Database credentials (yours — you already set these)

Whatever you chose when installing Postgres locally:

| Variable | Example used in this repo | Where it's used |
|---|---|---|
| DB user | `postgres` | `.env` → `DATABASE_URL` |
| DB password | `pavi1234` | `.env` → `DATABASE_URL` |
| DB host | `localhost` | `.env` → `DATABASE_URL` |
| DB port | `5433` | `.env` → `DATABASE_URL` |
| DB name | `payment_platform` | created manually, see step 5.2 |

> If your local Postgres runs on the default port `5432`, use `5432` instead of `5433` — just
> keep `DATABASE_URL` in `.env` consistent with whatever your server is actually listening on.

### 3.2 Transak sandbox API credentials (free signup, no real money)

Transak is the card→crypto provider. To exercise the **real** hosted checkout flow (optional —
the automated smoke test below does **not** need this), sign up for a free sandbox account:

1. Go to Transak's partner/developer dashboard and register for a **Staging** (sandbox)
   account — this is a standard developer signup, not a live merchant account.
2. Once approved, the dashboard gives you:
   - **API Key** → `TRANSAK_API_KEY`
   - **API Secret** → `TRANSAK_API_SECRET` (also used to verify/sign webhooks)
3. You do **not** need a real card or real crypto wallet — Transak's staging environment uses
   test cards and test KYC.

If you only want to run the automated tests (`pnpm smoke`), you can leave
`TRANSAK_API_KEY`/`TRANSAK_API_SECRET` as the placeholder dummy values already in `.env` — the
smoke test signs its own fake webhooks using whatever secret is in `.env`, so it works without a
real Transak account. You only need real Transak credentials to click through an actual hosted
checkout page in a browser.

### 3.3 Secrets you generate yourself (no signup needed)

Two secrets protect customer PII at rest. Generate them once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → PII_MASTER_KEK
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → PII_BLIND_INDEX_PEPPER
```

Run it twice (or twice in a row) to get two **different** values — one for each variable. These
already have working local values pre-filled in `.env`, so this step is only needed if you want
fresh ones or are setting up `.env` from scratch.

### 3.4 The internal API key (you choose this — not from any external service)

`PAYMENT_API_KEY` is a shared secret **you invent**, used only between `apps/web` and `apps/api`
on your own machine (it authenticates the storefront's backend to the gateway's backend — the
browser never sees it). Any random string works for local dev; `.env` already has
`local_dev_api_key_change_me` filled in, and `apps/web/.env.local` must contain the **exact same
value**.

---

## 4. Where each credential goes

Two separate env files, because these are two separate apps in the same monorepo:

### `F:\payment-full\payment-platform\.env` (the gateway, `apps/api`)

```ini
DATABASE_URL=postgresql://postgres:pavi1234@localhost:5433/payment_platform
DB_POOL_MAX=10
DB_SSL=false

PII_MASTER_KEK=<generated in 3.3>
PII_BLIND_INDEX_PEPPER=<generated in 3.3>

TRANSAK_ENV=staging
TRANSAK_API_KEY=<from 3.2, or leave dummy value for smoke-test-only>
TRANSAK_API_SECRET=<from 3.2, or leave dummy value for smoke-test-only>
TRANSAK_REDIRECT_URL=http://localhost:3001/checkout/return
TRANSAK_WEBHOOK_SCHEME=hmac-header

AML_RETENTION_DAYS=1825
PORT=3000

PAYMENT_API_KEY=<your invented shared secret, from 3.4>
```

### `F:\payment-full\payment-platform\apps\web\.env.local` (the storefront, `apps/web`)

```ini
PAYMENT_API_URL=http://localhost:3000
PAYMENT_API_KEY=<MUST match .env's PAYMENT_API_KEY exactly>
PAYMENT_MERCHANT_ID=11111111-1111-1111-1111-111111111111
```

`PAYMENT_MERCHANT_ID` is not a real credential — it's the ID of the test merchant the seed
script inserts (see step 5.3). Leave it exactly as shown; it must match the seeded row.

Both files already exist in the repo with working local-dev defaults — you're mainly checking
they match your own Postgres password/port.

---

## 5. Step-by-step: run it locally

Open a terminal at `F:\payment-full\payment-platform`.

### 5.1 Install dependencies

```bash
pnpm install
```

### 5.2 Create the database (one-time)

Connect with `psql` (adjust host/port/user to yours) and create an empty database:

```bash
psql -h localhost -p 5433 -U postgres -c "CREATE DATABASE payment_platform;"
```

It will prompt for the `postgres` user's password (`pavi1234` in this repo's example).

### 5.3 Run migrations and seed test data

```bash
pnpm db:migrate     # creates all tables
pnpm db:seed        # inserts one test merchant + one approved payout destination
```

`db:seed` inserts:
- Merchant `11111111-1111-1111-1111-111111111111` ("Acme Test Merchant Pvt Ltd")
- An approved USDT/Polygon payout destination pointing at a dummy address
  (`0x1111...1111`) — this is what the storefront's "USDT (Polygon)" option settles to.

### 5.4 Build once, to catch any config problems early

```bash
pnpm build
```

### 5.5 Start both apps (two terminals)

```bash
# Terminal 1
pnpm api:dev      # http://localhost:3000

# Terminal 2
pnpm web:dev      # http://localhost:3001
```

Leave both running for the rest of this guide.

---

## 6. Testing — two levels

### 6.1 Automated smoke test (no browser, no real Transak account needed)

With `apps/api` running (Terminal 1 above), in a third terminal:

```bash
pnpm smoke
```

This exercises 15 real guarantees against the running API: order creation, idempotency (same
key → same order, no duplicate), webhook signature verification (valid vs. tampered vs. expired
timestamp), duplicate webhook delivery (safe no-op), out-of-order/backwards transitions (rejected),
and the full happy-path status progression — all using self-signed fake webhooks, so it needs
nothing from Transak's actual servers.

Also worth running:

```bash
pnpm check:erasure   # 12 assertions that customer PII can be erased without corrupting orders
pnpm verify           # build + lint + smoke + check:erasure, all in one
```

All should print `PASS` for every line; a `FAIL` points at exactly what broke.

### 6.2 Manual walkthrough in a browser (exercises the real storefront UI)

With both `pnpm api:dev` and `pnpm web:dev` running:

1. Open `http://localhost:3001`.
2. Browse to a product, enter your own quote price and quantity (this storefront is
   custom-quote — there's no fixed catalog price).
3. Proceed to checkout, fill in contact/billing details, and select **USDT (Polygon)** (currently
   the only payment option — it's the only payout destination seeded in 5.3).
4. Submit. You should be redirected to a Transak-hosted checkout URL.
   - With **dummy Transak credentials**, this redirect will fail to load a real checkout page
     (Transak will reject the fake API key) — that's expected; you've still verified
     `apps/web → apps/api → order created → checkoutUrl returned` correctly.
   - With **real Transak staging credentials** (from step 3.2), you'll land on an actual sandbox
     checkout page and can complete it with Transak's documented test card numbers.
5. Watch order status live at `http://localhost:3001/orders/<reference>` — it polls every 4
   seconds and only changes when a **real, signature-verified webhook** arrives from Transak
   (the redirect back to your site does *not* by itself change the status — that's intentional).

If you don't have a public URL for Transak's staging environment to send webhooks to your
local machine, use a tunnel tool (e.g. `ngrok http 3000`) and set the webhook destination URL in
your Transak dashboard to `https://<your-ngrok-subdomain>.ngrok.io/webhooks/transak`. This is
only needed to see live status updates from a real Transak sandbox checkout — the automated
`pnpm smoke` test (6.1) already proves the webhook logic works without any tunnel.

---

## 7. Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `pnpm db:migrate` fails to connect | `DATABASE_URL` in `.env` doesn't match your actual Postgres host/port/user/password |
| `psql: FATAL: database "payment_platform" does not exist` | Skipped step 5.2 |
| API returns `401 Missing X-API-Key` | `PAYMENT_API_KEY` differs between `.env` and `apps/web/.env.local` |
| Checkout says "No approved and active payout destination" | `pnpm db:seed` wasn't run, or you're using a merchant/asset/network combo other than the seeded one (USDT/polygon) |
| Order status never leaves `CREATED`/`CHECKOUT_OPENED` | No webhook has arrived yet — either you're using dummy Transak credentials (no real checkout happened), or Transak can't reach your webhook URL (see the ngrok note above) |
| `pnpm smoke` fails on webhook checks | `TRANSAK_API_SECRET` in `.env` isn't set, or the API wasn't restarted after changing `.env` |

---

## 8. Summary checklist

- [ ] Node ≥ 22.11, pnpm 9.x, Postgres installed and running
- [ ] `payment_platform` database created
- [ ] `.env` filled in (DB creds yours, PII secrets generated, `PAYMENT_API_KEY` invented)
- [ ] `apps/web/.env.local` has the **same** `PAYMENT_API_KEY`
- [ ] `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm build`
- [ ] `pnpm api:dev` and `pnpm web:dev` both running
- [ ] `pnpm smoke` passes
- [ ] (optional) real Transak staging credentials obtained, manual browser checkout completed
