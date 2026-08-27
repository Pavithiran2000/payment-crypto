# AWS Deployment Architecture — under $20/month

**Target:** single-region AWS deployment of this monorepo (NestJS API + Next.js storefront + PostgreSQL), domain at Spaceship, total spend **under $20/month**.

**Verdict up front: one `t4g.small` in `ap-southeast-1` (Singapore), backed by a 1-year EC2 Instance Savings Plan — $15.00/mo all-in.** Not Mumbai, not `t3.small`, not two `t3.micro`. The arithmetic is in §1; the Savings Plan mechanics and timing are in §1.7.

> **Region finalized 2026-08-27: Singapore, not Mumbai.** Mumbai priced lower ($10.40/mo with the same plan), but MoonPay's live `/v3/countries` API returns **`isAllowed: false` for India** — not merely restricted, disallowed outright. Order creation depends on a live server-to-server call to MoonPay's quote endpoint ([`orders.service.ts`](../apps/api/src/orders/orders.service.ts) takes the quote *before* persisting anything), so if MoonPay edge-blocks Indian server IPs, orders stop being creatable — not a risk worth $2.58/mo. Singapore carries no such flag (`isBuyAllowed: true`) and is still close enough to Sri Lanka to matter for latency. See §1.6.
>
> **On-demand in Singapore does not fit the $20 budget** — $20.73/mo, over by 73¢. Unlike the earlier Mumbai recommendation, **the Savings Plan is not optional here; it is what makes Singapore affordable.** §1.7 covers when to buy it.

> **This document originally recommended `t3.small` in us-east-1**, then `t4g.small` in Mumbai. `t4g.small` is confirmed correct — same 2 vCPU/2 GiB as `t3.small` for materially less, and this codebase was verified ARM-clean (§1.4). Only the region changed, for the MoonPay-availability reason above.

