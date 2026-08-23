# Second gateway: Sri Lankan card → bank settlement

**Date:** 2026-08-20
**Question asked:** which of **PayHere**, **WEBXPAY** or **dLocal** is the best 2D-card
gateway for a Sri Lankan card→bank rail, alongside the existing Stripe onramp.
**Answer:** **PayHere**, with WEBXPAY as the upgrade path. dLocal does not serve
Sri Lanka.

Two things below will change how this gets scoped, so they are first.

---

## 0. Two findings that come before the comparison

### 0.1 This rail cannot touch the crypto leg

The Central Bank of Sri Lanka, in a public notice dated **29 March 2023**, states
that **"Electronic Fund Transfer Cards (EFTCs) such as debit cards and credit cards
are not permitted to be used for payments related to cryptocurrency transactions,"**
under Directions No. 03 of 2021 issued under the Foreign Exchange Act No. 12 of
2017. CBSL has licensed no virtual-currency scheme, exchange or ICO, and
cryptocurrency is not legal tender there.

Both PayHere and WEBXPAY are CBSL-supervised, locally-acquired gateways settling to
Sri Lankan bank accounts. **Neither may be wired into the card→crypto flow**, and a
merchant that describes the use case that way should expect the application to be
declined, or the MID terminated later — which is worse, because it happens after
you have live customers.

So the second gateway is a genuinely separate rail:

| | Rail A (built) | Rail B (this document) |
|---|---|---|
| Provider | Stripe fiat-to-crypto onramp | PayHere |
| Customer geography | EU + US only | Sri Lanka |
| Funding currency | USD, EUR | LKR (+ USD/GBP/EUR/AUD) |
| Settles to | Binance Entity Account (USDC) | Sri Lankan bank account (LKR) |
| Order outcome | crypto delivered on-chain | fiat cleared to bank |

They share the order model, the money primitives, the state machine, the webhook
ledger and the PII design. They do **not** share a payout destination, and Rail B
must never be selectable for an order whose settlement asset is crypto. Enforce
that in code, not in a runbook.

If the actual goal is *"take money from Sri Lankan customers and end up with crypto
in Binance"*, no gateway in this comparison delivers it lawfully. That is a legal
question, not a vendor-selection question, and it needs Sri Lankan counsel before
any engineering.

### 0.2 "2D card support" is not a feature any of them sells

A 2D card payment is one authorised **without a 3-D Secure challenge**. Three facts
worth being blunt about:

1. **None of the three publicly documents a non-3DS mode.** PayHere's own
   walkthrough of a payment puts bank OTP verification in the middle of the flow as
   a normal step. Whether 3DS is invoked is set at the **acquiring MID**, by the
   acquirer, under scheme and regional rules — it is not an API parameter you flip.
2. **Turning 3DS off moves chargeback liability from the issuer to you.** With a
   successful 3DS authentication, a "I didn't authorise this" dispute is generally
   the issuer's problem. Without it, it is yours. On a rail whose delivered goods
   may be irreversible, that is the single most expensive setting in the stack.
3. **The legitimate way to get a frictionless repeat payment is tokenization**, not
   disabling authentication: the customer authenticates once, you store a token,
   and later charges run server-to-server as merchant-initiated transactions with
   no challenge. That is the closest lawful equivalent of "2D", and it is exactly
   what PayHere's Preapproval + Charging APIs do.

If the reason 2D was asked for is *"our customers' cards keep failing 3DS"*, the fix
is 3DS **2.x** frictionless flow — sending richer device and order data so the
issuer risk-scores the payment and skips the challenge — plus the tokenized repeat
path. Ask each vendor, in writing: *which 3DS version do you run, what proportion
of our traffic completes frictionless, and can our MID be configured for risk-based
authentication?* Those answers decide this, and none of them is on a public page.

---

## 1. The three candidates

### dLocal — ruled out on coverage

dLocal's published coverage lists ten Asian markets: Bangladesh, China, India,
Indonesia, Japan, Malaysia, Pakistan, Philippines, Thailand and Vietnam.
**Sri Lanka is not among them.**

That settles it for this requirement. It is worth keeping in view for a different
one: if the real need is collecting from customers across *many* emerging markets
through a single API and a single contract, dLocal is built precisely for that, and
is the strongest of the three at it. It is an enterprise cross-border processor —
expect a sales-led onboarding, a non-Sri-Lankan contracting entity, and volume
commitments, none of which suit a first integration.

**Verdict:** not applicable to Sri Lanka. Revisit only if the requirement changes to
multi-market cross-border collection.

### WEBXPAY — the stronger platform, the heavier commitment

Sri Lanka's first aggregated gateway. Eight-plus local bank partnerships, running on
MPGS and CyberSource. Cards plus LankaQR, UPI, Alipay+ and local wallets (FriMi,
mCash, eZ Cash, JustPay). Multi-currency: LKR, USD, EUR, GBP, AUD. PCI-DSS
compliant with tokenization. **T+1 settlement** — a full day faster than PayHere,
which compounds into real working capital at volume. XSPLIT offers card
instalments, which raises average order value on high-ticket items.

