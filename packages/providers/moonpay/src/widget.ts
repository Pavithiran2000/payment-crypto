import { createHmac } from 'node:crypto';
import { formatDecimal } from '@pp/shared-types';
import { MOONPAY_BASE_CURRENCIES, toBaseCurrency, toQuoteCurrency } from './mapping.js';
import type { MoonPayConfig } from './config.js';

/**
 * Signed MoonPay on-ramp widget URLs.
 *
 * MoonPay has no server-side "create a session" call. The entire instruction to
 * the widget - which asset, which chain, how much, and above all WHERE THE
 * CRYPTO GOES - travels in the query string, which means the query string is
 * the security boundary. Two mechanisms defend it, and both are mandatory here:
 *
 *  1. URL signing. An HMAC-SHA256 of the query string under the secret key,
 *     appended as `signature`. MoonPay refuses to load a URL that carries
 *     `walletAddress` without a valid one, which is what stops a customer
 *     editing our deposit address out of the URL bar and paying themselves.
 *  2. IP matching. `allowedIpAddress` carries an HMAC of the payer's IP, so a
 *     signed URL lifted from one browser will not load in another. MoonPay
 *     requires this to go live.
 *
 * The secret key is used ONLY as an HMAC key. It is never placed in a URL and
 * never sent to MoonPay.
 *
 * Sources (fetched 2026-08-23):
 *   https://dev.moonpay.com/widget/on-ramp/integration-methods/url
 *   https://dev.moonpay.com/widget/on-ramp/customization/url-signing
 *   https://dev.moonpay.com/widget/on-ramp/customization/ip-matching
 *   https://dev.moonpay.com/widget/on-ramp/customization/parameters
 */

export interface BuildWidgetUrlParams {
  /**
   * Our order reference. Travels as `externalTransactionId` and comes back on
   * every webhook - it is the only join key we control.
   */
  reference: string;
  fiatAmount: bigint;
  fiatDecimals: number;
  /** Our currency code, e.g. "USD". Lowercased for MoonPay. */
  fiatCurrency: string;
  /** Our asset code, e.g. "USDC". */
  cryptoAsset: string;
  /** Our network, e.g. "polygon". */
  network: string;
  /** The approved Binance Entity Account deposit address. */
  walletAddress: string;
  /** Where MoonPay sends the customer when they are done. Must be HTTPS in live. */
  redirectUrl?: string | undefined;
  /**
   * The payer's public IP. Required whenever `cfg.requireIpMatch` is set, which
   * is unconditional in live.
   */
  customerIpAddress?: string | undefined;
}

/** Thrown before any URL is built when the order cannot be expressed to MoonPay. */
export class UnsupportedByMoonPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedByMoonPayError';
  }
}

/**
 * HMAC-SHA256 of the payer's IP under the secret key, base64.
 *
 * The IP is lowercased and trimmed before hashing so that the value MoonPay
 * observes and the value we hashed cannot differ over whitespace or IPv6
 * letter case. No salt: MoonPay derives the comparison from the same secret
 * key, so introducing one here would guarantee a mismatch.
 */
export function hashIpAddress(secretKey: string, ip: string): string {
  return createHmac('sha256', secretKey).update(ip.trim().toLowerCase()).digest('base64');
}

/**
 * Sign a query string.
 *
 * `search` must include the leading `?` and must be byte-identical to what is
 * sent - MoonPay recomputes the HMAC over the query string it receives, so any
 * re-encoding between signing and sending invalidates it. That is why this
 * takes the finished string rather than a parameter object.
 */
export function signQueryString(secretKey: string, search: string): string {
  return createHmac('sha256', secretKey).update(search).digest('base64');
}

/**
 * Verify a signature we produced. Used by the smoke suite and by anything that
 * needs to prove a URL was not tampered with; MoonPay itself does not call this.
 */
