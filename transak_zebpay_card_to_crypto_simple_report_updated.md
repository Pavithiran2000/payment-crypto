# Card Payment to Crypto Wallet  
## Simple Technical Report — Transak Enterprise → Binance Entity Account

**Project type:** Card-funded fiat-to-crypto payment platform  
**Main providers:** Transak Enterprise and Binance (Entity Account)  
**Development mode:** Sandbox first, then controlled live pilot  

---

## 1. Introduction

The purpose of this project is to allow a customer from a supported country to pay using a credit or debit card. Transak will process the card payment, complete customer KYC/AML checks, convert the fiat amount into crypto, and send the crypto to an approved Binance Entity Account.

Your platform will not handle card details, hold customer money, convert fiat into crypto, or store crypto private keys. It will only create orders, open the Transak checkout, receive payment updates, store transaction records, send notifications, and create a blockchain audit proof.

### Main flow

```text
Customer
   ↓
Your Checkout
   ↓
Transak Enterprise
   ↓
Card Payment + KYC/AML
   ↓
Fiat-to-Crypto Conversion
   ↓
Binance Entity Account
   ↓
Webhook to Your Platform
   ↓
Transaction Record + Blockchain Audit
```

---

## 2. Main Objective

The system must:

- accept card payments from supported countries;
- use Transak Hosted Checkout;
- allow Transak to complete customer KYC/AML;
- convert fiat into an approved crypto asset;
- send the crypto to an approved Binance Entity Account destination;
- receive signed Transak webhooks;
- store transaction details in PostgreSQL;
- send email notifications using Brevo; and
- store only a transaction hash on blockchain for audit.

---

## 3. Important Business Requirement

The required live flow is:

```text
Customer A pays with Customer A's card
               ↓
Crypto is delivered to Company B's Binance Entity Account
```

This is not a normal personal crypto purchase flow.

Before live implementation, Transak and Binance must confirm in writing that they support:

1. the payer and receiving wallet owner being different;
2. a corporate beneficiary (Binance Entity Account);
3. payments from multiple international customers;
4. the selected crypto and network;
5. required sender and beneficiary information;
6. transaction and monthly limits; and
7. chargeback responsibility.

A successful sandbox test does not mean the live business model is approved.

---

## 4. Simple Architecture

```text
┌───────────────────────────────┐
│ Customer Web / Mobile Browser │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Next.js Checkout              │
│ Order, amount, currency       │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ NestJS Backend API            │
│ Create order and Transak link │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Transak Hosted Checkout       │
│ Card + 3DS + KYC/AML          │
│ Fiat-to-crypto conversion     │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Binance Entity Account        │
│ Receives approved crypto      │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Transak Webhook               │
│ Status + amount + TxID        │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ PostgreSQL                    │
│ Orders and transactions       │
└───────┬───────────────────────┘
        ├── Brevo email
        └── Blockchain audit hash
```

---

## 5. Recommended Technology

| Area | Recommended technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Frontend | Next.js App Router |
| Backend | NestJS using the Fastify adapter |
| Monorepo | pnpm workspaces + Nx |
| Database | PostgreSQL |
| Email | Brevo Transactional Email API |
| Customer KYC | Transak |
| Merchant KYB | Sumsub |
| VDA custodian | Binance Entity Account |
| Blockchain test | Polygon Amoy |
| Blockchain live | Polygon PoS |
| Hosting | Render, Railway, AWS, Azure or another managed platform |

### Why this stack

- **TypeScript** keeps frontend, backend and shared models consistent.
- **Node.js 24 LTS** provides the stable production runtime.
- **Next.js** is used for checkout and merchant/admin pages.
- **NestJS with Fastify** is used for APIs, integrations and webhooks.
- **pnpm + Nx** keeps applications and shared packages organised.
- Start as a modular monolith; microservices are not needed for the first version.

### Simple Nx monorepo structure

```text
payment-platform/
├── apps/
│   ├── web/                 # Next.js checkout and merchant UI
│   ├── admin/               # Next.js administrator dashboard
│   └── api/                 # NestJS + Fastify backend
│
├── packages/
│   ├── shared-types/        # Shared TypeScript models
│   ├── database/            # PostgreSQL schema and access
│   ├── transak/             # Transak integration
│   ├── sumsub/              # Merchant KYB integration
│   ├── brevo/               # Email integration
│   └── blockchain/          # Polygon audit-hash integration
│
├── nx.json
├── pnpm-workspace.yaml
└── package.json
```

