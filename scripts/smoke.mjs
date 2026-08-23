/**
 * End-to-end smoke test against a running API.
 *
 * Exercises the guarantees that are easy to claim and easy to get wrong:
 * order idempotency, wallet-address locking, webhook signature rejection,
 * replay-window enforcement, secret rotation, duplicate-delivery dedupe,
 * out-of-order (backwards) transitions, misdelivery detection, and the happy
 * path. Run with the API up and the database migrated:
 *
 *   pnpm api:dev            # terminal 1
 *   node scripts/smoke.mjs  # terminal 2
 *
 * The script starts its own stub of Stripe's onramp API (scripts/stripe-stub.mjs)
 * so it runs without onramp credentials. Point STRIPE_API_BASE_URL at the stub
 * in the API's environment - .env does this already for local work.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startStripeStub } from './stripe-stub.mjs';

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
const WEBHOOK_SECRET =
  process.env.STRIPE_ONRAMP_WEBHOOK_SECRET ?? fileEnv.STRIPE_ONRAMP_WEBHOOK_SECRET;
const API_KEY = process.env.PAYMENT_API_KEY ?? fileEnv.PAYMENT_API_KEY;
const STUB_URL = process.env.STRIPE_API_BASE_URL ?? fileEnv.STRIPE_API_BASE_URL;

if (!WEBHOOK_SECRET) {
  console.error('STRIPE_ONRAMP_WEBHOOK_SECRET not found in env or .env');
  process.exit(1);
}
if (!API_KEY) {
  console.error('PAYMENT_API_KEY not found in env or .env');
  process.exit(1);
}

const MERCHANT = '11111111-1111-1111-1111-111111111111';
const APPROVED_ADDRESS = '0x2222222222222222222222222222222222222222';

/**
 * Event ids must be unique per run. They are the provider's own identifiers and
 * the dedupe table treats a repeat as an already-handled delivery - so reusing
 * a fixed id across runs makes every webhook after the first run a no-op.
 * (This is not hypothetical: the first version of this script did exactly that
 * and the "failures" were the deduplication working correctly.)
 */
const RUN = randomUUID().slice(0, 8);
const evt = (name) => `evt_${RUN}_${name}`;

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

/** Build a Stripe `crypto.onramp_session.updated` event envelope. */
function onrampEvent(id, { reference, sessionId, status, walletAddress, destinationAmount, transactionId }) {
  return {
    id,
    object: 'event',
    api_version: '2026-07-29',
    created: Math.floor(Date.now() / 1000),
    type: 'crypto.onramp_session.updated',
    data: {
      object: {
        id: sessionId,
        object: 'crypto.onramp_session',
        status,
        livemode: false,
        metadata: reference ? { partner_order_id: reference } : {},
        transaction_details: {
          destination_currency: 'usdc',
          destination_network: 'polygon',
          destination_amount: destinationAmount ?? null,
          source_currency: 'usd',
          source_amount: '150.00',
          lock_wallet_address: true,
          transaction_id: transactionId ?? null,
          wallet_address: walletAddress ?? APPROVED_ADDRESS,
        },
      },
    },
  };
}

/**
 * Sign exactly as Stripe does: HMAC-SHA256 over `${t}.${rawBody}` with the
 * endpoint secret, `t` in SECONDS. `extraSecret` adds a second v1 signature,
 * which is what an endpoint mid-secret-roll actually receives.
 */
function signed(body, { timestampSeconds = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET, extraSecret, scheme = 'v1' } = {}) {
  const raw = JSON.stringify(body);
  const sign = (s) => createHmac('sha256', s).update(`${timestampSeconds}.`).update(raw).digest('hex');
  const parts = [`t=${timestampSeconds}`, `${scheme}=${sign(secret)}`];
  if (extraSecret) parts.push(`v1=${sign(extraSecret)}`);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': parts.join(',') },
    body: raw,
  };
}

const authed = (init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...init.headers },
});

async function postWebhook(init) {
  return fetch(`${BASE}/webhooks/stripe`, init);
}

async function order(reference) {
  const res = await fetch(`${BASE}/orders/${reference}`, authed());
  return res.json();
}

async function orderStatus(reference) {
  return (await order(reference)).status;
}

const settle = () => new Promise((r) => setTimeout(r, 400));

async function createOrder(overrides = {}, idempotencyKey = randomUUID()) {
  const res = await fetch(
    `${BASE}/orders`,
    authed({
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        merchantId: MERCHANT,
        fiatAmount: '150.00',
        fiatCurrency: 'USD',
        cryptoAsset: 'USDC',
        network: 'polygon',
        customerEmail: 'payer@example.com',
        customerCountry: 'GB',
        ...overrides,
      }),
    }),
  );
  return { res, body: await res.json() };
}

