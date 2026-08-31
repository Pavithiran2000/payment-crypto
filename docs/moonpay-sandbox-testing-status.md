# MoonPay Sandbox Testing — Status & Next Steps, and Production Checklist

**Last updated:** 2026-08-25, from a live debugging session against the real MoonPay sandbox API and widget (not the local stub). Everything under "Verified working" and "Currently blocked" below was directly observed today, not inferred from docs.

**For the full technical reference** (credentials, how signing/webhooks/dedupe work, architecture) see [`moonpay-onramp-migration.md`](moonpay-onramp-migration.md). This document is the operational one: what's actually been proven, what's blocking a complete sandbox run right now, and what stands between here and production.

---

## Part A — Sandbox testing

### A.1 Verified working today, against the real MoonPay API

| Piece | Evidence |
|---|---|
| All three keys are valid and recognized | Real `buy_quote` call returned a real quote; the widget page renders your account's branding and a "Test Mode" badge |
| Quote pricing | `$100 USD → $98.53 USDC`, `$30 USD → $29.56 USDC`, fees itemized (`feeAmount`, `networkFeeAmount`) |
| Order creation → quote → persist → build signed URL | Full path exercised via `POST /orders` with real sandbox credentials, no stub involved |
| Signing algorithm | Cross-checked two ways: (1) reproduced MoonPay's own documented recipe from scratch and got a byte-identical signature to what our code produces; (2) ran MoonPay's own published test vector (`sk_test_DocsVector00` → known expected signature) through our actual `signQueryString` function — exact match |
| `usdc_polygon` fails in sandbox exactly as documented | Real API response: `{"moonPayErrorCode":"1_SYS_UNKNOWN","message":"Currency not supported in test mode"}`. `usdc` (Ethereum) works — this is why `apps/web/src/lib/payment-config.ts` currently points at Ethereum instead of the production default (Polygon); see §A.4. |
| MoonPay's real geographic gate | `GET https://api.moonpay.com/v4/ip_address` against this machine's own network resolved to Japan, which MoonPay's live `/v3/countries` list shows as `isBuyAllowed: false`. Confirmed against MoonPay's real, live countries list — 172 of 214 countries are buy-allowed; Japan and India are two of the exceptions. **This is the current network's real public IP, not a sandbox quirk or a proxy artifact** — worth knowing if testing stalls again with "Coming soon to your region." |
| Webhook infrastructure | API endpoint (`/webhooks/moonpay`), ngrok tunnel, and the background order-status watcher all wired up and working mechanically (tunnel proxies correctly, confirmed via direct curl) |

### A.2 Currently blocked — diagnosis CORRECTED 2026-08-28

**Symptom:** the widget shows *"Signature check failed — We couldn't validate the signature sent from the partner environment."*

> ⚠️ **The earlier diagnosis in this section was wrong.** It said `MOONPAY_SECRET_KEY` was invalid / not recognised by MoonPay. That is **disproven** — the key authenticates successfully against MoonPay's API (below). The corrected finding is narrower: both keys are valid, but they are **not a matched pair**.

**What was tested on 2026-08-28, each with a control:**

| # | Test | Result |
|---|---|---|
| 1 | `GET /v1/transactions` with `Authorization: Api-Key sk_test_BR0RC…` | **HTTP 200** — the secret key is **valid** |
| 2 | Same call with a deliberately fake `sk_test_…` (control) | HTTP 401 `4_SYS_NOT_AUTHORIZED` — proves the endpoint really does authenticate |
| 3 | `GET /v1/customers` with the secret key | HTTP **400** (missing param), not 401 — passed auth, reached validation |
| 4 | `GET /v3/accounts/me?apiKey=pk_test_GAh30…` | **HTTP 200** — publishable key valid, account `JAKAN & KAVIYA DISTRIBUTORS (PVT) LTD` |
| 5 | Our `signQueryString` vs MoonPay's own published test vector | **exact match** — algorithm is correct |
| 6 | Correctly-signed widget URL, loaded in a browser | ❌ "Signature check failed" |
| 7 | **UNSIGNED** widget URL (no `signature` param at all) | ❌ **identical error message** |
| 8 | `window.location` after load | `signature` param **survives** the redirect intact, uncorrupted |

