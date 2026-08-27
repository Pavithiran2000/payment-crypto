# PII Retention & Erasure Policy

**Status:** design decision, implemented in code. Requires sign-off from counsel in
each operating jurisdiction before the live pilot.

**Implemented by:** `packages/database/src/crypto-shred.ts`, `packages/database/src/erasure.ts`,
`data_subjects` table.

---

## 1. The apparent conflict

| Duty | Source | Effect |
|---|---|---|
| Erase personal data on request | GDPR Art. 17 (and UK GDPR, similar regimes) | Delete it |
| Retain transaction & customer records | EU AMLD 5y · India PMLA 5y · card scheme dispute windows | Keep it |

Read naively these cancel out. They don't, for two reasons.

**First — GDPR Art. 17(3)(b) already resolves it.** The erasure right does *not*
apply where processing is necessary for compliance with a legal obligation. AML
retention is exactly such an obligation. So the correct response to an erasure
request covering AML-scope data is **not deletion and not refusal — it is
restriction of processing** until the retention window closes, then deletion.

**Second — and more important here — we are not the AML-obligated entity for the
payer.** MoonPay performs payer KYC and owns that record. Sumsub holds merchant
KYB documents. If we never hold the data, we never have the conflict.

The policy therefore has two halves: hold almost nothing, and make what we do
hold erasable without touching the financial record.

---

## 2. Data tiers

| Tier | Contents | Where it lives | Retention | Erasable? |
|---|---|---|---|---|
| **0 — Financial** | order id, amounts, currency, asset, network, status, timestamps, provider order id, chain tx hash | `orders`, `order_status_history`, `provider_events` | **10 years** | **No.** Contains no PII by construction. |
| **1 — Contact PII** | customer email, IP, country | `orders.customer_email_enc` (ciphertext) | 5 years (`AML_RETENTION_DAYS`) | **Yes** — via key destruction |
| **2 — KYB reference** | Sumsub applicant id, status, decision date | `merchants` | 5 years after relationship ends | No — pseudonymous reference only |
| **3 — Payer KYC documents** | identity documents, selfies, DOB, address, SSN | **MoonPay. Never us.** | n/a | n/a |
| **4 — Card data** | PAN, CVV, expiry | **MoonPay. Never us.** | n/a | n/a |

**Tier 3 and 4 never enter our systems.** This is the single most valuable line in
the policy — it is what keeps us out of PCI-DSS scope beyond SAQ-A and out of the
heaviest data-protection obligations. Any future feature that would pull payer
documents into our database is a policy change requiring counsel review, not an
engineering decision.

---

## 3. Mechanism: crypto-shredding

Deleting rows from a payments database is not acceptable — it destroys the audit
trail that AML requires. Instead, PII is made *unreadable* while the surrounding
financial record stays intact.

```
data_subjects
  id            uuid          <- pseudonymous, referenced by orders
  dek_wrapped   text          <- DEK, sealed under the master KEK
  erased_at     timestamptz
  legal_hold    boolean
  retention_until timestamptz
```

1. Each data subject gets a random 256-bit **DEK** at order creation.
2. Every PII column is AES-256-GCM encrypted under that subject's DEK.
3. The DEK is stored wrapped under a master **KEK**.
4. **Erasure = `dek_wrapped := NULL`.** One update.

After that the ciphertext is unrecoverable by anyone, including us. The order row
keeps its amount, currency, status, timestamps and pseudonymous subject id, so
the AML and audit record survives intact.

Per-subject keys matter: a single global key would mean erasing one customer
requires re-encrypting every other customer's data.

**KEK custody.** Env var in local dev only. In production the KEK **must** be a
KMS key (AWS KMS / Azure Key Vault / GCP KMS) so wrap and unwrap are audited API
calls and raw key material never lands in application memory or a heap dump.

---

## 4. Searching encrypted columns

Support needs "find the order for this email" without a decryption key.

