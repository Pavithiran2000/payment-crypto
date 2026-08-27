# Credentials & Information Required From Client

To deploy and fully test the payment platform on a live QA/production environment, we need the
following from you. Nothing below is technical work on your side beyond account signups, business
information, and access grants — we handle the implementation.

---

## 1. MoonPay Account with On-Ramp Access

MoonPay's **fiat-to-crypto on-ramp** is the card→crypto payment provider this platform
integrates with. The account must be created by you (or someone authorized to represent the
business), since MoonPay ties API credentials to a verified legal entity.

**Two separate steps, and the second is the one that blocks us:**

1. Create an account at <https://dashboard.moonpay.com>. **Sandbox keys are issued immediately**
   on signup, so we can build and test straight away.
2. **Complete business verification (KYB).** Production keys are gated on it, and it is measured
   in **weeks, not hours**. Start it as early as possible — it is the long pole on go-live, and
   everything else can proceed in parallel.

> **Please also answer the geography question in §1.1**, so we configure the right currencies.

### 1.1 Which countries your customers are in

MoonPay's footprint is wide — the platform is currently configured to accept **USD, EUR, GBP,
AUD and LKR** by card, and MoonPay supports roughly thirty more fiat currencies we can enable on
request. It is not unlimited, though:

- **Minimum card payment** is enforced per currency: **20** USD/EUR/GBP, **35** AUD, **7,000**
  LKR. A payment below the minimum is refused outright, so this affects pricing and any
  suggested donation amounts.
- **Maximum** is 30,000 USD (and the local equivalent) per transaction.
- **USDC on Polygon**, our default settlement asset, is **not available in Canada** and is
  restricted in the US Virgin Islands. USDT on Polygon additionally excludes New York.

**What we need from you:** the countries your paying customers are actually in, in rough order
of volume, and the currencies you want to price in.

### Information MoonPay will ask for

| Field | What we need from you | Notes |
|---|---|---|
| **Company / legal entity name** | Full registered business name | Must match business registration documents |
| **Company email** | A business email address (not personal Gmail/Yahoo etc.) | Used for account verification and all MoonPay correspondence |
| **Business website** | Live company website URL | Reviewed as part of KYB |
| **Brand logo & colours** | Company logo file, brand colour | Used by the dashboard theme builder; a custom theme id can then be applied to the widget |
| **Business description / use case** | Short description of what you're selling and why card→crypto settlement is used | E.g., "Custom-quoted building materials and donations, settled in USDC to our custodial wallet" |
| **Country of registration** | Country the business is legally registered in | Affects which MoonPay entity and compliance rules apply |
| **Contact person name & phone** | Primary technical/business contact | For account verification and support escalation |
| **Domains hosting the widget** | `https://<your-domain>` | The widget is framed on your own site, so MoonPay needs to know the origin |
| **Webhook URL** | `https://<your-domain>/webhooks/moonpay` | We provide the exact path; you confirm the domain. Subscribe it to `transaction_created`, `transaction_updated` and `transaction_failed` |
| **Settlement wallet address** | The crypto wallet address funds should be delivered to (your Binance Entity Account deposit address) | **Critical — this is where all customer payments end up.** Must be an address your business controls and can verify. |
| **Settlement asset & network** | USDC on Polygon (preferred) | See §1.2 |

### 1.2 Asset choice — please confirm with MoonPay in writing

MoonPay lists both **USDC on Polygon** (`usdc_polygon`) and **USDT on Polygon** (`usdt_polygon`)
as live and unsuspended. The platform defaults to USDC/Polygon: Polygon's network fee on a
stablecoin transfer is a fraction of Ethereum's, and USDC has the wider geographic availability
of the two.

**Whichever you choose, we need MoonPay to confirm in writing that it is available on your
account, for your customers' geographies, on the network you intend to use** — and that the
Binance Entity Account will credit it. See §2.2.

> One testing note, so it isn't mistaken for a fault: MoonPay's **sandbox holds no test
> liquidity for USDC on Polygon**, so sandbox purchases of the production pair fail at the
> delivery step regardless of the integration. We rehearse the full happy path on USDC/Ethereum,
> which does support sandbox, and switch back for live.

### What MoonPay gives back to us (please forward these once received)

MoonPay issues **three separate keys per environment**, and they are not interchangeable. We
need all three, from the same environment (sandbox first, then live).