### Simple module boundaries

```text
Web/Admin → API contracts and shared types
API       → domain logic and provider packages
Domain    → must not directly depend on provider SDKs
Providers → Transak, Sumsub, Brevo and Polygon only
          → Binance is not a called API: it is only an allow-listed deposit
            address stored in payout_destinations (see 6.4)
Database  → backend access only; never frontend access
```

Nx module-boundary rules should prevent frontend and core business packages from directly importing provider SDKs.

---

## 6. Essential Features

### 6.1 Customer checkout

The customer must be able to:

- see the order amount;
- select a supported fiat currency;
- see the estimated crypto amount;
- review fees;
- proceed to Transak Hosted Checkout; and
- see payment success, pending or failed status.

### 6.2 Order management

Your backend must:

- create a unique order ID;
- store the amount and currency;
- store the selected crypto and network;
- connect the internal order with the Transak order;
- prevent duplicate orders; and
- track the current transaction status.

### 6.3 Webhook processing

Your backend must:

- receive Transak webhooks;
- verify the webhook signature;
- reject duplicate or invalid events;
- update the payment status;
- save the provider transaction ID;
- save the blockchain transaction hash; and
- send the customer or merchant notification.

### 6.4 Binance destination

The receiving custodian is **Binance**, via a **Binance Entity Account** — Binance's
corporate/KYB account type. Never a personal Binance account: a personal account is for an
individual's own trading, and routing continuous, third-party-funded, business-purpose deposits
through one very likely breaches Binance's personal-account Terms of Service (business use
through a retail account), independent of any Travel Rule question, and risks account suspension.

The platform never calls a custodian API directly — there is no `packages/binance` webhook/SDK
integration, and none is planned. The destination is just an allow-listed deposit address (see
below), which is what makes the custodian swappable by configuration rather than by rebuild. See
the full field-level requirements in `CLIENT_CREDENTIALS_REQUEST.md` §2.

The system must store:

- Binance Entity Account reference;
- approved deposit address;
- selected crypto;
- selected network;
- wallet status;
- transaction hash; and
- credited status.

Never store a seed phrase or private key.

**Precondition, per §3:** the live flow requires the payer (the card-paying customer) and the
beneficiary (your Binance Entity Account) to be different parties. This needs **written
confirmation from both Transak and Binance** that they support that model for your account before
any live traffic is pointed at it.

**Considerations specific to Binance:**

- **Travel Rule screening on every deposit.** Binance participates in the Global Travel Rule (GTR)
  Alliance and checks incoming transfers for FATF-required originator/beneficiary data. Because
  every deposit in this flow is customer-paid but corporate-owned, every single transaction is a
  potential originator/beneficiary mismatch — not an occasional edge case. Binance's own support
  documentation states that if Travel Rule information is missing or unverifiable, "users may be
  asked to provide sender information, and if it is not provided, access to the received crypto
  may be restricted or denied."
- **Screening/hold risk at volume.** Binance's post-2023 enhanced KYT (Know Your Transaction)
  monitoring routes flagged deposits into manual review, which can extend to weeks for larger or
  more complex exposures. This is an operational risk this platform's "confirm quickly via
  webhook" design does not currently account for.
- **Confirm which Binance legal entity holds the account** and under which jurisdiction's terms —
  Binance is registered with India's FIU-IND as a Reporting Entity (AML reporting), which is not
  RBI/SEBI licensing; Binance itself states user funds are not bank-protected. This affects dispute
  resolution and asset recovery if something goes wrong.

**Recommendation:** do not go live without (1) a Binance Entity Account already approved, (2)
written confirmation from Transak and Binance supporting the payer≠beneficiary model for that
account, and (3) a direct answer from Binance on how their Travel Rule/KYT screening will treat
recurring Transak-originated corporate deposits at expected volume.

### 6.5 Merchant KYB

Use Sumsub only for the client company and its authorised persons.

Check:

- company registration;
- company documents;
- directors;
- authorised representative;
- ultimate beneficial owners;
- PEP and sanctions status; and
- business verification status.

Transak remains responsible for the card-paying customer's KYC.

