# Getting Started — Setup, Credentials & Sandbox Testing

A beginner-friendly walkthrough for running `payment-platform` locally and testing it end to
end. Written assuming you have never run this project before.

---

## 1. What this application is (30 seconds)

Two apps talk to each other:

- **`apps/api`** (NestJS, port `3000`) — the payment gateway. Creates orders, prices them with
  MoonPay, builds a signed MoonPay on-ramp URL, and listens for MoonPay's signed webhook to know
  when a payment actually happened.
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

Nothing here talks to real money. Everything below is either generated locally or a **MoonPay
sandbox** credential — there is no cost and no live financial risk.

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

### 3.2 MoonPay sandbox credentials (self-serve, no real money)

MoonPay's on-ramp is the card→crypto provider. **Sandbox keys are issued immediately on
signup** — no application, no approval wait. (Production keys are a different matter: they are
gated on business verification, which takes weeks.)

1. Sign up at <https://dashboard.moonpay.com> and switch the dashboard to **Sandbox**.
2. Go to **Developers → API keys** and take **all three**:
   - **Publishable key** (`pk_test_...`) → `MOONPAY_PUBLISHABLE_KEY`
   - **Secret key** (`sk_test_...`) → `MOONPAY_SECRET_KEY`
   - **Webhook key** (`wk_test_...`) → `MOONPAY_WEBHOOK_KEY`
3. Under **Developers → Webhooks**, add an endpoint at
   `https://<your-public-host>/webhooks/moonpay` subscribed to `transaction_created`,
   `transaction_updated` and `transaction_failed`.

> **The three keys are not interchangeable.** The secret key signs widget URLs; the **webhook**
> key verifies inbound webhooks. Using the secret key for verification fails every check with no
> error other than 400s in MoonPay's webhook log — it is the single most common MoonPay
> integration bug. The API also refuses to boot if the three keys are not all from the same
> environment.

**You do not need any of this to run the project.** `.env` ships with `MOONPAY_API_BASE_URL`
pointing at `scripts/moonpay-stub.mjs`, a local stand-in for MoonPay's quote and transaction
endpoints. Order creation, quoting, URL signing, webhook verification and every state transition
run for real against it; only MoonPay's own payment UI is missing. `pnpm smoke` starts the stub
itself. Delete `MOONPAY_API_BASE_URL` once you have real keys — the API refuses that override
outright if the keys are live ones.

Sandbox test cards, once you do have access (expiry `12/2030`, CVC `123`):
`4242 4242 4242 4242` (Visa, 3DS challenge, succeeds) and `4544 2491 6767 3670` (fails,
insufficient funds). KYC is not verified in sandbox — use a US or UK address and click
**"Skip document submission"**.

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

MOONPAY_PUBLISHABLE_KEY=<from 3.2, or leave the placeholder for stub-only work>
MOONPAY_SECRET_KEY=<from 3.2, or leave the placeholder for stub-only work>
MOONPAY_WEBHOOK_KEY=<from 3.2; the smoke test signs with whatever is here>
MOONPAY_WIDGET_MODE=embedded
MOONPAY_REQUIRE_IP_MATCH=false
MOONPAY_API_BASE_URL=http://127.0.0.1:4599   # delete once you have real keys
WEB_BASE_URL=http://localhost:3001

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

### 6.1 Automated smoke test (no browser, no MoonPay account needed)

With `apps/api` running (Terminal 1 above), in a third terminal:

```bash
pnpm smoke
```

This exercises 63 real guarantees against the running API: order creation, quoting, idempotency
(same key → same order, no duplicate re-quote), widget-URL signing, wallet-address pinning and
amount locking, secret-key containment, IP binding, webhook signature verification (valid vs.
tampered vs. expired timestamp vs. legacy header), duplicate webhook delivery (safe no-op),
out-of-order/backwards transitions (rejected), stage-aware failure mapping, misdelivery
detection, the donation path, and the full happy-path status progression — all using self-signed
fake webhooks, so it needs nothing from MoonPay's actual servers.

Also worth running:

```bash
pnpm check:erasure   # 17 assertions that customer PII can be erased without corrupting orders
pnpm verify           # build + lint + smoke + check:erasure, all in one
```

