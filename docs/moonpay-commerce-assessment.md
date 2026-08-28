# MoonPay Commerce (Helio) — assessment for card → BTC → Binance

**Written:** 2026-08-28, from the live Helio/MoonPay Commerce docs and its public currency API.

**Companion to** [`btc-only-and-enterprise-assessment.md`](btc-only-and-enterprise-assessment.md), which rejected MoonPay **Enterprise** (Iron) for this use case. Commerce is a different product again, and a far better fit.

---

## Verdict

**Genuinely worth evaluating — it is the closest off-the-shelf match to what this platform hand-builds.** Unlike Enterprise, it clears every hard blocker: it takes **cards**, it supports **native BTC** as both a payment currency and a withdrawal destination, and the merchant nominates the destination wallet.

It may also **dissolve the payer ≠ beneficiary problem** that [`README.md`](../README.md) flags as a binary business risk (§4.3) — which would be the single biggest de-risking available to this project.

**But do not commit before answering one question: is it custodial?** The docs never say. That answer changes the risk profile completely, and §5.1 explains why.

| | Enterprise (Iron) | **Commerce (Helio)** | Standard on-ramp (current) |
|---|---|---|---|
| Card payments | ❌ bank wire only | ✅ | ✅ |
| Native BTC | ❌ stablecoins only | ✅ | ✅ |
| Binance address as destination | ❌ proof-of-ownership blocks it | ⚠️ `WITHDRAWAL_DESTINATION` confirmed on production BTC (§5.2-RESULT-2); exchange-address acceptance still unconfirmed | ⚠️ third-party deposit |
| Anonymous checkout | ❌ pre-onboarded customers | ✅ | ✅ |
| Build effort from here | full rewrite | **moderate rewrite** | **small change** |

---

## 1. First, the thing that reframes this

**Helio is MoonPay.** `docs.hel.io` self-describes as *"MoonPay Commerce"* throughout. MoonPay acquired Helio, so this is not an independent vendor being compared against MoonPay — it is a **second MoonPay product line**, alongside the standard on-ramp already integrated and Enterprise/Iron.

There are therefore three MoonPay products in play, and they solve different problems:

| Product | What it is | Fit here |
|---|---|---|
| **On-ramp** (`api.moonpay.com`) | Consumer fiat→crypto widget. Current integration | Works. Needs BTC config change |
| **Enterprise / Iron** (`api.iron.xyz`) | Institutional fiat→**stablecoin** via bank wire | ❌ Rejected — no BTC, no cards, no third-party addresses |
| **Commerce / Helio** (`api.hel.io`) | Merchant **checkout** — crypto + card acceptance | ✅ This document |

Commerce sits one layer *above* the on-ramp: it is a checkout product that **embeds** the on-ramp for card payers, rather than an alternative to it.

---

## 2. Verified capabilities

Everything in this section was checked against the live API or quoted directly from the docs.

### 2.1 It takes cards — the decisive difference from Enterprise

The Checkout Widget accepts *"USDC, 100+ digital currencies and card payments via a seamless on-ramp flow."*

- A **"Pay with card"** button is present **by default**; merchants opt out via `showPayWithCard: false`.
- `primaryPaymentMethod: "fiat"` makes card the *first* option shown rather than crypto.

That last setting matters a lot here: it means a Commerce checkout can be configured to look and behave like a **card-first** payment page — which is what this platform's storefront and donation page need — while still accepting crypto from customers who hold it.

> ⚠️ **Do not confuse this with the Stripe integration.** The `docs/stripe` page is *not* card acceptance — it is an invoice-reconciliation tool that marks a Stripe invoice "Paid" when an on-chain crypto payment lands, using a Restricted API Key. Cards come from the embedded on-ramp, not from Stripe.

### 2.2 Native BTC is fully supported — verified from the live API

`GET https://api.hel.io/v1/currency/all` returns 450 currencies. The native Bitcoin entry:

```json
{
  "name": "Bitcoin", "symbol": "BTC", "mintAddress": "btc",
  "decimals": 8, "isNative": true,
  "features": [
    "PAYMENT_PRICING",
    "PAYMENT_RECIPIENT",
    "DEPOSIT_CUSTOMER_CHECKOUT",
    "USD_RATE",
    "NATIVE_TOKEN",
    "WITHDRAWAL_DESTINATION"
  ],
  "blockchain": { "name": "BITCOIN", "engine": { "type": "BTC" } }
}
```

