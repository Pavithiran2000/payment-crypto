/**
 * End-to-end smoke test against a running API.
 *
 * Exercises the guarantees that are easy to claim and easy to get wrong:
 * order idempotency, widget-URL signing, wallet-address pinning, amount
 * locking, secret-key containment, webhook signature rejection, replay-window
 * enforcement, duplicate-delivery dedupe, out-of-order (backwards) transitions,
 * stage-aware failure mapping, misdelivery detection, the donation path, and
 * the happy path. Run with the API up and the database migrated:
 *
 *   pnpm api:dev            # terminal 1
 *   node scripts/smoke.mjs  # terminal 2
 *
 * The script starts its own stub of MoonPay's API (scripts/moonpay-stub.mjs)
 * so it runs without MoonPay credentials. Point MOONPAY_API_BASE_URL at the
 * stub in the API's environment - .env does this already for local work.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMoonPayStub, buyTransaction } from './moonpay-stub.mjs';

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
const WEBHOOK_KEY = process.env.MOONPAY_WEBHOOK_KEY ?? fileEnv.MOONPAY_WEBHOOK_KEY;
const SECRET_KEY = process.env.MOONPAY_SECRET_KEY ?? fileEnv.MOONPAY_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.MOONPAY_PUBLISHABLE_KEY ?? fileEnv.MOONPAY_PUBLISHABLE_KEY;
const API_KEY = process.env.PAYMENT_API_KEY ?? fileEnv.PAYMENT_API_KEY;
const STUB_URL = process.env.MOONPAY_API_BASE_URL ?? fileEnv.MOONPAY_API_BASE_URL;

for (const [name, value] of Object.entries({
  MOONPAY_WEBHOOK_KEY: WEBHOOK_KEY,
  MOONPAY_SECRET_KEY: SECRET_KEY,
  MOONPAY_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  PAYMENT_API_KEY: API_KEY,
})) {
  if (!value) {
    console.error(`${name} not found in env or .env`);
    process.exit(1);
  }
}

const MERCHANT = '11111111-1111-1111-1111-111111111111';
const APPROVED_ADDRESS = '0x2222222222222222222222222222222222222222';

/**
 * MoonPay events carry no id of their own, so the platform derives one from
 * (type, transaction id, updatedAt). Two events must therefore differ in at
 * least one of those to be treated as distinct - which is exactly the property
 * being tested, so the suite varies `updatedAt` on purpose and reuses it when
 * checking deduplication.
 */
const RUN = Date.now();
let tick = 0;
const nextUpdatedAt = () => new Date(RUN + ++tick * 1000).toISOString();

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

/** Wrap a transaction in the envelope MoonPay actually POSTs. */
function event(type, tx) {
  return { type, data: tx, externalCustomerId: tx.externalCustomerId ?? null };
}

/**
 * Sign exactly as MoonPay does: HMAC-SHA256 over `${t}.${rawBody}` with the
 * WEBHOOK key, `t` in SECONDS, hex-encoded, in a `Moonpay-Signature-V2` header.
 * `extraKey` adds a second `s=` element, which is what an endpoint mid-key-roll
 * would receive.
 */
function signed(body, { timestampSeconds = Math.floor(Date.now() / 1000), key = WEBHOOK_KEY, extraKey, header = 'moonpay-signature-v2' } = {}) {
  const raw = JSON.stringify(body);
  const sign = (k) => createHmac('sha256', k).update(`${timestampSeconds}.`).update(raw).digest('hex');
  const parts = [`t=${timestampSeconds}`, `s=${sign(key)}`];
  if (extraKey) parts.push(`s=${sign(extraKey)}`);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', [header]: parts.join(',') },
    body: raw,
  };
}

const authed = (init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...init.headers },
});

