/**
 * Translation between this platform's vocabulary and MoonPay Commerce's.
 *
 * Everything Commerce-specific about currencies, amounts and statuses lives
 * here, so the domain never learns that "USDC on Solana" is a Mongo-style id
 * to one provider and `usdc_polygon` to another.
 *
 * The two things that differ MOST from the on-ramp provider, and that will
 * cause real losses if treated the same way, are both in this file:
 * currency ids (§1) and fiat decimals (§2).
 */

/**
 * §1 — CURRENCY IDS ARE NOT CONSTANTS. Resolve them at runtime, always.
 *
 * The on-ramp uses stable string codes (`usdc_polygon`, `btc`) that are the
 * same everywhere, so `MOONPAY_QUOTE_CURRENCIES` can be a hardcoded table.
 * Commerce uses opaque ids that **differ between sandbox and production**:
 *
 *   USD  production 637ca18de2997b3a87a566a8
 *        sandbox    63777da9d2f1ab96ae0ee600     <-- different
 *   BTC  production 63d7d3b681c7f9e193bcdad5
 *        sandbox    63d7d3b681c7f9e193bcdad5     <-- same, but do not rely on it
 *
 * BTC happening to match is a coincidence, not a guarantee. A hardcoded id
 * silently targets the wrong currency - or a currency that does not exist -
 * in the other environment. Always resolve by symbol via `findFiatCurrency`
 * / `findCryptoCurrency` against a live `GET /v1/currency/all`.
 */

/** One entry from `GET /v1/currency/all`. */
export interface CommerceCurrency {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  type?: string | undefined;
  /** `"btc"` for native Bitcoin; a contract address for tokens. */
  mintAddress?: string | undefined;
  isNative?: boolean | undefined;
  features?: string[] | undefined;
  blockchain?:
    | {
        name?: string | undefined;
        engine?: { type?: string | undefined } | undefined;
      }
    | undefined;
}

/** Capability flags Commerce publishes per currency. */
export const FEATURE_PAYMENT_PRICING = 'PAYMENT_PRICING';
export const FEATURE_PAYMENT_RECIPIENT = 'PAYMENT_RECIPIENT';
export const FEATURE_WITHDRAWAL_DESTINATION = 'WITHDRAWAL_DESTINATION';

export class CommerceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceMappingError';
  }
}

/** Resolve a fiat pricing currency by symbol, e.g. "USD" -> its id + decimals. */
export function findFiatCurrency(
  currencies: CommerceCurrency[],
  symbol: string,
): CommerceCurrency | null {
  const want = symbol.toUpperCase();
  return currencies.find((c) => c.type === 'FIAT' && c.symbol.toUpperCase() === want) ?? null;
}

/**
 * Resolve a crypto recipient currency by symbol.
 *
 * BTC is special-cased to require `mintAddress === 'btc'`, the NATIVE asset.
 * The catalogue also carries `cbBTC`, `BBTC`, `BTCB` and `tBTC` - wrapped
 * tokens on EVM chains with `0x…` addresses. Sending one of those to a native
 * Bitcoin address loses the funds permanently, so matching on symbol alone is
 * not safe for Bitcoin.
 */
export function findCryptoCurrency(
  currencies: CommerceCurrency[],
  symbol: string,
): CommerceCurrency | null {
  const want = symbol.toUpperCase();
  if (want === 'BTC') {
    return currencies.find((c) => c.symbol.toUpperCase() === 'BTC' && c.mintAddress === 'btc') ?? null;
  }
  return (
    currencies.find(
      (c) =>
        c.symbol.toUpperCase() === want &&
        (c.features ?? []).includes(FEATURE_PAYMENT_RECIPIENT),
    ) ?? null
  );
}

/** Assert a currency can actually receive payments before an order is built on it. */
export function assertCanReceive(currency: CommerceCurrency): void {
  if (!(currency.features ?? []).includes(FEATURE_PAYMENT_RECIPIENT)) {
    throw new CommerceMappingError(
      `Commerce currency ${currency.symbol} is not PAYMENT_RECIPIENT-capable (features: ${(currency.features ?? []).join(', ') || 'none'})`,
    );
  }
}

/**
 * §2 — FIAT DECIMALS ARE NOT 2. This is the highest-consequence detail here.
 *
 * This platform stores fiat as minor units at `FIAT_DECIMALS`, which is 2 for
 * every supported currency - correct, those are real minor units (cents).
 *
 * Commerce prices in each currency's OWN base units, and those are NOT 2:
 *
 *   USD  6      $30.00  ->  "30000000"
 *   EUR  6
 *   GBP  9      £30.00  ->  "30000000000"
 *   AUD  9
 *   LKR  9
 *
 * Passing our 2-decimal minor units straight through would undercharge by a
 * factor of 10,000 (USD) or 10,000,000 (LKR). Passing a naive float multiply
 * would introduce rounding into a money path. Hence: integer-only conversion,
 * decimals read from the live API rather than a constant, and a hard throw on
 * anything that would lose precision.
 */
