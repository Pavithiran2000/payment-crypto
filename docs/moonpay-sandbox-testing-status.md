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

### A.2 Currently blocked

**Symptom:** the widget shows *"Signature check failed — We couldn't validate the signature sent from the partner environment."*

**Diagnosis, not a guess** — isolated by elimination:
1. Our signing algorithm is proven correct (§A.1, both cross-checks).
2. A **minimal** URL — just `apiKey` + `currencyCode` + `walletAddress`, matching MoonPay's own doc example almost exactly, built fresh with the live keys — **still fails**. This rules out any of our extra parameters (`redirectURL`, `baseCurrencyAmount`, `lockAmount`, `externalTransactionId`) as the cause.
3. That same failing page correctly shows the account's branding and the Test Mode badge — meaning MoonPay recognizes `MOONPAY_PUBLISHABLE_KEY` fine. Only the value that depends on `MOONPAY_SECRET_KEY` is rejected.

**Conclusion:** `MOONPAY_SECRET_KEY` in `.env` does not match what MoonPay's server has on file for `MOONPAY_PUBLISHABLE_KEY`. Not a code bug.

**Fix (needs dashboard access, so it's on you):**
1. **dashboard.moonpay.com → Developers → API keys**, confirm you're on **Test/Sandbox**.
2. Use the **copy button** on the Secret Key field — don't select/retype it by hand. A single dropped or transposed character produces exactly this symptom with no other clue.
3. Replace `MOONPAY_SECRET_KEY` in `.env` (root of the repo) with the freshly copied value.
4. Say the word and I'll restart the API and re-run the exact minimal-URL test immediately — that's the fastest way to confirm the fix before touching the full checkout flow again.

If the copy-button value *still* fails, regenerate the Secret Key on that same page (this mints a fresh, certainly-paired value) and repeat.

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