> **Prices are on-demand, 730 h/month, as of this writing.** `t4g.small` figures are **`ap-southeast-1` (Singapore)** unless marked otherwise; `t3.small` / `t3.micro` comparisons are `us-east-1`; Mumbai appears only as the rejected alternative. AWS changes prices and they vary by region — re-check in the [AWS pricing calculator](https://calculator.aws) before committing. Every figure below is shown with its arithmetic so you can re-run it.

---

## 1. The instance decision — with the numbers

### 1.1 Unit costs

| Item | Rate | Per month |
|---|---|---|
| **`t4g.small`** (2 vCPU, **2 GiB**, Graviton2 ARM) — **Singapore** | **$0.0212/h** | **$15.48** |
| `t4g.small` — Mumbai (rejected, §1.6) | $0.0112/h | $8.18 |
| `t4g.small` — us-east-1 | $0.0168/h | $12.26 |
| `t3.small` (2 vCPU, **2 GiB**, x86) — N. Virginia | $0.0208/h | $15.18 |
| `t3.micro` (2 vCPU, **1 GiB**, x86) | $0.0104/h | $7.59 |
| Public IPv4 address | $0.005/h | **$3.65 each** |
| EBS gp3 storage | $0.08/GB-mo | $1.60 @ 20 GB |
| Application Load Balancer | $0.0225/h | **$16.43** + LCU |
| NAT Gateway | $0.045/h | **$32.85** + data |
| Data transfer out | first 100 GB free | $0 |

> **The public IPv4 charge catches people out.** Since **1 Feb 2024** AWS bills **every** public IPv4 address at $0.005/h — including one attached to a *running* instance. It is no longer free. At $3.65/mo it is 18% of this entire budget, and it is the single line item that kills the two-instance option.

### 1.2 Topology comparison

| Option | Composition | Monthly | Verdict |
|---|---|---|---|
| **★ Singapore + 1-yr EC2 Instance SP, 20 GB** | $9.75 + $1.60 + $3.65 | **$15.00** | ✅ **Recommended.** §1.7 has the buy-timing |
| ★ same, + Compute SP instead | $11.14 + $1.60 + $3.65 | $16.39 | ✅ Flexible but more expensive here — §1.7 |
| Singapore on-demand, no commitment | $15.48 + $1.60 + $3.65 | **$20.73** | ❌ **Over budget by 73¢** — §1.7 explains why this still isn't a problem short-term |
| Mumbai + 1-yr EC2 Instance SP | $5.15 + $1.60 + $3.65 | $10.40 | ⚠️ Cheapest, but rejected — MoonPay flags India `isAllowed: false`, §1.6 |
| Mumbai on-demand | $8.18 + $1.60 + $3.65 | $13.43 | ⚠️ Rejected for the same reason |
| us-east-1 + 1-yr EC2 Instance SP | $7.73 + $1.60 + $3.65 | $12.98 | Works, but ~150–200ms further from Sri Lanka than Singapore |
| 1× t3.small + 1-yr Savings Plan, 20 GB | $10.93 + $1.60 + $3.65 | $16.18 | Superseded — worse chip, worse price, than t4g anywhere |
| 1× t3.small on-demand | $15.18 + $1.60 + $3.65 | $20.43 | ❌ Over |
| 2× t3.micro, both public | $15.18 + $1.92 + $7.30 | $24.40 | ❌ Over by $4.40 |
| 2× t3.micro, one private + NAT | + $32.85 NAT | $53.60 | ❌ Wildly over |
| Any option + ALB | + $16.43 | $30+ | ❌ ALB alone eats most of the budget |

`t4g.small` stays the right instance type everywhere it's priced — Graviton2 beats x86 on price/performance in every region above. What changed is the **region**: Singapore costs 89% more than Mumbai per hour ($0.0212 vs $0.0112), which is a real number, not noise — but it buys avoiding a live compliance flag on MoonPay's own API. §1.6 has the full reasoning; §1.7 has the Savings Plan math that makes Singapore affordable again.

### 1.3 Two different AWS offers — do not conflate them

Two separate things can make the first months of this cheap, and they are easy to mix up:

- **The T4g free trial** — 750 hours/month of `t4g.small`, free, for all new *and existing* AWS accounts, currently extended through **31 December 2026** ([AWS announcement](https://aws.amazon.com/ec2/instance-types/t4/)). This is a standing AWS program, not tied to a specific account.
- **A $200 promotional credit over an initial ~6-month window** — this is the path actually in use here, not the free trial above. Credits are typically account-specific (new-signup, a partner programme, a support offer) and behave differently: they are consumed as a balance, they can have their own expiry independent of the T4g trial, and — critically — **they may or may not cover Savings Plan commitment charges**. Confirm that in Billing before relying on it; §1.7 covers why this matters for *when* to buy the Savings Plan.

Either way, three things not to lose track of:

- **It expires.** Budget for the post-credit rate — **$20.74/mo on-demand, or $15.00/mo once on the EC2 Instance Savings Plan** (§1.7, §10) — from day one. Do not build a plan that only works while credits or a trial last.
- **The T4g free trial is aggregate across all regions**, so it funds exactly one `t4g.small`, not a second box, if it applies at all alongside credits.
- **Surplus CPU credits are still billable**, trial or not. §7.1's `credit_specification=standard` matters regardless of which offer is funding the instance.

### 1.4 ARM is safe for this codebase — verified, not assumed

`t4g` is AWS Graviton2, which is **arm64, not x86**. That is the one real risk in this swap, so it was checked rather than hoped:

| Check | Result |
|---|---|
| Native/binary deps across all 6 `package.json` files | **None.** No `bcrypt`, `sharp`, `canvas`, `argon2`, `better-sqlite3`, `re2` |
| PostgreSQL driver | **`pg` v8 — pure JavaScript.** Not `pg-native`, which would need `libpq` compiled for arm64 |
| Node.js 22 | Official `linux-arm64` builds |
| Next.js SWC | Ships `@next/swc-linux-arm64-gnu` as a first-class target |
| `tsx` / esbuild | Ship arm64 binaries |

Nothing in this stack is architecture-bound. Ubuntu's arm64 repositories carry nginx and PostgreSQL identically.

> The one thing to remember: **pick an `arm64` AMI** at launch. Selecting an x86 Ubuntu image for a `t4g` instance simply will not boot.

### 1.5 Why NOT Spot, despite $5.91/mo

Spot saves **$2.27/mo** against on-demand. Do not take it here.

Spot instances are reclaimed by AWS with **two minutes' notice** whenever capacity is needed. This design puts the application *and* PostgreSQL *and* all order state on **one stateful box**. A reclaim means:

- a guaranteed hard outage at a time you do not choose;
- PostgreSQL terminated mid-transaction, with a real chance of a payment webhook arriving during the gap and being lost — and the reconciliation worker that would recover it [is not built yet](implementation-status.md);
- no automatic replacement, because there is no Auto Scaling Group in this budget.

$2.27/mo is not worth unplanned outages on a system that moves money. Spot is for stateless, interruptible, horizontally-scaled work — the opposite of this. Take on-demand.

### 1.6 Why Singapore, not Mumbai — a live compliance flag, not a preference

Mumbai was the first recommendation, purely on price ($8.18 vs $15.48/mo raw compute). It was reconsidered after checking MoonPay's own live data:

```
GET https://api.moonpay.com/v3/countries
IN  India       isAllowed: false   isBuyAllowed: false
SG  Singapore   isAllowed: true    isBuyAllowed: true
LK  Sri Lanka   isAllowed: true    isBuyAllowed: true
```

`isAllowed: false` is India's own blanket flag on MoonPay's side — not a currency restriction like the ones several other countries carry, an outright disallow. That matters here specifically because **order creation is not fire-and-forget**: [`orders.service.ts`](../apps/api/src/orders/orders.service.ts) calls MoonPay's `buy_quote` endpoint from the server **before** the order row is even written, as a deliberate pre-flight (§3.1 of [`moonpay-onramp-migration.md`](moonpay-onramp-migration.md)). If MoonPay geo-blocks that server-to-server call from an Indian IP — undocumented either way, and not something worth finding out in production — every order creation fails, not just ones from Indian customers.

**Customer eligibility itself is unaffected either way.** `isAllowed`/`isBuyAllowed` key off the *payer's* IP inside the widget, not the server's location — Sri Lankan customers stay `isBuyAllowed: true` regardless of which region hosts the API. The risk is purely the outbound call the server itself makes.

Singapore carries no such flag, and:

- **It is still close to Sri Lanka.** Colombo → Singapore is roughly **50–80 ms**; Colombo → N. Virginia is **250–300 ms**. Not as tight as Mumbai's 30–50 ms, but the same order of magnitude better than the US.
- MoonPay's API and widget are globally distributed, so the provider leg of latency is unaffected by which region hosts your server either way.
- **No India data-residency question.** Singapore has its own Personal Data Protection Act (PDPA), which is a real consideration for any PII stored there, but it does not carry the same live-blocked signal this platform's own provider is showing for India. Confirm PDPA obligations with counsel the same way [`pii-retention-policy.md`](pii-retention-policy.md) §8 already flags for other jurisdictions — this is due diligence, not a red flag.

**Before committing real spend, test it rather than trust the reasoning.** Launch on-demand first (no commitment either way — see §1.7 for why on-demand is fine as a starting point even though it doesn't fit the long-run budget) and run:

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  "https://api.moonpay.com/v3/currencies/usdc/buy_quote?apiKey=<your_pk_test>&baseCurrencyCode=usd&baseCurrencyAmount=100&paymentMethod=credit_debit_card"
curl -s "https://api.moonpay.com/v4/ip_address?apiKey=<your_pk_test>"
```

A `200` with a real quote, and an `ip_address` response showing Singapore with `isBuyAllowed: true`, confirms the region is safe before any 1-year commitment is made.

### 1.7 The 1-year Savings Plan — which type, and when to buy it

Singapore's on-demand rate ($20.73/mo, §1.2) does not fit the $20 target on its own. A **1-year EC2 Instance Savings Plan** is what closes the gap — but the type and the timing both matter.

**EC2 Instance SP vs Compute SP — not the same product.** AWS's [Savings Plans page](https://aws.amazon.com/savingsplans/compute-pricing/) offers two:

| | Discount (t4g family) | Locked to |
|---|---|---|
| **EC2 Instance Savings Plan** | ~37% | **instance family + region**, for the full term |
| **Compute Savings Plan** | ~28% | nothing — any region, any family, even Fargate/Lambda |

For a single box that isn't moving regions, the EC2 Instance SP wins on price (§1.2: $15.00/mo vs $16.39/mo for Compute). The Compute SP only earns its lower discount back if there's real uncertainty about region or instance family — which there was, before §1.6 settled it. **Buy EC2 Instance, not Compute, once Singapore is confirmed by the curl test above.**

**Buying it does not need to happen on day one — and probably shouldn't.** If AWS credits are available (e.g. a $200 promotional credit over an initial window), a 12-month Savings Plan bought immediately wastes its own discount for as long as the credits are covering the bill anyway — the SP has value only once real money is being spent. Concretely: run on-demand first, confirm the region is genuinely usable end-to-end (§1.6's curl test, then a full sandbox purchase per [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md)), and buy the commitment once the deployment has actually proven itself — ideally timed so the 12-month term starts close to when any promotional credit runs out, so the discount lands on spend you're paying for either way. A 1-year commitment is a real cost if the project's shape changes before it plays out (MoonPay KYB is not yet approved; see [`README.md`](../README.md) "Before production").

### 1.8 Region and instance, for the rest of this document

The rest of this document assumes **EC2 `t4g.small` in `ap-southeast-1` (Singapore)**, on-demand to start, moving to a 1-year EC2 Instance Savings Plan once confirmed per §1.6–§1.7. Every step translates to `t3.small`, another region, or Lightsail essentially unchanged — only the AMI architecture (§7.1) and the region differ.

### 1.9 Why two `t3.micro` loses on merit too, not just cost

Even if the budget stretched, splitting across two 1 GiB boxes is the wrong shape here:

1. **1 GiB will not hold this stack.** Runtime footprint is roughly Next.js 150–250 MB + NestJS 120–200 MB + PostgreSQL 150–250 MB + nginx 20 MB + Ubuntu 150–200 MB ≈ **600–900 MB**. On a 1 GiB box that leaves nothing for page cache or a traffic spike. `next build` alone routinely needs >1 GB and will OOM outright.
2. **The second box needs internet access, and that is not free.** Put the DB on a private subnet and it cannot reach `apt` for security patches without a NAT Gateway (**$32.85/mo**). Give it a public IP instead and you pay another **$3.65/mo** *and* widen the attack surface on the box holding cardholder-adjacent PII.
3. **Two boxes without a load balancer is not redundancy.** You would be paying twice for infrastructure with the same single-point-of-failure profile, because nothing in the budget can fail traffic over between them.

**One `t4g.small` gives you 2 GiB, one public IP, one thing to patch, and DB traffic over loopback instead of the network.**

### 1.10 Alternatives worth 10 minutes before you build

Singapore + EC2 Instance SP at **$15.00/mo all-in** (§1.7) already leaves $5.00 of headroom, so neither of these is necessary. Both remain worth knowing:

- **A Compute Savings Plan instead of EC2 Instance** — already covered in §1.7: ~$16.39/mo total, $1.39 more expensive here, only worth it if region/family is still genuinely uncertain.
- **AWS Lightsail $10/mo** — 2 GiB RAM, 2 vCPU, 60 GB SSD, 3 TB transfer, **static IP included free**, and meaningfully cheaper than the Singapore EC2 recommendation. Confirm it is offered in `ap-southeast-1` before counting on it, and note it gives up the VPC/subnet control this design otherwise reserves for future RDS/ALB growth (§3).

---

## 2. Architecture

```mermaid
flowchart TB
    subgraph internet["Internet"]
        User["Customer browser"]
        MP["MoonPay<br/>webhooks + widget"]
    end

    subgraph cf["Cloudflare — free tier (optional, recommended)"]
        CDN["DNS + CDN + DDoS<br/>Universal SSL"]
    end

    subgraph aws["AWS — VPC 10.0.0.0/16, single region"]
        IGW["Internet Gateway<br/>$0"]
        subgraph pub1["Public subnet 10.0.1.0/24 — AZ a"]
            EC2["t3.small · Ubuntu 22.04 LTS<br/>Elastic IP"]
        end
        subgraph pub2["Public subnet 10.0.2.0/24 — AZ b (empty)"]
            R1["reserved: future ALB leg"]
        end
        subgraph priv["Private subnets 10.0.11-12.0/24 (empty)"]
            R2["reserved: future RDS"]
        end
    end

    subgraph box["Inside the instance"]
        NGX["nginx :80/:443<br/>TLS · reverse proxy · upstream pool"]
        WEB["Next.js :3001 + :3011"]
        API["NestJS :3000 + :3010"]
        PG[("PostgreSQL :5432<br/>loopback only")]
    end

    User --> CDN --> IGW
    MP -->|"POST /webhooks/moonpay"| IGW
    IGW --> EC2 --> NGX
    NGX -->|"/"| WEB
    NGX -->|"/api, /webhooks"| API
    WEB -->|"127.0.0.1:3000"| API
    API --> PG
```

**Everything runs on one instance.** nginx terminates TLS and reverse-proxies; both apps run two processes each behind an nginx `upstream` pool; PostgreSQL listens on loopback only and is never exposed to the network.

---

## 3. VPC and subnet design

Create four subnets even though you will only use one. They cost nothing empty, and they mean the ALB/RDS upgrade later is a configuration change rather than a rebuild — both **require two AZs** and retrofitting subnets into a live VPC is far more disruptive than reserving them now.

| Subnet | CIDR | AZ | Route table | Purpose |
|---|---|---|---|---|
| `pp-public-a` | `10.0.1.0/24` | `us-east-1a` | → IGW | **The instance lives here** |
| `pp-public-b` | `10.0.2.0/24` | `us-east-1b` | → IGW | Empty. Second ALB leg later |
| `pp-private-a` | `10.0.11.0/24` | `us-east-1a` | local only | Empty. RDS later |
| `pp-private-b` | `10.0.12.0/24` | `us-east-1b` | local only | Empty. RDS standby later |

**VPC:** `10.0.0.0/16`, DNS hostnames + DNS resolution **enabled** (RDS needs both later).

**No NAT Gateway.** This is the defining cost decision — at $32.85/mo it is larger than the entire budget. The consequence: anything needing outbound internet must sit in a public subnet with a public IP. Since the API must reach `api.moonpay.com` for quotes, it belongs in public regardless.

> The private subnets have **no route to the internet at all** while NAT is absent. That is intentional and safe for RDS (which needs no egress), but do not place anything there that needs to fetch updates.

### Security groups

| Group | Direction | Port | Source/Dest | Note |
|---|---|---|---|---|
| `sg-pp-web` | in | 443 | `0.0.0.0/0`, `::/0` | HTTPS |
| | in | 80 | `0.0.0.0/0` | Redirect to 443 + ACME challenge |
| | in | 22 | **your admin IP /32** | Never `0.0.0.0/0` |
| | out | all | `0.0.0.0/0` | MoonPay API, apt, Let's Encrypt |
| `sg-pp-db` *(future)* | in | 5432 | `sg-pp-web` only | Source is the **SG**, not a CIDR |

Prefer **AWS Systems Manager Session Manager** over SSH entirely — then port 22 can be closed to everything, and you get audited access with no key management. It is free.

---

## 4. What this architecture does *not* give you

Stated plainly, because this is a payments platform and the gap matters:

- **No high availability.** One instance, one AZ. Instance or AZ failure = full outage. AWS's EC2 SLA does not cover single instances.
- **No managed database.** No automated backups, no point-in-time recovery, no failover unless you build it (§8.4 covers a free-tier-ish backup path).
- **No horizontal scale.** Vertical only — resize the instance.
- **Blast radius is total.** Compromise the box and you have the app, the database, and whatever secrets the process can read.

That is an acceptable trade for **staging, sandbox, demo, or pre-revenue**. It is *not* an acceptable trade for a system holding real cardholder-adjacent PII and moving real money — which is consistent with what [`README.md`](../README.md) and [`moonpay-sandbox-testing-status.md`](moonpay-sandbox-testing-status.md) already say about production readiness. §9 has the upgrade path and what it costs.

---

## 5. Load balancing on this budget

**Honest answer: you cannot have a real load balancer at $20/mo.** An ALB is $16.43/mo before it serves a single request, taking the total to $36+. What you *can* have, and what genuinely helps:

### 5.1 nginx `upstream` pools — real request distribution + zero-downtime deploys

Run **two processes of each app** on different ports and let nginx round-robin between them. This gives you actual load balancing across processes (using both vCPUs properly, since Node is single-threaded) and, more valuably, **restart one process at a time for zero-downtime deploys**.

It does **not** protect against host failure. Nothing in this budget does.

### 5.2 Cloudflare free tier in front

Point Spaceship's nameservers at Cloudflare (§6) and you get, at no cost: CDN caching of static assets, DDoS mitigation, Universal SSL, and origin IP concealment. For a low-traffic storefront this offloads most bandwidth and is the single highest-value free addition to this design.

Cloudflare's actual *Load Balancing* product is paid and unnecessary here with one origin.

### 5.3 The nginx config

`/etc/nginx/sites-available/payment-platform`:

```nginx
upstream pp_web {
    least_conn;
    server 127.0.0.1:3001 max_fails=2 fail_timeout=10s;
    server 127.0.0.1:3011 max_fails=2 fail_timeout=10s;
    keepalive 32;
}

upstream pp_api {
    least_conn;
    server 127.0.0.1:3000 max_fails=2 fail_timeout=10s;
    server 127.0.0.1:3010 max_fails=2 fail_timeout=10s;
    keepalive 32;
}

# The Next.js BFF calls this loopback-only listener. Pointing
# PAYMENT_API_URL here means it also benefits from the two-process API pool;
# pointing it directly at :3000 would make that one process a hidden SPOF.
server {
    listen 127.0.0.1:8080;

    location / {
        proxy_pass http://pp_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
    }
}

# HTTP -> HTTPS, except the ACME challenge certbot needs.
server {
    listen 80;
    listen [::]:80;
    server_name pay.example.com;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    # This syntax works on the nginx versions shipped by both Ubuntu 22.04
    # and 24.04. Newer nginx versions may prefer a separate `http2 on` line.
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name pay.example.com;

    ssl_certificate     /etc/letsencrypt/live/pay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;

    # MoonPay frames buy.moonpay.com inside our page; do not send
    # X-Frame-Options DENY here or the widget breaks.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    client_max_body_size 2m;

    # ---------------------------------------------------------------
    # These four headers are NOT boilerplate for this project.
    #
    # apps/api/src/main.ts creates Fastify with `trustProxy: true`, and
    # apps/web/src/lib/client-ip.ts reads X-Forwarded-For to derive the
    # payer IP that gets HMAC-hashed into the MoonPay widget URL as
    # `allowedIpAddress`.
    #
    # MoonPay REQUIRES IP matching in live mode. Get these wrong and every
    # live payment fails with "Unverified Connection" - or, worse, the
    # platform refuses to build a widget URL at all (by design: it will not
    # silently issue an unbound one). See moonpay-onramp-migration.md §7.
    # ---------------------------------------------------------------
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # Webhooks: MoonPay wants 2xx within 5s. Keep the body unbuffered so the
    # raw bytes reach req.rawBody intact for HMAC verification.
    location /webhooks/ {
        proxy_pass http://pp_api;
        proxy_request_buffering off;
        proxy_read_timeout 30s;
        access_log /var/log/nginx/webhooks.log;
    }

    location /orders  { proxy_pass http://pp_api; }

    location / {
        proxy_pass http://pp_web;
        proxy_read_timeout 60s;
    }
}
```

Set `PAYMENT_API_URL=http://127.0.0.1:8080` in the application environment.
Do **not** route public `/api/*` to NestJS: this repository owns
`/api/checkout` and `/api/donate` in Next.js. Only `/orders*` and
`/webhooks/*` go directly to the API.

> **If you put Cloudflare in front**, `$remote_addr` becomes a Cloudflare IP. Install [Cloudflare's real-IP ranges](https://www.cloudflare.com/ips/) via `set_real_ip_from` + `real_ip_header CF-Connecting-IP`, or MoonPay's IP matching will bind to Cloudflare's address instead of the payer's and every live payment will fail.

---

## 6. Domain — Spaceship → AWS

You have two paths. **Path B is recommended.**

### Path A — Spaceship DNS direct

In Spaceship's DNS manager for your domain:

| Type | Host | Value | TTL |
|---|---|---|---|
| `A` | `pay` | *your Elastic IP* | 300 |
| `A` | `@` | *your Elastic IP* | 300 *(optional)* |

Simple, free, works. No CDN, no DDoS protection, origin IP is public.

### Path B — Spaceship → Cloudflare (free) → AWS

1. Create a free Cloudflare account, add your domain, let it import existing records.
2. Cloudflare gives you two nameservers.
3. In **Spaceship → Domain → Nameservers**, switch from Spaceship's defaults to Cloudflare's two.
4. In Cloudflare DNS, set `A` record `pay` → your Elastic IP, **proxy status: Proxied (orange cloud)**.
5. **SSL/TLS mode: Full (strict)** — anything less lets Cloudflare talk to your origin unencrypted or without validating, which for a payments origin is not acceptable.

Propagation is usually under an hour. You gain CDN, DDoS mitigation, and a hidden origin IP for free.

**Do not use Route 53** — it is $0.50/mo per hosted zone for something Spaceship and Cloudflare both do free. That is 2.5% of the budget for no benefit here.

### Domain requirements this project imposes

- **HTTPS is mandatory**, not optional: MoonPay requires `redirectURL` to be HTTPS in live mode, and will not deliver webhooks to a non-public or non-HTTPS endpoint.
- `WEB_BASE_URL` in `.env` must be exactly this HTTPS origin — it is what builds both the checkout URL and MoonPay's `redirectURL`.
- Register the domain under **MoonPay dashboard → Developers → General → App or website domains**, or the widget iframe is blocked by `frame-ancestors` CSP.
- The webhook endpoint to register is `https://pay.example.com/webhooks/moonpay`.

---

## 7. Build-out

### 7.1 Launch

- **Region:** `ap-southeast-1` (Singapore) — see §1.6 for why, and run the curl test there before committing to a Savings Plan
- **AMI:** Ubuntu Server 22.04 LTS or 24.04 LTS, **`arm64` build**. ⚠️ An x86_64 AMI will not boot on `t4g`. In the console the architecture selector is directly under the AMI name; verify it reads `64-bit (Arm)`
- **Type:** `t4g.small` (2 vCPU, 2 GiB, Graviton2)
- **Subnet:** `pp-public-a`, auto-assign public IP **enabled**
- **Storage:** 20 GB gp3 — comfortably affordable once the Savings Plan is in ($15.00 total), and still workable on-demand short-term ($20.74, see §1.7)
- **Security group:** `sg-pp-web`
- **⚠️ Credit specification: `standard`, not `unlimited`.** T3 instances default to **unlimited** mode, which silently bills **$0.05 per surplus vCPU-hour** when you exhaust CPU credits. A runaway process could quietly add tens of dollars. `standard` mode throttles instead of charging — a hard spend cap, which is what you want on a fixed budget.

```bash
aws ec2 modify-instance-credit-specification \
  --instance-credit-specifications "InstanceId=i-xxxx,CpuCredits=standard"
```

Then allocate an **Elastic IP** and associate it, so the address survives a stop/start. (An EIP attached to a running instance costs the same $3.65/mo as the auto-assigned one — no extra charge, and you get stability.)

### 7.2 Post-launch assumptions and paths

The commands below are the complete runbook after EC2 has launched. They use
the normal Ubuntu login account for cloning, building, and running the services:

```text
Linux user    ubuntu
Repository    /srv/payment-platform/payment-crypto
API ports     3000 and 3010
Web ports     3001 and 3011
Internal API  127.0.0.1:8080 (nginx pool used by the Next.js BFF)
Public ports  80 and 443 only
PostgreSQL    127.0.0.1:5432 only
```

Running as `ubuntu` is simpler for this sandbox deployment. Never run the Node
services as `root`, and never expose their ports or PostgreSQL in the EC2
security group.

### 7.3 Base system, Node.js, firewall, and swap

Connect as `ubuntu`, then run:

```bash
uname -m                       # must print aarch64 on t4g

sudo apt update
sudo apt upgrade -y
sudo apt install -y nginx postgresql postgresql-contrib git curl \
  certbot python3-certbot-nginx unattended-upgrades ufw

# Node 22 matches the repository's engines requirement.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm@9.12.0

node --version
pnpm --version

# Create swap once. Do not rerun these lines if /swapfile already exists.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

# Keep SSH open before enabling the host firewall.
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

sudo dpkg-reconfigure -plow unattended-upgrades
```

Verify the swap:

```bash
free -h
swapon --show
```

### 7.4 GitHub SSH access and clone

Create a named GitHub key under the `ubuntu` account. The private key stays on
the instance and must never be copied into the repository:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh

ssh-keygen -t ed25519 \
  -C "skspavithiran@gmail.com" \
  -f ~/.ssh/github_payment_platform
```

For unattended deployments, leave the passphrase empty. Display the public key:

```bash
cat ~/.ssh/github_payment_platform.pub
```

Add that public key in GitHub under **Settings → SSH and GPG keys**, or add it
as a read-only repository **Deploy key**. Then put this in `~/.ssh/config`:

```sshconfig
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_payment_platform
    IdentitiesOnly yes
```

Apply permissions and test authentication:

```bash
chmod 600 ~/.ssh/config ~/.ssh/github_payment_platform
chmod 644 ~/.ssh/github_payment_platform.pub
ssh -T git@github.com
```

Clone the repository, replacing the GitHub owner and repository placeholders:

```bash
sudo mkdir -p /srv/payment-platform
sudo chown ubuntu:ubuntu /srv/payment-platform

git clone git@github.com:GITHUB_OWNER/GITHUB_REPOSITORY.git \
  /srv/payment-platform/payment-crypto

cd /srv/payment-platform/payment-crypto
git status
git branch -a
```

If the clone already exists, do not clone again:

```bash
cd /srv/payment-platform/payment-crypto
git fetch --prune origin
git switch main
git pull --ff-only origin main
```

### 7.5 PostgreSQL, tuned for 2 GiB

Create the login first and make it the database owner. Using `\password` avoids
putting the database password in shell history:

```bash
sudo -u postgres psql
```

At the PostgreSQL prompt:

```sql
CREATE ROLE pp LOGIN;
\password pp
CREATE DATABASE payment_platform OWNER pp;
\q
```

Use a long alphanumeric password so it can be placed in `DATABASE_URL` without
URL encoding. Find the active configuration file:

```bash
sudo -u postgres psql -tAc "SHOW config_file;"
```

Open the returned file with `sudoedit` and set:

```conf
listen_addresses = 'localhost'
shared_buffers = 256MB
effective_cache_size = 768MB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 40
```

Only the two API processes use database pools: `DB_POOL_MAX=10` therefore uses
at most 20 application connections, leaving headroom for migrations and admin
access. Restart and verify PostgreSQL:

```bash
sudo systemctl restart postgresql
sudo systemctl enable postgresql
sudo ss -lntp | grep 5432
```

The listener must show only loopback (`127.0.0.1` and/or `::1`), never
`0.0.0.0:5432`.

### 7.6 Application environment

Create the root environment file:

```bash
cd /srv/payment-platform/payment-crypto
cp .env.example .env
nano .env
```

Use this complete sandbox shape, replacing every placeholder:

```dotenv
# PostgreSQL
DATABASE_URL=postgresql://pp:YOUR_DB_PASSWORD@127.0.0.1:5432/payment_platform
DB_POOL_MAX=10
DB_SSL=false

# Generate each separately with: openssl rand -base64 32
PII_MASTER_KEK=YOUR_32_BYTE_BASE64_KEK
PII_BLIND_INDEX_PEPPER=YOUR_32_BYTE_BASE64_PEPPER

# All three keys must come from the same MoonPay environment.
MOONPAY_PUBLISHABLE_KEY=YOUR_MOONPAY_TEST_PUBLISHABLE_KEY
MOONPAY_SECRET_KEY=YOUR_MOONPAY_TEST_SECRET_KEY
MOONPAY_WEBHOOK_KEY=YOUR_MOONPAY_TEST_WEBHOOK_KEY
MOONPAY_WIDGET_MODE=embedded
MOONPAY_REQUIRE_IP_MATCH=false
MOONPAY_WEBHOOK_TOLERANCE_SECONDS=3600

# Public HTTPS origin. Do not include a trailing slash.
WEB_BASE_URL=https://pay.example.com
AML_RETENTION_DAYS=1825

# Do not set PORT in this file. The pp-api@ systemd template supplies each
# instance's port explicitly (3000 or 3010).

# Shared only by the Next.js server and NestJS API. Generate with:
# openssl rand -hex 32
PAYMENT_API_KEY=YOUR_RANDOM_INTERNAL_API_KEY

# Loopback nginx balances Next.js BFF calls across both API processes.
PAYMENT_API_URL=http://127.0.0.1:8080

# This UUID exists only after the repository's sandbox seed is applied.
PAYMENT_MERCHANT_ID=11111111-1111-1111-1111-111111111111
```

Generate the three random values with separate commands:

```bash
openssl rand -base64 32     # PII_MASTER_KEK
openssl rand -base64 32     # PII_BLIND_INDEX_PEPPER
openssl rand -hex 32        # PAYMENT_API_KEY
```

Protect the file:

```bash
sudo chown ubuntu:ubuntu /srv/payment-platform/payment-crypto/.env
chmod 600 /srv/payment-platform/payment-crypto/.env
```

This `.env` procedure is for sandbox/staging. Before production, move the KEK,
blind-index pepper, MoonPay secrets, and internal API key to SSM Parameter Store
`SecureString` parameters and inject them at service startup. The application
still receives them as environment variables, but they no longer live in the
Git checkout.

### 7.7 Install, migrate, seed, and build

The first build can run on the instance after the 2 GiB swap is active:

```bash
cd /srv/payment-platform/payment-crypto
pnpm install --frozen-lockfile
pnpm db:migrate

# SANDBOX ONLY. This inserts demonstration merchants and wallet addresses.
pnpm db:seed

pnpm build
```

Do not run `pnpm db:seed` in production. The current
[`apps/web/next.config.ts`](../apps/web/next.config.ts) does not enable Next.js
standalone output, so this runbook intentionally keeps `node_modules` and starts
Next through its installed server binary. GitHub Actions plus versioned release
directories is the preferred later improvement; it avoids building on the 2 GiB
host and enables genuinely atomic deployments.

### 7.8 systemd API configuration

Create `/etc/systemd/system/pp-api@.service`:

```ini
[Unit]
Description=Payment Platform API (port %i)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/srv/payment-platform/payment-crypto
EnvironmentFile=/srv/payment-platform/payment-crypto/.env
Environment=NODE_ENV=production
# /usr/bin/env deliberately overrides any accidental PORT inherited elsewhere.
ExecStart=/usr/bin/env PORT=%i /usr/bin/node /srv/payment-platform/payment-crypto/apps/api/dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

### 7.9 systemd web configuration

Create `/etc/systemd/system/pp-web@.service`:

```ini
[Unit]
Description=Payment Platform Web (port %i)
After=network-online.target pp-api@3000.service pp-api@3010.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/srv/payment-platform/payment-crypto
EnvironmentFile=/srv/payment-platform/payment-crypto/.env
Environment=NODE_ENV=production
Environment=PORT=%i
ExecStart=/usr/bin/node /srv/payment-platform/payment-crypto/apps/web/node_modules/next/dist/bin/next start /srv/payment-platform/payment-crypto/apps/web --port %i
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/payment-platform/payment-crypto/apps/web/.next/cache

[Install]
WantedBy=multi-user.target
```

Load and start all four instances:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pp-api@3000 pp-api@3010
sudo systemctl enable --now pp-web@3001 pp-web@3011

sudo systemctl status pp-api@3000 --no-pager
sudo systemctl status pp-api@3010 --no-pager
sudo systemctl status pp-web@3001 --no-pager
sudo systemctl status pp-web@3011 --no-pager
```

If `/usr/bin/node` is not the result of `command -v node`, use the returned
absolute path in both units.

### 7.10 nginx bootstrap and TLS

The final nginx configuration in §5.3 references a certificate that does not
exist yet. Start with this temporary HTTP-only file at
`/etc/nginx/sites-available/payment-platform`:

```nginx
upstream pp_web_bootstrap {
    server 127.0.0.1:3001;
    server 127.0.0.1:3011;
}

server {
    listen 80;
    listen [::]:80;
    server_name pay.example.com;

    location / {
        proxy_pass http://pp_web_bootstrap;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Replace `pay.example.com`, enable the site, and validate it:

```bash
sudo ln -s /etc/nginx/sites-available/payment-platform \
  /etc/nginx/sites-enabled/payment-platform
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

The domain's DNS `A` record must now point to the EC2 Elastic IP, and ports 80
and 443 must be open in `sg-pp-web`. If using Cloudflare, leave the record DNS
only (grey cloud) until the certificate has been issued. Obtain the certificate:

```bash
sudo certbot certonly --nginx -d pay.example.com
```

Now replace the temporary file with the complete §5.3 configuration, substituting
the same domain in `server_name`, `ssl_certificate`, and
`ssl_certificate_key`, then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

If Cloudflare proxying is enabled afterward, use **SSL/TLS → Full (strict)** and
configure Cloudflare's published IP ranges with `set_real_ip_from` plus:

```nginx
real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

Do not trust `CF-Connecting-IP` from arbitrary sources: every
`set_real_ip_from` entry must be one of Cloudflare's official ranges. This is
required before live MoonPay IP matching is enabled.

### 7.11 Deployment verification

Check local listeners and services:

```bash
sudo ss -lntp
curl -I http://127.0.0.1:3001
curl -I http://127.0.0.1:3011
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3010/
curl -I https://pay.example.com
```

A NestJS `404` at the API root is expected and proves that the API answered.
Ports 3000, 3010, 3001, 3011, 5432, and 8080 must not be present in the EC2
security group's inbound rules.

Inspect logs if any check fails:

```bash
sudo journalctl -u pp-api@3000 -n 100 --no-pager
sudo journalctl -u pp-api@3010 -n 100 --no-pager
sudo journalctl -u pp-web@3001 -n 100 --no-pager
sudo journalctl -u pp-web@3011 -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

Complete the external setup:

1. Register `pay.example.com` under MoonPay **Developers → General → App or
   website domains**.
2. Register `https://pay.example.com/webhooks/moonpay` as the webhook URL.
3. Run the Singapore quote/IP test from §1.6.
4. Complete one sandbox purchase end to end.
5. Set the AWS billing alarm and uptime monitor from §8.

### 7.12 Updating from GitHub

This simple in-place process has a short maintenance window. Versioned release
directories are required for a truly zero-downtime build-and-switch workflow.

```bash
cd /srv/payment-platform/payment-crypto
git status                         # must be clean
git fetch --prune origin
git switch main
git pull --ff-only origin main

sudo systemctl stop pp-web@3001 pp-web@3011
sudo systemctl stop pp-api@3000 pp-api@3010

pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate

sudo systemctl start pp-api@3000 pp-api@3010
sudo systemctl start pp-web@3001 pp-web@3011
sudo nginx -t
curl -I https://pay.example.com
```

Never run the sandbox seed during a routine deployment.

### 7.13 Production secrets

**`PII_MASTER_KEK` must not remain in a plaintext `.env` on a public-subnet
production box.** [`pii-retention-policy.md`](pii-retention-policy.md) is
explicit that file-based key material is a local/sandbox compromise.

The minimum $0 improvement is AWS SSM Parameter Store with `SecureString`
parameters encrypted by the AWS-managed KMS key. Give the instance an IAM role
with `ssm:GetParameter` only for the `/pp/prod/*` path and fetch secrets at boot.
Secrets Manager adds built-in rotation for $0.40/secret/month and is a later
upgrade. Do not print decrypted values into deployment logs or write them into
the Git repository.

---

## 8. Operating it

### 8.1 Monitoring on the free tier

- **CloudWatch free tier:** 10 custom metrics, 10 alarms, 5 GB logs ingestion. Enough for what matters.
- **Set a billing alarm at $18** — the single most important alarm on a fixed budget. Do this first.
- Alarms worth having: `StatusCheckFailed`, `CPUCreditBalance` low (early warning of throttling), disk >80%.
- Memory and disk are **not** reported by default — install the CloudWatch agent, or use `node_exporter` + a free external scraper.

### 8.2 Uptime checking

UptimeRobot / Better Uptime free tiers will ping `https://pay.example.com` every 5 minutes and alert you. Free, and on a single-instance deployment it is your actual outage detection.

### 8.3 Application-level alerting this project specifically needs

Beyond infrastructure: **alert on orders reaching `MANUAL_REVIEW`**, particularly stage-four delivery failures. Those are *card charged, crypto not delivered* — money at risk sitting silently in a queue. See [`moonpay-onramp-migration.md`](moonpay-onramp-migration.md) §3.6.

### 8.4 Backups

EBS snapshots are $0.05/GB-mo — a 12 GB snapshot is $0.60/mo, which does not fit the on-demand budget but fits comfortably if you take the Savings Plan.

Cheaper: nightly `pg_dump` to **S3 Glacier Instant Retrieval** ($0.004/GB-mo). A compressed dump of this schema will be megabytes; the cost rounds to zero.

```bash
pg_dump -Fc payment_platform | \
  aws s3 cp - s3://your-bucket/pp-$(date +%F).dump --storage-class GLACIER_IR
```

**Test the restore.** An untested backup is not a backup — and for a ledger holding financial records, it is the difference between an incident and a catastrophe.

---

## 9. Upgrade path, and what each step costs

When budget allows, in the order that buys the most safety per dollar:

| Step | Adds | Cost/mo | Buys you |
|---|---|---|---|
| 1. RDS `db.t4g.micro` + 20 GB | Managed Postgres, private subnet | ~$13–15 | Automated backups, PITR, patching. **Do this first** — the DB is the irreplaceable part |
| 2. Second app instance + ALB | Real HA across two AZs | ~$16 ALB + $19 instance | Survives instance/AZ failure |
| 3. Auto Scaling Group | Self-healing, rolling deploys | $0 (ASG is free) | Replaces failed instances automatically |
| 4. Secrets Manager + rotation | Proper secret lifecycle | $0.40/secret | Rotation, finer audit |
| 5. WAF on the ALB | Rate limiting, managed rules | ~$8 + rules | Card-testing and enumeration defence |

Reserving the two private subnets and the second public subnet **now** (§3) makes steps 1 and 2 configuration changes rather than a migration.

---

## 10. Final cost sheet

**Recommended: 1× `t4g.small`, `ap-southeast-1` (Singapore), 1-year EC2 Instance Savings Plan, 20 GB gp3**

| Line | On-demand (to start) | + 1-yr EC2 Instance SP (once confirmed, §1.7) |
|---|---|---|
| `t4g.small`, Singapore | $15.48 | **$9.75** (~37% off) |
| EBS gp3, 20 GB | $1.60 | $1.60 |
| Elastic IP (1) | $3.65 | $3.65 |
| Data transfer out (<100 GB) | $0.00 | $0.00 |
| DNS — Spaceship or Cloudflare free | $0.00 | $0.00 |
| TLS — Let's Encrypt | $0.00 | $0.00 |
| CloudWatch — free tier | $0.00 | $0.00 |
| `pg_dump` → Glacier IR | ~$0.01 | ~$0.01 |
| **Total** | **≈ $20.74 — over budget** | **≈ $15.00** |

**On-demand alone does not fit $20 in Singapore.** That's expected and fine as a starting point (§1.7) — the Savings Plan is the intended end state, not an optional optimization. Once bought, **$5.00/mo of headroom** remains against the $20 target.

**Buy the commitment once Singapore is confirmed working (§1.6's curl test, plus a real sandbox purchase), not on day one.** If AWS credits are covering the early months, the SP's discount is wasted while they last — buy it once real spend starts. Set the billing alarm in §8.1 at **$18** so an unexpectedly long on-demand stretch is visible before it becomes a surprise.

---

## Appendix — quick reference

```
Instance      t4g.small (Graviton2 ARM), Ubuntu 22.04 LTS **arm64 AMI**,
              ap-southeast-1a (Singapore), credits=standard, ON-DEMAND to start
Disk          20 GB gp3 + 2 GB swap file
Cost          $20.74/mo on-demand (over budget - expected, temporary)
              $15.00/mo once on a 1-yr EC2 Instance Savings Plan (the target)
Plan timing   Buy the SP once Singapore is confirmed working end-to-end and
              any promotional AWS credit is running out - not on day one.
VPC           10.0.0.0/16   (subnet AZs below are ap-southeast-1a / -1b)
  public-a    10.0.1.0/24   <- the instance
  public-b    10.0.2.0/24   <- reserved, future ALB
  private-a   10.0.11.0/24  <- reserved, future RDS
  private-b   10.0.12.0/24  <- reserved, future RDS standby
No NAT Gateway (would be $32.85/mo, larger than the whole budget)

Ports   nginx 80/443 -> web 3001,3011 | api 3000,3010 | postgres 5432 loopback only
DNS     Spaceship -> Cloudflare (free) -> Elastic IP, proxied, SSL Full (strict)
TLS     certbot --nginx, auto-renewing

MoonPay must-dos on this host:
  - WEB_BASE_URL = https://pay.example.com   (HTTPS mandatory in live mode)
  - register the domain in MoonPay -> Developers -> website domains
    (otherwise the widget iframe is CSP-blocked)
  - webhook endpoint: https://pay.example.com/webhooks/moonpay
  - nginx MUST set X-Forwarded-For correctly - IP matching is mandatory in
    live and depends on it end to end (main.ts already sets trustProxy:true)
  - behind Cloudflare, also set real_ip_header CF-Connecting-IP

Gotchas that will bite:
  - x86 AMI on t4g = will not boot. Pick the arm64 image.
  - t3/t4g default to UNLIMITED credits = surprise bills. Set standard.
  - Public IPv4 is $3.65/mo each since Feb 2024, even when attached.
  - On-demand credits/trial run out eventually; bill goes to $20.74
    ($15.00 once the EC2 Instance Savings Plan is bought, see 1.7/10).
  - Region is Singapore, not Mumbai: MoonPay's own /v3/countries flags
    India isAllowed:false, and order creation makes a live server-side
    call to MoonPay before an order even exists. Not worth the risk for
    $5.33/mo less. Verify with the curl test in section 1.6 regardless.
  - EC2 Instance SP (not Compute SP) is cheaper once region+family are
    fixed - but buy it once Singapore is proven working and any credit
    runway is ending, not on day one.
```
