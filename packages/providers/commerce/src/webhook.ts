/**
 * Inbound MoonPay Commerce webhook verification.
 *
 * Same three production hazards the on-ramp verifier handles, handled the same
 * way — raw bytes, constant-time compare, and a dedupe key — but the scheme
 * itself differs in two ways that matter:
 *
 *   on-ramp                          Commerce
 *   ------------------------------   --------------------------------------
 *   header Moonpay-Signature-V2      header X-Signature
 *   `t=<seconds>,s=<hex>`            bare hex digest, no envelope
 *   HMAC over `<t>.<rawBody>`        HMAC over `<rawBody>` alone
 *   key = webhook key (wk_...)       key = per-endpoint sharedToken
 *   timestamp bounds replay          ⚠️ NO TIMESTAMP — see below
 *
 * ⚠️ **NO REPLAY WINDOW IS POSSIBLE HERE.** The documented Commerce signature
 * carries no timestamp, so a captured delivery stays verifiable indefinitely
 * and this code has nothing to bound it with. For the on-ramp, the timestamp
 * check is defence in depth and the unique constraint on
 * `provider_events (provider, external_event_id)` is the real control. Here the
 * constraint is the ONLY control. Two consequences:
 *
 *   1. `deriveEventId` must key off something stable and genuinely unique per
 *      event (mapping.ts), never off a hash of a body that could legitimately
 *      repeat.
 *   2. The dedupe row must be written BEFORE the event is acted on, which is
 *      what WebhooksService already does. Do not relax that ordering.
 *
 * If MoonPay confirms a timestamp is available - in a header or in the payload -
 * add the bound and downgrade this note. `scripts/commerce-webhook-listener.mjs`
 * reports whether one is present on a real delivery.
 *
 * Commerce also sends `Authorization: Bearer <sharedToken>` alongside the
 * signature. That is checked too, but it is NOT a substitute for the HMAC: a
 * bearer token proves only that the sender knows the token, while the HMAC also
 * proves the body was not altered in transit.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { deriveEventId } from './mapping.js';

export const COMMERCE_SIGNATURE_HEADER = 'x-signature';

export interface VerifyCommerceInput {
  /** Per-endpoint `sharedToken` — the dashboard labels it "Secret". */
  sharedToken: string;
  /** Exact bytes as received. Never a re-serialized object. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /**
   * Also require `Authorization: Bearer <sharedToken>`. Defaults on. Turn it
   * off only if a real delivery is observed without it.
   */
  requireBearer?: boolean | undefined;
}

export type VerifyCommerceResult =
  | {
      valid: true;
      payload: Record<string, unknown>;
      eventId: string;
      eventType: string | null;
    }
  | { valid: false; reason: string };

/**
 * Case-insensitive header lookup.
 *
 * Node lowercases incoming header names, so in production this is belt and
 * braces. It matters anyway: a caller passing a hand-built map with canonical
 * casing (`X-Signature`) would otherwise fail the signature check and DROP a
 * legitimate webhook - failing closed, but losing the event this whole
 * subsystem exists to preserve.
 */
function header(headers: VerifyCommerceInput['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/** Constant-time hex compare that cannot throw on a length mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Constant-time compare for the bearer token. */
function safeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyCommerceWebhook(input: VerifyCommerceInput): VerifyCommerceResult {
  if (!input.sharedToken) {
    return { valid: false, reason: 'no shared token configured' };
  }

  const provided = header(input.headers, COMMERCE_SIGNATURE_HEADER);
  if (!provided) return { valid: false, reason: 'missing X-Signature header' };

  const expected = createHmac('sha256', input.sharedToken).update(input.rawBody).digest('hex');
  if (!safeEqualHex(provided.trim(), expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  if (input.requireBearer !== false) {
    const auth = header(input.headers, 'authorization');
    if (!auth) return { valid: false, reason: 'missing Authorization bearer' };
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!safeEqualUtf8(token, input.sharedToken)) {
      return { valid: false, reason: 'bearer token mismatch' };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(input.rawBody.toString('utf8'));
    // `typeof [] === 'object'`, so arrays must be excluded explicitly or a
    // JSON array would be accepted as a payload and produce a garbage event
    // record with no event name and a hash-derived dedupe key.
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return { valid: false, reason: 'body is not a JSON object' };
    }
    parsed = decoded as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'unparseable JSON body' };
  }

  const sha = createHash('sha256').update(input.rawBody).digest('hex');
  const eventType =
    typeof parsed['event'] === 'string'
      ? (parsed['event'] as string)
      : typeof parsed['type'] === 'string'
        ? (parsed['type'] as string)
        : null;

  return {
    valid: true,
    payload: parsed,
    eventId: deriveEventId(parsed, sha),
    eventType,
  };
}
