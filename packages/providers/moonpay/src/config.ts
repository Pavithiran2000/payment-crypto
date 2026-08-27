/**
 * MoonPay credential set and the invariants that hold it together.
 *
 * MoonPay issues three separate keys per environment and they are not
 * interchangeable. Getting them crossed is the single most common integration
 * failure, so the distinction is encoded in the type rather than left to a
 * comment:
 *
 *   publishableKey  pk_test_ / pk_live_   goes in the widget URL and in API
 *                                         query strings. Public by design.
 *   secretKey       sk_test_ / sk_live_   signs widget URLs and hashes the
 *                                         payer IP. NEVER sent to MoonPay and
 *                                         never leaves this process.
 *   webhookKey      wk_test_ / wk_live_   verifies inbound webhook signatures.
 *                                         A different secret from `secretKey`;
 *                                         using the latter silently fails every
 *                                         signature check.
 *
 * Sources (fetched 2026-08-23):
 *   https://dev.moonpay.com/widget/on-ramp/integration-methods/url
 *   https://dev.moonpay.com/widget/on-ramp/customization/url-signing
 *   https://dev.moonpay.com/widget/on-ramp/customization/ip-matching
 *   https://dev.moonpay.com/api-reference/widget/webhooks/signature
 */

export const MOONPAY_API_BASE_URL = 'https://api.moonpay.com';
export const MOONPAY_WIDGET_BASE_URL_LIVE = 'https://buy.moonpay.com';
export const MOONPAY_WIDGET_BASE_URL_SANDBOX = 'https://buy-sandbox.moonpay.com';

/**
 * `embedded` renders MoonPay in an iframe on our own page. The customer never
 * leaves our domain, which is what the checkout flow is built around.
 *
 * `redirect` navigates the whole page to MoonPay and comes back via
 * `redirectURL`. It is the only mode where Apple Pay and Google Pay work -
 * MoonPay states those are unavailable inside an iframe - at the cost of
 * handing the customer to another origin mid-checkout.
 */
export type WidgetMode = 'embedded' | 'redirect';

export interface MoonPayConfig {
  /** `pk_test_...` / `pk_live_...`. Safe in the browser; the widget needs it. */
  publishableKey: string;
  /** `sk_test_...` / `sk_live_...`. Signing key only. Never transmitted. */
  secretKey: string;
  /** `wk_test_...` / `wk_live_...`. Inbound webhook verification only. */
  webhookKey: string;
  mode: WidgetMode;
  /** `buy.moonpay.com` or `buy-sandbox.moonpay.com`, derived from the key mode. */
  widgetBaseUrl: string;
  /**
   * Overridable only so the smoke test can point at a local stub. Refused at
   * boot whenever the keys are live; there is no other legitimate reason.
   */
  apiBaseUrl: string;
  /**
   * Binds each widget URL to a hash of the payer's IP. MoonPay requires this
   * to go live, so it is forced on for live keys and optional in sandbox where
   * a developer machine often has no routable client IP to bind to.
   */
  requireIpMatch: boolean;
  /** Replay window for inbound webhooks. See `verifyWebhook`. */
  webhookToleranceMs: number;
  theme?: 'light' | 'dark' | undefined;
  /** Custom theme built in the MoonPay dashboard's theme builder. */
  themeId?: string | undefined;
}

export type KeyMode = 'test' | 'live';

export class MoonPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoonPayConfigError';
  }
}

/**
 * Read the environment a key belongs to from its prefix.
 *
 * Returns null for anything that is not recognisably a MoonPay key of the
 * expected kind, so a value pasted into the wrong variable is caught at boot
 * rather than at the first payment.
 */
export function keyMode(key: string, prefix: 'pk' | 'sk' | 'wk'): KeyMode | null {
  if (key.startsWith(`${prefix}_test_`)) return 'test';
  if (key.startsWith(`${prefix}_live_`)) return 'live';
  return null;
}

export interface ResolveConfigInput {
  publishableKey: string;
  secretKey: string;
  webhookKey: string;
  mode: WidgetMode;
  apiBaseUrl?: string | undefined;
  widgetBaseUrl?: string | undefined;
  requireIpMatch?: boolean | undefined;
  webhookToleranceMs?: number | undefined;
  theme?: 'light' | 'dark' | undefined;
  themeId?: string | undefined;
}

export const DEFAULT_WEBHOOK_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Validate the credential set and derive everything that follows from it.
 *
 * All three keys must belong to the same environment. A live publishable key
 * paired with a test webhook key is not a half-configured integration - it is
 * an integration that takes real money and then silently rejects every event
 * telling it what happened.
 */
export function resolveMoonPayConfig(input: ResolveConfigInput): MoonPayConfig {
  const pk = keyMode(input.publishableKey, 'pk');
  const sk = keyMode(input.secretKey, 'sk');
  const wk = keyMode(input.webhookKey, 'wk');

  if (!pk) throw new MoonPayConfigError('MoonPay publishable key must start with pk_test_ or pk_live_');
  if (!sk) throw new MoonPayConfigError('MoonPay secret key must start with sk_test_ or sk_live_');
  if (!wk) throw new MoonPayConfigError('MoonPay webhook key must start with wk_test_ or wk_live_');

  if (pk !== sk || pk !== wk) {
    throw new MoonPayConfigError(
      `MoonPay keys are from different environments (publishable=${pk}, secret=${sk}, webhook=${wk}); all three must be test or all three live`,
    );
  }

  const live = pk === 'live';
  const apiBaseUrl = input.apiBaseUrl ?? MOONPAY_API_BASE_URL;

  // Live keys pointed at anything but MoonPay mean either a misconfiguration
  // or an exfiltration attempt. Neither may reach a request.
  if (live && apiBaseUrl !== MOONPAY_API_BASE_URL) {
    throw new MoonPayConfigError('MoonPay API base URL may not be overridden with live keys');
  }

  const widgetBaseUrl =
    input.widgetBaseUrl ?? (live ? MOONPAY_WIDGET_BASE_URL_LIVE : MOONPAY_WIDGET_BASE_URL_SANDBOX);
  if (live && widgetBaseUrl !== MOONPAY_WIDGET_BASE_URL_LIVE) {
    throw new MoonPayConfigError('MoonPay widget base URL may not be overridden with live keys');
  }

  return {
    publishableKey: input.publishableKey,
    secretKey: input.secretKey,
    webhookKey: input.webhookKey,
    mode: input.mode,
    widgetBaseUrl,
    apiBaseUrl,
    // Forced on in live: MoonPay states IP matching is required to go live.
    requireIpMatch: live ? true : (input.requireIpMatch ?? false),
    webhookToleranceMs: input.webhookToleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS,
    theme: input.theme,
    themeId: input.themeId,
  };
}

export function isLive(cfg: MoonPayConfig): boolean {
  return keyMode(cfg.publishableKey, 'pk') === 'live';
}