The API surface covers what this platform needs: Merchant Login, Transaction
Retrieval, Pay From Session, Card Saving / Get Cards / Pay From Token / Card
Deletion, and Refund. Integration is RSA-encrypted payload based.

Two frictions. **Pricing is not published** — there is a setup fee and an annual
fee, and card rates land around 2–3% but are negotiated, so you cannot scope the
economics without a sales conversation. And **the public developer documentation is
thin**: the portal lists endpoint names, but authentication, signing, callback
verification and error semantics are not on public pages, so an integration
estimate is guesswork until you have partner docs in hand.

**Verdict:** the better platform, and the right destination at volume. The wrong
place to start, because you cannot cost or estimate it from outside.

### PayHere — the right first integration

Sri Lanka's largest gateway by merchant count and CBSL-authorised. Accepts Visa,
Mastercard, American Express, Discover and Diners Club, plus the local methods that
actually matter for conversion there — eZ Cash, mCash, Sampath Vishwa, FriMi, Genie,
HelaPay, ComBank Q+, LOLC iPay — and LankaQR. Settles LKR and accepts USD, GBP, EUR
and AUD. Self-serve signup, **no setup fee**, sandbox available immediately.

**Published pricing**, which is why it can be scoped without a meeting:

| Plan | Monthly | Rate | Per-txn cap | Monthly cap |
|---|---|---|---|---|
| LITE | free | 3.30% | LKR 50,000 | LKR 200,000 |
| PLUS | LKR 3,990 | 2.99% | LKR 250,000 | LKR 3,000,000 |
| PREMIUM | LKR 9,990 | 2.69% | LKR 1,000,000 | unlimited |

Plus **1.0%** on foreign-currency transactions and **0.5%** on AmEx/Discover/Diners.
HelaPay is 1.99% on every plan. Settlement is a daily payout on a **T+2** cycle.

Note the LITE caps: LKR 200,000/month is a pilot allowance, not a business. Any real
volume starts at PLUS.

The API is the deepest of the three and, crucially, the best documented publicly:
Checkout, Charging, Preapproval, Recurring, Retrieval, Refund, Authorize and
Capture; SDKs for JavaScript, Android, iOS, React Native and Flutter; cart plugins.

---

## 2. Recommendation

**Integrate PayHere as Rail B. Keep the provider boundary clean so WEBXPAY is a
drop-in replacement when volume justifies T+1 settlement and negotiated rates.**

The case, in order of weight:

1. **It is the only one you can scope today.** Published rates, self-serve sandbox,
   public API docs. WEBXPAY needs a sales cycle before you can even estimate;
   dLocal is not an option.
2. **It has the strongest documented answer to the 2D question.** Preapproval →
   `customer_token` → Charging API is a real, supported, merchant-initiated flow:
   the customer authenticates once, later charges are pure server-to-server. That
   is the frictionless repeat payment that "2D" is usually reaching for, achieved
   without surrendering issuer liability.
3. **Widest local method coverage.** In Sri Lanka a meaningful share of customers
   pay by wallet or bank rail rather than card. Card-only is a conversion decision,
   not just a technical one.
4. **Its webhook model matches this platform's architecture.** Server-to-server
   `notify_url` callback with a verifiable signature and explicit status codes —
   which is what the existing `provider_events` ledger and state machine consume.
   Read §3.2 before celebrating that, though.
5. **Reversibility.** No setup fee and no contract means being wrong costs an
   integration, not a commercial commitment.

**Do this in parallel, not after:** send both vendors the 3DS questionnaire in §0.2.
If WEBXPAY comes back with materially better frictionless rates on your traffic mix,
that outweighs everything above, and the boundary you built means switching is a
package swap.

---

## 3. What integrating it actually involves

### 3.1 Shape

A new provider package, mirroring `packages/providers/stripe-onramp`:

```
packages/providers/payhere/
  src/mapping.ts    status_code → OrderStatus, currency mapping
  src/checkout.ts   hash generation, checkout form params
  src/charging.ts   Preapproval + Charging (the tokenized repeat path)
  src/webhook.ts    md5sig verification, payload parsing
```

The lint rules in `eslint.config.mjs` already forbid it from importing
`@pp/database` or another provider. Nothing in `apps/api` should learn the word
"payhere" beyond config wiring and one branch on the order's settlement rail.

Domain changes needed, all small:

- **A settlement rail on the order.** `orders` currently assumes a crypto payout
  destination. Rail B settles to a bank account, so `payout_destination_id` must
  become optional and a `settlement_rail` (`'crypto' | 'bank'`) added — this is what
  enforces §0.1 in code rather than in a runbook.
- **LKR in `FIAT_DECIMALS`.** LKR is a 2-decimal currency; the existing integer
  money handling covers it unchanged.