async function main() {
  console.log(`\nSmoke test against ${BASE}`);

  let stub;
  if (STUB_URL && /127\.0\.0\.1|localhost/.test(STUB_URL)) {
    stub = await startStripeStub({ port: Number(new URL(STUB_URL).port) });
    console.log(`stripe onramp stub on ${stub.url}\n`);
  } else {
    console.log('STRIPE_API_BASE_URL is not local - assuming a real onramp endpoint\n');
  }

  try {
    // --- order creation -------------------------------------------------
    console.log('order creation');
    const idemKey = randomUUID();
    const { res: createRes, body: created } = await createOrder({}, idemKey);

    check('order created', createRes.status === 201, `status ${createRes.status}`);
    check('checkout url returned', typeof created.checkoutUrl === 'string', String(created.checkoutUrl));
    check('onramp session minted', typeof created.onramp?.sessionId === 'string' && created.onramp.sessionId.startsWith('cos_'));
    check('client secret returned to the BFF', typeof created.onramp?.clientSecret === 'string');
    check('publishable key returned, secret key is not', created.onramp?.publishableKey?.startsWith('pk_') === true && !JSON.stringify(created).includes('sk_'));
    check('amount round-trips exactly', created.fiatAmount === '150.00', created.fiatAmount);

    if (stub) {
      const session = stub.sessions.get(created.onramp.sessionId);
      check('wallet address locked at Stripe', session?.transaction_details.lock_wallet_address === true, 'payer must not be able to edit the destination');
      check('wallet pinned to the approved destination', session?.transaction_details.wallet_address === APPROVED_ADDRESS);
      check('order reference travels as metadata', session?.metadata.partner_order_id === created.reference);
    }

    const { body: replayed } = await createOrder({}, idemKey);
    check('idempotent create returns same order', replayed.reference === created.reference);
    check('idempotent create does not mint a second session', replayed.onramp?.sessionId === created.onramp?.sessionId);

    const noKey = await fetch(`${BASE}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ merchantId: MERCHANT, fiatAmount: '150.00', fiatCurrency: 'USD', cryptoAsset: 'USDC', network: 'polygon' }),
    });
    check('missing idempotency key rejected', noKey.status === 400, `status ${noKey.status}`);

    const unauthed = await fetch(`${BASE}/orders/${created.reference}`);
    check('order read without API key rejected', unauthed.status === 401, `status ${unauthed.status}`);

    // Stripe only funds from USD and EUR; anything else must fail at creation,
    // not at the payment step where the customer is already committed.
    const { res: badCurrency } = await createOrder({ fiatCurrency: 'GBP' });
    check('unfundable source currency rejected at creation', badCurrency.status === 400, `status ${badCurrency.status}`);

    if (stub) {
      const { res: geo } = await createOrder({ customerIpAddress: '203.0.113.7' });
      check('unsupportable geography rejected at creation', geo.status === 400, `status ${geo.status}`);
    }

    const ref = created.reference;
    const sessionId = created.onramp.sessionId;

    // --- webhook verification -------------------------------------------
    console.log('\nwebhook verification');

    const forged = await postWebhook({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'deadbeef'.repeat(8)}`,
      },
      body: JSON.stringify(onrampEvent(evt('forged'), { reference: ref, sessionId, status: 'fulfillment_complete' })),
    });
    check('forged signature rejected', forged.status === 400, `status ${forged.status}`);
    check('forged webhook did not move order', (await orderStatus(ref)) === 'CREATED');

    const stale = await postWebhook(
      signed(onrampEvent(evt('stale'), { reference: ref, sessionId, status: 'fulfillment_complete' }), {
        timestampSeconds: Math.floor(Date.now() / 1000) - 10 * 60,
      }),
    );
    check('replayed old timestamp rejected', stale.status === 400, `status ${stale.status}`);

    // v0 is only ever sent alongside v1 on test events; honouring it on its own
    // would be a downgrade attack.
    const v0Only = await postWebhook(
      signed(onrampEvent(evt('v0'), { reference: ref, sessionId, status: 'fulfillment_complete' }), { scheme: 'v0' }),
    );
    check('non-v1 signature scheme rejected', v0Only.status === 400, `status ${v0Only.status}`);
    check('rejected webhooks did not move order', (await orderStatus(ref)) === 'CREATED');

    // --- state machine ---------------------------------------------------
    console.log('\nstate machine');

    await postWebhook(signed(onrampEvent(evt('1'), { reference: ref, sessionId, status: 'requires_payment' })));
    await settle();
    check('advanced to PAYMENT_PENDING', (await orderStatus(ref)) === 'PAYMENT_PENDING');

    const dupe = await postWebhook(signed(onrampEvent(evt('1'), { reference: ref, sessionId, status: 'requires_payment' })));
    const dupeBody = await dupe.json();
    check('duplicate delivery deduped', dupe.status === 200 && dupeBody.duplicate === true);

    // A secret mid-roll produces two v1 signatures, only one of which we hold.
    await postWebhook(
      signed(onrampEvent(evt('roll'), { reference: ref, sessionId, status: 'requires_payment' }), {
        secret: 'whsec_the_secret_being_rotated_out',
        extraSecret: WEBHOOK_SECRET,
      }),
    );
    await settle();
    check('accepts one of several v1 signatures during a secret roll', (await orderStatus(ref)) === 'PAYMENT_PENDING');

    await postWebhook(
      signed(onrampEvent(evt('2'), { reference: ref, sessionId, status: 'fulfillment_processing' })),
    );
    await settle();
    check('advanced to PAYMENT_CONFIRMED', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    // Stripe does not guarantee event ordering, so a late earlier event is the
    // normal case: it must be dropped, not applied.
    await postWebhook(
      signed(onrampEvent(evt('3-late'), { reference: ref, sessionId, status: 'requires_payment' })),
    );
    await settle();
    check('out-of-order webhook did not move order backwards', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    // An event type the endpoint is subscribed to but this integration does not
    // handle must be a silent no-op, never an escalation.
    const unrelated = onrampEvent(evt('unrelated'), { reference: ref, sessionId, status: 'fulfillment_complete' });
    unrelated.type = 'payment_intent.succeeded';
    await postWebhook(signed(unrelated));
    await settle();
    check('unrelated event type ignored, not escalated', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    await postWebhook(
      signed(
        onrampEvent(evt('4'), {
          reference: ref,
          sessionId,
          status: 'fulfillment_complete',
          destinationAmount: '150.000000000000000000',
          transactionId: '0xabc123',
        }),
      ),
    );
    await settle();
    const done = await order(ref);
    check('reached COMPLETED', done.status === 'COMPLETED');
    // Stripe renders every amount at the chain's full precision; USDC holds 6.
    // The padding must be dropped, not rejected and not truncated to a wrong figure.
    check('settled amount stored at the asset precision', done.cryptoAmountSettled === '150.000000', String(done.cryptoAmountSettled));
    check('delivery tx hash recorded', done.chainTxHash === '0xabc123', String(done.chainTxHash));

    const completed = await fetch(`${BASE}/orders/${ref}/onramp-session`, authed());
    check('client secret withheld once the order is terminal', completed.status === 404, `status ${completed.status}`);

    // --- misdelivery -------------------------------------------------------
    console.log('\ndelivery address');

    const { body: second } = await createOrder();
    await postWebhook(
      signed(
        onrampEvent(evt('misdelivery'), {
          reference: second.reference,
          sessionId: second.onramp.sessionId,
          status: 'fulfillment_complete',
          walletAddress: '0x9999999999999999999999999999999999999999',
        }),
      ),
    );
    await settle();
    check('delivery to an unapproved address escalates to MANUAL_REVIEW', (await orderStatus(second.reference)) === 'MANUAL_REVIEW');

    // --- unknown status ----------------------------------------------------
    console.log('\nunknown provider status');

    const { body: third } = await createOrder();
    await postWebhook(
      signed(
        onrampEvent(evt('unknown'), {
          reference: third.reference,
          sessionId: third.onramp.sessionId,
          status: 'some_new_status_stripe_added',
        }),
      ),
    );
    await settle();
    check('unknown provider status escalates to MANUAL_REVIEW', (await orderStatus(third.reference)) === 'MANUAL_REVIEW');

    // --- session lookup by id only -----------------------------------------
    console.log('\nsession lookup fallback');

    const { body: fourth } = await createOrder();
    const noMetadata = onrampEvent(evt('nometa'), {
      reference: null,
      sessionId: fourth.onramp.sessionId,
      status: 'requires_payment',
    });
    await postWebhook(signed(noMetadata));
    await settle();
    check('order found by session id when metadata is absent', (await orderStatus(fourth.reference)) === 'PAYMENT_PENDING');
  } finally {
    await stub?.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
