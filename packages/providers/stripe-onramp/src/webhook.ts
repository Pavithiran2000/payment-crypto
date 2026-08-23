import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound Stripe webhook verification.
 *
 * Implemented against the manual-verification procedure in
 * https://docs.stripe.com/webhooks#verify-manually rather than the Node SDK,
 * for the same reason as session.ts: the Onramp API is not in the SDK, and one
 * hand-rolled HMAC is cheaper than a dependency used for a single call.
 *
 * The three things that actually break in production are all handled here:
 *
 *  1. Body mutation. The signature covers the EXACT bytes received. Fastify
 *     parses JSON before the handler runs, so re-serializing the parsed object
 *     produces different bytes and the HMAC never matches. The caller must pass
 *     the raw Buffer (apps/api creates the app with `{ rawBody: true }`).
 *  2. Replay. A valid signature stays valid forever without a timestamp bound.
 *     Stripe's timestamp is inside the signed payload, so it cannot be moved.
 *  3. Timing leak. `===` on a signature comparison leaks it byte by byte.
 *
 * Two Stripe-specific details that are easy to get wrong:
 *
 *  - `t` is in SECONDS, not milliseconds.
 *  - The header can carry SEVERAL `v1` signatures. While an endpoint secret is
 *    being rolled, both the old and new secrets are live for up to 24h and
 *    Stripe signs once per secret. Accepting only the first one turns every
 *    secret rotation into an outage.
 *  - `v0` exists on test events and must be ignored: honouring any scheme but
 *    `v1` is a downgrade attack.
 */

export interface VerifyInput {
  /** Endpoint signing secret, `whsec_...`. Per endpoint, not the API key. */
  secret: string;
  /** Exact bytes as received. Not a re-serialized object. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Replay window. Default 5 minutes, matching Stripe's own libraries. */
  toleranceMs?: number;
}

export type VerifyResult =
  | { valid: true; payload: Record<string, unknown>; eventId: string; eventType: string | null }
  | { valid: false; reason: string };

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

function header(headers: VerifyInput['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface ParsedSignatureHeader {
  timestamp: string | null;
  v1: string[];
}

export function parseSignatureHeader(value: string): ParsedSignatureHeader {
  let timestamp: string | null = null;
  const v1: string[] = [];

  for (const element of value.split(',')) {
    const idx = element.indexOf('=');
    if (idx === -1) continue;
    const key = element.slice(0, idx).trim();
    const val = element.slice(idx + 1).trim();
    if (key === 't') timestamp = val;
    // Every other scheme, v0 included, is deliberately discarded.
    else if (key === 'v1') v1.push(val);
  }

  return { timestamp, v1 };
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  const raw = header(input.headers, 'stripe-signature');
  if (!raw) return { valid: false, reason: 'missing Stripe-Signature header' };

  const { timestamp, v1 } = parseSignatureHeader(raw);
  if (!timestamp) return { valid: false, reason: 'signature header has no timestamp' };
  if (v1.length === 0) return { valid: false, reason: 'signature header has no v1 scheme' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { valid: false, reason: 'malformed timestamp' };
  if (Math.abs(Date.now() - seconds * 1000) > tolerance) {
    return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.`)
    .update(input.rawBody)
    .digest('hex');

  // Every candidate is compared even after a match so the work is constant.
  let matched = false;
  for (const candidate of v1) {
    if (safeEqualHex(candidate, expected)) matched = true;
  }
  if (!matched) return { valid: false, reason: 'signature mismatch' };

  let parsed: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(input.rawBody.toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) {
      return { valid: false, reason: 'body is not a JSON object' };
    }
    parsed = decoded as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'unparseable JSON body' };
  }

  // Stripe's own event id is a natural, guaranteed-unique dedupe key. Unlike
  // the previous provider there is no need to fall back to a payload digest.
  const eventId = typeof parsed['id'] === 'string' ? parsed['id'] : null;
  if (!eventId) return { valid: false, reason: 'event has no id' };

  return {
    valid: true,
    payload: parsed,
    eventId,
    eventType: typeof parsed['type'] === 'string' ? parsed['type'] : null,
  };
}

/** The onramp session fields this platform acts on, flattened and type-checked. */
export interface OnrampEventData {
  sessionId: string | null;
  /** `metadata.partner_order_id` - our order reference, set at session creation. */
  partnerOrderId: string | null;
  status: string | null;
  /** Where Stripe actually delivered. Must equal our approved destination. */
  walletAddress: string | null;
  destinationCurrency: string | null;
  destinationNetwork: string | null;
  /** Decimal string in the asset's own units, e.g. "150.000000". */
  destinationAmount: string | null;
  sourceCurrency: string | null;
  sourceAmount: string | null;
  /** On-chain transaction hash once delivery has happened. */
  transactionId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Pull the session out of an Event envelope.
 *
 * Accepts either the full event (`{ data: { object: {...} } }`) or a bare
 * session object, because the reconciliation path retrieves sessions directly
 * from the API and must produce the same shape as the webhook path.
 */
export function parseOnrampEvent(payload: Record<string, unknown>): OnrampEventData {
  const data = isRecord(payload['data']) ? payload['data'] : undefined;
  const session = isRecord(data?.['object']) ? data['object'] : payload;
  const details = isRecord(session['transaction_details']) ? session['transaction_details'] : {};
  const metadata = isRecord(session['metadata']) ? session['metadata'] : {};

  return {
    sessionId: str(session['id']),
    partnerOrderId: str(metadata['partner_order_id']),
    status: str(session['status']),
    walletAddress: str(details['wallet_address']),
    destinationCurrency: str(details['destination_currency']),
    destinationNetwork: str(details['destination_network']),
    destinationAmount: str(details['destination_amount']),
    sourceCurrency: str(details['source_currency']),
    sourceAmount: str(details['source_amount']),
    transactionId: str(details['transaction_id']),
  };
}