export function toCommerceBaseUnits(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
): string {
  if (!Number.isInteger(fromDecimals) || !Number.isInteger(toDecimals)) {
    throw new CommerceMappingError('decimals must be integers');
  }
  if (fromDecimals < 0 || toDecimals < 0) {
    throw new CommerceMappingError('decimals must not be negative');
  }

  if (toDecimals >= fromDecimals) {
    // Widening. Always exact.
    const factor = 10n ** BigInt(toDecimals - fromDecimals);
    return (amount * factor).toString();
  }

  // Narrowing. Only safe when the digits being dropped are all zero; otherwise
  // this would silently round someone's money. Not currently reachable - every
  // Commerce fiat currency has more decimals than our 2 - but a provider-side
  // change must fail loudly rather than quietly truncate.
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (amount % divisor !== 0n) {
    throw new CommerceMappingError(
      `converting ${amount} from ${fromDecimals} to ${toDecimals} decimals would lose precision`,
    );
  }
  return (amount / divisor).toString();
}

/** Inverse of `toCommerceBaseUnits`, for reading amounts back off webhooks. */
export function fromCommerceBaseUnits(
  amount: string,
  fromDecimals: number,
  toDecimals: number,
): bigint {
  if (!/^\d+$/.test(amount)) {
    throw new CommerceMappingError(`not an integer base-unit string: ${amount}`);
  }
  const value = BigInt(amount);
  if (toDecimals >= fromDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (value % divisor !== 0n) {
    throw new CommerceMappingError(
      `converting ${amount} from ${fromDecimals} to ${toDecimals} decimals would lose precision`,
    );
  }
  return value / divisor;
}

/**
 * §3 — Commerce transaction status -> our order status.
 *
 * ⚠️ **THIS TABLE IS UNVERIFIED.** Commerce's webhook payload shape and its
 * status enum are not published in the documentation that was available when
 * this was written, and no real Commerce webhook has been captured yet -
 * devnet does not deliver them for the flows tested so far.
 *
 * The values below are inferred from the Pay Link / transaction vocabulary and
 * MUST be confirmed against a real delivery before this provider is used for
 * anything that matters. `scripts/commerce-webhook-listener.mjs` exists to
 * capture exactly that: point a sandbox webhook at it and it prints the raw
 * payload, the header set, and candidate dedupe keys.
 *
 * Until then the safety property is the same one the on-ramp mapping relies on:
 * **an unrecognised status maps to null, and the caller escalates to
 * MANUAL_REVIEW rather than guessing.** Never add a `default:` that assumes
 * success here.
 */
export function mapTransactionStatus(providerStatus: string | null): string | null {
  if (!providerStatus) return null;

  switch (providerStatus.toUpperCase()) {
    // Created / awaiting payment.
    case 'CREATED':
    case 'PENDING':
    case 'AWAITING_PAYMENT':
      return 'PAYMENT_PENDING';

    // Payment seen, not yet final - on-chain confirmations or fiat capture.
    case 'PROCESSING':
    case 'CONFIRMING':
    case 'UNCONFIRMED':
      return 'PAYMENT_CONFIRMED';

    // Terminal success.
    case 'SUCCESS':
    case 'COMPLETED':
    case 'PAID':
    case 'CONFIRMED':
      return 'COMPLETED';

    // Terminal failure, customer not charged or refunded by the provider.
    case 'FAILED':
    case 'CANCELLED':
    case 'CANCELED':
    case 'EXPIRED':
      return 'PAYMENT_FAILED';

    // Anything else is a status added after this was written. Escalate.
    default:
      return null;
  }
}

/**
 * Derive a stable dedupe id for a Commerce webhook delivery.
 *
 * Mirrors the on-ramp's approach and exists for the same reason: the dedupe
 * key feeds the unique constraint on `provider_events (provider,
 * external_event_id)`, which is what makes a re-delivered event a harmless
 * no-op.
 *
 * That constraint carries MORE weight here than it does for the on-ramp.
 * MoonPay's webhook signature embeds a timestamp, giving a replay window that
 * can be bounded independently. Commerce's `X-Signature` - as documented - does
 * NOT appear to include one, so a captured delivery may stay verifiable
 * indefinitely. If that holds, this dedupe key is the ONLY thing preventing
 * replay. Confirm the header shape with the listener script before relying on
 * it, and prefer a provider-supplied event id over the hash fallback.
 */
export function deriveEventId(
  payload: Record<string, unknown>,
  rawBodySha256: string,
): string {
  const str = (k: string): string | null =>
    typeof payload[k] === 'string' ? (payload[k] as string) : null;

  const event = str('event') ?? str('type') ?? 'unknown';
  const id = str('id') ?? str('eventId') ?? str('transactionId');

  if (id) return `${event}:${id}`;
  return `${event}:sha256:${rawBodySha256}`;
}
