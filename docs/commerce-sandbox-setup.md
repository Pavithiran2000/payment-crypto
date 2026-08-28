# MoonPay Commerce (Helio) sandbox — setup and the card → BTC test

**Purpose:** answer one question, cheaply — **can a customer pay by card and have us receive native BTC?**

That single fact gates the whole Commerce decision ([`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md) §5.2). Everything here is free, self-serve, and touches no existing code.

**Time:** ~30–45 minutes, most of it waiting on a testnet faucet.

---

## Read this before you start

Three things I could not verify from the documentation, which shape how you should read the result:

### ⚠️ 1. Sign-in is by crypto wallet, not email and password

Helio devnet authenticates by **connecting a wallet** (Phantom or MetaMask), not by creating a username/password account. So "create an account" really means "connect a wallet and let it become your merchant identity."

Practical consequence: **use a fresh, empty wallet for this**, not a personal one holding real funds. You are signing into a third-party dashboard; there is no reason to expose an existing wallet to it.

### ⚠️ 2. Bitcoin may not be usable on devnet — the signals conflict

| Source | Says |
|---|---|
| Helio devnet docs | Test networks are *"Solana Devnet, Polygon, Base or Ethereum Sepolia"* — **Bitcoin is not listed** |
| Sandbox currency API (queried directly) | Native BTC **is** present, with `PAYMENT_RECIPIENT` |
| Sandbox currency API | But **`WITHDRAWAL_DESTINATION` is absent** in sandbox (it is present in production) |

So the API advertises BTC while the documentation does not list Bitcoin among testable networks. One of them is out of date and I cannot tell which.

### ⚠️ 3. Card testing on devnet is undocumented

The devnet guide covers wallet connection and crypto faucets. It says **nothing** about the card / fiat on-ramp flow, and there is no published devnet test-card number.

### What this means for interpreting a failure

**A negative result may be ambiguous.** If no card option appears, it could mean:

- **(a)** card → BTC genuinely is not a supported combination — the real answer we want; or
- **(b)** the card flow simply is not wired into devnet at all, regardless of currency.

**You can distinguish them.** Re-run the probe with **USDC on Base or Polygon** instead of BTC:

- Card option appears for USDC but not BTC → **(a)**, a real BTC limitation. Decisive.
- No card option for either → **(b)**, a devnet limitation. Tells you nothing about BTC; ask MoonPay directly.

A **positive** result needs no such caveat: if a card option renders on a BTC-recipient paylink, card → BTC works.

---

## Step 1 — Create a throwaway wallet

Install [Phantom](https://phantom.app) or [MetaMask](https://metamask.io) if you do not have one, and **create a new empty wallet** for this test.

> Never connect a wallet holding real funds to a sandbox you are evaluating. This wallet only needs to establish identity.

## Step 2 — Sign in to the devnet dashboard

Go to **[app.dev.hel.io](https://app.dev.hel.io)** (also reachable as `moonpay.dev.hel.io`) and connect the wallet from Step 1.

Then open **Settings → Developer Settings** and confirm the environment is set to a test network.

> Both API base URLs are live and responding (checked directly): `https://api.dev.hel.io/v1` for sandbox, `https://api.hel.io/v1` for production. Stay on **dev** throughout.

## Step 3 — Get a Bitcoin testnet address you control

This is the fiddly step, and it is unavoidable.

**Do NOT use a Binance deposit address here.** Binance issues no testnet BTC addresses. A mainnet address in a testnet environment either fails validation or, worse, is accepted and later used for a real transfer.

Pick any testnet-capable wallet:

| Wallet | How |
|---|---|
| **Electrum** | `electrum --testnet` (or `Electrum-testnet` on Windows) |
| **Sparrow** | Preferences → Server → set network to Testnet |
| **BlueWallet** | Add wallet → advanced options → Testnet |

Copy the **receive address**. It must look like one of these — testnet formats are visually distinct from mainnet:

```
tb1...            bech32 testnet          ← most common
2...              P2SH testnet
m... or n...      P2PKH testnet
```

Regex, if you want to check it (this is MoonPay's own published testnet pattern):
```
^(tb1|[2mn])[a-zA-HJ-NP-Z0-9]{25,39}$
```

**If it starts with `bc1`, `1`, or `3`, it is a MAINNET address — wrong for this.**

You do **not** need to fund it. You are only receiving.

## Step 4 — Register the BTC wallet in the dashboard

**Settings → Wallets → add a wallet**, paste the testnet address from Step 3, and pick **Bitcoin** as the chain.

If Bitcoin is not offered in the chain dropdown, that is **finding (b) from the warnings above** — BTC is not usable on devnet. Stop here, record it, and go straight to the email in the last section.

## Step 5 — Generate API keys

**Developer → API → generate keys.**

You get a **public** key and a **secret** key. The secret is shown **once** and cannot be retrieved later — save it somewhere safe now.

The probe only needs the **public** key: paylink creation authenticates with it as an `apiKey` query parameter.

## Credentials reference

### What Commerce issues, and what each one is for

| Credential | Env var | How it travels | Notes |
|---|---|---|---|
| **Public API key** | `HELIO_API_KEY` | `?apiKey=…` **query parameter** | Public by design. **The only one the probe needs** |
| **Secret API key** | `HELIO_SECRET_KEY` | `Authorization: Bearer <secret>` header | Shown **once** at generation, never retrievable. Save it immediately |
| **Webhook shared token** | `HELIO_WEBHOOK_SHARED_TOKEN` | see below | Returned **once** when a webhook is created. **Per-webhook, not account-wide** |
| Base URL | `HELIO_BASE_URL` | — | `https://api.dev.hel.io` sandbox / `https://api.hel.io` production |

All four are now documented in [`.env.example`](../.env.example) and [`.env`](../.env), left empty until you have them.

### How this compares to the on-ramp's credentials

| | On-ramp (current) | Commerce |
|---|---|---|
| Key count | 3 — `pk_`/`sk_`/`wk_` | 2 + a per-webhook token |
| Public key travels as | query param in a **signed** URL | query param |
| Secret key used for | **HMAC-signing widget URLs** — never sent | Bearer auth — **is** sent |
| Webhook auth | `wk_` key, `Moonpay-Signature-V2` | `sharedToken`, `X-Signature` |

Two differences worth internalising:

**The secret key's role inverts.** On the on-ramp, `MOONPAY_SECRET_KEY` is *only ever* an HMAC key and is never transmitted — that is why [`widget.ts`](../packages/providers/moonpay/src/widget.ts) says "Treat it like a signing key, because that is all it is." Commerce's secret key **is transmitted** as a Bearer token. Same name, materially different exposure: a Commerce secret in a log or a proxy header is a live credential.

**The webhook token is per-webhook.** Registering a second webhook yields a *different* `sharedToken`. So the "one key per environment" mental model from the on-ramp does not carry over — verification must select the token matching the endpoint that received the delivery.

### Finding the webhook secret in the dashboard

**Developer → Webhooks → Add Endpoint.** The dialog calls it **"Secret"** — that is the `sharedToken` from the API docs, and what `.env` calls `HELIO_WEBHOOK_SHARED_TOKEN`. Three names, one value.

It is **pre-generated and shown in the dialog**, partially masked with a copy button beside it. Use the copy button; the masked portion is not recoverable later.

The dialog also scopes the endpoint, which the API docs did not make obvious:

- **Type** — `Pay Link` or `Deposit` (radio). **Choose `Pay Link`.**
- **Pay Link** — `All Pay Links`, or a specific one. **Choose `All Pay Links`** — the probe mints a fresh paylink per run, so there is nothing to pre-select.

**Why Pay Link, not Deposit** — this is a product-model decision, not just a test detail:

| | This platform's model | Pay Link | Deposit |
|---|---|---|---|
| Trigger | customer buys or donates a set amount | ✅ one-time checkout | ❌ customer sends whenever they like |
| Denomination | fiat (USD/EUR/GBP/AUD/LKR) | ✅ `pricingCurrency` | ❌ crypto-in |
| Customer identity | **pseudonymous, per order** | ✅ no account needed | ❌ requires a persistent `customerId` |
| Funding by card | required | ✅ `canPayWithCard` | ❌ no card path exists |

Two of those are decisive:

1. **`canPayWithCard` is a Pay Link feature.** Deposits are *"wallet-to-wallet transfers in any crypto"* — the payer sends crypto they already hold. There is no card leg, so a Deposit-scoped endpoint makes the card → BTC question untestable by construction.
2. **Deposits need a durable customer.** They key off a `customerId` with a persistent `recipientWallet`. This platform deliberately does the opposite — every order gets its own pseudonymous data subject and its own DEK so erasing one customer cannot touch another ([`pii-retention-policy.md`](pii-retention-policy.md)). Adopting Deposits would mean building customer accounts first, and would erode that isolation.

The Commerce primitive that maps onto this platform's orders is **Charges** — single-use checkout pages generated from a `paylinkId`. One charge, one order.

Because each endpoint carries its own Secret, scoping and credentials are coupled: two endpoints means two different tokens, and verification must use the one belonging to whichever endpoint received the delivery.

### ⚠️ Do not add a webhook endpoint yet

**There is no Commerce webhook handler in this codebase.** `apps/api` exposes exactly one webhook route — `POST /webhooks/moonpay` — and it verifies using `MOONPAY_WEBHOOK_KEY` with the `Moonpay-Signature-V2` header. A Commerce delivery hitting it would be **rejected**, because Commerce signs with `X-Signature` keyed by the `sharedToken`. Pointing the endpoint anywhere else on the API just 404s.

**You do not need a webhook to run the experiment.** The probe only needs the public API key, and payment completion can be confirmed two better ways:

1. the dashboard's own **Developer → Webhooks → Events** tab, and
2. a **block explorer** against your testnet address (Step 9) — which is stronger evidence than any webhook, since it is independent of the provider.

Add a webhook endpoint only if Commerce is actually adopted, at which point a `/webhooks/commerce` handler gets built alongside it.

### Webhook verification specifics

The `sharedToken` does double duty on every inbound delivery:

1. `Authorization: Bearer <sharedToken>` — authenticates the sender
2. `X-Signature` — HMAC-SHA256 hex digest of the **raw request body**, keyed with that same token

The three rules the existing on-ramp handler already gets right apply unchanged: compute over `req.rawBody` (Fastify parses JSON before the handler, so a re-serialisation will not match), use a **timing-safe compare**, and dedupe on the database constraint rather than trusting the signature alone.

> Commerce's docs do not mention a timestamp in the signature. If that holds, `X-Signature` alone is **replayable indefinitely** — which makes the existing `provider_events` unique constraint the *only* replay defence, not merely the primary one. Worth confirming with MoonPay.

## Where the BTC address is set — not in `.env`

Short answer: **in the Helio dashboard, not in any env file.**

You register the address under **Settings → Wallets**, and everything afterwards refers to it by **`walletId`**, never by raw address. Pay links take `recipients[].walletId`; the probe resolves it at runtime via `GET /v1/wallet/all`.

That is the same principle as this platform's own `payout_destinations` allowlist — a leaked API key cannot redirect settlement to an attacker's address, because the address is not a parameter of the request.

**For sandbox that wallet must hold a Bitcoin testnet address you control** (Step 3) — `tb1…`, `2…`, `m…`, `n…`. Never a Binance address: those are mainnet-only.

`HELIO_WALLET_ID` exists in `.env.example`, commented out. Pin it for a real integration so a misconfigured lookup cannot silently select a different wallet; the probe does not need it.

> ⚠️ **What Settings → Wallets does *not* give you** is maker-checker (approver ≠ proposer) or a cooling-off period — both of which [`schema.ts`](../packages/database/src/schema.ts) enforces locally today. Whoever holds the dashboard login can change where money goes, in one step. If Commerce is adopted, keep `payout_destinations` as an independent local control and verify the withdrawal destination against it.

## Step 6 — Run the probe

```bash
HELIO_API_KEY=<your sandbox public key> node scripts/commerce-probe.mjs
```

[`scripts/commerce-probe.mjs`](../scripts/commerce-probe.mjs) will:

1. list sandbox currencies and resolve USD + native BTC **by symbol** (ids differ between sandbox and production — never hardcode them);
2. confirm BTC is `PAYMENT_RECIPIENT`-capable in this environment;
3. list your wallets and find the BTC one;
4. create a **$30.00 USD-priced, BTC-recipient** paylink with `canPayWithCard: true`;
5. print a checkout URL.

It prints a `PASS`/`FAIL` line per step, so a failure tells you exactly which assumption broke.

> **The `$30.00 → "30000000"` conversion is not a typo.** Helio prices in each currency's own base units, and USD is **6 decimals** there, not 2. GBP, AUD and LKR are **9**. The script handles this; any real integration must too ([`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md) §2.3a).

## Step 7 — Open the checkout and look

Open the URL the probe printed (`https://app.dev.hel.io/pay/<id>`).

| What you see | Meaning |
|---|---|
| **A "Pay with card" option** | ✅ **Card → BTC works.** Gate cleared — go to Step 8 |
| **Crypto wallet only** | ❌ Ambiguous — run the USDC control test from the warnings section before concluding anything |

Also check the probe's own output: if the API accepted the paylink but echoed **`canPayWithCard: false`**, the server silently downgraded the request. That is a soft "no" worth recording verbatim.

## Step 8 — Pay it with a test card

There is **no published devnet test card**. Two possibilities when you click through:

- The card flow hands off to **MoonPay's on-ramp sandbox** — in which case MoonPay's sandbox cards apply: `4242 4242 4242 4242`, expiry `12/2030`, CVC `123` (and `4544 2491 6767 3670` to test a decline).
- It asks for something else, or errors — record exactly what it says.

Either way, **write down what the card step actually shows.** That observation is the most valuable output of this whole exercise, because it is undocumented.

## Step 9 — Verify BTC actually arrived

Do not trust a webhook or a green checkmark. Look at the chain:

- [mempool.space/testnet](https://mempool.space/testnet)
- [blockstream.info/testnet](https://blockstream.info/testnet)

Paste your testnet address and confirm an incoming transaction. **This is stronger proof than the current MoonPay integration can offer** — the existing sandbox rehearsal has no independent way to confirm delivery.

---

## What the result means

| Outcome | Conclusion | Next |
|---|---|---|
| Card option appears **and** BTC arrives | **Card → BTC works.** Strongest possible sandbox result | Custody question (§5.1) becomes the only remaining gate |
| Card option appears, BTC does not arrive | Card works, settlement broken or delayed | Check webhook events in the dashboard; may just be confirmation latency — Bitcoin is slow |
| No card for BTC, **but yes for USDC** | **Real BTC limitation.** Decisive negative | Stay on the standard on-ramp with BTC-only ([`btc-only-and-enterprise-assessment.md`](btc-only-and-enterprise-assessment.md) Part 3) |
| No card for either | Devnet limitation, not a BTC answer | Inconclusive — ask MoonPay |
| Bitcoin absent from the wallet dropdown | BTC not usable on devnet at all | Inconclusive — ask MoonPay |

---

## What this test can never tell you — ask MoonPay

Two things are **structurally unanswerable in sandbox**. Email `commerce@moonpay.com` in parallel with running the test, not after — these have lead time.

1. **Withdrawal to Binance.** Sandbox BTC lacks `WITHDRAWAL_DESTINATION` (production has it), so the leg that would make the payer ≠ beneficiary problem dissolve ([`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md) §4) **cannot be exercised here**.

   > *Can BTC be withdrawn from a Commerce merchant balance to an external address such as an exchange deposit address (e.g. Binance)? Is that available in sandbox, and if not, why does sandbox BTC lack `WITHDRAWAL_DESTINATION`?*

2. **Custody.** Undocumented, and it decides the entire risk profile.

   > *Are merchant funds held in a MoonPay-controlled balance between customer payment and withdrawal, or settled directly on-chain to the merchant's nominated address? If held — under what entity, what licence, and what happens to customer funds in an insolvency?*

Worth adding to the same message:

3. **Chargeback liability on card-funded payments** — the "no chargebacks" marketing is true of crypto payments but cannot be true of cards. Who absorbs a chargeback 120 days after irreversible BTC delivery?
4. **Whether card → BTC is supported at all**, and whether the card flow works on devnet — asking directly may be faster than inferring it from Step 7.
5. **Fees**, including the withdrawal leg.
6. **Whether the on-ramp KYB already in progress** ([`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) Part B) counts for Commerce, or restarts.

---

## Troubleshooting

**`HELIO_API_KEY not set`** — pass it inline: `HELIO_API_KEY=xxx node scripts/commerce-probe.mjs`. The probe also reads it from the repo-root `.env` if you prefer to put it there (already gitignored).

**`Api key or token is invalid` (401)** — you are probably using a **production** key against the sandbox base URL, or vice versa. Keys are per-environment. Confirm you generated them while signed in at `app.dev.hel.io`.

**`no wallets configured`** — Step 4 was not completed, or the wallet was added under a different account than the API key belongs to.

**`no BTC wallet configured`** — the wallet exists but its `blockchainEngineType` is not `BTC`. Check which chain it was registered under.

**`native BTC not available in this environment`** — the sandbox stopped listing BTC. That is itself a finding; record it.

**Probe passes but the checkout page 404s** — the paylink URL pattern may differ from `app.dev.hel.io/pay/<id>`. The probe prints the raw paylink `id`; find it in the dashboard under Pay Links and use the URL shown there.

---

## Note on scope

This is a **read-only evaluation** — a sandbox account, one paylink, no production keys, no real money, and no changes to the existing MoonPay on-ramp integration.

Keep the current integration moving in parallel. [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) §A.2 is still blocked on a mismatched `MOONPAY_SECRET_KEY` — a five-minute dashboard fix that is worth doing regardless of how Commerce turns out, because a working baseline is what makes this comparison meaningful rather than theoretical.