- **`CARD_DECLINED` gets used for real.** PayHere's `status_code` distinguishes
  failure from cancellation, which the current mapping already has states for.

### 3.2 The one thing to design around

PayHere's checkout `hash` and its `notify_url` `md5sig` are both:

```
UPPERCASE(MD5( merchant_id + order_id + amount + currency + status_code
               + UPPERCASE(MD5(merchant_secret)) ))
```

Compared with Stripe's `Stripe-Signature`, that is weaker in two specific ways, and
both need compensating for:

- **MD5, not HMAC-SHA256.** MD5 is broken for collision resistance. Used as a keyed
  digest over short structured fields it is not trivially forgeable, but it is not
  something to build new systems on. It is what PayHere provides; the mitigation is
  defence in depth, not a better parse.
- **No timestamp in the signed payload, so a captured notification replays forever.**
  Stripe's `t` bounds the window; there is no equivalent here.

The existing architecture already absorbs most of that, which is the useful part:

- `provider_events` is unique on `(provider, external_event_id)` — use PayHere's
  `payment_id`. A replayed notification is a deduplicated no-op.
- The forward-only state machine means a replay of an earlier status cannot move an
  order backwards.
- Verification must also check that `payhere_amount` and `payhere_currency` **match
  the order's own recorded amount and currency**. Without that, the signature only
  proves the message is well-formed for *some* order.

On top of those, for a rail carrying real money: **confirm every success out of band
with the Retrieval API before treating the order as paid.** Do not let an MD5 digest
with no replay window be the only thing standing between a forged POST and a
released order. This is a stricter rule than Rail A needs, and it is the direct
consequence of the weaker signature.

### 3.3 Sequencing

1. Send the 3DS questionnaire (§0.2) to PayHere and WEBXPAY. Blocks nothing, decides
   everything.
2. Get Sri Lankan legal sign-off on §0.1 — specifically, that the goods being sold
   on Rail B are ordinary goods and the rail is not connected to the crypto leg.
3. PayHere sandbox account; verify the LKR flow end to end against a stub, the same
   way `scripts/stripe-stub.mjs` works for Rail A.
4. `settlement_rail` migration and the guard that stops a crypto order selecting
   Rail B.
5. Provider package, then the `apps/api` seam, then the storefront option.
6. Extend `scripts/smoke.mjs`: forged `md5sig` rejected; replayed notification
   deduped; amount/currency mismatch escalated to `MANUAL_REVIEW`; each
   `status_code` mapping; and Retrieval-API confirmation before release.

---

## 4. Confidence, and what to check before committing

Everything above is from public documentation and vendor pages as of 2026-08-20.
Treat these as **unconfirmed** until a vendor says otherwise in writing:

| Claim | Status |
|---|---|
| CBSL prohibits card payments for cryptocurrency transactions | **Primary source** — CBSL notice, 29 Mar 2023 |
| PayHere plan rates and surcharges | **Published**, but verify at signup |
| PayHere T+2 settlement | From PayHere's own support KB; third-party sources say 3–5 working days — confirm |
| PayHere hash / md5sig formulas, `status_code` values | **Published** in PayHere's API docs |
| Preapproval → Charging is server-to-server with no customer interaction | **Published**, but test in sandbox before designing around it |
| WEBXPAY T+1 settlement, 8+ bank partners, tokenization, XSPLIT | Vendor marketing — not independently verified |
| WEBXPAY card rates ~2–3%, setup + annual fee | Third-party reporting — **get a written quote** |
| dLocal does not cover Sri Lanka | dLocal's own coverage page — confirm with their sales team, as coverage changes |
| Neither gateway supports a non-3DS mode | **Absence of public evidence, not evidence of absence.** This is the one to ask about directly |

### Sources

- [CBSL — Risks of using and investing in Cryptocurrency (29 Mar 2023)](https://www.cbsl.gov.lk/en/news/risks-of-using-and-investing-in-cryptocurrency-20230329)
- [CBSL — Public Awareness on Virtual Currencies in Sri Lanka](https://www.cbsl.gov.lk/en/news/public-awareness-on-virtual-currencies-in-sri-lanka)
- [PayHere — Fees](https://www.payhere.lk/fees/)
- [PayHere — Checkout API](https://support.payhere.lk/api-&-mobile-sdk/checkout-api)
- [PayHere — Preapproval API](https://support.payhere.lk/api-&-mobile-sdk/preapproval-api)
- [PayHere — How to make a payment through PayHere](https://blog.payhere.lk/how-to-make-a-payment-through-payhere-payhere-online-payments/)
- [WEBXPAY](https://www.webxpay.com/)
- [WEBXPAY developer portal](https://developers.webxpay.com/)
- [dLocal — Coverage](https://www.dlocal.com/coverage/)
- [dLocal — Pay-ins](https://www.dlocal.com/our-solution/payins/)