Three flags carry the weight:

- **`PAYMENT_RECIPIENT`** — the merchant can *receive* in BTC (only 48 of 450 currencies can).
- **`WITHDRAWAL_DESTINATION`** — funds can be withdrawn *to* a BTC address. **This is the Binance path.** Present in **production only** — sandbox BTC lacks it, so this leg cannot be rehearsed before going live (§5.2-RESULT-2).
- **`PAYMENT_PRICING`** — a charge can be denominated in BTC.

**And a useful safety property:** native BTC is the **only** currency on the `BITCOIN` chain in the entire catalogue. The wrapped variants — `cbBTC`, `BBTC`, `BTCB`, `tBTC` — all live on EVM chains with `0x…` addresses. Selecting `mintAddress: "btc"` is therefore unambiguous; there is no way to accidentally pick a wrapped token *on the Bitcoin chain*, because none exists.

That said, §5.3 still applies: picking `BTCB` (a BSC token) instead of `BTC` in the dashboard would send the wrong asset to a native Bitcoin address. The chain-level cleanliness removes one failure mode, not the operator error.

Chains available: `ABSTRACT, ARBITRUM, BASE, BITCOIN, BSC, DOGE, ETH, HYPERCORE, HYPERLIQUID, MEGAETH, PLASMA, POLYGON, ROBINHOOD, SOL, TON, TRON`.

### 2.3 The merchant nominates the destination

- Pay Links take a **`walletId`**, obtained from dashboard **Settings → Wallets** or the Get Wallets API — not a raw address per charge.
- Deposits take a **`recipientWallet`** on the Deposit Customer.
- `currencyId` comes from the Get All Currencies endpoint.

Referencing a **pre-registered wallet by ID** rather than passing an address per request is the same security principle as this platform's own `payout_destinations` allowlist ([`README.md`](../README.md), "The payout address is the crown jewel"). The provider implements it, so a compromised API call cannot redirect settlement to an arbitrary address.

### 2.3a Fiat pricing is supported — including LKR

`GET /v1/currency/all` returns **78 `type: "FIAT"` currencies** usable as `pricingCurrency`. All five this platform supports are present:

| | Production id | Helio decimals | **This platform's `FIAT_DECIMALS`** |
|---|---|---|---|
| USD | `637ca18de2997b3a87a566a8` | **6** | 2 |
| EUR | `637cd0e96b0e90a42a707571` | **6** | 2 |
| GBP | `637cd10e6b0e90a42a707572` | **9** | 2 |
| AUD | `637cd1976b0e90a42a707577` | **9** | 2 |
| LKR | `6660a371a37904ef15ee2c92` | **9** | 2 |

So a charge can be **priced in fiat and settled in BTC** — exactly the model this platform needs, and it means the storefront's existing fiat-denominated orders map over cleanly. LKR being present matters: it is the home market and the reason LKR is in [`payment-config.ts`](../apps/web/src/lib/payment-config.ts).

> ⚠️ **Decimals trap, and it is a real one.** Helio prices in each currency's **own base units**, and those decimals are **not 2** — USD and EUR are **6**, GBP/AUD/LKR are **9**. `$30.00` is `"30000000"`, not `"3000"`. Get this wrong by three orders of magnitude and you charge 1000× the intended amount.
>
> This platform's [`FIAT_DECIMALS`](../packages/shared-types/src/money.ts) says 2 for all of them (correct — those are real minor units). Any integration therefore needs an explicit conversion layer at the provider boundary, using **Helio's per-currency `decimals` read from the API**, never a hardcoded constant. This is precisely the "decimals is stored per asset, never hardcoded" discipline the money module already enforces — it just extends to fiat here, which it never had to before.

### 2.4 API surface

| | |
|---|---|
| Production | `https://api.hel.io/v1` |
| **Sandbox** | `https://api.dev.hel.io/v1`, keys from `app.dev.hel.io` |
| Auth | `publicKey` **query parameter** + `Authorization: Bearer <secret>` **header** |
| Keys | Dashboard → Developer → API. Secret shown once, not retrievable later |
| Webhooks | HMAC-SHA256, Node example provided; dashboard panel supports **replaying failed events** |
| Models | Pay Links (`paylinkId`), Charges (single-use, from a paylink), Deposits (`depositId`), Subscriptions, Headless Payments, Split Payments |

