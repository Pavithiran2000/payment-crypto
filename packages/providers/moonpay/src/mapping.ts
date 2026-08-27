/**
 * The translation layer between this platform's vocabulary and MoonPay's.
 *
 * Everything MoonPay-specific about currencies, networks and statuses lives
 * here, so the domain never learns that "USDC on polygon" is spelled
 * `usdc_polygon` to one provider and something else to the next.
 *
 * The tables below were taken from MoonPay's live currency catalogue
 * (`GET https://api.moonpay.com/v3/currencies`, fetched 2026-08-23) rather
 * than from prose, because that endpoint is the only authoritative source for
 * codes, minimums and sandbox availability - and all three change.
 *
 * Sources:
 *   https://dev.moonpay.com/widget/supported-currencies
 *   https://dev.moonpay.com/widget/on-ramp/customization/parameters
 *   https://dev.moonpay.com/api-reference/widget/webhooks/overview
 */

/** What MoonPay calls a fiat currency, plus the limits it enforces on it. */
export interface BaseCurrencySpec {
  /** `baseCurrencyCode` in the widget URL and the quote API. Always lowercase. */
  code: string;
  /** MoonPay rejects a buy below this. Enforced by them; mirrored for UX. */
  minBuyAmount: number;
  maxBuyAmount: number;
}

/**
 * Our `FiatCurrency` -> MoonPay `baseCurrencyCode`.
 *
 * SGD is deliberately absent: MoonPay's catalogue has no `sgd`, so an SGD
 * order must be refused at creation rather than at the payment step where the
 * customer is already committed. LKR is present because MoonPay does list it
 * and it is this platform's home market.
 */
export const MOONPAY_BASE_CURRENCIES: Record<string, BaseCurrencySpec> = {
  USD: { code: 'usd', minBuyAmount: 20, maxBuyAmount: 30_000 },
  EUR: { code: 'eur', minBuyAmount: 20, maxBuyAmount: 30_000 },
  GBP: { code: 'gbp', minBuyAmount: 20, maxBuyAmount: 30_000 },
  AUD: { code: 'aud', minBuyAmount: 35, maxBuyAmount: 16_000 },
  LKR: { code: 'lkr', minBuyAmount: 7_000, maxBuyAmount: 2_150_000 },
};

/** What MoonPay calls one asset on one chain. */
export interface QuoteCurrencySpec {
  /** `currencyCode` in the widget URL and the quote API path. */
  code: string;
  /** On-chain decimals. Matches `ASSET_DECIMALS`; kept here as a cross-check. */
  decimals: number;
  /**
   * Whether MoonPay's sandbox can deliver this pair at all.
   *
   * `false` is not a limitation of this integration. MoonPay's sandbox settles
   * on testnets, and it holds no testnet liquidity for these codes - a sandbox
   * buy of `usdc_polygon` fails with "Transaction processing failed" no matter
   * how correct the integration is. Sandbox rehearsals must use a pair where
   * this is `true`; see docs/moonpay-onramp-migration.md.
   */
  supportsTestMode: boolean;
  minBuyAmount: number;
}

/** Our `(CryptoAsset, ChainNetwork)` -> MoonPay `currencyCode`. */
export const MOONPAY_QUOTE_CURRENCIES: Record<string, Record<string, QuoteCurrencySpec>> = {
  USDC: {
    polygon: { code: 'usdc_polygon', decimals: 6, supportsTestMode: false, minBuyAmount: 5 },
    ethereum: { code: 'usdc', decimals: 6, supportsTestMode: true, minBuyAmount: 5 },
  },
  USDT: {
    polygon: { code: 'usdt_polygon', decimals: 6, supportsTestMode: false, minBuyAmount: 5.01 },
    ethereum: { code: 'usdt', decimals: 6, supportsTestMode: false, minBuyAmount: 5.01 },
  },
};

export function toBaseCurrency(fiatCurrency: string): BaseCurrencySpec | null {
  return MOONPAY_BASE_CURRENCIES[fiatCurrency.toUpperCase()] ?? null;
}

