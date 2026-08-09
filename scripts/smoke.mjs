/**
 * End-to-end smoke test against a running API.
 *
 * Exercises the guarantees that are easy to claim and easy to get wrong:
 * order idempotency, webhook signature rejection, replay-window enforcement,
 * duplicate-delivery dedupe, out-of-order (backwards) transitions, and the
 * happy path. Run with the API up and the database migrated:
 *
 *   pnpm api:dev            # terminal 1
 *   node scripts/smoke.mjs  # terminal 2
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deliberately dependency-free: this script must run against a deployed API
// from anywhere, including a CI box with no workspace install.
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
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.TRANSAK_API_SECRET ?? fileEnv.TRANSAK_API_SECRET;

if (!SECRET) {
  console.error('TRANSAK_API_SECRET not found in env or .env');
  process.exit(1);
}
const MERCHANT = '11111111-1111-1111-1111-111111111111';

/**
 * Event ids must be unique per run. They are the provider's own identifiers and
 * the dedupe table treats a repeat as an already-handled delivery - so reusing
 * a fixed id across runs makes every webhook after the first run a no-op.
 * (This is not hypothetical: the first version of this script did exactly that
 * and the "failures" were the deduplication working correctly.)
 */
const RUN = randomUUID().slice(0, 8);
const evt = (name) => `${RUN}-${name}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    failed++;
  }
}

function signedWebhook(body, { timestamp = Date.now() } = {}) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.`).update(raw).digest('hex');
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-transak-signature': signature,
      'x-transak-timestamp': String(timestamp),
    },
    body: raw,
  };
}

async function orderStatus(reference) {
  const res = await fetch(`${BASE}/orders/${reference}`);
  return (await res.json()).status;
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  // --- order creation -------------------------------------------------
  console.log('order creation');
  const idemKey = randomUUID();
  const payload = {
    merchantId: MERCHANT,
    fiatAmount: '150.00',
    fiatCurrency: 'USD',
    cryptoAsset: 'USDT',
    network: 'polygon',
    customerEmail: 'payer@example.com',
    customerCountry: 'GB',
  };

  const createRes = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
    body: JSON.stringify(payload),
  });
  const order = await createRes.json();
  check('order created', createRes.status === 201, `status ${createRes.status}`);
  check('checkout url returned', typeof order.checkoutUrl === 'string');
  check(
    'checkout pins wallet address',
    order.checkoutUrl?.includes('disableWalletAddressForm=true'),
    'payer must not be able to edit the destination',
  );
  check('amount round-trips exactly', order.fiatAmount === '150.00', order.fiatAmount);

  const replay = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
    body: JSON.stringify(payload),
  });
  const replayed = await replay.json();
  check('idempotent create returns same order', replayed.reference === order.reference);

  const noKey = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  check('missing idempotency key rejected', noKey.status === 400, `status ${noKey.status}`);

  const ref = order.reference;

  // --- webhook verification -------------------------------------------
  console.log('\nwebhook verification');

  const forged = await fetch(`${BASE}/webhooks/transak`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-transak-signature': 'deadbeef'.repeat(8),
      'x-transak-timestamp': String(Date.now()),
    },
    body: JSON.stringify({ partnerOrderId: ref, status: 'COMPLETED', id: evt('forged-1') }),
  });
  check('forged signature rejected', forged.status === 401, `status ${forged.status}`);
  check('forged webhook did not move order', (await orderStatus(ref)) === 'CREATED');

  const stale = await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook(
      { partnerOrderId: ref, status: 'COMPLETED', id: evt('stale-1') },
      { timestamp: Date.now() - 10 * 60 * 1000 },
    ),
  );
  check('replayed old timestamp rejected', stale.status === 401, `status ${stale.status}`);

  // --- state machine ---------------------------------------------------
  console.log('\nstate machine');

  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'AWAITING_PAYMENT_FROM_USER', id: evt('1') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check('advanced to PAYMENT_PENDING', (await orderStatus(ref)) === 'PAYMENT_PENDING');

  const dupe = await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'AWAITING_PAYMENT_FROM_USER', id: evt('1') }),
  );
  const dupeBody = await dupe.json();
  check('duplicate delivery deduped', dupe.status === 200 && dupeBody.duplicate === true);

  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'PROCESSING', id: evt('2') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check('advanced to PAYMENT_CONFIRMED', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

  // Late-arriving earlier event: must be dropped, not applied.
  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'AWAITING_PAYMENT_FROM_USER', id: evt('3-late') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check(
    'out-of-order webhook did not move order backwards',
    (await orderStatus(ref)) === 'PAYMENT_CONFIRMED',
  );

  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'PENDING_DELIVERY_FROM_TRANSAK', id: evt('4') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref, status: 'COMPLETED', id: evt('5') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check('reached COMPLETED', (await orderStatus(ref)) === 'COMPLETED');

  // Unknown provider status must escalate, never silently no-op.
  const ref2 = (
    await (
      await fetch(`${BASE}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify(payload),
      })
    ).json()
  ).reference;

  await fetch(
    `${BASE}/webhooks/transak`,
    signedWebhook({ partnerOrderId: ref2, status: 'SOME_NEW_STATUS_WE_DO_NOT_KNOW', id: evt('x') }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check('unknown provider status escalates to MANUAL_REVIEW', (await orderStatus(ref2)) === 'MANUAL_REVIEW');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
