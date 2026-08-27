import type { FiatCurrency, CryptoAsset, ChainNetwork } from "@pp/shared-types";

/**
 * What MoonPay will actually fund from.
 *
 * MoonPay's catalogue is far wider than the previous provider's USD/EUR, but it
 * is not unlimited: there is no `sgd`, so SGD is absent here even though the
 * shared `FiatCurrency` type still carries it. Offering a currency the gateway
 * rejects only moves the failure to a worse place.
 *
 * `minAmount` mirrors MoonPay's own per-currency minimum. MoonPay enforces it
 * and the gateway's quote call surfaces the refusal, but a customer should be
 * told before they type an amount, not after. These figures come from
 * `GET https://api.moonpay.com/v3/currencies` (fetched 2026-08-23) and MoonPay
 * changes them - re-check when a legitimate amount starts being refused.
 */
export interface FiatOption {
  code: FiatCurrency;
  label: string;
  minAmount: number;
  maxAmount: number;
}

export const SUPPORTED_FIAT: FiatOption[] = [
  { code: "USD", label: "US Dollar", minAmount: 20, maxAmount: 30_000 },
  { code: "EUR", label: "Euro", minAmount: 20, maxAmount: 30_000 },
  { code: "GBP", label: "Pound Sterling", minAmount: 20, maxAmount: 30_000 },
  { code: "AUD", label: "Australian Dollar", minAmount: 35, maxAmount: 16_000 },
  { code: "LKR", label: "Sri Lankan Rupee", minAmount: 7_000, maxAmount: 2_150_000 },
];

export const SUPPORTED_FIAT_CURRENCIES: FiatCurrency[] = SUPPORTED_FIAT.map((f) => f.code);

export function fiatOption(code: string): FiatOption | undefined {
  return SUPPORTED_FIAT.find((f) => f.code === code);
}

/**
 * Only combinations with an approved, matured `payout_destination` row will be
 * accepted by the gateway (orders.service.ts rejects everything else with a
 * 400), AND that MoonPay can deliver. Keep this list in sync with whatever
 * destinations are actually seeded and approved.
 *
 * USDC (Polygon) is the production default: `usdc_polygon` is live, unsuspended
 * and unrestricted in MoonPay's catalogue, and Polygon's network fee is a
 * fraction of Ethereum's on a stablecoin transfer.
 *
 * TEMPORARY SANDBOX OVERRIDE (2026-08-24): swapped to USDC (Ethereum) because
 * MoonPay's sandbox has no testnet liquidity for `usdc_polygon`
 * (`supportsTestMode: false`) - a real sandbox quote for it 400s with
 * "Currency not supported in test mode". `usdc` (Ethereum) does support test
 * mode, and scripts/seed.sql seeds an approved destination for it for exactly
 * this rehearsal. Revert to `polygon` before anything but sandbox testing -
 * see docs/moonpay-onramp-migration.md §4.2.
 */
export const SUPPORTED_CRYPTO_OPTIONS: { asset: CryptoAsset; network: ChainNetwork; label: string }[] = [
  { asset: "USDC", network: "ethereum", label: "USDC (Ethereum, sandbox)" },
];

export const DEFAULT_FIAT_CURRENCY: FiatCurrency = "USD";
