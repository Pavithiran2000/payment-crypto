# Payment Platform — Implemented Architecture

This document describes the **as-built** architecture of `payment-platform`, the merged monorepo
that connects the `apps/web` storefront to the `apps/api` crypto payment gateway. It reflects the
actual code in this repository (verified against source, not the original plan) as of this
implementation. See `PAYMENT_INTEGRATION_PLAN.md` for the design rationale and phase history.

---

## 1. Components

| Component | Path | Role |
|---|---|---|
| **Storefront (Next.js)** | `apps/web` | Public-facing catalog/checkout UI. App Router, port `3001`. |
| **Web BFF (Route Handlers)** | `apps/web/src/app/api/**` | Server-only proxy between the browser and the gateway. Holds the shared secret and merchant ID; the browser never sees either. |
| **Payment Gateway API (NestJS)** | `apps/api` | Owns orders, payout destinations, and the Transak integration. Fastify adapter, port `3000`. |
| **Webhook ingestion** | `apps/api/src/webhooks` | Verifies and records Transak's signed status callbacks; the *only* writer of order status. |
| **Provider adapter** | `packages/providers/transak` | Builds the hosted-checkout URL, verifies webhook signatures, maps Transak's status vocabulary to internal `OrderStatus`. |
| **Database layer** | `packages/database` | Drizzle ORM + Postgres schema: `orders`, `payoutDestinations`, `orderStatusHistory`, `providerEvents`, `outbox`, `dataSubjects`. Per-order PII encryption (DEK-wrapped). |
| **Shared types** | `packages/shared-types` | Zero-dependency package: `OrderStatus` state machine, `Money` (bigint decimal) helpers, currency/asset decimal tables. Imported by both `apps/api` and `apps/web`. |
| **Transak (external)** | — | Hosted checkout (card → crypto on-ramp) and the only source of payment-status truth, delivered via signed webhook. |
| **Binance Entity Account (external)** | — | Fixed settlement destination; the customer never chooses it (`disableWalletAddressForm=true`). |

---

## 2. Full architecture — components, data flow, trust boundaries

```mermaid
flowchart TB
    subgraph untrusted["🔴 UNTRUSTED — Browser / Public Internet"]
        Browser["Customer browser<br/>apps/web pages"]
    end

    subgraph webTrust["🟡 apps/web — Next.js (port 3001)"]
        direction TB
        UI["Client components<br/>product-purchase.tsx<br/>checkout-form.tsx<br/>order-status-tracker.tsx"]
        subgraph bff["Server-only BFF layer (import 'server-only')"]
            CheckoutRoute["POST /api/checkout<br/>route.ts — re-validates price/qty/currency/asset,<br/>recomputes total server-side"]
            OrderRoute["GET /api/orders/[reference]<br/>route.ts — trims response to status fields"]
            PaymentApi["lib/payment-api.ts<br/>holds PAYMENT_API_KEY + PAYMENT_MERCHANT_ID<br/>never exposed to client bundle"]
        end
    end

    subgraph apiTrust["🟢 apps/api — NestJS/Fastify gateway (port 3000)"]
        direction TB
        ApiKeyGuard["ApiKeyGuard<br/>timingSafeEqual(X-API-Key)<br/>guards ALL /orders* routes"]
        OrdersController["OrdersController<br/>POST /orders, GET /orders/:reference"]
        OrdersService["OrdersService<br/>idempotency check → payout-destination lookup<br/>→ insert order → build checkout URL"]
        WebhooksController["WebhooksController<br/>POST /webhooks/transak<br/>NOT guarded by ApiKeyGuard —<br/>trusts only its own signature check"]
        WebhooksService["WebhooksService<br/>verifyWebhook() → persist providerEvents (unique)<br/>→ canTransition() → moveTo() → outbox"]
        DB[("Postgres<br/>orders, payoutDestinations,<br/>orderStatusHistory, providerEvents, outbox")]
    end

    subgraph providerTrust["🔵 External — Transak / Binance"]
        TransakHosted["Transak hosted checkout<br/>(global.transak.com)"]
        Binance["Binance Entity Account<br/>(fixed payout address)"]
    end

    Browser -->|"1 fills checkout form"| UI
    UI -->|"2 POST /api/checkout (no secrets)"| CheckoutRoute
    CheckoutRoute --> PaymentApi
    PaymentApi -->|"3 POST /orders<br/>X-API-Key + Idempotency-Key headers"| ApiKeyGuard
    ApiKeyGuard --> OrdersController --> OrdersService
    OrdersService <-->|"lookup destination, insert order"| DB
    OrdersService -->|"4 checkoutUrl (partnerOrderId, walletAddress,<br/>disableWalletAddressForm=true)"| OrdersController
    OrdersController -->|"5"| PaymentApi --> CheckoutRoute -->|"{reference, checkoutUrl} only"| UI
    UI -->|"6 window.location.href = checkoutUrl"| Browser
    Browser -->|"7 redirected to hosted checkout"| TransakHosted
    TransakHosted -->|"8 card payment, KYC, conversion"| TransakHosted
    TransakHosted -->|"9 settles crypto to fixed address"| Binance
    TransakHosted -.->|"10 signed webhook (HMAC/JWT)<br/>— sole source of status truth"| WebhooksController
    WebhooksController --> WebhooksService
    WebhooksService <-->|"verify, dedupe, canTransition, moveTo"| DB
    TransakHosted -->|"11 browser redirect (NOT trusted)<br/>TRANSAK_REDIRECT_URL"| Browser
    Browser -->|"12 lands on /checkout/return"| UI
    UI -->|"13 poll GET /api/orders/[reference] every 4s"| OrderRoute
    OrderRoute --> PaymentApi -->|"GET /orders/:reference"| ApiKeyGuard --> OrdersController --> OrdersService --> DB

    classDef untrustedStyle fill:#ffe3e3,stroke:#c92a2a,color:#000
    classDef bffStyle fill:#fff9db,stroke:#e8590c,color:#000
    classDef apiStyle fill:#d3f9d8,stroke:#2b8a3e,color:#000
    classDef extStyle fill:#d0ebff,stroke:#1864ab,color:#000
    class Browser untrustedStyle
    class UI,CheckoutRoute,OrderRoute,PaymentApi bffStyle
    class ApiKeyGuard,OrdersController,OrdersService,WebhooksController,WebhooksService,DB apiStyle
    class TransakHosted,Binance extStyle
```

