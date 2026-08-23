import { formatDecimal } from '@pp/shared-types';
import {
  toStripeSourceCurrency,
  toStripeDestinationCurrency,
  toStripeDestinationNetwork,
} from './mapping.js';

/**
 * Stripe fiat-to-crypto onramp session creation.
 *
 * Stripe's official server SDKs do not cover `/v1/crypto/onramp_sessions` -
 * the Onramp API is in public preview and the docs use raw curl. This is a
 * thin, typed client over the same form-encoded endpoint, which also keeps the
 * provider free of a heavyweight dependency it would use one method of.
 *
 * Docs: https://docs.stripe.com/crypto/onramp/embedded
 */

export const STRIPE_API_BASE_URL = 'https://api.stripe.com';

/**
 * `embedded` mounts Stripe's widget inside our own page and is the default:
 * we keep the customer on our domain and control what happens after payment.
 *
 * `hosted` redirects to Stripe's standalone page at crypto.link.com. It is
 * lower-effort but the standalone page takes no return URL, so the customer is
 * never sent back to us - only use it if that is acceptable.
 */
export type OnrampMode = 'embedded' | 'hosted';

export interface StripeOnrampConfig {
  /** Secret key (sk_...). Server-side only, never reaches the browser. */
  secretKey: string;
  /** Publishable key (pk_...). Safe to hand to the browser; the widget needs it. */
  publishableKey: string;
  /** Endpoint signing secret (whsec_...) for inbound webhook verification. */
  webhookSecret: string;
  mode: OnrampMode;
  /**
   * Overridable only so the smoke test can point at a local stub. Production
   * leaves this at the default; there is no other legitimate reason to change it.
   */
  apiBaseUrl: string;
}

export interface CreateSessionParams {
  /** Our order reference. Travels as metadata and comes back on every event. */
  partnerOrderId: string;
  fiatAmount: bigint;
  fiatDecimals: number;
  /** Our currency code, e.g. "USD". Lowercased for Stripe. */
  fiatCurrency: string;
  /** Our asset code, e.g. "USDT". */
  cryptoAsset: string;
  /** Our network, e.g. "polygon". */
  network: string;
  /** The approved Binance Entity Account deposit address. */
  walletAddress: string;
  /**
   * Used by Stripe to reject unsupportable geographies at creation time
   * (HTTP 400 `crypto_onramp_unsupportable_customer`) rather than showing the
   * customer a disabled widget.
   */
  customerIpAddress?: string | undefined;
  /** Stripe idempotency key: a retried create returns the original session. */
  idempotencyKey: string;
}

export interface OnrampSession {
  id: string;
  clientSecret: string;
  /** Only populated for the Stripe-hosted standalone flow. */
  redirectUrl: string | null;
  status: string;
  livemode: boolean;
  transactionDetails: Record<string, unknown>;
}

export class StripeOnrampError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /** Stripe's machine-readable code, e.g. `crypto_onramp_unsupportable_customer`. */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'StripeOnrampError';
  }
}

/** Thrown before any network call when the order cannot be expressed to Stripe. */
export class UnsupportedByOnrampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedByOnrampError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Build the form body.
 *
 * `lock_wallet_address` is the parameter this entire business model turns on.
 * It pins delivery to the address we pass and stops the payer substituting
 * their own. Without it a customer could redirect their own purchase and the
 * merchant would never be credited - so it is set unconditionally here rather
 * than exposed as an option.
 */
export function buildSessionForm(p: CreateSessionParams): URLSearchParams {
  const sourceCurrency = toStripeSourceCurrency(p.fiatCurrency);
  if (!sourceCurrency) {
    throw new UnsupportedByOnrampError(
      `Stripe onramp cannot fund from ${p.fiatCurrency}; supported source currencies are USD and EUR`,
    );
  }

  const destinationCurrency = toStripeDestinationCurrency(p.cryptoAsset);
  if (!destinationCurrency) {
    throw new UnsupportedByOnrampError(`Stripe onramp does not support asset ${p.cryptoAsset}`);
  }

  const destinationNetwork = toStripeDestinationNetwork(p.network);
  if (!destinationNetwork) {
    throw new UnsupportedByOnrampError(`Stripe onramp does not support network ${p.network}`);
  }

  const form = new URLSearchParams();
  form.set(`wallet_addresses[${destinationNetwork}]`, p.walletAddress);
  form.set('lock_wallet_address', 'true');

  // Single-element arrays are how Stripe locks the choice: the customer cannot
  // override `destination_currencies` / `destination_networks` in the UI, and
  // a mismatch between the locked wallet's network and this list is a 400.
  form.set('destination_currencies[0]', destinationCurrency);
  form.set('destination_networks[0]', destinationNetwork);
  form.set('destination_currency', destinationCurrency);
  form.set('destination_network', destinationNetwork);

  form.set('source_currency', sourceCurrency);
  // Fiat only. `source_amount` and `destination_amount` are mutually exclusive,
  // and we fix the fiat leg because that is the amount the merchant invoiced.
  form.set('source_amount', formatDecimal(p.fiatAmount, p.fiatDecimals));

  // The join key. Stripe events carry no reference of ours unless we put one here.
  form.set('metadata[partner_order_id]', p.partnerOrderId);

  if (p.customerIpAddress) form.set('customer_ip_address', p.customerIpAddress);

  return form;
}

function parseSession(body: unknown): OnrampSession {
  if (!isRecord(body)) throw new StripeOnrampError('Malformed session response', 502, null);

  const id = str(body['id']);
  const clientSecret = str(body['client_secret']);
  const status = str(body['status']);
  if (!id || !clientSecret || !status) {
    throw new StripeOnrampError('Session response missing id, client_secret or status', 502, null);
  }

  return {
    id,
    clientSecret,
    redirectUrl: str(body['redirect_url']),
    status,
    livemode: body['livemode'] === true,
    transactionDetails: isRecord(body['transaction_details']) ? body['transaction_details'] : {},
  };
}

async function readError(res: Response): Promise<StripeOnrampError> {
  const body: unknown = await res.json().catch(() => undefined);
  const err = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
  return new StripeOnrampError(
    str(err?.['message']) ?? `Stripe returned ${res.status}`,
    res.status,
    str(err?.['code']),
  );
}

export async function createOnrampSession(
  cfg: StripeOnrampConfig,
  p: CreateSessionParams,
): Promise<OnrampSession> {
  const res = await fetch(`${cfg.apiBaseUrl}/v1/crypto/onramp_sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Stripe-side idempotency. Combined with our own (merchant, key) check
      // this means a double-submitted checkout can never mint two sessions.
      'idempotency-key': p.idempotencyKey,
    },
    body: buildSessionForm(p).toString(),
  });

  if (!res.ok) throw await readError(res);
  return parseSession(await res.json());
}

/**
 * Read a session back. Used by reconciliation when a webhook never arrived -
 * the provider's own record, not our belief about it, is the tiebreaker.
 */
export async function retrieveOnrampSession(
  cfg: StripeOnrampConfig,
  sessionId: string,
): Promise<OnrampSession> {
  const res = await fetch(
    `${cfg.apiBaseUrl}/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${cfg.secretKey}` } },
  );
  if (!res.ok) throw await readError(res);
  return parseSession(await res.json());
}