### 6.6 Email notifications

Use Brevo for:

- email verification;
- merchant onboarding status;
- payment initiated;
- payment completed;
- payment failed;
- crypto sent;
- delayed transaction; and
- receipt.

Do not send KYC documents, card information, API keys or private wallet information through email.

---

## 7. Transaction Statuses

Use a simple status flow:

```text
CREATED
   ↓
CHECKOUT_OPENED
   ↓
KYC_PENDING
   ↓
PAYMENT_PENDING
   ↓
PAYMENT_CONFIRMED
   ↓
CRYPTO_CONVERTED
   ↓
CRYPTO_SENT
   ↓
COMPLETED
```

Failure statuses:

```text
KYC_FAILED
CARD_DECLINED
PAYMENT_FAILED
CONVERSION_FAILED
CRYPTO_TRANSFER_FAILED
MANUAL_REVIEW
CANCELLED
```

The browser success page must not directly mark the order as completed. The final status must come from a verified webhook.

---

## 8. Important Database Tables

Only these main tables are required initially:

```text
users
merchants
orders
transactions
wallets
provider_events
notifications
audit_records
```

### Important transaction fields

- internal order ID;
- Transak order ID;
- fiat amount;
- fiat currency;
- crypto amount;
- crypto asset;
- network;
- masked wallet address;
- transaction status;
- blockchain transaction hash;
- Binance credit status;
- provider reference;
- created time; and
- completed time.

---

## 9. Security Requirements

The first version must include:

- HTTPS for all pages and APIs;
- Transak Hosted Checkout;
- no card-data storage;
- webhook signature verification;
- secure environment variables;
- database encryption;
- administrator login with two-factor authentication;
- role-based access;
- API rate limiting;
- audit logs;
- regular backups; and
- error monitoring.

Never store or request:

- full card number;
- CVV;
- card PIN;
- wallet seed phrase;
- wallet private key;
- provider password; or
- customer KYC documents unless legally required.

---

## 10. Blockchain Security

Blockchain should be used only to prove that transaction records were not changed.

### Simple audit flow

```text
Completed Transaction
        ↓
Remove Personal Data
        ↓
Create SHA-256 Hash
        ↓
Store Hash on Polygon
        ↓
Save Polygon TxID in PostgreSQL
```

### Store on blockchain

- transaction hash;
- internal transaction reference hash;
- timestamp; and
- record version.

### Do not store on blockchain

- customer name;
- email;
- phone number;
- card details;
- KYC information;
- full wallet address; or
- full transaction payload.

For the first MVP, storing one transaction hash at a time is acceptable. Merkle tree batching can be added later when transaction volume increases.

---

## 11. Sandbox Testing

### Required test accounts

- Transak Staging
- Sumsub Sandbox
- Brevo account
- PostgreSQL database
- Polygon Amoy test wallet
- Polygon RPC provider
- GitHub
- Frontend and backend hosting accounts

### Sandbox workflow

```text
1. Create test merchant
2. Complete Sumsub sandbox KYB
3. Create test order
4. Open Transak staging checkout
5. Complete dummy KYC
6. Use Transak test card
7. Receive test payment result
8. Receive Transak webhook
9. Simulate Binance credit
10. Send Brevo test email
11. Store transaction hash on Polygon Amoy
12. Show test receipt
```

### Important tests

- successful payment;
- failed card;
- failed KYC;
- invalid webhook;
- duplicate webhook;
- unsupported country;
- invalid wallet;
- crypto transfer failure;
- email delivery;
- blockchain audit hash; and
- administrator access control.

---

## 12. Live Provider Responsibilities

### Transak handles

- card payment;
- 3D Secure;
- customer KYC;
- AML and sanctions checks;
- fraud detection;
- fiat collection;
- fiat-to-crypto conversion;
- blockchain transfer; and
- payment webhooks.

### Binance handles

- corporate (Entity) account;
- crypto deposit;
- crypto custody;
- compliance review;
- balance and transaction history; and
- corporate reporting.

### Your platform handles

- checkout interface;
- order creation;
- payment tracking;
- webhook verification;
- database records;
- merchant dashboard;
- Brevo emails;
- blockchain audit hash; and
- reports.

---

## 13. Fees to Consider

### Transak

Possible fees include:

