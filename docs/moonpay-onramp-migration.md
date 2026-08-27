# MoonPay On-Ramp Migration — Runbook

**Date:** 2026-08-23
**Change:** the fiat-to-crypto on-ramp leg moves from **Stripe Crypto Onramp** to
**MoonPay Buy (on-ramp)**. Stripe is removed entirely — package, stub, config,
webhook route and all.
**Supersedes:** `docs/stripe-onramp-migration.md` (deleted)

Everything in this document was written against MoonPay's live documentation and
live API, fetched 2026-08-23:

| Source | Used for |
|---|---|
| <https://dev.moonpay.com/widget/on-ramp/overview> | integration model |
| <https://dev.moonpay.com/widget/on-ramp/integration-methods/url> | widget base URLs, URL building |
| <https://dev.moonpay.com/widget/on-ramp/customization/parameters> | every query parameter |
| <https://dev.moonpay.com/widget/on-ramp/customization/url-signing> | signing algorithm |
| <https://dev.moonpay.com/widget/on-ramp/customization/ip-matching> | `allowedIpAddress` |
| <https://dev.moonpay.com/api-reference/widget/webhooks/signature> | `Moonpay-Signature-V2` |
| <https://dev.moonpay.com/api-reference/widget/webhooks/overview> | delivery, retries, dedupe |
| `dev.moonpay.com/api-reference/widget/webhooks.openapi.json` | exact event payloads |
| <https://dev.moonpay.com/api-reference/widget/getbuyquote> | quote endpoint |
| <https://dev.moonpay.com/api-reference/widget/getbuytransactionbyexternalid> | reconciliation lookup |
| <https://dev.moonpay.com/widget/sandbox-testing> | test cards, sandbox limits |
| `GET https://api.moonpay.com/v3/currencies` | currency codes, decimals, minimums, sandbox support |

> **Read §1 before touching the dashboard.** The three MoonPay keys are not
> interchangeable and the failure mode for crossing them is silent.

---

## Contents

