/**
 * Throwaway listener for MoonPay Commerce (Helio) webhooks.
 *
 * Point a sandbox webhook endpoint at this (via ngrok) and it captures the
 * delivery verbatim, then answers questions the documentation leaves open:
 *
 *   - Does X-Signature verify as HMAC-SHA256(rawBody) keyed with the Secret?
 *   - Is there a TIMESTAMP anywhere in the signature or headers? If not, the
 *     signature is replayable forever and the provider_events unique
 *     constraint is the ONLY replay defence, not merely the primary one.
 *     (docs/commerce-sandbox-setup.md, "Webhook verification specifics")
 *   - What does the payload actually look like, and what are the event types?
 *
 * This is EVALUATION SCAFFOLDING, not the real handler. It writes nothing to
 * the database and is deliberately separate from apps/api.
 *
 *   1. HELIO_WEBHOOK_SHARED_TOKEN=<the dashboard "Secret"> \
 *        node scripts/commerce-webhook-listener.mjs
 *   2. ngrok http 4000
 *   3. Paste the ngrok https URL + /webhook into the dashboard's Endpoint URL
 *
 * Dependency-free, matching the other scripts in this directory.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readEnvFile(url) {
  const out = {};
  let text;
  try {
    text = readFileSync(fileURLToPath(url), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = readEnvFile(new URL('../.env', import.meta.url));
const TOKEN = process.env.HELIO_WEBHOOK_SHARED_TOKEN ?? fileEnv.HELIO_WEBHOOK_SHARED_TOKEN;
const PORT = Number(process.env.PORT ?? 4000);

if (!TOKEN) {
  console.error(`
HELIO_WEBHOOK_SHARED_TOKEN not set.

It is the "Secret" shown in the MoonPay Commerce dashboard when you add a
webhook endpoint (Developer -> Webhooks -> Add Endpoint). Copy it with the
copy button - the masked portion cannot be recovered afterwards.

  HELIO_WEBHOOK_SHARED_TOKEN=<secret> node scripts/commerce-webhook-listener.mjs
`);
  process.exit(1);
}

/** Constant-time compare that cannot throw on a length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

let seq = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // The RAW bytes. Never re-serialise before verifying - a re-encoded body
    // produces a different HMAC even when semantically identical. This is the
    // same trap apps/api solves with Fastify's rawBody option.
    const raw = Buffer.concat(chunks).toString('utf8');
    const n = ++seq;

    console.log(`\n${'='.repeat(72)}`);
    console.log(`#${n}  ${req.method} ${req.url}   ${new Date().toISOString()}`);
    console.log('='.repeat(72));

    if (req.method !== 'POST') {
      res.writeHead(200).end('listener alive');
      console.log('  (non-POST - ignored. The dashboard may probe with GET.)');
      return;
    }

    console.log('\n-- headers --');
    for (const [k, v] of Object.entries(req.headers)) {
      // Do not print the bearer token itself; confirm its presence instead.
      const shown = k.toLowerCase() === 'authorization' ? '<present, redacted>' : v;
      console.log(`  ${k}: ${shown}`);
    }

    // --- signature ------------------------------------------------------
    const sig = req.headers['x-signature'];
    console.log('\n-- signature --');
    if (!sig) {
      console.log('  X-Signature: ABSENT');
      console.log('  -> Deliveries are not signed the way the docs describe. Record this.');
    } else {
      const expected = createHmac('sha256', TOKEN).update(raw, 'utf8').digest('hex');
      const ok = safeEqual(String(sig), expected);
      console.log(`  X-Signature: ${sig}`);
      console.log(`  computed   : ${expected}`);
      console.log(`  VERIFIES   : ${ok ? 'YES - HMAC-SHA256(rawBody) keyed with the Secret' : 'NO'}`);
      if (!ok) {
        console.log(`
  A mismatch usually means one of:
    - wrong Secret (each endpoint has its OWN - check you copied the right one)
    - the digest is over something other than the bare raw body
      (some providers prefix a timestamp, e.g. "<ts>.<body>")
    - hex vs base64 encoding
  Record the exact header and body so the real handler can be written against
  observed behaviour rather than docs.`);
      }
    }

    // --- replay exposure -------------------------------------------------
    const auth = req.headers['authorization'];
    const tsHeader = Object.keys(req.headers).find((h) => /timestamp|date|x-request-time/i.test(h));
    let tsInBody = false;
    try {
      const j = JSON.parse(raw);
      tsInBody = Boolean(j.timestamp ?? j.createdAt ?? j.eventTime ?? j.time);
    } catch {
      /* not json */
    }

    console.log('\n-- replay exposure --');
    console.log(`  Authorization bearer present : ${auth ? 'yes' : 'NO'}`);
    console.log(`  timestamp header             : ${tsHeader ?? 'none found'}`);
    console.log(`  timestamp-ish field in body  : ${tsInBody ? 'yes' : 'no'}`);
    if (!tsHeader && !tsInBody) {
      console.log(`
  No timestamp anywhere -> this signature is replayable INDEFINITELY. Anyone
  who captures one valid delivery can resend it forever. If Commerce is
  adopted, the provider_events unique constraint is then the ONLY thing
  preventing replay, so the dedupe key must be derived from something stable
  and unique in the payload. Confirm with MoonPay.`);
    }

    // --- payload ---------------------------------------------------------
    console.log('\n-- body --');
    try {
      const parsed = JSON.parse(raw);
      console.log(JSON.stringify(parsed, null, 2));
      console.log('\n-- candidate dedupe keys --');
      for (const k of ['id', 'eventId', 'transactionId', 'paylinkId', 'event', 'type', 'status']) {
        if (parsed[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(parsed[k])}`);
      }
    } catch {
      console.log(raw || '(empty)');
    }

    // Always 2xx: a non-2xx triggers exponential-backoff retries, which is
    // noise while probing. The real handler must be more discerning.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
  });
});

// Loopback ONLY. nginx (or ngrok) is the thing exposed to the internet; this
// process must never be directly reachable, even briefly, since it accepts any
// POST and returns 200.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
Commerce webhook listener on http://127.0.0.1:${PORT}  (loopback only)

  Expose it one of two ways:

  A) On your own domain - stable URL, no third party, recommended.
     Add the /webhooks/commerce-probe location block from
     deploy/nginx/payment-platform.conf, reload nginx, then use:
       https://api.terracottatiles.online/webhooks/commerce-probe

  B) Locally via ngrok - fine for a quick look, but the free tier issues a
     NEW URL on every restart and the endpoint must be re-registered each time.
       ngrok http ${PORT}
       https://<subdomain>.ngrok-free.app/webhook

  Every delivery is printed in full, with signature verification and a
  replay-exposure check. Ctrl-C to stop.
`);
});