async function postWebhook(init) {
  return fetch(`${BASE}/webhooks/moonpay`, init);
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

/** Re-derive a widget URL's signature the way MoonPay does, and compare. */
function signatureIsValid(widgetUrl) {
  const parsed = new URL(widgetUrl);
  const provided = parsed.searchParams.get('signature');
  if (!provided) return false;
  const params = new URLSearchParams(parsed.search);
  params.delete('signature');
  const expected = createHmac('sha256', SECRET_KEY).update(`?${params.toString()}`).digest('base64');
  return expected === provided;
}

async function main() {
  console.log(`\nSmoke test against ${BASE}`);

  let stub;
  if (STUB_URL && /127\.0\.0\.1|localhost/.test(STUB_URL)) {
    stub = await startMoonPayStub({ port: Number(new URL(STUB_URL).port) });
    console.log(`moonpay stub on ${stub.url}\n`);
  } else {
    console.log('MOONPAY_API_BASE_URL is not local - assuming a real MoonPay endpoint\n');
  }

  try {
    // --- order creation -------------------------------------------------
    console.log('order creation');
    const idemKey = randomUUID();
    const { res: createRes, body: created } = await createOrder({}, idemKey);

    check('order created', createRes.status === 201, `status ${createRes.status}`);
    check('checkout url returned', typeof created.checkoutUrl === 'string', String(created.checkoutUrl));
    check('signed widget url returned to the BFF', typeof created.onramp?.widgetUrl === 'string');
    check('amount round-trips exactly', created.fiatAmount === '150.00', created.fiatAmount);
    check('order type defaults to PURCHASE', created.orderType === 'PURCHASE', String(created.orderType));

    // The quote is the only pre-flight MoonPay offers, so it must actually run.
    check('quote taken at creation', created.cryptoAmountQuoted === '145.510000', String(created.cryptoAmountQuoted));
    check('quote expiry persisted', typeof created.quoteExpiresAt === 'string', String(created.quoteExpiresAt));
    if (stub) {
      const q = stub.quotes.at(-1);
      check('quote priced against cards, not a cheaper rail', q?.paymentMethod === 'credit_debit_card', String(q?.paymentMethod));
      check('quote asked MoonPay for the right currency code', q?.code === 'usdc_polygon', String(q?.code));
    }

    const widget = new URL(created.onramp.widgetUrl);
    const wp = widget.searchParams;
    check('widget url is signed', signatureIsValid(created.onramp.widgetUrl));
    check('publishable key in the url, secret key nowhere near it', wp.get('apiKey') === PUBLISHABLE_KEY && !created.onramp.widgetUrl.includes(SECRET_KEY));
    check('secret key absent from the whole response', !JSON.stringify(created).includes(SECRET_KEY));
    check('wallet pinned to the approved destination', wp.get('walletAddress') === APPROVED_ADDRESS, String(wp.get('walletAddress')));
    check('asset locked, not merely defaulted', wp.get('currencyCode') === 'usdc_polygon' && wp.get('defaultCurrencyCode') === null);
    check('amount locked so the payer cannot change it', wp.get('lockAmount') === 'true' && wp.get('baseCurrencyAmount') === '150.00');
    check('order reference travels as externalTransactionId', wp.get('externalTransactionId') === created.reference);
    check('redirect returns the customer to their own order', (wp.get('redirectURL') ?? '').endsWith(`/orders/${created.reference}`));
    check('no ip binding when no payer ip is known', wp.get('allowedIpAddress') === null);
    // An email in a query string reaches access logs, proxy logs and browser
    // history - undoing the encryption-at-rest this platform does everywhere else.
    check('customer email never reaches the widget url', wp.get('email') === null && !created.onramp.widgetUrl.includes('payer%40example.com'));

    const { body: replayed } = await createOrder({}, idemKey);
    check('idempotent create returns same order', replayed.reference === created.reference);
    if (stub) {
      const quotesBefore = stub.quotes.length;
      await createOrder({}, idemKey);
      check('idempotent create does not re-quote MoonPay', stub.quotes.length === quotesBefore, `${stub.quotes.length} vs ${quotesBefore}`);
    }

    const noKey = await fetch(`${BASE}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ merchantId: MERCHANT, fiatAmount: '150.00', fiatCurrency: 'USD', cryptoAsset: 'USDC', network: 'polygon' }),
    });
    check('missing idempotency key rejected', noKey.status === 400, `status ${noKey.status}`);

    const unauthed = await fetch(`${BASE}/orders/${created.reference}`);
    check('order read without API key rejected', unauthed.status === 401, `status ${unauthed.status}`);

    // MoonPay has no `sgd`, so an SGD order must fail at creation, not at the
    // payment step where the customer is already committed.
    const { res: badCurrency } = await createOrder({ fiatCurrency: 'SGD' });
    check('unfundable source currency rejected at creation', badCurrency.status === 400, `status ${badCurrency.status}`);

    // MoonPay's own per-currency minimum, surfaced before the customer commits.
    const { res: tooSmall } = await createOrder({ fiatAmount: '5.00' });
    check('below-minimum amount rejected at creation', tooSmall.status === 400, `status ${tooSmall.status}`);

    // Widening the currency list is only safe if the newly-offered ones work.
    const { res: gbpRes, body: gbp } = await createOrder({ fiatCurrency: 'GBP', fiatAmount: '80.00' });
    check('GBP is fundable on MoonPay', gbpRes.status === 201, `status ${gbpRes.status}`);
    check('GBP widget url carries the right base currency', new URL(gbp.onramp.widgetUrl).searchParams.get('baseCurrencyCode') === 'gbp');

    const ref = created.reference;

    // --- ip matching -----------------------------------------------------
    console.log('\nip matching');
    const { body: bound } = await createOrder({ customerIpAddress: '203.0.113.42' });
    const boundHash = new URL(bound.onramp.widgetUrl).searchParams.get('allowedIpAddress');
    const expectedHash = createHmac('sha256', SECRET_KEY).update('203.0.113.42').digest('base64');
    check('payer ip is bound into the url as a hash', boundHash === expectedHash, String(boundHash));
    check('raw payer ip never appears in the url', !bound.onramp.widgetUrl.includes('203.0.113.42'));
    check('ip-bound url is still correctly signed', signatureIsValid(bound.onramp.widgetUrl));

    // Rebuilding must produce a URL bound to the CURRENT request's IP, not the
    // one the order was created from - a customer who changes network otherwise
    // hits MoonPay's "Unverified Connection" error and cannot pay at all.
    const rebound = await fetch(
      `${BASE}/orders/${bound.reference}/onramp-session`,
      authed({ headers: { 'x-customer-ip': '198.51.100.9' } }),
    ).then((r) => r.json());
    check(
      'handle rebinds to the ip of the request that asks for it',
      new URL(rebound.widgetUrl).searchParams.get('allowedIpAddress') ===
        createHmac('sha256', SECRET_KEY).update('198.51.100.9').digest('base64'),
    );

    // --- webhook verification -------------------------------------------
    console.log('\nwebhook verification');

    const forged = await postWebhook({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'moonpay-signature-v2': `t=${Math.floor(Date.now() / 1000)},s=${'deadbeef'.repeat(8)}`,
      },
      body: JSON.stringify(event('transaction_updated', buyTransaction({ reference: ref, status: 'completed', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() }))),
    });
    check('forged signature rejected', forged.status === 400, `status ${forged.status}`);
    check('forged webhook did not move order', (await orderStatus(ref)) === 'CREATED');

    const stale = await postWebhook(
      signed(event('transaction_updated', buyTransaction({ reference: ref, status: 'completed', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() })), {
        timestampSeconds: Math.floor(Date.now() / 1000) - 48 * 60 * 60,
      }),
    );
    check('replayed old timestamp rejected', stale.status === 400, `status ${stale.status}`);

    // The legacy Moonpay-Signature header is keyed differently and is not the
    // one this integration honours. Accepting it would be a downgrade.
    const legacyOnly = await postWebhook(
      signed(event('transaction_updated', buyTransaction({ reference: ref, status: 'completed', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() })), {
        header: 'moonpay-signature',
      }),
    );
    check('legacy-only signature header rejected', legacyOnly.status === 400, `status ${legacyOnly.status}`);
    check('rejected webhooks did not move order', (await orderStatus(ref)) === 'CREATED');

    // --- state machine ---------------------------------------------------
    console.log('\nstate machine');

    const txId = `mp_${randomUUID()}`;
    const authorizing = buyTransaction({ id: txId, reference: ref, status: 'waitingAuthorization', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() });
    await postWebhook(signed(event('transaction_created', authorizing)));
    await settle();
    check('advanced to PAYMENT_PENDING on 3DS authorisation', (await orderStatus(ref)) === 'PAYMENT_PENDING');

    // MoonPay events have no id: the dedupe key is (type, id, updatedAt), so an
    // identical redelivery must be absorbed by the unique constraint.
    const dupe = await postWebhook(signed(event('transaction_created', authorizing)));
    const dupeBody = await dupe.json();
    check('duplicate delivery deduped', dupe.status === 200 && dupeBody.duplicate === true, JSON.stringify(dupeBody));

    // A webhook key mid-rotation produces two `s=` elements, only one of which
    // we hold. Accepting only the first turns every rotation into an outage.
    await postWebhook(
      signed(event('transaction_updated', buyTransaction({ id: txId, reference: ref, status: 'waitingAuthorization', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() })), {
        key: 'wk_test_the_key_being_rotated_out',
        extraKey: WEBHOOK_KEY,
      }),
    );
    await settle();
    check('accepts one of several signatures during a key roll', (await orderStatus(ref)) === 'PAYMENT_PENDING');

    await postWebhook(
      signed(event('transaction_updated', buyTransaction({ id: txId, reference: ref, status: 'pending', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() }))),
    );
    await settle();
    check('advanced to PAYMENT_CONFIRMED', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    // MoonPay warns events can arrive out of order, especially on retries, so a
    // late earlier event is the normal case: it must be dropped, not applied.
    await postWebhook(
      signed(event('transaction_updated', buyTransaction({ id: txId, reference: ref, status: 'waitingPayment', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() }))),
    );
    await settle();
    check('out-of-order webhook did not move order backwards', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    // An event type the endpoint is subscribed to but this integration cannot
    // join to an order must be a silent no-op, never an escalation.
    await postWebhook(
      signed({
        type: 'identity_check_updated',
        data: { id: `ic_${randomUUID()}`, updatedAt: nextUpdatedAt(), status: 'completed', result: 'clear', customerId: 'cus_1', externalCustomerId: null },
      }),
    );
    await settle();
    check('unjoinable event type ignored, not escalated', (await orderStatus(ref)) === 'PAYMENT_CONFIRMED');

    await postWebhook(
      signed(event('transaction_updated', buyTransaction({
        id: txId,
        reference: ref,
        status: 'completed',
        walletAddress: APPROVED_ADDRESS,
        // A JSON number, exactly as MoonPay sends it. The platform must render
        // it to a decimal string without ever floating it through a parse.
        quoteCurrencyAmount: 145.51,
        cryptoTransactionId: '0xabc123',
        updatedAt: nextUpdatedAt(),
      }))),
    );
    await settle();
    const done = await order(ref);
    check('reached COMPLETED', done.status === 'COMPLETED', String(done.status));
    check('settled amount stored at the asset precision', done.cryptoAmountSettled === '145.510000', String(done.cryptoAmountSettled));
    check('delivery tx hash recorded', done.chainTxHash === '0xabc123', String(done.chainTxHash));

    const completed = await fetch(`${BASE}/orders/${ref}/onramp-session`, authed());
    check('widget url withheld once the order is terminal', completed.status === 404, `status ${completed.status}`);

    // --- failure mapping ---------------------------------------------------
    console.log('\nfailure mapping');

    const failureCases = [
      ['stage_one_ordering', 'CARD_DECLINED'],
      ['stage_two_verification', 'KYC_FAILED'],
      ['stage_three_processing', 'PAYMENT_FAILED'],
      // Card charged, crypto not delivered. Money is at risk, so no automated
      // rule closes it out - a human decides.
      ['stage_four_delivery', 'MANUAL_REVIEW'],
    ];

    for (const [stage, expected] of failureCases) {
      const { body: o } = await createOrder();
      await postWebhook(
        signed(event('transaction_failed', buyTransaction({
          reference: o.reference,
          status: 'failed',
          failureReason: 'stub failure',
          walletAddress: APPROVED_ADDRESS,
          updatedAt: nextUpdatedAt(),
          stages: [{ stage, status: 'failed', failureReason: 'stub failure', actions: [] }],
        }))),
      );
      await settle();
      check(`failure at ${stage} maps to ${expected}`, (await orderStatus(o.reference)) === expected, await orderStatus(o.reference));
    }

    const { body: noStages } = await createOrder();
    await postWebhook(
      signed(event('transaction_failed', buyTransaction({ reference: noStages.reference, status: 'failed', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() }))),
    );
    await settle();
    check('failure with no stages falls back to PAYMENT_FAILED', (await orderStatus(noStages.reference)) === 'PAYMENT_FAILED');

    // --- misdelivery -------------------------------------------------------
    console.log('\ndelivery address');

    const { body: second } = await createOrder();
    await postWebhook(
      signed(event('transaction_updated', buyTransaction({
        reference: second.reference,
        status: 'completed',
        walletAddress: '0x9999999999999999999999999999999999999999',
        updatedAt: nextUpdatedAt(),
      }))),
    );
    await settle();
    check('delivery to an unapproved address escalates to MANUAL_REVIEW', (await orderStatus(second.reference)) === 'MANUAL_REVIEW');

    // --- unknown status ----------------------------------------------------
    console.log('\nunknown provider status');

    const { body: third } = await createOrder();
    await postWebhook(
      signed(event('transaction_updated', buyTransaction({
        reference: third.reference,
        status: 'someNewStatusMoonPayAdded',
        walletAddress: APPROVED_ADDRESS,
        updatedAt: nextUpdatedAt(),
      }))),
    );
    await settle();
    check('unknown provider status escalates to MANUAL_REVIEW', (await orderStatus(third.reference)) === 'MANUAL_REVIEW');

    // --- join fallback -----------------------------------------------------
    console.log('\ntransaction id fallback');

    const { body: fourth } = await createOrder();
    const fourthTxId = `mp_${randomUUID()}`;
    await postWebhook(
      signed(event('transaction_created', buyTransaction({
        id: fourthTxId,
        reference: fourth.reference,
        status: 'waitingAuthorization',
        walletAddress: APPROVED_ADDRESS,
        updatedAt: nextUpdatedAt(),
      }))),
    );
    await settle();

    // Same transaction, external id dropped. The id we recorded on the first
    // event is the only remaining way back to the order.
    const orphan = buyTransaction({ id: fourthTxId, reference: fourth.reference, status: 'pending', walletAddress: APPROVED_ADDRESS, updatedAt: nextUpdatedAt() });
    orphan.externalTransactionId = null;
    await postWebhook(signed(event('transaction_updated', orphan)));
    await settle();
    check('order found by transaction id when the external id is absent', (await orderStatus(fourth.reference)) === 'PAYMENT_CONFIRMED');

    // --- donations ---------------------------------------------------------
    console.log('\ndonations');

    const { res: donateRes, body: donation } = await createOrder({
      orderType: 'DONATION',
      donationCampaign: 'artisan-apprenticeships',
      donorName: 'A. Donor',
      fiatAmount: '75.00',
    });
    check('donation order created', donateRes.status === 201, `status ${donateRes.status}`);
    check('donation is typed as one', donation.orderType === 'DONATION', String(donation.orderType));
    check('campaign recorded', donation.donationCampaign === 'artisan-apprenticeships', String(donation.donationCampaign));
    check('donor name is never projected back out', !JSON.stringify(donation).includes('A. Donor'));
    check(
      'donation uses the same signed widget url as a purchase',
      signatureIsValid(donation.onramp.widgetUrl) &&
        new URL(donation.onramp.widgetUrl).searchParams.get('walletAddress') === APPROVED_ADDRESS,
    );

    const { res: campaignOnPurchase } = await createOrder({ donationCampaign: 'artisan-apprenticeships' });
    check('campaign on a PURCHASE order rejected', campaignOnPurchase.status === 400, `status ${campaignOnPurchase.status}`);

    const { res: donationNoCampaign } = await createOrder({ orderType: 'DONATION' });
    check('donation without a campaign rejected', donationNoCampaign.status === 400, `status ${donationNoCampaign.status}`);

    // The whole point: a donation runs the identical webhook path.
    await postWebhook(
      signed(event('transaction_updated', buyTransaction({
        reference: donation.reference,
        status: 'completed',
        walletAddress: APPROVED_ADDRESS,
        quoteCurrencyAmount: 70.51,
        cryptoTransactionId: '0xdef456',
        updatedAt: nextUpdatedAt(),
      }))),
    );
    await settle();
    const donationDone = await order(donation.reference);
    check('donation settles through the same state machine', donationDone.status === 'COMPLETED', String(donationDone.status));
    check('donation settled amount recorded', donationDone.cryptoAmountSettled === '70.510000', String(donationDone.cryptoAmountSettled));
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
