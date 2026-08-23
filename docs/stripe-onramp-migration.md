# Onramp provider: Transak → Stripe

**Date:** 2026-08-20
**Scope:** the fiat→crypto leg only. Order model, money handling, state machine,
PII/erasure design and the payout allowlist are unchanged.

The original design report (`transak_zebpay_card_to_crypto_simple_report_updated.md`)
specified Transak. This records what actually changed, what Stripe constrains that
Transak did not, and what has *not* been verified.

Everything here was checked against Stripe's live documentation on 2026-08-20:
[the onramp overview](https://docs.stripe.com/crypto/onramp),
[the embedded integration](https://docs.stripe.com/crypto/onramp/embedded),
[the Stripe-hosted integration](https://docs.stripe.com/crypto/onramp/stripe-hosted),
[the create-session reference](https://docs.stripe.com/api/crypto/onramp_sessions/create),
and [webhook signature verification](https://docs.stripe.com/webhooks#verify-manually).

---

## 1. Read this before planning around it

Three constraints are properties of Stripe's product, not of this implementation.
They cannot be engineered away.

### The onramp is application-gated, including sandboxes

Nothing works — not even test keys — until an application at
<https://dashboard.stripe.com/crypto-onramp/get-started> is approved. Stripe reviews
most within 48 hours.

Because of that gate, **no code here has ever run against Stripe's real onramp API.**
It has been verified against `scripts/stripe-stub.mjs`, which speaks the same HTTP
contract. Stripe's real browser SDK *has* been exercised: the widget loads from
`js.stripe.com` and `crypto-js.stripe.com` and mounts its iframe correctly.

### EU and US only, USD and EUR only

The embedded onramp is documented as available in the EU and the US (excluding
Hawaii). `source_currency` accepts `usd` and `eur` and nothing else. Session
creation returns HTTP 400 `crypto_onramp_unsupportable_customer` for a payer whose
IP is outside the supported footprint.

**A Sri Lankan customer cannot pay through this flow.** Neither can an Indian,
Australian or Singaporean one. If those geographies matter, they need a second
gateway — see [`payment-gateway-2d-cards-sri-lanka.md`](payment-gateway-2d-cards-sri-lanka.md).

The storefront's currency list was cut from five currencies to USD/EUR to match
(`apps/web/src/lib/payment-config.ts`), and the gateway rejects an unfundable
currency at order creation rather than at the payment step.

### "2D cards" is not a setting Stripe exposes

A 2D card is one authorised without a 3-D Secure challenge. Whether 3DS is invoked
is decided by the issuer, the scheme's regional mandates, and Stripe's own risk
engine — not by any onramp parameter. In the EU, SCA makes a challenge effectively
mandatory. In the US it is risk-based, so most US card payments will complete
without one.

So: **US customers will frequently get a 2D-style frictionless flow; EU customers
will not; and no configuration changes that.** A gateway that reliably accepts 2D
cards is a different product in a different market, which is what the companion
document is about.

### USDC, not USDT

Stripe's published availability table for the onramp lists USDC on Polygon,
Ethereum, Solana, Avalanche, Base and Stellar. It does **not** list USDT, although
`usdt` does appear in the create-session `destination_currency` enum.

The storefront therefore defaults to **USDC (Polygon)**. `scripts/seed.sql` seeds
approved payout destinations for both USDC and USDT so either can be enabled, but
USDT stays out of `SUPPORTED_CRYPTO_OPTIONS` until Stripe confirms it in writing
for the account and geographies in question.

---

## 2. What changed in the code

| Before | After |
|---|---|
| `packages/providers/transak` | `packages/providers/stripe-onramp` (deleted / added) |
| `buildCheckoutUrl()` → a redirect URL | `createOnrampSession()` → `POST /v1/crypto/onramp_sessions` |
| `disableWalletAddressForm=true` | `lock_wallet_address=true` |
| `partnerOrderId` query param | `metadata[partner_order_id]` |
| Two possible signing schemes behind `TRANSAK_WEBHOOK_SCHEME` | One documented scheme, no switch |
| `POST /webhooks/transak`, 401 on bad signature | `POST /webhooks/stripe`, 400 |
| Redirect to a third-party page | Widget embedded on `/checkout/onramp/[reference]` |
| `TRANSAK_*` env vars | `STRIPE_*` env vars |

New: `apps/web/src/components/onramp-widget.tsx`,
`apps/web/src/app/checkout/onramp/[reference]/page.tsx`,
`scripts/stripe-stub.mjs`, `GET /orders/:reference/onramp-session`,
`orders.provider_client_secret` (migration `0002_faithful_sleeper`).

The module-boundary lint rule did its job: the provider swap touched one package
plus the seams into it. No domain logic moved.

### Why embedded rather than Stripe-hosted

The Stripe-hosted standalone page at `crypto.link.com` **takes no return URL.** A
customer sent there has no supported path back to the order. `hosted` mode still
exists behind `STRIPE_ONRAMP_MODE` and returns Stripe's `redirect_url`, but
`embedded` is the default and the one the storefront is built around.

### Status mapping

| Stripe session status | Order status |
|---|---|
| `initialized` | `CHECKOUT_OPENED` |
| `rejected` | `KYC_FAILED` |
| `requires_payment` | `PAYMENT_PENDING` |
| `fulfillment_processing` | `PAYMENT_CONFIRMED` |
| `fulfillment_complete` | `COMPLETED` |

Anything else maps to `null` and the order is escalated to `MANUAL_REVIEW` — never
guessed at, never silently dropped.

Two consequences worth knowing:

- **`CRYPTO_CONVERTED` and `CRYPTO_SENT` are never observed.** Stripe reports one
  fulfilment state and then completion. Those statuses remain in the state machine
  (a future provider may report them) and the forward-skip rule already permits
  jumping past them.
- **`COMPLETED` means Stripe confirmed delivery**, not that Binance credited the
  deposit. `orders.binance_credited` is still unset by anything; closing that gap
  belongs to the reconciliation worker.

### One state machine change

`KYC_FAILED` is now reachable from `CREATED`, `CHECKOUT_OPENED` and
`PAYMENT_PENDING`, not only from `KYC_PENDING`.

Stripe screens the payer inside its own flow and reports a single `rejected` status
covering KYC failure, sanctions screening and fraud checks. We never see a
`KYC_PENDING` of our own, so the rejection lands on whatever state the order is
already in. Without this edge every legitimately-rejected payer would have been
routed to `MANUAL_REVIEW` instead of recording why they were declined.

### One control that is new, not ported

The webhook handler re-checks `transaction_details.wallet_address` against the
approved `payout_destinations` row and escalates a mismatch to `MANUAL_REVIEW`
instead of advancing the order. `lock_wallet_address=true` should make that
impossible; "should be impossible" is not a control.

---

## 3. Verification

Run against a live Postgres with the API up:

| Check | Command | Result |
|---|---|---|
| Build, all packages | `pnpm build` | clean (see caveat) |
| Lint + module boundaries | `pnpm lint` | clean |
| End-to-end | `pnpm smoke` | **33 / 33** |
| PII erasure | `pnpm check:erasure` | **12 / 12** |
| Browser flow | manual | product → checkout → order → widget mounted → webhooks → `COMPLETED` |

The smoke suite covers, among others: wallet-address locking asserted at the
provider, order reference travelling as metadata, Stripe-side idempotency (a
retried create does not mint a second session), unfundable currency and
unsupportable geography both rejected at creation, forged signature, stale
timestamp, `v0`-only signature, **multiple `v1` signatures during a secret roll**,
duplicate delivery, out-of-order delivery, an unrelated event type being ignored
rather than escalated, misdelivery escalation, unknown status escalation, lookup by
session id when metadata is absent, the client secret being withheld once the order
is terminal, and an 18-decimal-padded settlement amount being stored at the asset's
own 6-decimal precision.

**Caveat:** `pnpm build` fails in `apps/web` on this machine — the Next.js 16 static
generation worker exits with `3221226505` (`STATUS_STACK_BUFFER_OVERRUN`). This
reproduces on the pre-change commit and is unrelated to the migration. `next dev`
and `tsc --noEmit` are both clean, and the flow was verified in a browser against
the dev server.

---

## 4. Still open

1. **Nothing has run against the real onramp API.** Re-run `pnpm smoke` with
   `STRIPE_API_BASE_URL` removed once the application is approved, and compare a
   real session response against `scripts/stripe-stub.mjs`.
2. **`kyc_details` pre-population is not implemented.** Stripe accepts name, email,
   DOB and address to reduce checkout friction. It is deliberately not sent: this
   platform's design is to hold as little payer PII as possible, and forwarding it
   would mean collecting it first. Revisit only if conversion data justifies it.
3. **Quote lock is still unbuilt.** `GET /v1/crypto/onramp/quotes` is the endpoint;
   see Step 4 of `implementation-status.md`.
4. **Chargeback ingestion.** Stripe is merchant of record and says it assumes
   dispute liability. Get the boundary of that in writing before assuming the
   `DISPUTED` → `CHARGEBACK_RECEIVED` → `REVERSED` path will ever be driven by a
   Stripe event at all.