export function verifyWidgetUrl(secretKey: string, url: string): boolean {
  const parsed = new URL(url);
  const provided = parsed.searchParams.get('signature');
  if (!provided) return false;

  // Strip the signature and re-derive the exact string that was signed. Order
  // is preserved because URLSearchParams.delete() does not reorder the rest.
  const params = new URLSearchParams(parsed.search);
  params.delete('signature');
  const expected = signQueryString(secretKey, `?${params.toString()}`);
  return expected === provided;
}

/**
 * Build the query parameters, in the order MoonPay's own examples use.
 *
 * `lockAmount` and a pinned `currencyCode` are what make this a payment rather
 * than an invitation to buy crypto: without them the customer can change the
 * amount and the asset, and the merchant is invoiced for one thing and credited
 * with another.
 *
 * `walletAddress` is the parameter this entire business model turns on. It is
 * set unconditionally rather than exposed as an option, and its presence is
 * precisely what makes signing non-optional.
 *
 * MoonPay's `email` parameter is deliberately NOT used, despite being the
 * obvious convenience. Two reasons, either sufficient on its own:
 *
 *  - It puts an email address in a query string. Signed or not, query strings
 *    reach access logs, proxy logs, referrer headers and browser history, and
 *    this platform goes to the trouble of encrypting that same address at rest.
 *    Undoing that for one prefilled form field is a bad trade.
 *  - MoonPay signs a customer OUT if it does not match the account they are
 *    already logged into. A stale or mistyped address is therefore worse than
 *    no address, and we would have to decrypt PII on every render to supply it.
 */
export function buildWidgetParams(
  cfg: MoonPayConfig,
  p: BuildWidgetUrlParams,
): URLSearchParams {
  const base = toBaseCurrency(p.fiatCurrency);
  if (!base) {
    // Enumerated from the table rather than hardcoded, so the message can never
    // drift from what the integration actually accepts.
    throw new UnsupportedByMoonPayError(
      `MoonPay cannot fund from ${p.fiatCurrency}; supported currencies are ${Object.keys(MOONPAY_BASE_CURRENCIES).join(', ')}`,
    );
  }

  const quote = toQuoteCurrency(p.cryptoAsset, p.network);
  if (!quote) {
    throw new UnsupportedByMoonPayError(
      `MoonPay does not support ${p.cryptoAsset} on ${p.network}`,
    );
  }

  if (cfg.requireIpMatch && !p.customerIpAddress) {
    throw new UnsupportedByMoonPayError(
      'IP matching is enabled but the payer IP address is unknown; refusing to build an unbound widget URL',
    );
  }

  const params = new URLSearchParams();
  params.set('apiKey', cfg.publishableKey);

  // Pinned, not merely defaulted. `currencyCode` locks the asset; the
  // `defaultCurrencyCode` parameter would leave the customer free to switch.
  params.set('currencyCode', quote.code);
  params.set('baseCurrencyCode', base.code);
  params.set('baseCurrencyAmount', formatDecimal(p.fiatAmount, p.fiatDecimals));
  params.set('lockAmount', 'true');

  params.set('walletAddress', p.walletAddress);
  params.set('externalTransactionId', p.reference);

  if (p.redirectUrl) params.set('redirectURL', p.redirectUrl);
  if (cfg.theme) params.set('theme', cfg.theme);
  if (cfg.themeId) params.set('themeId', cfg.themeId);

  if (p.customerIpAddress) {
    params.set('allowedIpAddress', hashIpAddress(cfg.secretKey, p.customerIpAddress));
  }

  return params;
}

/**
 * Build the finished, signed widget URL.
 *
 * The signature is computed over the query string WITHOUT it and appended last,
 * URL-encoded. Building the string once and signing that same string is
 * deliberate: deriving the signature from a parameter object and the URL from
 * another encoding pass is how signed-URL integrations break in production.
 */
export function buildWidgetUrl(cfg: MoonPayConfig, p: BuildWidgetUrlParams): string {
  const params = buildWidgetParams(cfg, p);
  const search = `?${params.toString()}`;
  const signature = signQueryString(cfg.secretKey, search);
  return `${cfg.widgetBaseUrl}/${search}&signature=${encodeURIComponent(signature)}`;
}
