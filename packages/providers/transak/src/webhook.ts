import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Inbound webhook verification.
 *
 * Three failure modes account for most webhook bugs in production, and all
 * three are handled here rather than left to the caller:
 *
 *  1. Body mutation. The signature covers the EXACT bytes received. Fastify
 *     parses JSON before the handler runs, so re-serializing the parsed object
 *     produces different bytes and the HMAC will never match. The caller must
 *     pass the raw Buffer (see the rawBody plugin in apps/api).
 *  2. Replay. A valid signature stays valid forever without a timestamp bound.
 *  3. Timing leak. `===` on a signature comparison leaks it byte by byte.
 *
 * Transak has shipped more than one webhook signing scheme (an HMAC header, and
 * a JWT-encoded body signed with the API secret). Which one applies depends on
 * your integration's vintage, so both are implemented behind one interface and
 * selected by config. CONFIRM THE ACTIVE SCHEME against your partner dashboard
 * before going live and delete the branch you do not use.
 */

export type VerificationScheme = 'hmac-header' | 'jwt-body';

export interface VerifyInput {
  scheme: VerificationScheme;
  secret: string;
  /** Exact bytes as received. Not a re-serialized object. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Replay window. Default 5 minutes. */
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

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  if (input.scheme === 'hmac-header') {
    const signature = header(input.headers, 'x-transak-signature');
    const timestamp = header(input.headers, 'x-transak-timestamp');
    if (!signature) return { valid: false, reason: 'missing signature header' };
    if (!timestamp) return { valid: false, reason: 'missing timestamp header' };

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { valid: false, reason: 'malformed timestamp' };
    if (Math.abs(Date.now() - ts) > tolerance) {
      return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };
    }

    // Signed payload binds the timestamp so it cannot be swapped independently.
    const expected = createHmac('sha256', input.secret)
      .update(`${timestamp}.`)
      .update(input.rawBody)
      .digest('hex');

    if (!safeEqualHex(signature, expected)) {
      return { valid: false, reason: 'signature mismatch' };
    }
    return finalize(input.rawBody);
  }

  // jwt-body: the entire body is a compact JWS signed HS256 with the API secret.
  const token = input.rawBody.toString('utf8').trim().replace(/^"|"$/g, '');
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'body is not a compact JWS' };
  const [encHeader, encPayload, encSignature] = parts as [string, string, string];

  let alg: string;
  try {
    alg = (JSON.parse(base64UrlDecode(encHeader).toString('utf8')) as { alg?: string }).alg ?? '';
  } catch {
    return { valid: false, reason: 'unparseable JWS header' };
  }
  // Pin the algorithm. Accepting whatever the token declares is the classic
  // alg-confusion hole (alg:none, or HS256 verified against a public key).
  if (alg !== 'HS256') return { valid: false, reason: `unexpected alg: ${alg}` };

  const expected = createHmac('sha256', input.secret)
    .update(`${encHeader}.${encPayload}`)
    .digest();
  const provided = base64UrlDecode(encSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  const claims = base64UrlDecode(encPayload);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(claims.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'unparseable JWS payload' };
  }

  const iat = typeof parsed['iat'] === 'number' ? parsed['iat'] * 1000 : undefined;
  if (iat !== undefined && Math.abs(Date.now() - iat) > tolerance) {
    return { valid: false, reason: 'iat outside tolerance (possible replay)' };
  }

  return shape(parsed);
}

function finalize(rawBody: Buffer): VerifyResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'unparseable JSON body' };
  }
  return shape(parsed);
}

function shape(parsed: Record<string, unknown>): VerifyResult {
  const eventType = typeof parsed['eventID'] === 'string' ? parsed['eventID'] : null;
  const data = (parsed['webhookData'] ?? parsed['data'] ?? parsed) as Record<string, unknown>;

  // Prefer the provider's own event id. Where none exists, a digest of the
  // payload still gives the unique constraint something stable to bite on.
  const providerEventId =
    (typeof parsed['id'] === 'string' && parsed['id']) ||
    (typeof data['id'] === 'string' && `${eventType ?? 'evt'}:${data['id']}`) ||
    `sha256:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;

  return { valid: true, payload: data, eventId: providerEventId, eventType };
}

/**
 * Map a provider status onto our vocabulary. Unknown statuses map to null and
 * the caller routes them to MANUAL_REVIEW - never guess at an unrecognised
 * status, and never let one silently no-op.
 */
export function mapTransakStatus(providerStatus: string): string | null {
  const table: Record<string, string> = {
    AWAITING_PAYMENT_FROM_USER: 'PAYMENT_PENDING',
    PAYMENT_DONE_MARKED_BY_USER: 'PAYMENT_PENDING',
    PROCESSING: 'PAYMENT_CONFIRMED',
    PENDING_DELIVERY_FROM_TRANSAK: 'CRYPTO_CONVERTED',
    ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK: 'MANUAL_REVIEW',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    FAILED: 'PAYMENT_FAILED',
    REFUNDED: 'REVERSED',
    EXPIRED: 'EXPIRED',
  };
  return table[providerStatus] ?? null;
}