### Trust boundaries, explicitly

1. **Browser ↔ apps/web (untrusted → app boundary).** Every field in the `POST /api/checkout`
   body is treated as attacker-controlled (`route.ts` comment: *"Every value below is
   attacker-controlled"*). Product existence, price, quantity, currency, and crypto/network
   combination are all re-validated against server-known constraints before anything is
   forwarded. The **total is recomputed** server-side as `price × quantity`, not trusted as a
   pre-formatted string, because this storefront sells custom-quoted goods with no fixed catalog
   price.

2. **apps/web ↔ apps/api (BFF → gateway boundary).** This is the boundary the whole merge was
   built around. `lib/payment-api.ts` is marked `import "server-only"` so bundlers refuse to ship
   it to the client. It is the **only** place `PAYMENT_API_KEY` and `PAYMENT_MERCHANT_ID` exist.
   The gateway enforces this boundary independently with `ApiKeyGuard`, a constant-time
   (`timingSafeEqual`) shared-secret check on `X-API-Key`, applied to the whole `OrdersController`
   (both `POST /orders` and `GET /orders/:reference`). A request with a missing or wrong key never
   reaches `OrdersService`.

3. **apps/api response ↔ apps/web (data-minimization boundary).** The gateway's `OrderResponse`
   is not passed straight through. `/api/checkout` returns only `{ reference, checkoutUrl }`;
   `/api/orders/[reference]` returns only status-relevant fields (reference, status, amount,
   currency, asset, network) — no internal IDs, no PII.

4. **Browser redirect ↔ webhook (the trust model's core boundary).** The Transak redirect landing
   on `/checkout/return` is a **navigation event, not proof of payment** — it is never used to
   advance order status. Only `POST /webhooks/transak`, verified via `verifyWebhook()`
   (HMAC-header or JWT-body scheme, configured per `TRANSAK_WEBHOOK_SCHEME`), can move an order
   forward. This is enforced at two independent layers: the webhook route rejects unverifiable
   payloads (401), and `OrdersController`'s `GET /orders/:reference` handler comment states
   explicitly it only ever reads a value **only a verified webhook writes**.

5. **Webhook controller is intentionally *not* behind `ApiKeyGuard`.** `WebhooksController` is a
   separate `@Controller('webhooks')`, not decorated with `@UseGuards(ApiKeyGuard)` — Transak
   cannot present the web BFF's shared secret, so the webhook route authenticates purely via
   signature verification against `rawBody`. Confirmed by reading `app.module.ts`: `ApiKeyGuard`
   is registered as an injectable provider (constructor-injected into `OrdersController`), not as
   an `APP_GUARD`, so it applies only where explicitly attached.

6. **apps/api ↔ Postgres (data boundary).** Customer email is never stored as plaintext — each
   order gets its own `dataSubjects` row with a wrapped DEK; `customerEmailEnc` is
   application-layer encrypted, with a separate `customerEmailIdx` blind index for lookup.

7. **apps/api ↔ Transak/Binance (settlement boundary).** `buildCheckoutUrl` sets
   `disableWalletAddressForm=true` and passes a `walletAddress` sourced only from an **approved,
   unrevoked, active** row in `payoutDestinations` — the payer can never redirect settlement to
   their own address.

---

## 3. Payment sequence flow

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer (Browser)
    participant Web as apps/web UI<br/>(checkout-form.tsx)
    participant BFF as apps/web BFF<br/>(/api/checkout)
    participant API as apps/api<br/>(OrdersController/Service)
    participant DB as Postgres
    participant TX as Transak hosted checkout
    participant WH as apps/api<br/>(WebhooksController/Service)

    C->>Web: Fill contact/billing form, pick USDT/Polygon
    Note over Web: idempotencyKey generated ONCE via<br/>useState(() => crypto.randomUUID())<br/>reused across retries
    Web->>BFF: POST /api/checkout {productSlug, price, qty,<br/>currency, cryptoAsset, network, idempotencyKey}
    Note over BFF: Re-validate everything.<br/>fiatAmount = (price*qty).toFixed(2)
    BFF->>API: POST /orders<br/>X-API-Key, Idempotency-Key headers<br/>{merchantId, fiatAmount, fiatCurrency, cryptoAsset, network}
    API->>API: ApiKeyGuard.canActivate() — timingSafeEqual
    API->>DB: findFirst WHERE merchantId + idempotencyKey
    alt existing order found
        DB-->>API: existing order row
    else new order
        API->>DB: findFirst approved+active payoutDestination
        alt no destination
            API-->>BFF: 400 "No approved and active payout destination"
            BFF-->>Web: 400 error
            Web-->>C: inline error message
        else destination found
            API->>DB: BEGIN TX: insert dataSubjects, insert orders (status=CREATED),<br/>insert orderStatusHistory
            API->>API: buildCheckoutUrl(partnerOrderId, walletAddress,<br/>disableWalletAddressForm=true, redirectURL)
        end
    end
    API-->>BFF: 200 {reference, checkoutUrl, ...}
    BFF-->>Web: 200 {reference, checkoutUrl}
    Web->>C: window.location.href = checkoutUrl
    C->>TX: GET hosted checkout (card entry, KYC, conversion)
    TX->>TX: Process card payment → KYC → convert to crypto
    TX->>WH: POST /webhooks/transak (signed HMAC/JWT, rawBody)
    WH->>WH: verifyWebhook(scheme, secret, rawBody, headers)
    alt signature invalid
        WH-->>TX: 401 signature verification failed
    else signature valid
        WH->>DB: insert providerEvents (unique externalEventId)
        alt duplicate delivery
            DB-->>WH: unique_violation (23505)
            WH-->>TX: 200 {received:true, duplicate:true}
        else new event
            WH-->>TX: 200 {received:true, duplicate:false}
            WH->>WH: process(event) — async, post-response
            WH->>DB: SELECT order FOR UPDATE (row lock)
            WH->>WH: canTransition(order.status, mapped target)
            alt not allowed / backwards
                WH->>DB: moveTo MANUAL_REVIEW (if illegal, not if stale/duplicate)
            else allowed
                WH->>DB: UPDATE orders.status, insert orderStatusHistory, insert outbox
            end
        end
    end
    TX-->>C: browser redirect to TRANSAK_REDIRECT_URL (NOT trusted as proof)
    C->>Web: GET /checkout/return?partnerOrderId=...
    Web->>Web: probe candidate query keys, redirect to /orders/[reference]
    loop every 4000ms until isTerminal(status)
        Web->>BFF: GET /api/orders/[reference]
        BFF->>API: GET /orders/:reference (X-API-Key)
        API->>DB: findFirst orders WHERE reference
        API-->>BFF: {status, fiatAmount, fiatCurrency, cryptoAsset, network}
        BFF-->>Web: trimmed status payload
        Web-->>C: render STATUS_COPY[status]
    end
```

Key properties this sequence encodes:
- **Exactly-once order creation** — `(merchantId, idempotencyKey)` is the dedupe key; a client
  retry after a network blip returns the original order rather than creating a duplicate.
- **Webhook processing is decoupled from the HTTP response** — `ingest()` acknowledges the
  provider immediately after persisting the raw event, then processes asynchronously
  (`void this.process(...)`), so a slow DB never causes Transak to see a timeout and retry a
  webhook already on file.
- **Row-level locking** (`SELECT ... FOR UPDATE`) serializes concurrent webhooks for the same
  order, preventing lost updates when Transak delivers out-of-order or overlapping events.
- **The browser redirect and the status page are read-only observers** — nothing the browser does
  after leaving `apps/web` can change an order's status; only the webhook path writes it.

---

## 4. Order status state machine

Source of truth: `packages/shared-types/src/order-status.ts`, shared unmodified by both
`apps/api` (writes it) and `apps/web` (reads it, via `isTerminal()` in `order-status-tracker.tsx`).

```mermaid
stateDiagram-v2
    [*] --> CREATED: OrdersService.create()

    CREATED --> CHECKOUT_OPENED
    CREATED --> CANCELLED
    CREATED --> EXPIRED
    CREATED --> MANUAL_REVIEW

    CHECKOUT_OPENED --> KYC_PENDING
    CHECKOUT_OPENED --> CANCELLED
    CHECKOUT_OPENED --> EXPIRED
    CHECKOUT_OPENED --> MANUAL_REVIEW

    KYC_PENDING --> PAYMENT_PENDING
    KYC_PENDING --> KYC_FAILED
    KYC_PENDING --> CANCELLED
    KYC_PENDING --> EXPIRED
    KYC_PENDING --> MANUAL_REVIEW

    PAYMENT_PENDING --> PAYMENT_CONFIRMED
    PAYMENT_PENDING --> CARD_DECLINED
    PAYMENT_PENDING --> PAYMENT_FAILED
    PAYMENT_PENDING --> CANCELLED
    PAYMENT_PENDING --> EXPIRED
    PAYMENT_PENDING --> MANUAL_REVIEW

    PAYMENT_CONFIRMED --> CRYPTO_CONVERTED
    PAYMENT_CONFIRMED --> CONVERSION_FAILED
    PAYMENT_CONFIRMED --> MANUAL_REVIEW
    PAYMENT_CONFIRMED --> DISPUTED

    CRYPTO_CONVERTED --> CRYPTO_SENT
    CRYPTO_CONVERTED --> CRYPTO_TRANSFER_FAILED
    CRYPTO_CONVERTED --> MANUAL_REVIEW
    CRYPTO_CONVERTED --> DISPUTED

    CRYPTO_SENT --> COMPLETED
    CRYPTO_SENT --> CRYPTO_TRANSFER_FAILED
    CRYPTO_SENT --> MANUAL_REVIEW
    CRYPTO_SENT --> DISPUTED

    COMPLETED --> DISPUTED
    COMPLETED --> MANUAL_REVIEW
    COMPLETED --> [*]

    KYC_FAILED --> MANUAL_REVIEW
    CARD_DECLINED --> MANUAL_REVIEW
    PAYMENT_FAILED --> MANUAL_REVIEW
    CONVERSION_FAILED --> MANUAL_REVIEW
    CRYPTO_TRANSFER_FAILED --> MANUAL_REVIEW
    CANCELLED --> MANUAL_REVIEW
    EXPIRED --> MANUAL_REVIEW
    KYC_FAILED --> [*]
    CARD_DECLINED --> [*]
    PAYMENT_FAILED --> [*]
    CONVERSION_FAILED --> [*]
    CRYPTO_TRANSFER_FAILED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]

    MANUAL_REVIEW --> COMPLETED: operator resolves
    MANUAL_REVIEW --> CANCELLED: operator resolves
    MANUAL_REVIEW --> REVERSED: operator resolves
    MANUAL_REVIEW --> DISPUTED: operator resolves
    MANUAL_REVIEW --> CHARGEBACK_RECEIVED: operator resolves

    DISPUTED --> CHARGEBACK_RECEIVED
    DISPUTED --> COMPLETED
    DISPUTED --> MANUAL_REVIEW

    CHARGEBACK_RECEIVED --> REVERSED
    CHARGEBACK_RECEIVED --> COMPLETED
    CHARGEBACK_RECEIVED --> MANUAL_REVIEW

    REVERSED --> MANUAL_REVIEW
    REVERSED --> [*]
```

### Rules enforced by `canTransition()`

1. **`RANK` is monotonic and checked first.** `RANK[to] < RANK[from]` is always rejected
   (`reason: 'backwards'`) regardless of whether the edge would otherwise be legal — a late,
   out-of-order `PAYMENT_PENDING` webhook arriving after `COMPLETED` is dropped, not applied.
2. **Forward movement along the main sequence is legal, including skips.** Providers don't
   reliably report every intermediate state (a fast card auth can jump straight to
   `PAYMENT_CONFIRMED` with no observed `CHECKOUT_OPENED`/`PAYMENT_PENDING`); requiring strict
   step-by-step progression would misclassify normal orders as integrity failures.
3. **Every off-sequence edge is explicitly enumerated** in `ALLOWED`. Anything not listed —
   same-state, backwards, or simply undeclared — is rejected. `WebhooksService.process()` routes
   a `not-allowed` rejection to `MANUAL_REVIEW` (an integrity problem, escalated to a human);
   `backwards`/`same-state` rejections are silently dropped (expected under retries/out-of-order
   delivery) and the event is still marked processed.
4. **`TERMINAL` is scoped to the payment flow, not the order's whole life.** `COMPLETED`,
   `KYC_FAILED`, `CARD_DECLINED`, `PAYMENT_FAILED`, `CONVERSION_FAILED`,
   `CRYPTO_TRANSFER_FAILED`, `CANCELLED`, `EXPIRED`, `REVERSED` all stop the frontend's polling
   loop (`isTerminal()` in `order-status-tracker.tsx`) — but `COMPLETED` can still transition to
   `DISPUTED`/`MANUAL_REVIEW` later (e.g., a chargeback 120 days out), which is why those two are
   ranked *above* `COMPLETED` rather than being unreachable from it.
5. **Unrecognized provider statuses never guess.** If `mapTransakStatus()` returns `null` for an
   unmapped value, the order goes straight to `MANUAL_REVIEW` rather than being silently ignored
   or misapplied.

---

## 5. Summary of enforced invariants

| Invariant | Where enforced |
|---|---|
| Browser never sees `PAYMENT_API_KEY` / `PAYMENT_MERCHANT_ID` | `server-only` import in `lib/payment-api.ts`; both env vars read only inside Route Handlers |
| Gateway only accepts requests from the trusted BFF | `ApiKeyGuard` (`timingSafeEqual`) on `OrdersController` |
| No duplicate orders from client retries | `(merchantId, idempotencyKey)` uniqueness check in `OrdersService.create()` |
| No duplicate webhook processing | Unique `externalEventId` constraint on `providerEvents`, caught via Postgres `23505` |
| Settlement address cannot be redirected by the payer | `disableWalletAddressForm=true` + `walletAddress` sourced only from an approved `payoutDestinations` row |
| Order status can only move forward, or along an explicit exception edge | `RANK` check + `ALLOWED` table in `canTransition()` |
| Browser navigation is never treated as payment proof | `/checkout/return` only redirects to the status page; status itself is written only by `WebhooksService` |
| Concurrent webhooks for one order can't race | `SELECT ... FOR UPDATE` row lock in `WebhooksService.process()` |
| Currency/asset choices on the storefront can never exceed what the gateway can actually settle | `SUPPORTED_FIAT_CURRENCIES` / `SUPPORTED_CRYPTO_OPTIONS` in `apps/web/src/lib/payment-config.ts`, kept in sync with seeded `payoutDestinations` |