| Credential | Used for |
|---|---|
| `MOONPAY_PUBLISHABLE_KEY` (`pk_test_...` / `pk_live_...`) | Identifies your account in the widget URL. Public by design — not a secret |
| `MOONPAY_SECRET_KEY` (`sk_test_...` / `sk_live_...`) | Cryptographically signs each payment URL so the deposit address cannot be tampered with — **treat as a password, share over a secure channel only.** It is never transmitted to MoonPay by our platform |
| `MOONPAY_WEBHOOK_KEY` (`wk_test_...` / `wk_live_...`) | Verifies that inbound payment notifications genuinely came from MoonPay — **also a password.** This is a **different secret** from the one above; they are frequently confused, and using the wrong one makes every notification fail silently |
| Sandbox vs. live account status | Determines which keys we point the platform at |
| Written confirmation of KYB approval | Confirms live keys are actually enabled |

All three are found in the MoonPay dashboard under **Developers → API keys**.

> **Do not share `MOONPAY_SECRET_KEY` or `MOONPAY_WEBHOOK_KEY` over email, chat, or any
> unencrypted channel.** Use a password manager's secure share feature, or we'll provide a
> one-time secret-sharing link.

---

## 2. Settlement Custodian (where the crypto is received and held)

The platform never talks to the custodian's API directly — it only stores a pre-approved deposit
address and passes it to MoonPay. This means **which custodian you use is a business/compliance
decision, not a technical one**. The platform is configured to settle to **Binance**.

### 2.1 Binance Entity Account

**Account type required: Binance Entity Account (Binance's name for its Corporate/KYB account) —
never a personal Binance account.**

- A personal account is for an individual's own trading. Routing recurring, business-purpose,
  third-party-funded deposits through a personal account risks breaching Binance's own Terms of
  Service for that account type and can get the account suspended, independent of any other
  compliance question.
- Only a **Binance Entity Account**, opened through Binance's Entity Verification (KYB — Know
  Your Business) process, is designed to receive funds on behalf of a legal entity. It ties the
  account to your incorporation documents and verified beneficial owners, and gives a defensible
  paper trail if a transaction is ever queried by Binance, a bank, or a regulator.
- Sub-accounts (for separating responsibilities, e.g. a dedicated deposit-only sub-account) are
  only available once the Entity Account itself exists — this is an optional refinement after
  onboarding, not a substitute for it.

**What Binance's Entity Verification (KYB) actually asks for** — the exact fields, so you know
what to have ready before starting:

| Step | Field | Notes |
|---|---|---|
| **Account information** | Entity (legal) name | Must match incorporation documents |
| | Registration number | Company registration/CIN number |
| | Date of incorporation | |
| **Entity address** | Registered address | As on incorporation documents |
| | Operating business address | If different from registered address |
| **Source declaration** | Source of capital | Where the entity's capital originated |
| | Source of wealth | |
| | Source of funds | Specifically, funds expected to flow through this account — describe the MoonPay on-ramp card-payment settlement use case here |
| **Additional information** | Assets under management (AUM) | Rough figure is acceptable |
| | Expected monthly transaction volume | Estimate based on expected order volume |
| | Preferred language & contact number | |
| | Company website | |
| | Purpose of application | State clearly: receiving converted crypto from MoonPay on-ramp card-payment settlements |
| **Identity documents** | ID (front & back) of the applicant/workspace administrator | |
| | ID (front & back) of the business's actual controller | The natural person with ultimate control |
| | Certificate of Incorporation | |
| | Operating license | If applicable to your business type |
| | Organizational chart with ownership % | Required if there are multiple shareholders |

The exact document list Binance shows varies by country/region and legal entity type — Binance
confirms the specific list on the verification page itself once the entity's country is entered.

**Additional items specific to Binance, beyond the KYB fields above:**

| Item | Why |
|---|---|
| Confirmation of which Binance legal entity holds the account | Determines which jurisdiction's terms and dispute process apply |
| Binance's answer on Travel Rule / KYT handling of recurring onramp-funded Entity Account deposits | Binance screens incoming transfers for FATF Travel Rule originator/beneficiary data; every deposit in this flow is a potential originator/beneficiary mismatch by design, and flagged deposits can be held pending manual review for an extended period |
| Binance Entity Account deposit address, asset, network | The address, asset and network MoonPay should settle to, once the account and above confirmations are in place |
| Withdrawal permissions confirmed | If a deposit-only sub-account is used under the Entity Account, withdrawal must be explicitly enabled by the master account — confirm this is configured correctly so settlement can actually be moved onward |

### 2.2 Written approval requirement

Before going live, we need **written confirmation from both MoonPay and Binance** that they
support a flow where the card-paying customer and the receiving account holder are different
parties, specifically where crypto is delivered to a corporate exchange account the payer does
not own.