**Two things test 7 establishes:**

1. **This account has URL signing enforced.** An unsigned load is refused, which is the correct security posture — but
2. **MoonPay returns the same message for "signature missing" and "signature invalid."** The wording is misleading, and it means the UI alone cannot distinguish the two cases. Any future debugging of this error must use the API-level checks above, not the widget text.

**Test 8 rules out transport corruption.** Note the widget redirects `buy-sandbox.moonpay.com/` → `buy.moonpay.com/v2/buy`, changing both host and path, but query parameters (including `signature`) arrive intact and byte-correct.

**Conclusion by elimination.** The algorithm is right (5), the signature reaches MoonPay intact (8), both keys are individually valid (1, 4), and signing is required (7). The only remaining variable is **pairing**: the `sk_` in `.env` is not the signing secret that belongs to this `pk_`. Most likely it came from a different key row, a different publishable key, or was superseded by a regeneration that left the old key valid for API auth.

**Fix — dashboard access required, so this one is yours:**

1. **dashboard.moonpay.com → Developers → API keys**, on **Test/Sandbox**.
2. Copy the **publishable and secret keys together, from the same row**, using the copy buttons. The pairing is the thing that matters — a correct-looking secret from the wrong pair produces exactly this symptom.
3. If there is any doubt, **regenerate the secret key**. That forces a known-good pair and is the fastest way to eliminate this variable.
4. Update both `MOONPAY_PUBLISHABLE_KEY` and `MOONPAY_SECRET_KEY` in `.env` — not just the secret.

**Verify the fix in seconds, without a browser:**

```bash
node scripts/moonpay-signature-check.mjs
```

### A.2b RESOLVED — root cause is account provisioning, not code

**2026-08-28. The signature failure is not fixable from this codebase.** After eliminating every code-side hypothesis, the cause is that this MoonPay account is not provisioned for **standalone Ramps widget** integration.

**Hypotheses tested and eliminated, in order:**

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Secret key invalid | ❌ wrong | Authenticates against MoonPay API (HTTP 200); fake key controls return 401 |
| Keys not a matched pair | ❌ wrong | All three keys byte-identical to the dashboard, same lengths |
| Signing algorithm wrong | ❌ wrong | Exact match against MoonPay's own published test vector |
| Signature corrupted in transit | ❌ wrong | Arrives byte-intact after the `buy-sandbox` → `buy.moonpay.com/v2/buy` redirect |
| Parameter ordering | ❌ wrong | Fails identically in insertion and alphabetical order |
| Generic widget breakage | ❌ wrong | An unrecognised API key loads the widget fine — failure is account-specific |
| **Account not provisioned for standalone Ramps** | ✅ **cause** | see below |

**Evidence from `GET /v3/accounts/me`:**

```
isVerified            false     KYB not complete
hasConfiguredRampFees null      Ramp fees never configured
accessTier            null      no tier assigned
hasMsa                false     no Master Service Agreement
category              null
allowedIframeAncestorUrls  ...,https://moonpay.hel.io,https://moonpay.dev.hel.io
```

The two `hel.io` entries are **MoonPay Commerce** domains, pre-populated by MoonPay. Combined with the dashboard showing **"Ramps only with Commerce plan"**, the reading is that Ramps is available on this account *through Commerce* — where the on-ramp is embedded inside Helio checkout — and **not** as a standalone signed-widget integration, which is what [`widget.ts`](../packages/providers/moonpay/src/widget.ts) builds.

`hasConfiguredRampFees: null` is the specific tell: standalone Ramps requires fee configuration that has never been done on this account.

**Consequence:** no key regeneration, code change, or parameter adjustment will fix this. It requires either MoonPay provisioning standalone Ramps for the account (KYB + MSA + fee configuration — a business process measured in weeks), or moving to the Commerce integration the account already supports.

