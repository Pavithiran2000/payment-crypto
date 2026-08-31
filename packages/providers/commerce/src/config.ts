/**
 * MoonPay Commerce (Helio) credential set and the invariants around it.
 *
 * Commerce is a DIFFERENT MoonPay product from the on-ramp in
 * `@pp/provider-moonpay`. Same vendor, different API, different auth, different
 * money flow. See docs/moonpay-commerce-assessment.md.
 *
 * Two credentials plus a per-webhook token:
 *
 *   publicKey           sent as an `apiKey` QUERY PARAMETER. Public by design.
 *   secretKey           sent as `Authorization: Bearer`. Unlike the on-ramp's
 *                       secretKey - which is only ever an HMAC key and never
 *                       leaves this process - this one IS transmitted on every
 *                       authenticated call. Treat it as a live bearer credential:
 *                       it must never reach a log, a browser bundle, or a URL.
 *   webhookSharedToken  the dashboard calls it "Secret"; the API calls it
 *                       `sharedToken`. PER-WEBHOOK-ENDPOINT, not account-wide -
 *                       registering a second endpoint mints a different one.
 *
 * ⚠️ NO ENVIRONMENT PREFIX. The on-ramp encodes test/live in the key itself
 * (`pk_test_` / `pk_live_`), which lets `resolveMoonPayConfig` refuse a mixed
 * set at boot. Helio keys carry no such marker, so the ONLY thing distinguishing
 * sandbox from production is the base URL. That makes `apiBaseUrl` a safety
 * control here, not a convenience: point production keys at the sandbox host,
 * or vice versa, and the failure is a 401 rather than anything louder.
 */

/** Production. Real money. */
export const COMMERCE_API_BASE_URL_LIVE = 'https://api.hel.io';
/** Sandbox. Keys from app.dev.hel.io do not work against production, or vice versa. */
export const COMMERCE_API_BASE_URL_SANDBOX = 'https://api.dev.hel.io';

/** Checkout origins, for building the customer-facing pay link URL. */
export const COMMERCE_APP_BASE_URL_LIVE = 'https://app.hel.io';
export const COMMERCE_APP_BASE_URL_SANDBOX = 'https://app.dev.hel.io';

export type CommerceMode = 'sandbox' | 'live';

export interface CommerceConfig {
  /** Query parameter `apiKey`. Public by design. */
  publicKey: string;
  /** `Authorization: Bearer <secretKey>`. IS transmitted - see header note. */
  secretKey: string;
  /**
   * Per-endpoint webhook secret. Optional at config time because paylink
   * creation does not need it; required before any webhook can be verified.
   */
  webhookSharedToken?: string | undefined;
  apiBaseUrl: string;
  /** Where the customer-facing checkout lives, derived from `apiBaseUrl`. */
  appBaseUrl: string;
  mode: CommerceMode;
}

export class CommerceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceConfigError';
  }
}

export interface ResolveCommerceConfigInput {
  publicKey: string;
  secretKey: string;
  webhookSharedToken?: string | undefined;
  /** Defaults to sandbox. Production must be opted into explicitly. */
  apiBaseUrl?: string | undefined;
}

/**
 * Validate the credential set and derive the environment from the base URL.
 *
 * Defaults to SANDBOX deliberately. With no environment marker on the keys
 * themselves, an accidental omission should fail safe by pointing at the
 * environment where mistakes cost nothing - not at the one that moves money.
 */
export function resolveCommerceConfig(input: ResolveCommerceConfigInput): CommerceConfig {
  if (!input.publicKey) throw new CommerceConfigError('Commerce public key is required');
  if (!input.secretKey) throw new CommerceConfigError('Commerce secret key is required');

  const apiBaseUrl = (input.apiBaseUrl ?? COMMERCE_API_BASE_URL_SANDBOX).replace(/\/+$/, '');

  let mode: CommerceMode;
  let appBaseUrl: string;
  if (apiBaseUrl === COMMERCE_API_BASE_URL_LIVE) {
    mode = 'live';
    appBaseUrl = COMMERCE_APP_BASE_URL_LIVE;
  } else if (apiBaseUrl === COMMERCE_API_BASE_URL_SANDBOX) {
    mode = 'sandbox';
    appBaseUrl = COMMERCE_APP_BASE_URL_SANDBOX;
  } else {
    // An unrecognised host is refused rather than assumed. Credentials are sent
    // on every call - a typo'd or attacker-supplied host would exfiltrate the
    // bearer secret, and there is no legitimate third value.
    throw new CommerceConfigError(
      `Unrecognised Commerce API base URL "${apiBaseUrl}"; expected ${COMMERCE_API_BASE_URL_LIVE} or ${COMMERCE_API_BASE_URL_SANDBOX}`,
    );
  }

  return {
    publicKey: input.publicKey,
    secretKey: input.secretKey,
    webhookSharedToken: input.webhookSharedToken,
    apiBaseUrl,
    appBaseUrl,
    mode,
  };
}

export function isLive(cfg: CommerceConfig): boolean {
  return cfg.mode === 'live';
}

/** The customer-facing checkout URL for a pay link. */
export function payLinkUrl(cfg: CommerceConfig, payLinkId: string): string {
  return `${cfg.appBaseUrl}/pay/${encodeURIComponent(payLinkId)}`;
}
