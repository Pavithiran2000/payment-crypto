/**
 * A minimal stand-in for `POST /v1/crypto/onramp_sessions`.
 *
 * The onramp API is gated behind an approved application, so without this the
 * end-to-end suite could not run at all until Stripe says yes - and the first
 * time anyone exercised order creation would be against production credentials.
 *
 * It is deliberately *not* a mock inside the API process. The real HTTP client,
 * the real form encoding and the real error handling all run; only Stripe's
 * side is replaced. It asserts the parameters this integration depends on, so a
 * regression that drops `lock_wallet_address` fails here rather than in the
 * wild, where the symptom is a customer redirecting their own settlement.
 *
 * Reachable only because STRIPE_API_BASE_URL points at it; apps/api refuses that
 * override whenever the secret key is live.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 4599;

function sessionId() {
  return `cos_${randomBytes(12).toString('hex')}`;
}

/**
 * @param {{ port?: number }} [opts]
 * @returns {Promise<{ url: string, sessions: Map<string, object>, close: () => Promise<void> }>}
 */
export async function startStripeStub(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** Stripe idempotency: the same key must return the same session. */
  const byIdempotencyKey = new Map();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload) => {
        const json = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      };

      if (!/^Bearer sk_/.test(req.headers.authorization ?? '')) {
        return send(401, { error: { type: 'invalid_request_error', message: 'no secret key' } });
      }

      const retrieve = /^\/v1\/crypto\/onramp_sessions\/([^/?]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && retrieve) {
        const found = sessions.get(decodeURIComponent(retrieve[1]));
        return found ? send(200, found) : send(404, { error: { code: 'resource_missing', message: 'no such session' } });
      }

      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/crypto/onramp_sessions')) {
        return send(404, { error: { message: `unstubbed route ${req.method} ${req.url}` } });
      }

      const form = new URLSearchParams(body);
      const network = form.get('destination_network');
      const currency = form.get('destination_currency');
      const walletAddress = network ? form.get(`wallet_addresses[${network}]`) : null;
      const reference = form.get('metadata[partner_order_id]');

      // The guarantees this integration is built on. Stripe would accept a
      // request without them; this platform must never send one.
      if (form.get('lock_wallet_address') !== 'true') {
        return send(400, { error: { code: 'stub_wallet_not_locked', message: 'lock_wallet_address must be true' } });
      }
      if (!walletAddress) {
        return send(400, { error: { code: 'crypto_onramp_no_wallet_address_to_lock', message: 'no wallet address to lock' } });
      }
      if (!reference) {
        return send(400, { error: { code: 'stub_missing_metadata', message: 'metadata[partner_order_id] is required' } });
      }
      if (form.get('source_amount') && form.get('destination_amount')) {
        return send(400, { error: { code: 'crypto_onramp_invalid_source_destination_pair', message: 'mutually exclusive' } });
      }
      if (!['usd', 'eur'].includes(form.get('source_currency') ?? '')) {
        return send(400, { error: { code: 'crypto_onramp_missing_source_currency', message: 'unsupported source currency' } });
      }

      // Geography rejection, keyed off a reserved IP so the suite can trigger it.
      if (form.get('customer_ip_address') === '203.0.113.7') {
        return send(400, {
          error: {
            type: 'invalid_request_error',
            code: 'crypto_onramp_unsupportable_customer',
            message: "Based on the information provided about the customer, we're currently unable to support them.",
          },
        });
      }

      const idem = req.headers['idempotency-key'];
      if (idem && byIdempotencyKey.has(idem)) {
        return send(200, byIdempotencyKey.get(idem));
      }

      const id = sessionId();
      const session = {
        id,
        object: 'crypto.onramp_session',
        client_secret: `${id}_secret_${randomBytes(16).toString('hex')}`,
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        metadata: { partner_order_id: reference },
        redirect_url: `https://crypto.link.com?session_hash=${randomBytes(8).toString('hex')}`,
        status: 'initialized',
        transaction_details: {
          destination_currency: currency,
          destination_amount: null,
          destination_network: network,
          destination_currencies: [currency],
          destination_networks: [network],
          fees: null,
          lock_wallet_address: true,
          source_currency: form.get('source_currency'),
          source_amount: form.get('source_amount'),
          transaction_id: null,
          wallet_address: walletAddress,
          wallet_addresses: { [network]: walletAddress },
        },
      };

      sessions.set(id, session);
      if (idem) byIdempotencyKey.set(idem, session);
      send(200, session);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Runnable on its own (`node scripts/stripe-stub.mjs`) so the API can be
// developed against it without the smoke suite driving the lifecycle.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const stub = await startStripeStub();
  console.log(`stripe onramp stub listening on ${stub.url}`);
}
