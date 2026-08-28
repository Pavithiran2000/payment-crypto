# BTC-only on-ramp — and why MoonPay Enterprise is the wrong product for it

**Written:** 2026-08-28, from the live MoonPay currency catalogue and the MoonPay Enterprise (Iron) developer docs.

> **Follow-up, same day:** a third MoonPay product — **Commerce (Helio)** — was assessed separately in [`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md). Unlike Enterprise it *does* take cards and *does* support native BTC, and it may dissolve the payer ≠ beneficiary problem entirely. It is a genuine contender; read that document before acting on the BTC-only plan in Part 3 here.

**Verdict up front: do NOT migrate to MoonPay Enterprise. Stay on the standard MoonPay on-ramp and restrict it to BTC.**

Enterprise cannot deliver Bitcoin at all, cannot take card payments at all, and cannot accept a Binance deposit address as a destination. Those are three independent structural blockers, not configuration gaps — details in Part 1.

The good news is that **BTC on the standard on-ramp is a better fit than the pair currently configured**, and it happens to fix the sandbox blocker this project has been stuck on. Part 2 onward is the actual BTC plan.

---

## Part 1 — MoonPay Enterprise (Iron) assessment

`dev.enterprise.moonpay.com` documents **Iron** (`api.iron.xyz` / `app.iron.xyz`), MoonPay's institutional **fiat-to-stablecoin** infrastructure business. It is a genuinely different product from the consumer on-ramp this platform integrates — different API, different auth, different money flow, different customer model.

### 1.1 Blocker A — no Bitcoin

Iron's stated purpose is stablecoins: on-ramp fiat→stablecoin, off-ramp stablecoin→fiat, stablecoin↔stablecoin swaps, and stablecoin issuance. Its documentation index describes the Blockchains page as covering *"Ethereum, Solana, Arbitrum, Base, Polygon, and tokens like USDC, USDT, EURC."*

**Bitcoin is not named anywhere in the documentation.** That is consistent with the product's design — Bitcoin is not a stablecoin, and none of the four Iron products have a use for it.

> ⚠️ **Confidence note:** the `/blockchains` page itself returned 404 when fetched directly, so this rests on the documentation index summary and the `/onramp` tutorial (whose request examples show only `"token": "USDC", "blockchain": "Ethereum"`-shaped destinations). Treat "Iron has no BTC" as *strongly indicated*, and confirm with `developers@iron.xyz` before acting on it — that email is also how Enterprise access is requested, so one message covers both.

### 1.2 Blocker B — no card payments

Iron funds transactions through **bank rails into virtual accounts (vIBANs)**, not cards:

| Currency | Rails |
|---|---|
| EUR | SEPA |
| USD | ACH, Wire, RTP, FedNow |
| GBP | CHAPS, FPS |
| Other | SWIFT, Pix, Spei, MobileMoney, AfricanBankTransfer, Crypto |

The flow is: create an "autoramp" → Iron issues a virtual bank account named to your customer → the customer **wires money to it** → webhooks track conversion and payout.

This platform exists to accept **cards**. Its founding design document is a report on 2D card acceptance in Sri Lanka; [`README.md`](../README.md) opens with *"card-funded fiat-to-crypto settlement."* Moving to Iron would not be a provider swap — it would replace the product with a different one that has a different customer experience (wire a bank transfer, wait for settlement) and a different addressable market.

### 1.3 Blocker C — the Binance deposit address cannot be registered

This one is specific to your stated destination and is the hardest of the three.

Iron requires every destination address to be **pre-registered for Travel Rule compliance** before it can be used in any autoramp, via `POST /api/addresses/crypto/selfhosted`. Registration requires **cryptographic proof of ownership** — a message signed with the wallet's private key:

> *"I am verifying ownership of the wallet address [ADDRESS] as customer [CUSTOMER_ID]. This message was signed on DD/MM/YYYY..."*

**You cannot produce that signature for a Binance deposit address.** Binance holds the private key, not you. That is the entire point of a custodial exchange account.

Iron does document a **hosted-wallet path** that substitutes the custodian's DID for a signature — but that requires Binance to participate as an identified custodian in Iron's Travel Rule flow. That is a business negotiation between two institutions, not an integration task, and there is no reason to assume it succeeds.

Note this is a *sharper* version of a risk this project already carries: [`README.md`](../README.md) "Before production" already flags that payer ≠ beneficiary delivery to a Binance Entity Account needs written confirmation from both MoonPay and Binance. Iron turns that open question into a hard technical precondition.

### 1.4 Also disqualifying — the customer model

Iron requires each customer to be **"Active"** (terms signed, KYC/KYB approved through Iron's own onboarding) *before* any transaction can be created. It is built for B2B/B2B2C — banks, fintechs, PSPs onboarding identified end-customers.

This platform serves an **anonymous storefront checkout and a public donation page**. Every order deliberately gets its own pseudonymous data subject ([`pii-retention-policy.md`](pii-retention-policy.md)); there are no customer accounts to onboard. The models are incompatible without building a customer-onboarding product first.

### 1.5 What migrating would actually cost, if the blockers vanished

For completeness — none of the current provider integration survives:

| Concern | Standard MoonPay (now) | Iron Enterprise |
|---|---|---|
| Auth | `pk_` + `sk_` + `wk_` triple | Single `X-API-Key` header |
| Session | None — signed widget URL | `POST /api/autoramps`, server-side resource |
| URL signing | HMAC-SHA256 over query string — **the core security control** | None. No widget exists |
| Customer pays via | Card, in an iframe | Bank wire to a vIBAN |
| Webhook auth | `Moonpay-Signature-V2`, `t=…,s=…` | Standard Webhooks spec, HMAC-SHA256 |
| Webhook topics | `transaction_created/updated/failed` | `transaction`, `transaction_status`, `register_autoramp_status` |
| Statuses | `waitingPayment`, `pending`, `completed`, `failed` + 4 stages | `FundsReviewInProgress`, `ConversionInProgress`, `PayoutInProgress`, `Completed`, `Failed`, `RejectedAml`, `RejectedFraud`, `RejectedMinAmount` |

Essentially all of [`packages/providers/moonpay`](../packages/providers/moonpay) would be rewritten, plus the state-machine mapping in [`mapping.ts`](../packages/providers/moonpay/src/mapping.ts), plus the checkout UX. The module-boundary discipline in this repo means it *would* be contained to one package plus the web layer — but it is a rewrite of that package, not an edit.

### 1.6 If the goal was commercial terms, not technology

If Enterprise came up because you want better rates, higher limits, or a named account manager — **those are available on the standard consumer on-ramp too**, through a MoonPay partner agreement. `dev.enterprise.moonpay.com` is specifically the Iron stablecoin-infrastructure business, not "the paid tier of the thing you already use." Ask your MoonPay contact about partner/enterprise terms on the standard on-ramp instead.

---

## Part 2 — BTC on the standard on-ramp: what's verified

Fetched live from `GET https://api.moonpay.com/v3/currencies` on 2026-08-28:

```json
{
  "code": "btc", "name": "Bitcoin", "decimals": 8, "precision": 5,
  "supportsTestMode": true,
  "supportsLiveMode": true,
  "isSuspended": false,
  "notAllowedCountries": [],
  "notAllowedUSStates": ["VI"],
  "addressRegex":        "^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$",
  "testnetAddressRegex": "^(tb1|[2mn])[a-zA-HJ-NP-Z0-9]{25,39}$",
  "supportsAddressTag": false,
  "minBuyAmount": 0.00007, "maxBuyAmount": 30000,
  "isUtxoCompatible": true,
  "metadata": { "networkCode": "bitcoin", "chainId": null, "contractAddress": null }
}
```

Three things worth pulling out:

**`supportsTestMode: true` — this fixes the current sandbox blocker.** [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.4 documents a temporary override away from USDC/Polygon because `usdc_polygon` has no sandbox liquidity (`supportsTestMode: false`). BTC has no such problem. Going BTC-only means that override and its revert-before-production risk both disappear.

**`notAllowedCountries: []` — no country restrictions at all.** Broader than `usdc_polygon`, which [`README.md`](../README.md) notes is unavailable in Canada and restricted in some US states. Only the US Virgin Islands is excluded. (MoonPay's separate *country-level* buy restrictions still apply — India remains `isAllowed: false`, which is why [`aws-deployment-architecture.md`](aws-deployment-architecture.md) §1.6 puts the server in Singapore.)

**`supportsAddressTag: false`** — BTC needs no memo/destination tag. Simpler than XRP or XLM, where a missing tag means an exchange deposit is unattributable.

---

## Part 3 — Code changes required

Restricting to BTC is **not** a config-only change. Bitcoin is structurally different from the ERC-20 assets this codebase was built around, and it breaks the type model in one place that needs deliberate design rather than a quick patch.

### 3.1 The type model needs restructuring — not just widening

[`packages/shared-types/src/money.ts`](../packages/shared-types/src/money.ts):

```ts
export type CryptoAsset  = 'USDT' | 'USDC';
export type ChainNetwork = 'polygon' | 'ethereum';

export const ASSET_DECIMALS: Record<CryptoAsset, Record<ChainNetwork, number>> = {
  USDT: { polygon: 6, ethereum: 6 },
  USDC: { polygon: 6, ethereum: 6 },
};
```

Naively adding `'BTC'` and `'bitcoin'` makes that `Record` demand entries that are **nonsense**: `USDT.bitcoin`, `USDC.bitcoin`, `BTC.polygon`, `BTC.ethereum`. There is no USDT on Bitcoin (ignoring Omni, which MoonPay does not offer) and no BTC on Polygon.

The fix is to make the map partial and force callers to handle the missing pair:

```ts
export type CryptoAsset  = 'USDT' | 'USDC' | 'BTC';
export type ChainNetwork = 'polygon' | 'ethereum' | 'bitcoin';

/** Only real pairs appear. A missing entry means the pair does not exist. */
export const ASSET_DECIMALS: Partial<Record<CryptoAsset, Partial<Record<ChainNetwork, number>>>> = {
  USDT: { polygon: 6, ethereum: 6 },
  USDC: { polygon: 6, ethereum: 6 },
  BTC:  { bitcoin: 8 },
};
```

This is a **net improvement** — an impossible pair becomes a compile error instead of a silent `undefined` — but it makes `ASSET_DECIMALS[asset][network]` possibly-undefined, so every lookup must be checked. Call sites to update:

- [`money.ts`](../packages/shared-types/src/money.ts) `crypto()` — throw `MoneyParseError` on an unknown pair
- [`orders.service.ts`](../apps/api/src/orders/orders.service.ts) — `cryptoDecimals` lookup at order creation; reject with `BadRequestException` (it already rejects unsupported pairs, so this fits the existing shape)

> Do this as a deliberate change with the type checker on. `pnpm typecheck` will enumerate every site; do not paper over it with `!` or `as number`, which would reintroduce exactly the "hardcoded decimals" loss event the file's own header warns about.

### 3.2 Provider mapping

[`packages/providers/moonpay/src/mapping.ts`](../packages/providers/moonpay/src/mapping.ts) — add BTC:

```ts
BTC: {
  bitcoin: { code: 'btc', decimals: 8, supportsTestMode: true, minBuyAmount: 0.00007 },
},
```

Note `code: 'btc'` — no network suffix, unlike `usdc_polygon`. Bitcoin is `isBaseAsset: true` in MoonPay's catalogue.

**While here:** `minBuyAmount` on `QuoteCurrencySpec` is **dead code** — defined, populated for every pair, and never read by any consumer (verified by grep). Either wire it into pre-flight validation or delete it; leaving it populated implies an enforcement that does not exist. The *fiat* minimums in `MOONPAY_BASE_CURRENCIES` are the ones that actually matter for UX, and those are real.

### 3.3 Storefront config

[`apps/web/src/lib/payment-config.ts`](../apps/web/src/lib/payment-config.ts):

```ts
export const SUPPORTED_CRYPTO_OPTIONS = [
  { asset: "BTC", network: "bitcoin", label: "Bitcoin" },
] as const;
```

This also **removes the temporary sandbox override** (§A.4 of the testing-status doc) and the standing risk of shipping it to production by accident. Delete that block's comment along with it.

### 3.4 Address validation — now genuinely needed

**There is currently no address-format validation anywhere in the codebase** (verified by grep: no regex, no checksum, nothing). For EVM destinations that was survivable — MoonPay validates server-side and rejects a malformed address before taking money.

For Bitcoin the risk profile is worse, and specifically because of the **testnet/mainnet split**:

| | EVM (USDC etc.) | Bitcoin |
|---|---|---|
| Testnet vs mainnet address format | **Identical** (`0x…` both) | **Completely different** — `bc1…`/`1…`/`3…` vs `tb1…`/`2…`/`m…`/`n…` |
| Wrong-network address | Usually still valid-looking, often recoverable | Rejected by MoonPay, or funds lost |

The realistic failure this prevents: a **mainnet** Binance address left in the config during sandbox testing, or worse, a **testnet** rehearsal address surviving into production — where real money would be sent to an address on the wrong chain.

Add validation in [`payout_destinations`](../packages/database/src/schema.ts) admission (service-level, not just a DB CHECK, so the error message is useful), using MoonPay's own published regexes:

```ts
const BTC_MAINNET = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/;
const BTC_TESTNET = /^(tb1|[2mn])[a-zA-HJ-NP-Z0-9]{25,39}$/;
```

Validate against **the regex for the mode the keys are in** — mainnet for `pk_live_`, testnet for `pk_test_`. The API already refuses to boot on mixed test/live keys, so that mode is unambiguous at startup.

### 3.5 Seed data

[`scripts/seed.sql`](../scripts/seed.sql) needs a BTC destination — and **sandbox and production need different addresses**, which was never true for the EVM pairs. See §5.2 for where the sandbox one comes from.

---

## Part 4 — Credentials and configuration

### 4.1 What does NOT change

**Nothing about the credentials themselves.** Staying on the standard on-ramp means the same three keys, same dashboard, same `.env` shape:

```dotenv
MOONPAY_PUBLISHABLE_KEY=pk_test_…   # or pk_live_
MOONPAY_SECRET_KEY=sk_test_…
MOONPAY_WEBHOOK_KEY=wk_test_…
```

No new credential type, no new base URL, no new signing scheme. This is the single biggest argument for the standard on-ramp over Enterprise: **you already have working sandbox credentials for it.**

### 4.2 What you'd need if you pursued Enterprise anyway

Recorded for completeness, not recommended:

| Item | How |
|---|---|
| Dashboard access | Email `developers@iron.xyz` — access is request-gated, not self-serve |
| Sandbox sign-in | `https://app.sandbox.iron.xyz/` |
| Production sign-in | `https://app.iron.xyz/` |
| API key | Generated in the Partner Dashboard once onboarded |
| Auth header | `X-API-Key: <key>` (plus `Idempotency-Key: <uuid>` on writes) |
| Optional | `X-API-Version: 2026-08-01` |
| Base URLs | `https://api.sandbox.iron.xyz` / `https://api.iron.xyz` |

Note there is **no separate webhook key** — Iron uses the Standard Webhooks spec. Also note Enterprise onboarding includes KYB of your own entity, so it is at least as slow as the standard-product KYB already on the critical path.

### 4.3 Dashboard changes for BTC

- **Nothing key-related.** BTC is enabled per-account like any other asset; if your account can sell BTC in sandbox (it can — `supportsTestMode: true`), no dashboard toggle is needed.
- **Webhook endpoint** stays as-is: `https://api.terracottatiles.online/webhooks/moonpay`, topics `transaction_created`, `transaction_updated`, `transaction_failed`.
- **Domain allowlist** stays as-is: `terracottatiles.online` under Developers → General.

---

## Part 5 — Binance BTC deposit: the operational details that will bite

### 5.1 Network selection is the whole ballgame

Binance issues BTC deposit addresses on **several different networks**. Only one is correct:

| Binance network option | Use it? |
|---|---|
| **Bitcoin (BTC)** | ✅ **This one.** Native Bitcoin, matches MoonPay's `networkCode: "bitcoin"` |
| BNB Smart Chain (BEP20) — "BTCB" | ❌ A wrapped token, different asset, different address format (`0x…`) |
| Lightning (BTC-LN) | ❌ MoonPay delivers on-chain, not over Lightning |
| Other wrapped variants | ❌ |

**Sending native BTC to a BEP20 "BTCB" address, or vice versa, loses the funds permanently.** The `payout_destinations` maker-checker flow ([`schema.ts`](../packages/database/src/schema.ts) — approver ≠ proposer, plus a cooling-off period) is exactly the control for this, and it should be used with the network explicitly verified by the second approver, not assumed.

No memo or destination tag is required (`supportsAddressTag: false`), which removes a common exchange-deposit failure mode.

### 5.2 Sandbox cannot deliver to Binance — plan for this

**MoonPay's sandbox settles on Bitcoin testnet.** Binance does not issue testnet BTC deposit addresses. So:

- The full sandbox purchase **cannot** end at the real Binance address.
- You need a **testnet BTC address you control** for the rehearsal — e.g. Electrum started with `--testnet`, or any testnet-capable wallet. Fund nothing; you are only receiving.
- That address goes in the sandbox `payout_destinations` row and must match `^(tb1|[2mn])[a-zA-HJ-NP-Z0-9]{25,39}$`.
- The real Binance mainnet address is proposed and approved **separately**, for production only.

This is a genuine behavioural difference from the EVM pairs, where the same address string worked in both modes and the distinction never came up. The §3.4 validation exists precisely to stop these two getting crossed.

### 5.3 Address stability

Binance deposit addresses are generally persistent per account/network, but confirm — and note that because `payout_destinations` is an allowlist with maker-checker plus cooling-off, **rotating the address is a deliberate two-person operation**, not a config edit. That is by design ([`README.md`](../README.md), "The payout address is the crown jewel"), but it means an unexpected Binance-side rotation is an incident, not a quick fix. Ask Binance whether the Entity Account's BTC deposit address is guaranteed stable.

### 5.4 The pre-existing questions get sharper, not easier

BTC does not change [`README.md`](../README.md)'s "Before production" items — it sharpens two of them:

- **Payer ≠ beneficiary** — still needs written confirmation from MoonPay *and* Binance, now naming **BTC on the Bitcoin network** specifically.
- **Chargeback liability** — arguably worse with BTC than a stablecoin. BTC is volatile, so a chargeback 120 days after delivery reverses a fiat amount while the crypto delivered has moved in value independently. Get the liability boundary in writing before launch.

---

## Part 6 — Testing plan

### 6.1 Prerequisite, unchanged

[`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.2 is **still blocking**: the widget returns *"Signature check failed"* and the diagnosis is that `MOONPAY_SECRET_KEY` does not match the publishable key on MoonPay's side. Re-copy it from the dashboard with the copy button.

**Switching to BTC does not fix this** — the failure is in URL signing, which is asset-independent. Fix it first, or BTC testing will fail identically and confusingly.

### 6.2 Automated suites

`pnpm verify` runs 63 smoke + 17 erasure assertions against [`scripts/moonpay-stub.mjs`](../scripts/moonpay-stub.mjs), not the real API. Going BTC-only requires updating:

- [`scripts/smoke.mjs`](../scripts/smoke.mjs) — currently asserts `cryptoAmountQuoted === '145.510000'` (6-decimal USDC) and `q?.code === 'usdc_polygon'`. Both become BTC values at **8 decimals**. The 8-vs-6 decimal change is the substantive part — it exercises `parseDecimalPadded` on a different precision and is worth getting right rather than just making green.
- [`scripts/moonpay-stub.mjs`](../scripts/moonpay-stub.mjs) — stub quote responses and the `btc` currency code.
- [`scripts/seed.sql`](../scripts/seed.sql) — the testnet BTC destination.

### 6.3 Manual sandbox run

Once §6.1 is unblocked, the sequence from [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.3 applies unchanged, with BTC substituted:

1. Confirm a minimal signed URL loads (proves the secret key is fixed).
2. Confirm the webhook endpoint is registered at the real domain.
3. Full purchase: email → OTP → test card `4242 4242 4242 4242` (`12/2030`, CVC `123`).
4. **Verify the testnet BTC address received the funds** — a block explorer for Bitcoin testnet. This is a *stronger* check than the EVM rehearsal offered, because you can independently confirm on-chain arrival rather than trusting the webhook alone.
5. Decline path with `4544 2491 6767 3670` → `CARD_DECLINED`.
6. Donation flow at `/donate` — same rails.
7. `pnpm verify` green.

### 6.4 BTC-specific things to check that USDC never exercised

- **8-decimal amounts round-trip exactly.** `parseDecimalPadded` was written for this, but BTC is the first asset to actually use 8 decimals. Assert an amount with significant digits deep in the fraction — a satoshi is `0.00000001`.
- **The quoted BTC amount is tiny and volatile.** Unlike a stablecoin, `$30 → ~0.0003 BTC` and that figure moves between quote and settlement. `cryptoAmountQuoted` is already documented as indicative, but the *visible gap* between quoted and settled will be much larger than with USDC. Confirm the UI does not present it as a guarantee.
- **Confirmation latency.** Bitcoin settlement is slower than Polygon/Ethereum — expect meaningfully longer `PAYMENT_CONFIRMED` → `COMPLETED` dwell. Check `DWELL_TIMEOUT_MS` is not tuned so tight that normal BTC confirmation trips a false escalation.
- **Testnet vs mainnet address rejection.** Deliberately try a *mainnet* address in sandbox and confirm it is refused, not silently accepted. This proves §3.4's validation actually works in the direction that protects real money.

---

## Open questions to resolve before building

1. **Confirm with `developers@iron.xyz` that Enterprise has no BTC path** — the `/blockchains` page 404'd, so this rests on indirect evidence (§1.1). One email settles it.
2. **Why Enterprise?** If the motivation was commercial terms rather than capability, ask about a partner agreement on the standard on-ramp instead (§1.6). If it was something Iron uniquely does — stablecoin issuance, vIBANs — that is a different product decision, and BTC is not part of it.
3. **BTC-only, or BTC in addition?** This document assumes replacing USDC/USDT entirely. Keeping both is also viable — the §3.1 type restructuring supports it cleanly — but "restrict to only BTC" was the stated intent, and fewer supported pairs means less to verify.
4. **Confirm the Binance Entity Account's BTC deposit address is stable** and on the native Bitcoin network (§5.1, §5.3).
5. **Get MoonPay and Binance confirmation naming BTC** specifically for the payer ≠ beneficiary flow (§5.4).
