import type { FiatCurrency, CryptoAsset, ChainNetwork } from "@pp/shared-types";

/**
 * Stripe's onramp funds from USD and EUR only - `source_currency` takes no
 * other value. This is not a subset we chose to start with; offering anything
 * else here produces an order the gateway rejects at creation.
 */
export const SUPPORTED_FIAT_CURRENCIES: FiatCurrency[] = ["USD", "EUR"];

/**
 * Only combinations with an approved, matured payout_destination row will be
 * accepted by the gateway (orders.service.ts rejects everything else with a
 * 400), AND that Stripe's onramp can deliver. Keep this list in sync with
 * whatever destinations are actually seeded and approved.
 *
 * USDC (Polygon) is the default: it appears in Stripe's published availability
 * table for the onramp. USDT is in the API's `destination_currency` enum but
 * not in that table, so it is deliberately absent here until Stripe confirms
 * it in writing for this account - see docs/provider-approval.md.
 */
export const SUPPORTED_CRYPTO_OPTIONS: { asset: CryptoAsset; network: ChainNetwork; label: string }[] = [
  { asset: "USDC", network: "polygon", label: "USDC (Polygon)" },
];

export const DEFAULT_FIAT_CURRENCY: FiatCurrency = "USD";