**Ask MoonPay explicitly who bears chargeback liability.** That is the question with real money
attached: the card leg is reversible for 120+ days, the crypto leg is irreversible the moment it
settles, and the answer determines whether you need a rolling reserve. Get it in writing.

This is a compliance precondition of the business model itself — do not skip this step to save
time, as an unapproved live flow risks funds being held or the account being restricted after
the fact.

> **Note — other custodians:** the platform can settle to a different provider (e.g. ZebPay)
> instead of Binance if preferred; that requires the equivalent account/approval steps for that
> provider and a small config change on our side. Tell us if you'd rather use a different
> custodian and we'll adjust this document accordingly.

---

## 3. AWS (Hosting)

We need access to provision and deploy the application. Choose **one** of the following:

**Option A — We provision, you approve costs (recommended)**
- An AWS account (new or existing) you control, with billing set up.
- An **IAM user or role** granted to us with permissions scoped to what deployment needs (EC2 or
  ECS, RDS, Route 53/ACM if applicable, and their supporting services — we'll send an exact IAM
  policy document, not full admin access).
- Preferred AWS **region** (e.g., `ap-south-1`, `us-east-1`) — usually chosen based on where your
  customers are.

**Option B — Your DevOps team provisions**
- Confirmation of who to coordinate with, and their availability for a short kickoff call to align
  on infrastructure (compute, database, networking).

### What we need either way
| Item | Notes |
|---|---|
| AWS account ID | For any cross-account IAM roles |
| Preferred region | Affects latency and any data-residency requirements |
| Existing infrastructure to reuse, if any | e.g., an existing RDS Postgres instance, VPC, or load balancer we should integrate with rather than duplicate |
| Budget/instance-size constraints | So we size compute/DB appropriately |

---

## 4. Domain

| Item | What we need from you |
|---|---|
| **QA domain** (or subdomain) | e.g., `qa.yourbrand.com` or `payments-qa.yourbrand.com` |
| **Production domain** (if different) | e.g., `pay.yourbrand.com` |
| **DNS access** | Either: (a) access to your DNS provider/registrar to add records ourselves, or (b) your DNS admin adds the records we specify (we'll provide exact CNAME/A records once infrastructure is provisioned) |
| **SSL/TLS** | We'll provision via AWS Certificate Manager if the domain's DNS is on Route 53 or can be validated by us; otherwise let us know your preferred certificate process |

> The webhook URL and the widget-hosting domain given to MoonPay (section 1) must use this
> domain over **HTTPS** — MoonPay will not deliver webhooks to `localhost`, and requires the
> post-payment return URL to be HTTPS in live mode. TLS 1.2 or higher.

---

## 5. Business/Compliance Details (may be requested by MoonPay or the custodian directly)

Depending on MoonPay's and the custodian's onboarding tier, they may separately request:
- Business registration certificate / incorporation documents
- Proof of address for the business
- Director/beneficial-owner KYC (identity documents) for compliance sign-off
- Expected transaction volumes (rough estimate is fine)

We'll flag these explicitly if MoonPay or the custodian requests them during the application —
they go directly to that provider's compliance team, not to us.

---

## 6. Summary — what to send us

0. ☐ **The list of countries your paying customers are in, and the currencies you want to price
   in** (§1.1) — this decides which currencies we enable and what the minimum payment is
1. ☐ MoonPay account created and **all three sandbox keys** sent to us:
   `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY`, `MOONPAY_WEBHOOK_KEY`. **This unblocks
   everything else** — sandbox keys are self-serve and issued immediately
2. ☐ **MoonPay business verification (KYB) started.** Live keys are gated on it and it takes
   weeks — please start it the same day as item 1
3. ☐ Binance Entity Account (corporate/KYB) approved, with deposit address, asset, and network
   confirmed
4. ☐ Written confirmation from both MoonPay and Binance supporting the payer≠beneficiary flow,
   and from MoonPay on **who bears chargeback liability** (§2.2)
5. ☐ Written confirmation from MoonPay on the settlement asset — USDC/Polygon, or USDT if the
   business requires it (§1.2)
6. ☐ AWS account access (IAM credentials scoped per our policy doc) **or** confirmation of your
   DevOps contact
7. ☐ QA domain (and production domain, if different) with DNS access or a DNS contact. It must
   be **HTTPS** — MoonPay requires an HTTPS return URL in live mode
8. ☐ The three live MoonPay keys, once KYB is approved

Once we have items 0–7, we can complete the QA deployment and run a full sandbox checkout test,
including real webhook delivery. Item 8 is the final switch to live.