- card-processing fee;
- exchange-rate spread;
- blockchain network fee;
- optional partner fee; and
- country-specific charges.

The final checkout quote must be shown before payment.

### Binance

Possible fees include:

- corporate/entity trading fee;
- applicable local taxes (e.g. GST, TDS, depending on jurisdiction);
- crypto withdrawal fee;
- enhanced KYC/KYB fee; and
- account-specific corporate fees.

Receiving crypto may be free, but Binance's corporate terms must confirm the final pricing.

---

## 14. Main Limitations

1. Transak and Binance must approve the different payer and beneficiary model.
2. Not every country or card will be supported.
3. The crypto asset and network must match exactly.
4. A card transaction may be disputed after crypto has been sent.
5. A provider may delay a transaction for compliance review.
6. Fees and exchange rates can change.
7. Sandbox testing does not prove production approval.
8. Binance Entity Account limits may differ from personal-account retail limits.
9. The project should start with only one crypto asset and one network.
10. No live payment should be enabled before legal and provider approval.

---

## 15. Recommended First Version

Use:

```text
Language:        TypeScript
Runtime:         Node.js 24 LTS
Frontend:        Next.js App Router
Backend:         NestJS + Fastify
Monorepo:        pnpm + Nx
Database:        PostgreSQL
Email:           Brevo
Customer KYC:    Transak
Merchant KYB:    Sumsub
VDA custodian:   Binance Entity Account
Audit chain:     Polygon Amoy
```

Start with:

- one merchant;
- one fiat currency;
- one crypto asset;
- one blockchain network;
- low test amounts;
- manual transaction review; and
- sandbox-only operation.

---

## 16. Implementation Steps

### Phase 1 — Sandbox setup

1. Install Node.js 24 LTS, pnpm and Nx.
2. Create the Nx monorepo.
3. Create the Next.js `web` and `admin` applications.
4. Create the NestJS API using Fastify.
5. Create Transak staging, Sumsub sandbox and Brevo accounts.
6. Create the PostgreSQL database.
7. Create a Polygon Amoy test wallet.
8. Add shared-type and provider-integration packages.

### Phase 2 — Main payment flow

1. Create order API.
2. Add Transak checkout.
3. Add Transak webhook verification.
4. Store transactions.
5. Add mock Binance credit.
6. Show transaction status.

### Phase 3 — Supporting features

1. Add Sumsub merchant KYB.
2. Add Brevo email notifications.
3. Add administrator dashboard.
4. Add blockchain audit hash.
5. Add logs and backups.

### Phase 4 — Live preparation

1. Obtain Transak written approval.
2. Obtain Binance Entity Account approval.
3. Confirm token and network.
4. Confirm limits and fees.
5. Complete legal review.
6. Run a low-value controlled pilot.

---

## 17. Final Recommendation

The simplest suitable architecture is:

```text
Customer Card
      ↓
Transak Enterprise
      ↓
Customer KYC + Card Processing
      ↓
Fiat-to-Crypto Conversion
      ↓
Approved Binance Entity Account
      ↓
Verified Webhook
      ↓
PostgreSQL Record
      ↓
Brevo Receipt + Polygon Audit Hash
```

Build and demonstrate this in sandbox first. Use a simple TypeScript modular monolith inside the pnpm + Nx monorepo; do not add complex microservices, automatic refunds, multiple providers, multiple crypto networks or advanced blockchain contracts in the first version.

The live system should be activated only after Transak and Binance confirm that international customers may fund the corporate (Entity Account) beneficiary.

---

## 18. Official References

- Transak On-Ramp: https://docs.transak.com/products/on-ramp
- Transak Sandbox: https://docs.transak.com/guides/sandbox-credentials
- Transak Webhooks: https://docs.transak.com/features/webhooks
- Binance Entity Verification (KYB): https://www.binance.com/en/support/faq/how-to-complete-entity-verification-kyb-on-binance-step-by-step-guide-360015552032
- Binance Travel Rule: https://www.binance.com/en/learn/travel-rule
- Sumsub Business Verification: https://docs.sumsub.com/docs/verify-businesses
- Brevo Transactional Email: https://developers.brevo.com/docs/send-a-transactional-email
- Polygon RPC and Network Details: https://docs.polygon.technology/pos/reference/rpc-endpoints