1. [Credentials you need](#1-credentials-you-need)
2. [Step-by-step setup](#2-step-by-step-setup)
3. [How the integration works](#3-how-the-integration-works)
4. [Sandbox testing](#4-sandbox-testing)
5. [Donations](#5-donations)
6. [Reference tables](#6-reference-tables)
7. [Going live](#7-going-live)
8. [Get these answers in writing](#8-get-these-answers-in-writing)
9. [Troubleshooting](#9-troubleshooting)
10. [What changed in the codebase](#10-what-changed-in-the-codebase)
11. [Rollback](#11-rollback)

---

## 1. Credentials you need

### 1.1 The three MoonPay keys

All three come from **<https://dashboard.moonpay.com> → Developers**. You get a
separate set per environment (sandbox and production), and **all three must come
from the same environment**. The API refuses to boot on a mix — see
`resolveMoonPayConfig` in `packages/providers/moonpay/src/config.ts`.

| Env var | MoonPay name | Prefix | What it does | Exposure |
|---|---|---|---|---|
| `MOONPAY_PUBLISHABLE_KEY` | Publishable API key | `pk_test_` / `pk_live_` | Identifies your account in the widget URL and in quote / transaction API calls | **Public.** Visible to anyone who opens the payment page. |
| `MOONPAY_SECRET_KEY` | Secret API key | `sk_test_` / `sk_live_` | HMAC key for **URL signing** and for hashing the payer IP | **Server only.** Never sent to MoonPay, never in a URL, never in the browser bundle. |
| `MOONPAY_WEBHOOK_KEY` | Webhook API key | `wk_test_` / `wk_live_` | HMAC key for verifying `Moonpay-Signature-V2` on inbound webhooks | **Server only.** |

> **The single most common MoonPay integration bug:** using the *secret* key to
> verify webhooks. There is no error message — every event just fails
> verification, your endpoint returns 400, MoonPay retries nine times and gives
> up, and orders silently never advance. `MOONPAY_WEBHOOK_KEY` is a **different
> secret** with a `wk_` prefix.

> The secret key is only ever used as an HMAC key in this codebase. Nothing sends
> it anywhere. Grep it: `packages/providers/moonpay/src/widget.ts` is the only
> file that reads it.

### 1.2 Everything else

| Env var | Where it comes from | Notes |
|---|---|---|
| `DATABASE_URL` | your Postgres | unchanged |
| `PII_MASTER_KEK` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | **Production: a KMS key, not env.** See `docs/pii-retention-policy.md`. |
| `PII_BLIND_INDEX_PEPPER` | same generator, **different value** | Must survive subject erasure, so it is not the KEK. |
| `PAYMENT_API_KEY` | you choose it | Shared secret between `apps/web` and `apps/api`. Never reaches the browser. |
| `WEB_BASE_URL` | your storefront origin | MoonPay's `redirectURL` is built from it and **must be HTTPS in live mode**. |
| `PAYMENT_MERCHANT_ID` (in `apps/web/.env.local`) | `merchants.id` from your seed / production row | Server-side constant; the browser must never be able to forge it. |

### 1.3 Optional MoonPay knobs

| Env var | Default | When to change it |
|---|---|---|
| `MOONPAY_WIDGET_MODE` | `embedded` | `redirect` if you need Apple Pay / Google Pay — they do not work in an iframe. |
| `MOONPAY_REQUIRE_IP_MATCH` | `false` | Ignored in live: **forced on**. Leave false locally, where there is no routable client IP. |
| `MOONPAY_THEME` | unset | `light` / `dark`. |
| `MOONPAY_THEME_ID` | unset | A custom theme from the dashboard theme builder. |
| `MOONPAY_WEBHOOK_TOLERANCE_SECONDS` | `3600` | See §3.4 before shortening it. |
| `MOONPAY_API_BASE_URL` | `https://api.moonpay.com` | **Test only.** Refused at boot with live keys. |
| `MOONPAY_WIDGET_BASE_URL` | derived from key mode | **Test only.** Refused at boot with live keys. |

### 1.4 Account access you also need

Not env vars, but the migration is blocked without them:

- [ ] **A MoonPay account** — <https://dashboard.moonpay.com>. Sandbox keys are issued on signup.
- [ ] **KYB completed** for production keys. MoonPay will not issue `pk_live_` until your entity is verified. Start this early; it is the long pole.
- [ ] **A publicly reachable HTTPS webhook endpoint** — `https://<your-api>/webhooks/moonpay`. MoonPay cannot deliver to `localhost`.
- [ ] **An approved deposit address** on the Binance Entity Account, entered into `payout_destinations` through the maker-checker flow.

> **MoonPay Enterprise / `dev.enterprise.moonpay.com` is a different product.**
> It is MoonPay's stablecoin-infrastructure platform (virtual accounts, issuance,
> treasury), runs on `app.iron.xyz`, and needs an intro through
> `developers@iron.xyz`. **This integration does not use it.** Everything here is
> the widget on-ramp, which needs only the three keys above.

---

## 2. Step-by-step setup

### Step 1 — Create the MoonPay account and take sandbox keys

1. Sign up at <https://dashboard.moonpay.com>.
2. Switch the dashboard to **Sandbox**.
3. **Developers → API keys.** Copy all three: publishable, secret, webhook.
4. Confirm every one starts with `pk_test_`, `sk_test_`, `wk_test_` respectively. If any says `live`, you are on the wrong environment.

### Step 2 — Start KYB for production

Do this now, in parallel with everything else. Production keys are gated on it
and it is measured in weeks, not hours. **Dashboard → Settings → Business
verification.** See §8 for what to ask while you have their attention.

### Step 3 — Register the webhook endpoint

1. **Developers → Webhooks → Add endpoint.**
2. URL: `https://<your-api-host>/webhooks/moonpay`
3. Subscribe to exactly these three:
   - `transaction_created`
   - `transaction_updated`
   - `transaction_failed`
4. Optionally also `identity_check_updated` — it is recorded in the audit ledger and acknowledged as a no-op. See §3.6 for why it cannot be acted on.
5. **Leave every `sell_*` and `swap_*` event unselected.** They never fire for a buy-only widget account.

> Subscribing to more than you handle is harmless: unhandled types are
> acknowledged and dropped, never escalated. The smoke suite asserts this.

### Step 4 — Fill in the environment

```bash
cp .env.example .env
```

Then set, at minimum:

```
MOONPAY_PUBLISHABLE_KEY=pk_test_...
MOONPAY_SECRET_KEY=sk_test_...
MOONPAY_WEBHOOK_KEY=wk_test_...
MOONPAY_WIDGET_MODE=embedded
MOONPAY_REQUIRE_IP_MATCH=false

DATABASE_URL=postgresql://...
PII_MASTER_KEK=<32 random bytes, base64>
PII_BLIND_INDEX_PEPPER=<32 different random bytes, base64>
PAYMENT_API_KEY=<a long random string>
WEB_BASE_URL=http://localhost:3001
```

Generate the two PII secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

And in `apps/web/.env.local`:

```
PAYMENT_API_URL=http://127.0.0.1:3000
PAYMENT_API_KEY=<the same value as above>
PAYMENT_MERCHANT_ID=11111111-1111-1111-1111-111111111111
```

> To run entirely without MoonPay credentials, leave the placeholder keys that
> ship in `.env` and set `MOONPAY_API_BASE_URL=http://127.0.0.1:4599`. The smoke
> suite starts a stub on that port. The placeholders carry real prefixes so the
> boot-time credential check still runs for real.

### Step 5 — Migrate the database

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
```

Two new migrations run:

- `0003_add_order_type_and_donation_fields` — adds `order_type`, `donation_campaign`, `donor_name_enc`, an index and two CHECK constraints.
- `0004_drop_provider_client_secret` — drops the Stripe session secret column. **Irreversible**, and intentionally so: MoonPay has no session and no client secret, and any value left in that column refers to a Stripe session that no longer exists on Stripe's side either.

### Step 6 — Build and run

```bash
pnpm build
pnpm api:dev     # :3000
pnpm web:dev     # :3001
```

The API refuses to start if any key is missing, malformed, or from a different
environment than the other two. That is deliberate — a payments service that
starts with a broken secret and finds out on the first webhook is worse than one
that will not start.

### Step 7 — Verify

```bash
pnpm verify
```

Runs build → lint → smoke (63 assertions) → erasure (17 assertions). All must
pass before you point anything at real money. See §4 for what to test by hand on
top of that.

### Step 8 — Expose the webhook for a real sandbox run

Local `localhost` is unreachable from MoonPay. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Put the resulting `https://…/webhooks/moonpay` into the dashboard, and set
`WEB_BASE_URL` to a tunnel pointing at `:3001` so `redirectURL` resolves.

---

## 3. How the integration works

### 3.1 The shape change: no session

Stripe minted an **onramp session** server-side; we stored its id and client
secret and mounted a widget against them.

**MoonPay has no such call.** The entire instruction to the widget — asset,
chain, amount, and above all *where the crypto goes* — travels in a **query
string**. That has three consequences the code is built around:

| Consequence | How it is handled |
|---|---|
| The query string is the security boundary. | Every URL is HMAC-signed; MoonPay refuses to load a URL carrying `walletAddress` without a valid signature. |
| There is no pre-flight failure at creation. | A **buy quote** is fetched at order creation instead. It is the one moment before the customer commits at which MoonPay will refuse an unsupported pair, amount or account. |
| We do not know MoonPay's transaction id until the customer commits. | `orders.provider_order_id` is NULL until the first `transaction_created` webhook. Until then the join runs on `externalTransactionId` = our `orders.reference`. |

### 3.2 The flow

```
POST /orders
  ├─ resolve approved payout destination        (allowlist, maker-checker, matured)
  ├─ GET /v3/currencies/{code}/buy_quote        ← pre-flight + crypto_amount_quoted
  ├─ INSERT order + data subject + DEK          (one transaction)
  └─ build signed widget URL                    ← never stored

customer → buy.moonpay.com (iframe or redirect)
  └─ card + KYC + delivery, all on MoonPay's side

MoonPay → POST /webhooks/moonpay
  ├─ verify Moonpay-Signature-V2                (HMAC-SHA256, wk_ key, hex)
  ├─ INSERT provider_events                     ← unique constraint IS the dedupe
  ├─ 200 within 5 s                             ← processing happens after the response
  └─ process: join → address check → settlement → state transition → outbox
```

### 3.3 URL signing, exactly

```
signature = base64( HMAC-SHA256( secretKey, "?" + queryString ) )
finalUrl  = base + "?" + queryString + "&signature=" + urlencode(signature)
```

Three details that break integrations:

1. **The leading `?` is part of the signed string.** MoonPay's own example signs `new URL(url).search`, which includes it.
2. **base64, not hex.** The webhook signature is hex; the URL signature is base64. They are different.
3. **Sign the exact string you send.** `buildWidgetUrl` builds the query string once and signs that same string. Re-encoding between signing and sending invalidates the signature.

Parameters this platform pins on every URL:

| Parameter | Value | Why it is not optional |
|---|---|---|
| `walletAddress` | the approved deposit address | The whole business model. Signed, so the payer cannot edit it. |
| `currencyCode` | e.g. `usdc_polygon` | **Locks** the asset. `defaultCurrencyCode` would only suggest it. |
| `baseCurrencyAmount` + `lockAmount=true` | the invoiced amount | Without `lockAmount` the payer can change what they pay. |
| `externalTransactionId` | `orders.reference` | The only join key we control. |
| `redirectURL` | `${WEB_BASE_URL}/orders/{reference}` | Lands the customer on their own status page. |
| `allowedIpAddress` | `base64(HMAC-SHA256(secretKey, ip))` | Binds the URL to one browser. Mandatory in live. |

**`email` is deliberately never sent.** It would put an email address in a query
string — which reaches access logs, proxy logs, referrer headers and browser
history — undoing the encryption-at-rest this platform does everywhere else. It
would also require decrypting PII on every render, and MoonPay signs a customer
*out* when the value does not match their logged-in account. The smoke suite
asserts the email never appears in the URL.

**The signed URL is never stored.** It is rebuilt per request, because it is
bound to the IP of the request that asks for it. A stored URL would be wrong for
any customer who came back on a different network.

### 3.4 Webhook verification

```
Moonpay-Signature-V2: t=<unix seconds>,s=<hex hmac>
signed payload        = "<t>." + <raw request body>
key                   = MOONPAY_WEBHOOK_KEY   (wk_..., NOT sk_...)
```

- **Raw body.** Fastify parses JSON before the handler runs; the HMAC must be over `req.rawBody`. The app is created with `{ rawBody: true }`. Re-serialized JSON produces different bytes and never matches.
- **Constant-time compare.** `===` on a signature leaks it byte by byte.
- **V2 only.** The legacy `Moonpay-Signature` header is sent alongside and keyed differently; accepting it would be a downgrade. The smoke suite asserts a V2-less request is rejected.
- **Multiple `s=` elements are accepted.** MoonPay documents one, but every provider in this space signs with both keys during a rotation. Accepting extras costs nothing and stops key rotation becoming an outage.

**On the one-hour replay tolerance.** MoonPay retries a failed delivery up to
nine times with exponential backoff and **does not document whether retries are
re-signed with a fresh timestamp**. A Stripe-style five-minute window would
therefore risk rejecting every legitimate retry, permanently losing events — the
exact failure this subsystem exists to prevent. Replay is really prevented by the
unique constraint on `provider_events (provider, external_event_id)`, which makes
a re-delivered event a no-op at any age, plus the monotonic `RANK` check. The
timestamp bound is defence in depth. **Ask MoonPay whether retries are re-signed
(§8) and tighten `MOONPAY_WEBHOOK_TOLERANCE_SECONDS` to 300 if they are.**

### 3.5 Deduplication without an event id

**MoonPay webhooks carry no event id.** MoonPay's own guidance is to deduplicate
on `type` + transaction `id` + `updatedAt`, so that is exactly the key this
platform synthesises:

```
external_event_id = "<type>:<data.id>:<data.updatedAt>"
```

It goes into the existing unique index on `provider_events`. Two genuine state
changes differ in `updatedAt`; a retried delivery of the same change does not.
The fallback for a payload missing either field is a SHA-256 of the raw bytes.

MoonPay also warns that **events can arrive out of order**, especially on
retries. The existing `RANK` guard already handles that: a late earlier event is
dropped, never applied.

### 3.6 Status and failure mapping

| MoonPay status | Our status | Note |
|---|---|---|
| `waitingPayment` | `PAYMENT_PENDING` | bank transfer initiated, MoonPay not in receipt |
| `waitingAuthorization` | `PAYMENT_PENDING` | waiting on 3DS / issuer |
| `pending` | `PAYMENT_CONFIRMED` | MoonPay holds the money and is processing |
| `completed` | `COMPLETED` | delivered to the wallet address |
| `failed` | *depends on the failed stage* | see below |
| anything else | `MANUAL_REVIEW` | never guessed |

`failureReason` is **free text with no documented enum**, so it is never parsed
for meaning — only recorded in `order_status_history.reason`. The `stages` array
*is* enumerated, and it answers the only question that decides the outcome:
**did money move?**

| Failed stage | Our status | Reasoning |
|---|---|---|
| `stage_one_ordering` | `CARD_DECLINED` | fails before MoonPay takes the money |
| `stage_two_verification` | `KYC_FAILED` | identity check, no charge |
| `stage_three_processing` | `PAYMENT_FAILED` | charged then reversed by MoonPay; customer made whole |
| `stage_four_delivery` | **`MANUAL_REVIEW`** | **charged, crypto NOT delivered.** Money is at risk. No automated rule closes this out. |
| absent / unrecognised | `PAYMENT_FAILED` | the safe reading |

> **State-machine change this forced.** MoonPay can send `transaction_failed` as
> the *first* event we ever see, against an order still in `CREATED` — a card
> declined at stage one produces no prior event. `CARD_DECLINED` and
> `PAYMENT_FAILED` are therefore now reachable from every pre-settlement state,
> the same way `KYC_FAILED` already was. Without that, every ordinary declined
> card was reported as an illegal transition and buried in `MANUAL_REVIEW`.
> **The smoke suite caught this.**

**`identity_check_updated` is recorded but not acted on.** It carries a MoonPay
customer id and *no transaction id*, and this platform has no customer accounts
to join one to — every order gets its own pseudonymous data subject. Acting on it
would mean guessing which order it refers to. It is kept verbatim in
`provider_events` for the audit trail and acknowledged as a no-op.

### 3.7 Money precision

MoonPay sends `quoteCurrencyAmount` as a **JSON number**, not a string. By the
time `JSON.parse` has run it is an IEEE-754 double and the original text is gone.
`decimalStringFromNumber` (in `@pp/shared-types`) renders the exact shortest
decimal that round-trips to that double, expanding exponent notation, and the
result goes through `parseDecimalPadded` into integer base units.

**This is why the asset list is limited to 6-decimal stablecoins.** Every
representable USDC/USDT amount survives that round trip exactly. An 18-decimal
asset would need the amount as a string from the provider, and adding one without
handling that would be a real loss event.

---

## 4. Sandbox testing

### 4.1 Test cards

From MoonPay's sandbox documentation. Expiry `12/2030`, CVC `123` for all.

| Card | Outcome |
|---|---|
| `5385 3083 6013 5181` | MasterCard, 3DS challenge (US) — success |
| `4485 0403 7153 6584` | Visa, 3DS frictionless (UK) — success |
| `4242 4242 4242 4242` | Visa, 3DS challenge (UK) — success |
| `4544 2491 6767 3670` | Visa — **insufficient funds**, fails |

KYC data is not verified in sandbox; use a **US or UK address**, and click
**"Skip document submission"** when asked for documents.

### 4.2 The USDC-on-Polygon sandbox trap

> **`usdc_polygon` has `supportsTestMode: false`.** MoonPay's sandbox settles on
> testnets and holds **no testnet liquidity** for it. A sandbox purchase of the
> production default pair **fails at delivery no matter how correct your
> integration is**, with `Transaction processing failed`.

To rehearse the full happy path end-to-end in sandbox, use **USDC on Ethereum**
(`usdc`), which is the only USDC code with test mode. `scripts/seed.sql` seeds an
approved Ethereum destination for exactly this purpose. Temporarily add it to
`SUPPORTED_CRYPTO_OPTIONS` in `apps/web/src/lib/payment-config.ts` for the
rehearsal, then take it back out.

Other sandbox limits worth knowing:

- Sandbox delivers **1/100th of the quoted amount** — testnet funds are scarce. Do not treat the delivered figure as a bug.
- Rate limiting kicks in after unusual activity; the cooldown is roughly 20 minutes.
- A production MoonPay account cannot access sandbox, and vice versa.

### 4.3 Manual checklist

Run `pnpm verify` first — it covers the mechanics. Then, by hand against real
sandbox keys:

- [ ] Widget loads in the iframe on `/checkout/onramp/{reference}` with the amount pre-filled and **not editable**.
- [ ] The destination address is **not editable** and matches the seeded destination.
- [ ] A successful 3DS card drives the order to `COMPLETED` and the status page updates without a refresh.
- [ ] The insufficient-funds card drives it to a failure state with a sensible message.
- [ ] `provider_events` holds the raw payloads with `signature_valid = true`.
- [ ] Re-delivering an event from the dashboard's webhook log returns `{"duplicate": true}` and changes nothing.
- [ ] Camera access is requested during identity capture (this is what the iframe's `allow="camera"` is for — without it KYC dead-ends silently).
- [ ] The same run through the donation flow at `/donate`.

---

## 5. Donations

Donations are **the same order, on the same rails**: same gateway, same quote,
same signed widget URL, same webhook, same state machine, same approved payout
destination. A second payment path would be a second place for money to go
missing.

| Piece | Where |
|---|---|
| Campaign list (server-side, not a table) | `apps/web/src/lib/campaigns.ts` |
| Donation page | `apps/web/src/app/donate/page.tsx` |
| Form | `apps/web/src/components/donation-form.tsx` |
| BFF route | `apps/web/src/app/api/donate/route.ts` |
| Gateway fields | `orders.order_type`, `orders.donation_campaign`, `orders.donor_name_enc` |

Design decisions worth keeping:

- **`order_type` discriminates what an order IS, not how it is paid.** A CHECK constraint keeps `donation_campaign` and `donor_name_enc` off purchase rows.
- **The campaign slug is only ever used to look one up from our own list.** A slug from the request is never stored as given — that is the sanitisation, since it is rendered back to donors.
- **The donor's display name is encrypted under the data subject's DEK**, like every other identifier. An erasure request shreds it with one key deletion, and the erasure suite asserts exactly that. **Anonymous is the default reading** of both an unticked box and an empty field.
- **The campaign survives erasure.** It names a programme, not a person, so donation reporting keeps adding up afterwards.

### The minimum-donation problem

**MoonPay enforces a per-currency minimum that is higher than a typical suggested
gift.** USD/EUR/GBP start at 20, AUD at 35, LKR at 7,000. A `$5` donate button
would simply fail. The form filters suggested amounts against the minimum for the
chosen currency and, where every suggestion is below the floor, offers the floor
and multiples of it instead. The BFF re-checks server-side, and MoonPay's quote
call is the authority.

Refresh those figures from `GET https://api.moonpay.com/v3/currencies` when a
legitimate amount starts being refused — MoonPay changes them.

---

## 6. Reference tables

### 6.1 Currency codes

Fiat (`baseCurrencyCode`) offered by this platform:

| Ours | MoonPay | Min | Max |
|---|---|---|---|
| USD | `usd` | 20 | 30,000 |
| EUR | `eur` | 20 | 30,000 |
| GBP | `gbp` | 20 | 30,000 |
| AUD | `aud` | 35 | 16,000 |
| LKR | `lkr` | 7,000 | 2,150,000 |

**SGD is not offered.** MoonPay's catalogue has no `sgd`. It remains in the
`FiatCurrency` type but the mapping returns null, so an SGD order is refused at
creation with a clear message. The smoke suite asserts this.

Crypto (`currencyCode`):

| Ours | MoonPay | Decimals | Sandbox? |
|---|---|---|---|
| USDC / polygon | `usdc_polygon` | 6 | **no** |
| USDC / ethereum | `usdc` | 6 | yes |
| USDT / polygon | `usdt_polygon` | 6 | no |
| USDT / ethereum | `usdt` | 6 | no |

`usdc_polygon` is not available in Canada and is restricted in the US Virgin
Islands; `usdt_polygon` adds New York. MoonPay enforces this — the widget will
tell the customer — but it is worth knowing before you promise a geography.

### 6.2 Webhook events

| Event | Carries | We act on it? |
|---|---|---|
| `transaction_created` | full `BuyTransaction` + `stages` | yes |
| `transaction_updated` | full `BuyTransaction` | yes |
| `transaction_failed` | full `BuyTransaction` + `stages` | yes |
| `identity_check_updated` | `IdentityCheck` (customer id only) | recorded, not acted on |
| `sell_*`, `swap_*` | — | never fire for a buy widget |

Delivery contract: **2xx within 5 seconds**, up to **9 retries** with exponential
backoff, **at-least-once** semantics.

### 6.3 REST endpoints used

| Call | Auth | Used for |
|---|---|---|
| `GET /v3/currencies/{code}/buy_quote` | `apiKey` = **publishable** key | pre-flight + `crypto_amount_quoted` |
| `GET /v1/transactions/ext/{reference}` | `apiKey` = **publishable** key | reconciliation (implemented, not yet scheduled) |

Both authenticate with the publishable key in a query parameter. That is
MoonPay's design, not a downgrade, and it is why the secret key never leaves the
process.

---

## 7. Going live

Work top to bottom. Nothing below is optional.

- [ ] **KYB approved** and `pk_live_` / `sk_live_` / `wk_live_` issued.
- [ ] **All three live keys set together.** The API refuses a mixed set.
- [ ] **`WEB_BASE_URL` is HTTPS.** MoonPay requires `redirectURL` to be HTTPS in live.
- [ ] **IP matching works.** It is forced on with live keys, so your load balancer **must** set `X-Forwarded-For` and the API must trust it (`FastifyAdapter({ trustProxy: true })` — already set). If the payer IP cannot be determined, the platform refuses to build an unbound URL rather than issuing one that anyone could reuse. Verify this on staging before launch, or the first live customer cannot pay. MoonPay also enables production enforcement manually — confirm they have.
- [ ] **A live webhook endpoint** registered, subscribed to the three buy events, verified with a test delivery.
- [ ] **`MOONPAY_API_BASE_URL` and `MOONPAY_WIDGET_BASE_URL` unset.** The API refuses them with live keys, but check anyway.
- [ ] **`PII_MASTER_KEK` moved to a KMS.** Env-var key material is local-dev only.
- [ ] **Payout destination approved through maker-checker** and past its cooling-off period, matching the asset and network you actually offer.
- [ ] **Written answers to §8 on file** in `docs/provider-approval.md`.
- [ ] **Reconciliation worker running.** Still the largest functional gap — see `docs/implementation-status.md` Step 1. `fetchTransactionByExternalId` exists for it; nothing schedules it yet. Webhooks *will* be lost.
- [ ] **Alerting on `MANUAL_REVIEW`.** Especially stage-four delivery failures: those are charged cards with undelivered crypto.
- [ ] Start with one merchant, one currency, one asset, one network, low amounts, manual review on every transaction.

---

## 8. Get these answers in writing

This is a business risk, not an engineering task, and it is binary. Standard
on-ramp terms assume delivery to the **KYC'd payer's own wallet**. Payer ≠
beneficiary, with a corporate exchange account as the beneficiary, is exactly
what AML controls flag. Sandbox access answers none of it — sandbox keys are
self-serve and say nothing about what production permits.

**From MoonPay:**

- [ ] May the payer and the receiving wallet owner be **different parties**?
- [ ] May the beneficiary be a **corporate entity** holding a Binance Entity Account?
- [ ] Which **payer geographies** are supported for this pattern?
- [ ] Which **asset and network**, exactly? (Confirm `usdc_polygon` for a corporate beneficiary.)
- [ ] **Per-transaction and monthly limits** for a corporate beneficiary. MoonPay's published card cap is 30,000 USD per transaction — confirm the aggregate.
- [ ] **Who bears chargeback liability?** ← the one with real money attached.
- [ ] What **sender/beneficiary information** must accompany each transfer (Travel Rule)?
- [ ] **Are webhook retries re-signed with a fresh timestamp?** Decides whether §3.4's tolerance can drop to 5 minutes.
- [ ] Is `failureReason` enumerated anywhere? If a stable list exists, the failure mapping can be finer-grained.

**From Binance:**

- [ ] Will the Entity Account **accept third-party deposits** from a licensed on-ramp?
- [ ] Which **assets and networks** will be credited to it?
- [ ] What happens to a deposit that arrives on an **unsupported network**?

**Done when:** written confirmation on file naming the entity, asset, network and
geographies. Record it in `docs/provider-approval.md`.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Widget shows a signature error, or refuses to load | Query string changed after signing, or the wrong key was used to sign | Sign with `sk_`, over `"?" + queryString`, base64. Verify with `verifyWidgetUrl`. |
| `Unverified Connection` in the widget | `allowedIpAddress` does not match the IP MoonPay observes | Your proxy is not setting `X-Forwarded-For`, or you hashed a private/loopback address. `clientIp` returns undefined for private ranges precisely to avoid this. |
| Every webhook 400s, nothing advances | `MOONPAY_SECRET_KEY` used to verify instead of `MOONPAY_WEBHOOK_KEY` | Use the `wk_` key. This is the most common MoonPay bug. |
| Webhooks 400 only sometimes | Body re-serialized before the HMAC | Verify over `req.rawBody`. The app must be created with `{ rawBody: true }`. |
| Webhooks 400 after a few minutes of retries | Replay tolerance too short for MoonPay's backoff | Raise `MOONPAY_WEBHOOK_TOLERANCE_SECONDS`; see §3.4. |
| Order stuck in `CREATED`, no events at all | Endpoint unreachable, or not subscribed to the buy events | Check the dashboard's webhook log. It shows the response code we returned. |
| Sandbox transaction fails at delivery | `usdc_polygon` has no sandbox liquidity | Rehearse on `usdc` (Ethereum). See §4.2. |
| Sandbox delivers a hundredth of the amount | Expected — MoonPay's testnet funds are scarce | Not a bug. |
| Order creation 400s with a MoonPay message | Amount below MoonPay's minimum, or an unsupported pair | The message is passed through verbatim; it is customer-actionable. |
| API will not boot: "keys are from different environments" | A mixed `pk_live_` / `wk_test_` set | Take all three from the same dashboard environment. |
| KYC dead-ends with no error inside the iframe | The embedder did not delegate camera permission | The iframe needs `allow="camera"` — already set in `moonpay-widget.tsx`. |
| Apple Pay / Google Pay never appear | They do not work in an iframe. MoonPay says so explicitly. | Set `MOONPAY_WIDGET_MODE=redirect`. |

---

## 10. What changed in the codebase

**Added**

```
packages/providers/moonpay/          @pp/provider-moonpay
  src/config.ts                      credential validation, environment derivation
  src/mapping.ts                     currency codes, status + stage mapping
  src/widget.ts                      signed widget URLs, IP hashing
  src/api.ts                         buy quote, transaction lookup, parsing
  src/webhook.ts                     Moonpay-Signature-V2, event id derivation

apps/web/src/app/donate/page.tsx
apps/web/src/app/api/donate/route.ts
apps/web/src/components/donation-form.tsx
apps/web/src/components/moonpay-widget.tsx
apps/web/src/lib/campaigns.ts
apps/web/src/lib/client-ip.ts

scripts/moonpay-stub.mjs
packages/database/migrations/0003_add_order_type_and_donation_fields.sql
packages/database/migrations/0004_drop_provider_client_secret.sql
```

**Removed**

```
packages/providers/stripe-onramp/    entire package
scripts/stripe-stub.mjs
apps/web/src/components/onramp-widget.tsx
docs/stripe-onramp-migration.md
orders.provider_client_secret        column
POST /webhooks/stripe                route
```

**Changed**

| File | Change |
|---|---|
| `apps/api/src/config.ts` | MoonPay credential set; boot-time environment consistency check |
| `apps/api/src/orders/*` | quote at creation, signed URL per request, `orderType` / donation fields, payer IP via header |
| `apps/api/src/webhooks/*` | `/webhooks/moonpay`, MoonPay parsing, transaction-id pinning, stage-aware failures |
| `packages/shared-types/src/money.ts` | `decimalStringFromNumber`; `LKR` added |
| `packages/shared-types/src/order-status.ts` | pre-settlement failures reachable from any pre-settlement state |
| `packages/database/src/schema.ts` | `order_type`, `donation_campaign`, `donor_name_enc`, CHECKs, index |
| `apps/web/src/lib/payment-config.ts` | MoonPay's fiat list with per-currency limits |
| `scripts/smoke.mjs` | rewritten; 63 assertions |
| `scripts/erasure-check.mjs` | now covers the encrypted donor name and campaign survival |
| `scripts/seed.sql` | third destination for sandbox rehearsal on Ethereum |

**Unchanged, and deliberately so** — the whole point of the provider boundary:
`orders`, `order_status_history`, `provider_events`, `outbox`, `data_subjects`,
`payout_destinations`, crypto-shredding, erasure, the outbox pattern, the
idempotency model, and the `RANK` / `ALLOWED` state machine (bar the one edge
above).

---

## 11. Rollback

There is no partial rollback. Stripe is gone from the tree and migration 0004
dropped its column.

To revert, restore the commit before this migration and run the database back to
`0002`. **`provider_client_secret` values are not recoverable** — but they refer
to Stripe sessions that no longer exist on Stripe's side either, so nothing
payable is lost. Orders created under MoonPay keep their rows; their
`provider_order_id` will hold a MoonPay transaction id that Stripe cannot resolve,
so treat them as terminal and reconcile by hand.

The realistic failure mode is not "roll back the code" but "MoonPay says no in
§8". That is why §8 runs in parallel with everything else, starting on day one.