export function toQuoteCurrency(asset: string, network: string): QuoteCurrencySpec | null {
  return MOONPAY_QUOTE_CURRENCIES[asset.toUpperCase()]?.[network.toLowerCase()] ?? null;
}

/**
 * The four stages MoonPay reports on a transaction, in order.
 *
 * Only `transaction_created` and `transaction_failed` events carry them, which
 * is exactly when they are needed: a `failed` transaction says nothing about
 * *what* failed, and the stage does.
 */
export const TRANSACTION_STAGES = [
  'stage_one_ordering',
  'stage_two_verification',
  'stage_three_processing',
  'stage_four_delivery',
] as const;

export type TransactionStage = (typeof TRANSACTION_STAGES)[number];

export interface StageSnapshot {
  stage: string | null;
  status: string | null;
  failureReason: string | null;
}

/**
 * MoonPay transaction status -> our order status.
 *
 * The five states are the complete documented set:
 *
 *   waitingPayment        bank transfer initiated, MoonPay is not in receipt
 *   waitingAuthorization  card issued, waiting on 3DS / bank-side approval
 *   pending               MoonPay holds the money and is processing/delivering
 *   completed             crypto delivered to the wallet address
 *   failed                terminal failure; `stages` says which stage broke
 *
 * `completed` is MoonPay confirming *its* delivery, which is as far as this
 * provider can see. Confirming the deposit actually credited the Binance Entity
 * Account is a separate reconciliation step (`orders.binance_credited`).
 *
 * Anything not in this table is a status MoonPay added after this was written:
 * it maps to null and the caller escalates to MANUAL_REVIEW rather than guessing.
 */
export function mapTransactionStatus(providerStatus: string, stages?: StageSnapshot[] | null): string | null {
  switch (providerStatus) {
    case 'waitingPayment':
    case 'waitingAuthorization':
      return 'PAYMENT_PENDING';
    case 'pending':
      return 'PAYMENT_CONFIRMED';
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return mapFailedStatus(stages ?? null);
    default:
      return null;
  }
}

/**
 * Resolve which of our failure states a `failed` transaction landed in.
 *
 * MoonPay documents no enum for `failureReason` - it is free text - so keying
 * off it would be guesswork that silently rots. `stages` IS enumerated, and it
 * tells us the one thing that decides the outcome: whether money moved.
 *
 * Stages one and two fail before MoonPay takes the money, so those are ordinary
 * customer-facing declines. Stage three fails after the charge but is MoonPay
 * reversing its own payment, so the customer is made whole and PAYMENT_FAILED
 * is honest. Stage four means the card was charged and the crypto did NOT
 * arrive - that is money at risk, and no automated rule should close it out.
 * It goes to a human.
 */
export function mapFailedStatus(stages: StageSnapshot[] | null): string {
  const failed = stages?.find((s) => s.status === 'failed')?.stage;

  switch (failed) {
    case 'stage_one_ordering':
      return 'CARD_DECLINED';
    case 'stage_two_verification':
      return 'KYC_FAILED';
    case 'stage_four_delivery':
      return 'MANUAL_REVIEW';
    // stage_three_processing, an unrecognised stage, or no stages at all.
    // PAYMENT_FAILED is the safe reading: the transaction is over and the
    // customer was not charged, or was charged and refunded by MoonPay.
    default:
      return 'PAYMENT_FAILED';
  }
}

/**
 * MoonPay identity-check result -> our order status.
 *
 * Exposed for completeness, not wired in. `identity_check_updated` events carry
 * a customer id and no transaction id, and this platform has no customer
 * accounts to join one to - every order gets its own pseudonymous data subject.
 * The events are still recorded verbatim in `provider_events` for the audit
 * trail; see WebhooksService.
 */
export function mapIdentityCheck(result: string | null, rejectType: string | null): string | null {
  if (result === 'rejected' && rejectType === 'final') return 'KYC_FAILED';
  if (result === 'rejected') return null; // retry / level-up requests are not terminal
  return null;
}