`blindIndex()` stores `HMAC-SHA256(pepper, lower(trim(email)))` alongside the
ciphertext for equality lookup.

**It is an HMAC, not a plain hash, deliberately.** A bare `SHA-256(email)` is
still personal data — an attacker with a candidate email can confirm a match
instantly. The pepper makes that infeasible.

**The pepper is a separate secret from the KEK and must survive subject erasure.**
If the blind index were derivable from erased key material the lookup would break;
if it were derivable from the KEK, compromising one would compromise both.

Consequence: the blind index survives erasure. It is a one-way commitment with an
unknown pepper, which we assess as acceptable — but it means erasure is *key
destruction*, not *total unlinkability*. State this plainly in the privacy notice
rather than overclaiming.

---

## 5. Handling an erasure request

```
request received
      │
      ├─ legal_hold = true?  ──────────► REFUSE, cite ongoing dispute/investigation.
      │                                  Record the refusal and its reason.
      │
      ├─ retention_until > now()? ─────► DEFER. Restrict processing (no marketing,
      │                                  no analytics, support access by blind
      │                                  index only). Confirm to the subject, in
      │                                  writing, the date erasure will complete.
      │                                  sweepExpiredSubjects() then completes it
      │                                  automatically — no human follow-up needed.
      │
      └─ otherwise ────────────────────► ERASE NOW. Destroy the DEK.
```

Respond within one calendar month (GDPR Art. 12(3)). A deferral is a valid,
documented response — provided the completion date is stated and the system
actually honours it, which `sweepExpiredSubjects()` guarantees.

`legal_hold` must be set automatically whenever an order enters `DISPUTED`,
`CHARGEBACK_RECEIVED` or `MANUAL_REVIEW`, and cleared only by an operator.

---

## 6. Retention is an expiry, not a request queue

Data nobody asked us to delete still must not be kept forever — that is the
storage-limitation principle (GDPR Art. 5(1)(e)), and it is the half of retention
policy most implementations skip.

`sweepExpiredSubjects()` runs daily and erases every subject whose window has
closed and which is not under legal hold. It needs no request and no human.

Set `AML_RETENTION_DAYS` from the **strictest** regime you operate under. Do not
average across jurisdictions.

---

## 7. The blockchain constraint

**Nothing on-chain can ever be erased.** This is why the architecture anchors
hashes only — and why the hash pre-image rule needs stating precisely:

> A hash of a record containing PII is itself personal data, because anyone with
> a candidate value can verify a guess.

Therefore the anchored digest must be computed over **Tier 0 fields only**, or
over an HMAC using a secret that is not published. Hashing the full order row —
email included — and putting it on Polygon would place an unerasable commitment
to a customer's personal data on a public chain. That is not fixable after the
fact.

Add a test that fails if any Tier 1+ column reaches the anchoring function.

---

## 8. Cross-border transfer

Payers are international; the beneficiary is Indian. Before the live pilot,
confirm with counsel:

- **EU/UK payer data** — transfer mechanism for any processing outside the EEA
  (SCCs plus a transfer impact assessment). Minimised by holding almost no payer
  data, but not eliminated.
- **India data localisation** — whether the RBI storage-of-payment-system-data
  direction reaches this arrangement. It turns on how the structure is
  characterised, which is precisely the open question in
  `docs/provider-approval.md`. Resolve that first; hosting region may not be a
  free choice.
- **Retention floor** — reconcile the strictest applicable AML window across all
  operating jurisdictions and set `AML_RETENTION_DAYS` to it.

---

## 9. Open items for counsel

1. Confirm the 5-year AML window against every jurisdiction in the payer set.
2. Confirm the blind index surviving erasure is acceptable in your DPA/privacy notice.
3. Confirm the 10-year Tier 0 retention against local financial-records rules.
4. Confirm whether the platform is a data controller or processor for payer contact
   data given MoonPay is the KYC-obligated party for the payer. This changes who answers the
   erasure request, and it should be answered before the first live payer exists.
