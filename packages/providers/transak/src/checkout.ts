import { formatDecimal } from '@pp/shared-types';

export type TransakEnv = 'staging' | 'production';

const BASE_URL: Record<TransakEnv, string> = {
  staging: 'https://global-stg.transak.com',
  production: 'https://global.transak.com',
};

export interface TransakConfig {
  env: TransakEnv;
  apiKey: string;
  /** Shared secret used to verify inbound webhooks. Never sent to the browser. */
  apiSecret: string;
  redirectUrl: string;
}

export interface CheckoutParams {
  /** Our internal order reference. Comes back on every webhook - the join key. */
  partnerOrderId: string;
  fiatAmount: bigint;
  fiatDecimals: number;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  /** The approved ZebPay corporate deposit address. */
  walletAddress: string;
  customerEmail?: string | undefined;
}

/**
 * Build the hosted-checkout URL.
 *
 * `disableWalletAddressForm` is the parameter this entire business model turns
 * on: it pins delivery to the address we pass and stops the payer editing it.
 * Without it, a customer could redirect their own purchase and the merchant
 * would never be credited.
 *
 * Note this is also precisely the payer-is-not-the-beneficiary pattern that
 * needs written provider sign-off before production. See docs/provider-approval.md.
 */
export function buildCheckoutUrl(cfg: TransakConfig, p: CheckoutParams): string {
  const url = new URL(BASE_URL[cfg.env]);
  const q = url.searchParams;

  q.set('apiKey', cfg.apiKey);
  q.set('partnerOrderId', p.partnerOrderId);
  q.set('fiatAmount', formatDecimal(p.fiatAmount, p.fiatDecimals));
  q.set('fiatCurrency', p.fiatCurrency);
  q.set('cryptoCurrencyCode', p.cryptoAsset);
  q.set('network', p.network);
  q.set('walletAddress', p.walletAddress);
  q.set('disableWalletAddressForm', 'true');
  q.set('redirectURL', cfg.redirectUrl);
  q.set('productsAvailed', 'BUY');
  if (p.customerEmail) q.set('email', p.customerEmail);

  return url.toString();
}