All should print `PASS` for every line; a `FAIL` points at exactly what broke.

### 6.2 Manual walkthrough in a browser (exercises the real storefront UI)

With both `pnpm api:dev` and `pnpm web:dev` running:

1. Open `http://localhost:3001`.
2. Browse to a product, enter your own quote price and quantity (this storefront is
   custom-quote — there's no fixed catalog price).
3. Proceed to checkout, fill in contact/billing details, and select **USDC (Polygon)** (currently
   the only payment option — see 5.3 and `apps/web/src/lib/payment-config.ts`).
4. Submit. You land on `/checkout/onramp/<reference>` — **our own page**, which builds a signed
   MoonPay widget URL server-side and frames it. The amount, asset and deposit address are all
   locked by the signature.
   - Against the **stub**, the frame points at MoonPay's real sandbox widget, but the
     publishable key is a placeholder, so it shows an error instead of a payment form. That is
     expected, and everything either side of it has still been exercised.
   - With **real sandbox credentials**, you get a working on-ramp and can complete it with the
     test cards in 3.2.
5. Watch order status live at `http://localhost:3001/orders/<reference>` — it polls every 4
   seconds and only changes when a **real, signature-verified webhook** arrives from MoonPay.
   MoonPay's `redirectURL` navigates you there but never marks the order paid.
6. Do the same through the **donation** flow at `http://localhost:3001/donate`. It is the
   identical rail — same quote, same signed URL, same webhook, same state machine — so anything
   that works for a purchase works for a donation and vice versa.

MoonPay cannot reach `localhost`. To see live status from a real sandbox checkout, expose the
API over HTTPS (`cloudflared tunnel --url http://localhost:3000`) and register
`https://…/webhooks/moonpay` in the MoonPay dashboard. This is only needed for a real sandbox
checkout — `pnpm smoke` (6.1) already proves the webhook logic without any tunnel.

---

## 7. Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `pnpm db:migrate` fails to connect | `DATABASE_URL` in `.env` doesn't match your actual Postgres host/port/user/password |
| `psql: FATAL: database "payment_platform" does not exist` | Skipped step 5.2 |
| API returns `401 Missing X-API-Key` | `PAYMENT_API_KEY` differs between `.env` and `apps/web/.env.local` |
| Checkout says "No approved and active payout destination" | `pnpm db:seed` wasn't run, or you're using a merchant/asset/network combo other than the seeded ones (USDC/polygon, USDT/polygon) |
| Order status never leaves `CREATED`/`CHECKOUT_OPENED` | No webhook has arrived yet — either you're on the stub (no real checkout happened), or MoonPay can't reach your webhook URL (see the tunnel note above) |
| `pnpm smoke` fails on webhook checks | `MOONPAY_WEBHOOK_KEY` in `.env` isn't set, or the API wasn't restarted after changing `.env` |
| Every real webhook returns 400 | You used `MOONPAY_SECRET_KEY` where `MOONPAY_WEBHOOK_KEY` belongs. They are different secrets |
| API won't boot: "keys are from different environments" | A mixed set, e.g. `pk_live_` with `wk_test_` — take all three from the same dashboard environment |
| Order creation fails with `ECONNREFUSED` | `MOONPAY_API_BASE_URL` points at the stub but the stub isn't running — `node scripts/moonpay-stub.mjs` |

---

## 8. Summary checklist

- [ ] Node ≥ 22.11, pnpm 9.x, Postgres installed and running
- [ ] `payment_platform` database created
- [ ] `.env` filled in (DB creds yours, PII secrets generated, `PAYMENT_API_KEY` invented)
- [ ] `apps/web/.env.local` has the **same** `PAYMENT_API_KEY`
- [ ] `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm build`
- [ ] `pnpm api:dev` and `pnpm web:dev` both running
- [ ] `pnpm smoke` passes
- [ ] (optional) MoonPay sandbox keys in place (all three), webhook endpoint registered, manual browser checkout completed
- [ ] (optional) The same walkthrough via `/donate`

Deeper detail on credentials, going live and every provider-specific decision:
[`docs/moonpay-onramp-migration.md`](docs/moonpay-onramp-migration.md).
