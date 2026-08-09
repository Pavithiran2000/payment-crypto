# Credentials & Information Required From Client

To deploy and fully test the payment platform on a live QA/production environment, we need the
following from you. Nothing below is technical work on your side beyond account signups, business
information, and access grants — we handle the implementation.

---

## 1. Transak Partner Account

Transak is the card→crypto payment provider this platform integrates with. A **Partner
(merchant) account** must be created directly by you (or someone authorized to represent the
business), since Transak ties API credentials to a verified legal entity.

**Where:** Transak's partner/business signup portal (we'll share the exact link when ready to
apply — sandbox/staging access is free and typically approved quickly; production access requires
additional business verification).

### Information Transak will ask for

| Field | What we need from you | Notes |
|---|---|---|
| **Company / legal entity name** | Full registered business name | Must match business registration documents |
| **Company email** | A business email address (not personal Gmail/Yahoo etc.) | Used for account verification and all Transak correspondence |
| **Company website** | Live company website URL | Should be publicly accessible — Transak reviews this during approval |
| **Brand name** | The name shown to customers on the Transak checkout page | Can differ from the legal entity name (e.g., a storefront brand) |
| **Brand logo** | Company logo file (PNG/SVG, per Transak's spec) | Displayed on the hosted checkout page |
| **Business description / use case** | Short description of what you're selling and why card→crypto settlement is used | E.g., "Custom-quoted building materials, settled in USDT to our custodial wallet" |
| **Country of registration** | Country the business is legally registered in | Affects which Transak regions/compliance rules apply |
| **Contact person name & phone** | Primary technical/business contact | For account verification and support escalation |
| **Redirect URL** | `https://<your-domain>/checkout/return` | We provide the exact path; you confirm the domain |
| **Webhook URL** | `https://<your-domain>/webhooks/transak` | We provide the exact path; you confirm the domain |
| **Settlement wallet address** | The crypto wallet address funds should be delivered to (your Binance Entity Account deposit address) | **Critical — this is where all customer payments end up.** Must be an address your business controls and can verify. |
| **Settlement asset & network** | e.g., USDT on Polygon | Confirms which crypto/network Transak should convert to |

### What Transak gives back to us (please forward these once received)

| Credential | Used for |
|---|---|
| `TRANSAK_API_KEY` | Identifies your account when building checkout links |
| `TRANSAK_API_SECRET` | Signs/verifies webhook authenticity — **treat as a password, share over a secure channel only** |
| Confirmation of webhook signature scheme (HMAC header vs. JWT body) | Configures how we verify incoming payment confirmations |
| Sandbox vs. production account status | Determines which environment (`staging`/`production`) we point the platform at |

> **Do not share `TRANSAK_API_SECRET` over email, chat, or any unencrypted channel.** Use a
> password manager's secure share feature, or we'll provide a one-time secret-sharing link.

---

## 2. Settlement Custodian (where the crypto is received and held)

The platform never talks to the custodian's API directly — it only stores a pre-approved deposit
address and passes it to Transak. This means **which custodian you use is a business/compliance
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
| | Source of funds | Specifically, funds expected to flow through this account — describe the Transak card-payment settlement use case here |
| **Additional information** | Assets under management (AUM) | Rough figure is acceptable |
| | Expected monthly transaction volume | Estimate based on expected order volume |
| | Preferred language & contact number | |
| | Company website | |
| | Purpose of application | State clearly: receiving converted crypto from Transak card-payment settlements |
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
| Binance's answer on Travel Rule / KYT handling of recurring Transak-funded Entity Account deposits | Binance screens incoming transfers for FATF Travel Rule originator/beneficiary data; every deposit in this flow is a potential originator/beneficiary mismatch by design, and flagged deposits can be held pending manual review for an extended period |
| Binance Entity Account deposit address, asset, network | The address, asset and network Transak should settle to, once the account and above confirmations are in place |
| Withdrawal permissions confirmed | If a deposit-only sub-account is used under the Entity Account, withdrawal must be explicitly enabled by the master account — confirm this is configured correctly so settlement can actually be moved onward |

### 2.2 Written approval requirement

Before going live, we need **written confirmation from both Transak and Binance** that they
support a flow where the card-paying customer and the receiving account holder are different
parties. This is a compliance precondition of the business model itself — do not skip this step
to save time, as an unapproved live flow risks funds being held or the account being restricted
after the fact.

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

> The webhook and redirect URLs given to Transak (section 1) must use this domain over **HTTPS**
> — Transak will not reliably deliver webhooks to plain HTTP or to `localhost`.

---

## 5. Business/Compliance Details (may be requested by Transak or the custodian directly)

Depending on Transak's and the custodian's onboarding tier, they may separately request:
- Business registration certificate / incorporation documents
- Proof of address for the business
- Director/beneficial-owner KYC (identity documents) for compliance sign-off
- Expected transaction volumes (rough estimate is fine)

We'll flag these explicitly if Transak or the custodian requests them during the application —
they go directly to that provider's compliance team, not to us.

---

## 6. Summary — what to send us

1. ☐ Transak Partner account created, with `TRANSAK_API_KEY` + `TRANSAK_API_SECRET` (staging first,
   production once verified)
2. ☐ Binance Entity Account (corporate/KYB) approved, with deposit address, asset, and network
   confirmed
3. ☐ Written confirmation from both Transak and Binance supporting the payer≠beneficiary flow
   (§2.2)
4. ☐ AWS account access (IAM credentials scoped per our policy doc) **or** confirmation of your
   DevOps contact
5. ☐ QA domain (and production domain, if different) with DNS access or a DNS contact
6. ☐ Company logo + brand name for the Transak checkout page

Once we have items 1–5, we can complete the QA deployment and run a full live checkout test,
including real webhook delivery.
