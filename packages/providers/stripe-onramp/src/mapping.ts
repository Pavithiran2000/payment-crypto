/**
 * The translation layer between this platform's vocabulary and Stripe's.
 *
 * Everything Stripe-specific about currencies, networks and statuses lives
 * here, so the domain never learns that "USDT on polygon" is spelled
 * `usdt` / `polygon` to one provider and something else to the next.
 *
 * Sources (fetched 2026-08-20):
 *   https://docs.stripe.com/api/crypto/onramp_sessions/create
 *   https://docs.stripe.com/crypto/onramp/stripe-hosted
 */

/**
 * Onramp accepts only these two as `source_currency`. This is the hard
 * constraint that decides which fiat currencies the storefront may offer -
 * it is NOT a subset we chose.
 */
export const STRIPE_SOURCE_CURRENCIES = ['usd', 'eur'] as const;
export type StripeSourceCurrency = (typeof STRIPE_SOURCE_CURRENCIES)[number];

/** `destination_currency` enum, verbatim from the create-session reference. */
export const STRIPE_DESTINATION_CURRENCIES = [
  'avax',
  'btc',
  'eth',
  'matic',
  'sol',
  'usdc',
  'usdt',
  'wld',
  'xlm',
] as const;

/** `destination_network` enum, verbatim from the create-session reference. */
export const STRIPE_DESTINATION_NETWORKS = [
  'avalanche',
  'base',
  'bitcoin',
  'ethereum',
  'optimism',
  'polygon',
  'solana',
  'stellar',
  'sui',
  'tempo',
  'worldchain',
] as const;

/**
 * Our `FiatCurrency` -> Stripe `source_currency`.
 * Returns null for anything Onramp cannot fund, so the caller rejects the
 * order at creation instead of discovering it at the payment step.
 */
export function toStripeSourceCurrency(fiatCurrency: string): StripeSourceCurrency | null {
  const lower = fiatCurrency.toLowerCase();
  return (STRIPE_SOURCE_CURRENCIES as readonly string[]).includes(lower)
    ? (lower as StripeSourceCurrency)
    : null;
}

/** Our `CryptoAsset` -> Stripe `destination_currency`. */
export function toStripeDestinationCurrency(asset: string): string | null {
  const lower = asset.toLowerCase();
  return (STRIPE_DESTINATION_CURRENCIES as readonly string[]).includes(lower) ? lower : null;
}

/** Our `ChainNetwork` -> Stripe `destination_network`. */
export function toStripeDestinationNetwork(network: string): string | null {
  const lower = network.toLowerCase();
  return (STRIPE_DESTINATION_NETWORKS as readonly string[]).includes(lower) ? lower : null;
}

/**
 * Onramp session status -> our order status.
 *
 * The five states are the complete documented set. Anything else is a status
 * Stripe added after this was written: it maps to null and the caller escalates
 * to MANUAL_REVIEW rather than guessing.
 *
 *   initialized            session minted, customer has not started
 *   rejected               KYC failure, sanctions screening, or fraud check
 *   requires_payment       customer onboarded, at the payment step
 *   fulfillment_processing paid; crypto not delivered yet
 *   fulfillment_complete   paid and delivery confirmed by Stripe
 *
 * `fulfillment_complete` is Stripe confirming *its* delivery, which is as far
 * as this provider can see. Confirming the deposit actually credited the
 * Binance Entity Account is a separate reconciliation step (`orders.binance_credited`).
 */
export function mapOnrampStatus(providerStatus: string): string | null {
  const table: Record<string, string> = {
    initialized: 'CHECKOUT_OPENED',
    rejected: 'KYC_FAILED',
    requires_payment: 'PAYMENT_PENDING',
    fulfillment_processing: 'PAYMENT_CONFIRMED',
    fulfillment_complete: 'COMPLETED',
  };
  return table[providerStatus] ?? null;
}
