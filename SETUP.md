# First-Time Setup — `payment-platform`

Everything you need to go from a fresh `git clone` to a working local checkout flow (API + web, both dev servers, Postgres running, a real order created and tracked).

This monorepo has two runnable apps:

- `apps/api` — NestJS payment gateway (orders, webhooks, Transak integration) — port **3000**
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

# --- Transak ---
TRANSAK_ENV=staging
TRANSAK_API_KEY=<your Transak staging API key>
TRANSAK_API_SECRET=<your Transak staging API secret>
TRANSAK_REDIRECT_URL=http://localhost:3001/checkout/return
TRANSAK_WEBHOOK_SCHEME=hmac-header

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

You need real Transak **staging** credentials (`TRANSAK_API_KEY` / `TRANSAK_API_SECRET`) to actually reach Transak's hosted checkout — sign up for a Transak partner staging account if you don't have one yet. Without them, order creation will still work locally but the redirect to Transak's checkout page will fail.

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

This inserts one pre-approved test merchant (`Acme Test Merchant Pvt Ltd`, id `11111111-1111-1111-1111-111111111111`) and one pre-approved payout destination (USDT on Polygon, settling to a ZebPay-style custodial address). The storefront is currently wired to offer only this one crypto/network combination — see `apps/web/src/lib/payment-config.ts` — because it's the only payout destination that exists.

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
3. `apps/web`'s `/api/checkout` Route Handler validates the input, recomputes the total server-side, and calls `POST /orders` on the API with the `X-API-Key` header — you should be redirected to a Transak-hosted checkout URL.
4. After completing (or abandoning) payment on Transak, you land back on `/checkout/return`, which forwards you to `/orders/<reference>`.
5. That page polls `GET /api/orders/<reference>` every 4 seconds and shows live status until the order reaches a terminal state (`COMPLETED`, `PAYMENT_FAILED`, etc.) — driven entirely by Transak's signed webhook hitting `POST /webhooks/transak`, never by the browser redirect alone.

If you don't have real Transak credentials, step 3 will fail at the "redirect to Transak" point — everything up to and including order creation in Postgres still works, which is enough to verify the wiring.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `pnpm db:migrate` hangs / `ECONNREFUSED` on 55432 | Docker Desktop isn't running, or `pnpm db:up` never completed — run `docker ps` to confirm `pp-postgres` is `healthy` |
| `pnpm db:seed` errors with "DATABASE_URL is not set" | No `.env` at the repo root, or it's missing the `DATABASE_URL` line — see step 3a |
| `pnpm db:seed` errors "psql was not found on PATH" | Install the PostgreSQL client tools (`psql`) and ensure they're on PATH |
| API starts but immediately throws a config error | A required env var in `apps/api/.env` (`.env` at repo root) is missing — check against `.env.example`, especially `PAYMENT_API_KEY`, `PII_MASTER_KEK`, `PII_BLIND_INDEX_PEPPER` |
| Web's `/api/checkout` returns 401 from the API | `PAYMENT_API_KEY` differs between `.env` (api) and `apps/web/.env.local` (web) — they must match exactly |
| Checkout succeeds but redirect to Transak fails | Missing/invalid `TRANSAK_API_KEY` / `TRANSAK_API_SECRET`, or `TRANSAK_ENV` mismatched with your Transak account type |
| Order status page never leaves "Processing" | Transak webhooks need a publicly reachable URL to call back to — on localhost you won't receive them; use a tunnel (e.g. ngrok) pointed at `apps/api` port 3000 and register that URL with Transak if you need to test the full webhook path |
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