**This reverses the earlier sequencing advice.** Commerce was previously parked as a speculative alternative to evaluate *after* finishing Ramps. Ramps cannot be finished on this account as it stands, so Commerce moves onto the critical path — see [`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md) and [`commerce-sandbox-setup.md`](commerce-sandbox-setup.md).

> Confirm the reading with MoonPay before acting on it. The account fields are suggestive, not a documented statement, and only MoonPay can say definitively whether standalone Ramps can be enabled here and what it would take.

### A.2a Separate issue — `localhost` is not in the iframe allowlist

The account's `allowedIframeAncestorUrls` is currently:

```
https://terracottatiles.online/, https://moonpay.hel.io, https://moonpay.dev.hel.io
```

`http://localhost:3001` is **absent**, so once the signature is fixed, framing the widget locally will fail a `frame-ancestors` CSP check — a *different* error from the signature one. Either add localhost in the dashboard for local testing, or test against the deployed `terracottatiles.online`, which is already allowlisted.

(Worth noting: `moonpay.hel.io` and `moonpay.dev.hel.io` are **Commerce** domains, already allowlisted on this account — relevant to [`moonpay-commerce-assessment.md`](moonpay-commerce-assessment.md).)

### A.3 Once unblocked — remaining steps to a complete sandbox proof

1. **Confirm the minimal URL passes.** (Automatic once you send the new key — I'll verify before anything else.)
2. **Re-register the webhook**, since ngrok's free tier hands out a new URL on every restart. Current live tunnel:
   ```
   https://b2e0-149-88-103-56.ngrok-free.app/webhooks/moonpay
   ```
   Dashboard → Developers → Webhooks → update the endpoint URL if it's changed since you last registered it. Subscribe to `transaction_created`, `transaction_updated`, `transaction_failed`.
3. **Full click-through purchase** on a fresh order at `http://localhost:3001/checkout/onramp/<reference>`: email → OTP → test card `4242 4242 4242 4242` (exp `12/2030`, CVC `123`) → skip document upload if KYC asks.
4. **Watch it complete.** Tell me when you've started the widget flow and I'll start a background watcher on that order (the previous one, on `ord_KXhhhl3L5Hzue4ha`, already timed out after 15 minutes sitting on `CREATED` — expected, since no purchase was actually attempted while we were mid-diagnosis). You can also watch `http://localhost:3001/orders/<reference>` directly — it polls every 4 seconds and only advances on a real, signature-verified webhook.
5. **Test the failure path**, same flow but with the decline card `4544 2491 6767 3670` — confirms `CARD_DECLINED` mapping end to end, not just the happy path.
6. **Test the donation flow** at `http://localhost:3001/donate` — same rails, different framing; worth one full run to be sure nothing donation-specific broke.
7. **Run `pnpm verify` once more** afterward, against the stub (not the real API) — the 63 smoke assertions and 17 erasure assertions are the automated safety net; the manual run above is what the stub can't prove (real MoonPay UI, real signature validation, real webhook delivery over the internet).

### A.4 One thing to revert before you're done testing

`apps/web/src/lib/payment-config.ts` currently points at **USDC (Ethereum)**, not the production default of **USDC (Polygon)** — because MoonPay's sandbox has no testnet liquidity for the Polygon pair (confirmed today, §A.1). The code comment marks this as a **TEMPORARY SANDBOX OVERRIDE, dated 2026-08-24**. Revert it to `network: "polygon"` before this goes anywhere near production — it's flagged in the file itself so it shouldn't get missed, but calling it out here too since it's an easy thing to forget once sandbox testing feels "done."

---

## Part B — What's needed for production

Nothing here is optional. Ordered roughly by how long each takes to clear, so the slow ones can start now, in parallel with finishing sandbox testing.

### B.1 Business / compliance (start these first — they're the long poles)

- [ ] **MoonPay KYB (business verification) approved**, and `pk_live_` / `sk_live_` / `wk_live_` issued. This takes **weeks**, not hours — sandbox access says nothing about production eligibility.
- [ ] **Written confirmation from MoonPay** that a payer ≠ beneficiary flow (crypto delivered to a corporate Binance Entity Account the payer doesn't own) is permitted, naming the asset, network, and geographies. This is a binary business risk, not an engineering task.
- [ ] **Written confirmation from MoonPay on who bears chargeback liability.** The card leg is reversible for 120+ days; the crypto leg is irreversible the moment it settles. This is the question with real money attached.
- [ ] **Written confirmation from Binance** that the Entity Account accepts third-party deposits from a licensed on-ramp, on the specific asset and network you intend to use.
- [ ] Full question list: §8 of [`moonpay-onramp-migration.md`](moonpay-onramp-migration.md).

### B.2 Configuration changes for live keys

- [ ] All three keys (`pk_live_`, `sk_live_`, `wk_live_`) set together — the API refuses to boot on a mixed test/live set, by design.
- [ ] `WEB_BASE_URL` is a real **HTTPS** origin. MoonPay requires `redirectURL` to be HTTPS in live mode.
- [ ] `MOONPAY_REQUIRE_IP_MATCH` — no action needed, it's **forced on automatically** once live keys are detected. But your load balancer **must** set `X-Forwarded-For` correctly, or the platform will refuse to build a widget URL at all (it will not silently issue an unbound one). Test this on staging before launch.
- [ ] `MOONPAY_API_BASE_URL` and `MOONPAY_WIDGET_BASE_URL` **unset**. The API refuses them with live keys, but confirm they're not lingering in a deploy config somewhere.
- [ ] A **real, stable webhook URL** — your actual deployed API domain, not an ngrok tunnel. (Ngrok's free tier reissuing a new URL on every restart, which caused real friction during this session's testing, is a dev-only problem — production doesn't have it because the deployed API has a fixed domain.)
- [ ] `apps/web/src/lib/payment-config.ts` reverted to **USDC (Polygon)** — see §A.4. Confirm this explicitly; it's easy to ship the sandbox override by accident.

### B.3 Infrastructure

- [ ] **`PII_MASTER_KEK` moved to a KMS** (AWS KMS / Azure Key Vault / GCP KMS). Env-var key material is local-dev only.
- [ ] **Reconciliation worker built and running.** Still the largest functional gap in the system — `fetchTransactionByExternalId` exists in the provider package for exactly this, but nothing schedules it yet. Without it, a lost webhook means a stuck order forever. See `docs/implementation-status.md` Step 1.
- [ ] **Alerting on `MANUAL_REVIEW`.** Especially stage-four delivery failures (card charged, crypto not delivered) — those are money at risk sitting silently in a queue until a human looks.
- [ ] Payout destination approved through the maker-checker flow and past its cooling-off period, on the asset/network you're actually launching with.
- [ ] Secrets manager, automated backups with a tested restore, error monitoring, incident runbook.

### B.4 Launch posture

- [ ] Start with one merchant, one currency, one asset, one network, low amounts, manual review on every transaction. Widen from there once the reconciliation worker and alerting have proven themselves against real traffic.

---

## Appendix — current environment reference (for picking this up cold)

```
API:        http://localhost:3000   (running)
Web:        http://localhost:3001   (running)
Webhook tunnel: https://b2e0-149-88-103-56.ngrok-free.app/webhooks/moonpay
              (ngrok free tier - URL changes on every restart; re-register in
               the MoonPay dashboard whenever it does)

Keys in .env (test/sandbox):
  MOONPAY_PUBLISHABLE_KEY=pk_test_GAh30sllJTd28IuLAERrpx2GjFVM5Lcm   (confirmed working)
  MOONPAY_SECRET_KEY=sk_test_BR0RCYaWit0AbYKOn4brl2L6sM2NN70         (BLOCKED - see A.2)
  MOONPAY_WEBHOOK_KEY=wk_test_M6Plv0sDTTyHtteAuBFwP0ZzdoxbXB         (not yet exercised
                                                                       end-to-end - blocked
                                                                       on A.2 first)

Sandbox rehearsal pair (temporary, see A.4):
  USDC on Ethereum, not Polygon - packages/database seed already has an
  approved destination for this: 0x3333333333333333333333333333333333333333

If the whole stack goes down again (it did once already this session -
environment restart killed every background process, database was
unaffected): rebuild is NOT needed, just restart:
  node apps/api/dist/main.js
  pnpm --filter @pp/web dev --port 3001
  ngrok http 3000
...then re-register the new ngrok URL in the MoonPay dashboard.
```
