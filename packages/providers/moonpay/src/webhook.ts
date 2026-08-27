import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound MoonPay webhook verification.
 *
 * Implemented against
 * https://dev.moonpay.com/api-reference/widget/webhooks/signature (fetched
 * 2026-08-23) and the published webhook OpenAPI document.
 *
 * The three things that actually break in production are all handled here:
 *
 *  1. Body mutation. The signature covers the EXACT bytes received. Fastify
 *     parses JSON before the handler runs, so re-serializing the parsed object
 *     produces different bytes and the HMAC never matches. The caller must pass
 *     the raw Buffer (apps/api creates the app with `{ rawBody: true }`).
 *  2. Replay. A valid signature stays valid forever without a timestamp bound.
 *     MoonPay's timestamp is inside the signed payload, so it cannot be moved.
 *  3. Timing leak. `===` on a signature comparison leaks it byte by byte.
 *
 * Three MoonPay-specific details that are easy to get wrong:
 *
 *  - The key is the **webhook key** (`wk_...`) from the dashboard's Developers
 *    page, NOT the secret API key. Using `sk_...` fails every check silently.
 *  - `Moonpay-Signature-V2` is the header to honour. A legacy `Moonpay-Signature`
 *    is sent alongside it; accepting that instead would be a downgrade.
 *  - `t` is in SECONDS, and the signed payload is `<t>.<raw body>`.
 */

export interface VerifyInput {
  /** Webhook key, `wk_test_...` / `wk_live_...`. Not the secret API key. */
  webhookKey: string;
  /** Exact bytes as received. Not a re-serialized object. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Replay window. See DEFAULT_TOLERANCE_MS for why the default is an hour. */
  toleranceMs?: number;
}

export type VerifyResult =
  | {
      valid: true;
      payload: Record<string, unknown>;
      /** Synthesised - MoonPay events carry no id of their own. See `deriveEventId`. */
      eventId: string;
      eventType: string | null;
    }
  | { valid: false; reason: string };

/**
 * One hour, not the five minutes a Stripe-shaped integration would use.
 *
 * MoonPay retries a failed delivery up to nine times with exponential backoff,
 * and does not document whether a retry is re-signed with a fresh timestamp. If
 * it is not, a five-minute window would reject every retry after the first few
 * minutes - turning a transient outage into permanently lost events, which is
 * the exact failure this whole subsystem exists to prevent.
 *
 * The timestamp bound is therefore defence in depth here, not the primary
 * replay control. That role belongs to the unique constraint on
 * `provider_events (provider, external_event_id)`, which makes a re-delivered
 * event a no-op regardless of its age, plus the monotonic `RANK` check that
 * refuses to move an order backwards. Confirm MoonPay's retry-signing behaviour
 * and tighten this if they re-sign; see docs/moonpay-onramp-migration.md.
 */
const DEFAULT_TOLERANCE_MS = 60 * 60 * 1000;

const SIGNATURE_HEADER = 'moonpay-signature-v2';

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

export interface ParsedSignatureHeader {
  timestamp: string | null;
  signatures: string[];
}

/**
 * Parse `t=<unix seconds>,s=<hex hmac>`.
 *
 * Several `s=` elements are accepted even though MoonPay documents one. If they
 * ever sign with both an old and a new webhook key during a rotation - as every
 * other provider in this space does - honouring only the first would turn key
 * rotation into an outage. Accepting extras costs nothing: each is still checked
 * against the one key we hold.
 */
export function parseSignatureHeader(value: string): ParsedSignatureHeader {
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const element of value.split(',')) {
    const idx = element.indexOf('=');
    if (idx === -1) continue;
    const key = element.slice(0, idx).trim();
    const val = element.slice(idx + 1).trim();
    if (key === 't') timestamp = val;
    else if (key === 's') signatures.push(val);
  }

  return { timestamp, signatures };
}

/**
 * Derive a stable, unique id for an event that has none.
 *
 * MoonPay does not put an event id in the payload, so the dedupe key has to be
 * synthesised. MoonPay's own guidance is to deduplicate on the combination of
 * event `type`, transaction `id` and `updatedAt`, and that is exactly what this
 * builds. Two genuine state changes differ in `updatedAt`; a retried delivery of
 * the same change does not, so the unique constraint absorbs it.
 *
 * The fallback is a digest of the raw bytes. It is strictly worse - a retry of a
 * payload MoonPay re-serialized differently would slip through as new - but it
 * is only reached for a payload with no id or no `updatedAt`, which no
 * documented event shape produces.
 */
export function deriveEventId(payload: Record<string, unknown>, rawBody: Buffer): string {
  const type = typeof payload['type'] === 'string' ? payload['type'] : 'unknown';
  const data = typeof payload['data'] === 'object' && payload['data'] !== null
    ? (payload['data'] as Record<string, unknown>)
    : {};
  const id = typeof data['id'] === 'string' ? data['id'] : null;
  const updatedAt = typeof data['updatedAt'] === 'string' ? data['updatedAt'] : null;

  if (id && updatedAt) return `${type}:${id}:${updatedAt}`;
  return `${type}:sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  const raw = header(input.headers, SIGNATURE_HEADER);
  if (!raw) return { valid: false, reason: 'missing Moonpay-Signature-V2 header' };

  const { timestamp, signatures } = parseSignatureHeader(raw);
  if (!timestamp) return { valid: false, reason: 'signature header has no timestamp' };
  if (signatures.length === 0) return { valid: false, reason: 'signature header has no s element' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { valid: false, reason: 'malformed timestamp' };
  if (Math.abs(Date.now() - seconds * 1000) > tolerance) {
    return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };
  }

  const expected = createHmac('sha256', input.webhookKey)
    .update(`${timestamp}.`)
    .update(input.rawBody)
    .digest('hex');

  // Every candidate is compared even after a match so the work is constant.
  let matched = false;
  for (const candidate of signatures) {
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

  return {
    valid: true,
    payload: parsed,
    eventId: deriveEventId(parsed, input.rawBody),
    eventType: typeof parsed['type'] === 'string' ? parsed['type'] : null,
  };
}

/**
 * The webhook event types this integration subscribes to and acts on.
 *
 * `identity_check_updated` is deliberately absent: it carries a customer id and
 * no transaction id, and this platform has no customer accounts to join one to.
 * Subscribing to it is still useful for the audit ledger, and the handler
 * acknowledges it as a no-op rather than escalating - see mapping.ts.
 */
export const BUY_EVENT_TYPES = ['transaction_created', 'transaction_updated', 'transaction_failed'] as const;

export type BuyEventType = (typeof BUY_EVENT_TYPES)[number];

export function isBuyEvent(eventType: string | null): eventType is BuyEventType {
  return eventType !== null && (BUY_EVENT_TYPES as readonly string[]).includes(eventType);
}