**Two keys, not three.** Simpler than the on-ramp's `pk_`/`sk_`/`wk_` triple — and notably, there is **no separate webhook key**, so the class of bug documented in [`.env.example`](../.env.example) (using the secret key for webhook verification and silently failing every check) does not exist here.

**Webhook replay from the dashboard** is worth calling out: it directly mitigates the largest functional gap in the current system — the missing reconciliation worker ([`README.md`](../README.md), "Not built yet" #1). It is not a substitute for reconciliation, but a lost webhook becomes recoverable by hand instead of leaving an order stuck forever.

---

## 3. What this would replace in the current codebase

Commerce is a *hosted checkout*, so much of the hand-built machinery becomes the provider's problem:

| Currently hand-built | Under Commerce |
|---|---|
| Signed widget URLs — HMAC over the query string ([`widget.ts`](../packages/providers/moonpay/src/widget.ts)) | ❌ Gone. Commerce hosts checkout; no URL to sign |
| Quote at order creation ([`orders.service.ts`](../apps/api/src/orders/orders.service.ts)) | ❌ Gone. Commerce prices the charge |
| `payout_destinations` allowlist + maker-checker | ⚠️ Partly replaced by Settings → Wallets. **Keep ours anyway** — see §5.4 |
| MoonPay status → order status mapping ([`mapping.ts`](../packages/providers/moonpay/src/mapping.ts)) | 🔄 Rewritten against Commerce's event model |
| Webhook signature verification | 🔄 Rewritten — HMAC-SHA256, different envelope |
| IP matching / `allowedIpAddress` | ❌ Gone. No signed URL to bind |

**What you keep regardless** — and these are the parts that justify this platform existing at all:

- The **order ledger** and its forward-only state machine
- **PII encryption with per-subject keys** and erasure ([`pii-retention-policy.md`](pii-retention-policy.md))
- **Idempotency** on order creation
- **Reconciliation** — still needed, and arguably *more* so under a two-hop model (§5.1)
- The **donation** framing and campaign attribution

The module-boundary discipline ([`README.md`](../README.md)) means this lands as a new `packages/providers/commerce` beside the existing one — the same property that made the Stripe → MoonPay swap a one-package change rather than a rewrite.

---

## 4. The potentially large win: payer ≠ beneficiary may dissolve

This deserves its own section because it is the most consequential thing in this document.

**Today's flow — a third-party deposit:**

```
customer's card → MoonPay → BTC delivered DIRECTLY to the company's Binance Entity Account
                                              ↑
                        payer (customer) ≠ beneficiary (company)
```

[`README.md`](../README.md) "Before production" #2 flags this as a **binary business risk** needing written confirmation from *both* MoonPay and Binance — and the pre-existing worry is that either could refuse, because exchanges routinely prohibit third-party deposits.

**Commerce flow — if funds land in a merchant account first:**

```
customer's card → Commerce → merchant's own Commerce balance → withdrawal → company's own Binance account
                                                                    ↑
                                        payer and beneficiary are BOTH the company
```

The Binance leg becomes an **ordinary first-party deposit** — a company moving its own funds into its own exchange account. That is unremarkable and is what exchange deposit addresses are designed for.

**This could remove the single largest business risk in the project.** It is contingent on §5.1 (whether funds really do land in a merchant account first), which is exactly why that question is the gate.

---

## 5. Unknowns to resolve before committing

The docs are noticeably thin on money mechanics. Each of these is a genuine gap in the published documentation, not something I overlooked.

### 5.1 ⚠️ Custody — the gate

**The documentation never states whether Commerce holds a balance on the merchant's behalf.** Both the Charges and Deposits pages were checked; neither addresses custody. Deposits documentation says only that *"Deposited funds are then bridged and swapped into your specified recipient currency."*

Circumstantial evidence points to **custodial or semi-custodial**:
- A whole **Withdrawals** product exists — *"transfer funds from a supported wallet to a user-selected destination wallet"*. Withdrawals only make sense if a balance is held somewhere.
- BTC carries `WITHDRAWAL_DESTINATION`, implying BTC is withdrawn *out of* something.
- "Bridged and swapped" means funds demonstrably pass through provider-controlled infrastructure.

**Why this is the gate, cutting both ways:**

- If **custodial**: §4's benefit is real — the Binance deposit becomes first-party. But MoonPay holds your money between payment and withdrawal. That is **counterparty risk this platform currently does not have**, and it contradicts the design property [`README.md`](../README.md) leads with: *"This platform never touches card data, fiat, or private keys."* Funds would sit with a third party rather than moving atomically to your exchange account.
- If **non-custodial** (settles straight to a merchant address): custody risk is nil, but §4's benefit **evaporates** — the payer ≠ beneficiary problem returns exactly as it is today.

**Ask `commerce@moonpay.com` directly:** *Are merchant funds held in a MoonPay-controlled balance between customer payment and withdrawal, or settled directly on-chain to the merchant's nominated address? If held — under what entity, what licence, and what happens to customer funds in an insolvency?*

### 5.2 ⚠️ Does card → BTC actually work?

Both halves are independently confirmed — the checkout takes cards (§2.1), and BTC is `PAYMENT_RECIPIENT`-capable (§2.2). **The combination is not documented anywhere.**

It is plausible the card on-ramp only settles into stablecoins on EVM/SVM chains, with BTC available solely to customers paying from an existing BTC wallet. MoonPay's own on-ramp does support BTC natively (verified in [`btc-only-and-enterprise-assessment.md`](btc-only-and-enterprise-assessment.md) §2, `supportsTestMode: true`), so it is likely wired through — but **likely is not verified**.

**A probe script is ready:** [`scripts/commerce-probe.mjs`](../scripts/commerce-probe.mjs), with step-by-step setup in [`commerce-sandbox-setup.md`](commerce-sandbox-setup.md). It resolves currency ids live, finds your BTC wallet, and creates one sandbox pay link priced in USD with `canPayWithCard: true` and a BTC recipient — then hands you the checkout URL. It touches no existing code.

```bash
HELIO_API_KEY=<sandbox public key> node scripts/commerce-probe.mjs
```

Note that `canPayWithCard` is a **pay-link feature flag**, so there are three distinct outcomes and all are informative: the API rejects the combination (clear no), the API accepts but echoes `canPayWithCard: false` (silently downgraded — also a no), or the checkout genuinely renders a card option (yes).

### 5.2-RESULT — probe run 2026-08-28: INCONCLUSIVE, and why that is still useful

The probe was run against a real sandbox account. Outcome:

| Check | Result |
|---|---|
| Native BTC as `PAYMENT_RECIPIENT` in sandbox | ✅ present |
| Fiat (USD) pricing | ✅ `$30 USD`, priced in 6-decimal base units (`30000000`) |
| Pay link creation with `canPayWithCard: true`, BTC recipient | ✅ **accepted**, HTTP 201 |
| Server echoed `canPayWithCard` | ✅ **`true`** — not silently downgraded |
| Checkout page renders | ✅ `$30 USD` → `0.00037627 BTC`, recipient `tb1qt8…6az` (correct testnet address, linked to mempool.space/testnet) |
| **A "Pay with card" option in the checkout** | ❌ **absent.** Only `Connect Wallet` |
| **CONTROL: same paylink with USDC recipient** | ❌ **also absent.** Only `Connect Wallet` and `Pay with QR` |

**The control is what matters.** Per §5.2a's decision rule, card appearing for *neither* BTC nor USDC means this is a **devnet limitation, not a BTC limitation** — the card/on-ramp flow simply is not wired into `app.dev.hel.io`. It says nothing either way about whether card → BTC works in production.

**So gate §5.2 is neither cleared nor failed. It is blocked by the test environment**, exactly as §5.2a warned it might be.

**What the run did establish, which is not nothing:**

- Native BTC is a **fully working payment recipient** in Commerce — paylink, live fiat→BTC conversion, correct testnet address handling, block-explorer link. That was previously unverified.
- The API **accepts and preserves** `canPayWithCard: true` on a BTC-recipient paylink. If card→BTC were categorically unsupported, silently forcing the flag to `false` would be the natural place to reject it — and it did not.
- Fiat-denominated pricing works with BTC settlement, which is the model this platform needs.

**Remaining path to an answer.** Sandbox cannot settle this; ask MoonPay directly, alongside the custody and withdrawal questions (§6):

> *Does the "Pay with card" on-ramp support a native BTC recipient in production? It does not render in devnet for any currency — including USDC — so we cannot test it. The API accepts `canPayWithCard: true` on a BTC-recipient pay link and echoes it back as true.*

### 5.2-RESULT-2 — repeated with a second wallet, and checked against production

**Sandbox, re-run with a different BTC wallet (Leather, `tb1qzrrl7s6dzjq2qwz09q08m7xyqxarwa52864r2p`).** Same outcome, which rules out the first wallet being misconfigured:

| Check | Result |
|---|---|
| Address format | OK - testnet (`tb1...`, 42 chars), passes MoonPay's own testnet regex |
| Recipient shown on checkout | OK - `tb1qzr..r2p`, linked to `mempool.space/testnet/address/...` |
| Pricing | OK - `$30 USD` -> `0.0003761 BTC` |
| `canPayWithCard` echoed by API | OK - `true` |
| **Card option in checkout** | **Absent** - only `Connect Wallet` |

Four BTC pay links across two different wallets, plus the USDC control, all agree: **no card option in devnet for any currency.** Nothing about the BTC configuration is at fault.

**Production catalogue check - the useful part.** `GET /v1/currency/all` is public, so production was queryable without production credentials. Native BTC differs meaningfully between environments:

```
production (450 currencies):
  PAYMENT_PRICING, PAYMENT_RECIPIENT, DEPOSIT_CUSTOMER_CHECKOUT,
  USD_RATE, NATIVE_TOKEN, WITHDRAWAL_DESTINATION      <-- present

sandbox    (242 currencies):
  PAYMENT_PRICING, PAYMENT_RECIPIENT, DEPOSIT_CUSTOMER_CHECKOUT,
  NATIVE_TOKEN                                        <-- no WITHDRAWAL_DESTINATION
```

**This is the first hard evidence that the withdraw-BTC-to-an-external-address path exists in production** - the leg §4 depends on for reaching Binance. Previously it was inferred from the Withdrawals documentation; it is now read from the live catalogue. It remains unproven that an *exchange deposit address specifically* is an acceptable destination (§5.1 custody, §6 questions), but the capability itself is confirmed.

**Attempting the full production probe was correctly refused:**

```
FAIL  could not list wallets (HTTP 401)
      {"message":"Api key or token is invalid","code":401}
```

Sandbox keys (issued by `app.dev.hel.io`) do not authenticate against `api.hel.io`. That is correct environment isolation, not a fault.

**To close gate §5.2 you need**, in this order:

1. **Production Helio credentials** - sign in at **`app.hel.io`** (a different environment from `app.dev.hel.io`), then Developer -> API -> generate keys.
2. **A mainnet BTC wallet registered** in that account - `bc1...` / `1...` / `3...`. This is where the real Binance deposit address goes, and the point at which §5.3's network-selection warning becomes live money.
3. Re-run without touching `.env`:
   ```bash
   HELIO_BASE_URL=https://api.hel.io node scripts/commerce-probe.mjs
   ```
   Pass the base URL inline rather than editing `.env`, so a later run cannot hit production unintentionally.

> **Expect a verification gate.** The associated MoonPay Ramps account reports `isVerified: false` with `hasMsa: false` ([`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.2b). Commerce production may likewise require KYB before issuing keys or accepting a payout wallet. If so, this is the same multi-week business process that gates standalone Ramps - worth discovering before budgeting time against it.

### 5.2a ⚠️ What sandbox can and cannot prove

Both environments were queried directly. **They are not equivalent, and the difference lands exactly on the feature that matters most:**

| | Production | Sandbox |
|---|---|---|
| Currencies | 450 | 242 |
| Native BTC present | ✅ | ✅ (same id) |
| `PAYMENT_RECIPIENT` | ✅ | ✅ |
| **`WITHDRAWAL_DESTINATION`** | ✅ | ❌ **absent** |
| `USD_RATE` | ✅ | ❌ absent |
| USD currency id | `637ca18de2997b3a87a566a8` | `63777da9d2f1ab96ae0ee600` — **different** |

Two consequences:

1. **The withdrawal-to-Binance leg cannot be tested in sandbox.** Sandbox BTC has no `WITHDRAWAL_DESTINATION`, so the step that would make the payer ≠ beneficiary problem dissolve (§4) is **unverifiable before production**. Sandbox can prove card → BTC *acceptance*; it cannot prove you can then get the BTC to Binance. Treat §4's benefit as unconfirmed until either MoonPay states it in writing or a small real-money production test demonstrates it.
2. **Never hardcode currency ids.** USD differs between environments. Resolve by symbol at runtime — the probe script does this, and any real integration must too.

**Test it in sandbox before anything else anyway** — `api.dev.hel.io` is reachable and self-serve, and gate §5.2 is decisive on its own. If card → BTC does not work, everything else here is moot.

### 5.3 ⚠️ Chargeback liability

Commerce markets itself on avoiding *"delays, chargebacks, and high fees."* That claim is **true for crypto payments** — on-chain transfers are irreversible.

**It cannot be true for card payments.** A card payment is chargeback-eligible for 120+ days by card-network rule, regardless of what happens downstream. Once cards enter through the on-ramp, chargeback risk exists — the question is only who absorbs it.

This is the same question [`README.md`](../README.md) already says to get in writing, and the marketing language makes it *more* important to pin down here, not less — because it would be easy to read "no chargebacks" and assume the risk was engineered away. Get the liability boundary in writing, specifically for **card-funded** payments.

### 5.4 Keep the local payout allowlist regardless

Settings → Wallets is provider-side. It does **not** give maker-checker (approver ≠ proposer, enforced by a DB CHECK) or the cooling-off period that [`schema.ts`](../packages/database/src/schema.ts) enforces locally.

Whoever holds the Commerce dashboard login can change where money goes. Keep `payout_destinations` as an independent local control and **verify the withdrawal destination against it**, exactly as the webhook handler already re-checks the delivered address today. "The provider validates it" is not a substitute for a control you own.

### 5.5 Smaller open items

- **Fees** — not in any page fetched. Compare against the standard on-ramp's total cost, including the withdrawal leg.
- **KYB** — Commerce merchant onboarding is presumably its own process. Confirm whether the on-ramp KYB already underway (still pending — [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) Part B) counts, or whether this restarts the clock.
- **Withdrawal timing and minimums** — the docs mention `minimumAmountMinimalUnit` and `minimumAmountUsd` per route, plus quotes valid until `summary.expiresAt`. Confirm BTC's floor is compatible with donation-sized amounts; a $20 donation is a small BTC amount and network fees are not trivial.
- **Geographic coverage** — the on-ramp's country restrictions (India `isAllowed: false`, which drove the Singapore hosting decision in [`aws-deployment-architecture.md`](aws-deployment-architecture.md) §1.6) presumably still apply to the embedded card flow. Confirm.

---

## 6. Recommendation

**Do not switch yet. Run one cheap experiment first.**

1. **Sign up for the Commerce sandbox** at [`app.dev.hel.io`](https://app.dev.hel.io) — self-serve, free, no commitment. Then **Settings → Wallets** → add a BTC wallet (a **testnet** address you control — *not* a Binance address; Binance issues no testnet BTC addresses, §5.2a), and **Developer → API** → generate keys.
2. **Run the probe** — it does steps 1–3 of the experiment for you:
   ```bash
   HELIO_API_KEY=<sandbox public key> node scripts/commerce-probe.mjs
   ```
   It prints a checkout URL. Open it and look for a "Pay with card" option. That answers §5.2, the gate on everything else.
3. **Email `commerce@moonpay.com` the custody question** (§5.1) in parallel — it is the other gate and has a lead time. Add the **withdrawal question** from §5.2a to the same message, since sandbox cannot answer it: *"Can BTC be withdrawn to an external address such as an exchange deposit address, and is that available in sandbox?"*
4. **Ask the chargeback-liability question** (§5.3) in the same email; it is already on the critical path for the current integration anyway.

**Meanwhile, do not stall the current integration.** [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.2 is still blocked on a mismatched `MOONPAY_SECRET_KEY`, and that is worth fixing regardless — it is a five-minute dashboard action, it proves the existing integration end-to-end, and a working baseline makes the Commerce comparison meaningful rather than theoretical.

**How to decide once the answers land:**

| If… | Then |
|---|---|
| Card → BTC works **and** custody is acceptable | **Strong case to migrate.** Less code, and payer ≠ beneficiary likely dissolves (§4) |
| Card → BTC works but custody is unacceptable | Stay on the on-ramp; the custody risk is real and the current design deliberately avoids holding funds |
| Card → BTC does not work | Stay on the on-ramp with BTC-only ([`btc-only-and-enterprise-assessment.md`](btc-only-and-enterprise-assessment.md) Part 3) |

The BTC-only work on the current integration is a **small, well-understood change** and is not wasted either way — the order ledger, PII handling, state machine, and reconciliation all survive a later move to Commerce.
