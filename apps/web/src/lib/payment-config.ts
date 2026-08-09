import { FIAT_DECIMALS, type FiatCurrency, type CryptoAsset, type ChainNetwork } from "@pp/shared-types";

export const SUPPORTED_FIAT_CURRENCIES = Object.keys(FIAT_DECIMALS) as FiatCurrency[];

/**
 * Only combinations with an approved, matured payout_destination row will be
 * accepted by the gateway (orders.service.ts rejects everything else with a
 * 400). Local seed data provisions exactly USDT/polygon - keep this list in
 * sync with whatever destinations are actually seeded/approved.
 */
export const SUPPORTED_CRYPTO_OPTIONS: { asset: CryptoAsset; network: ChainNetwork; label: string }[] = [
  { asset: "USDT", network: "polygon", label: "USDT (Polygon)" },
];

export const DEFAULT_FIAT_CURRENCY: FiatCurrency = "USD";
