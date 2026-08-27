/**
 * Money is NEVER a float. Two representations, both integer-based:
 *
 *  - Fiat   -> minor units (cents/paise) as bigint.  USD 12.34 => 1234n, decimals 2
 *  - Crypto -> base units (wei/satoshi) as bigint.   1 USDT    => 1000000n on a 6-dec chain
 *
 * `decimals` is stored per asset, never hardcoded: USDT is 6 decimals on Ethereum
 * and Polygon but 18 on BSC. Hardcoding it is a real and common loss event.
 *
 * bigint does not survive JSON.stringify, so amounts cross the API boundary as
 * decimal strings and are parsed back at the edge. Never `Number(amount)`.
 */

export type FiatCurrency = 'USD' | 'EUR' | 'GBP' | 'AUD' | 'SGD' | 'LKR';
export type CryptoAsset = 'USDT' | 'USDC';
export type ChainNetwork = 'polygon' | 'ethereum';

export interface Money {
  /** Integer amount in the asset's smallest unit. */
  readonly amount: bigint;
  /** Number of decimal places the smallest unit represents. */
  readonly decimals: number;
  readonly currency: string;
}

export const FIAT_DECIMALS: Record<FiatCurrency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  SGD: 2,
  LKR: 2,
};

/** Asset decimals are network-specific. Look up, never assume. */
export const ASSET_DECIMALS: Record<CryptoAsset, Record<ChainNetwork, number>> = {
  USDT: { polygon: 6, ethereum: 6 },
  USDC: { polygon: 6, ethereum: 6 },
};

export class MoneyParseError extends Error {}

/**
 * Parse a human decimal string ("12.34") into integer minor units.
 * Rejects floats, exponent notation and excess precision rather than rounding —
 * silent rounding of money is how reconciliation breaks.
 */
export function parseDecimal(input: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new MoneyParseError(`Not a plain decimal string: ${input}`);
  }
  const [whole = '0', frac = ''] = input.split('.');
  if (frac.length > decimals) {
    throw new MoneyParseError(
      `${input} has ${frac.length} decimal places, currency allows ${decimals}`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/**
 * Parse a decimal string that may be padded with insignificant trailing zeros
 * beyond the asset's precision.
 *
 * Providers commonly render every amount at the chain's full precision:
 * `"0.123400000000000000"` for an 18-decimal asset, or more decimal places than
 * a 6-decimal USDC balance can hold. Those zeros carry no value, so rejecting
 * them would fail a webhook over a formatting choice.
 * Genuinely excess precision — a non-zero digit past the asset's decimals —
 * still throws, because that is a real mismatch and not an artefact.
 */
export function parseDecimalPadded(input: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new MoneyParseError(`Not a plain decimal string: ${input}`);
  }
  const [whole = '0', frac = ''] = input.split('.');
  const trimmed = frac.length > decimals ? frac.replace(/0+$/, '') : frac;
  return parseDecimal(trimmed.length > 0 ? `${whole}.${trimmed}` : whole, decimals);
}

/**
 * Render a JSON number as an exact decimal string.
 *
 * Some providers send amounts as JSON numbers rather than strings - MoonPay's
 * `quoteCurrencyAmount` is a `number`. By the time `JSON.parse` has run, the
 * value is an IEEE-754 double and the original text is gone, so the only safe
 * move left is to render the double back to the shortest decimal string that
 * round-trips to exactly that double. `String(n)` does precisely that; this
 * function only expands the exponent notation `String()` switches to outside
 * roughly 1e21 and 1e-7, which `parseDecimal` would otherwise reject.
 *
 * It does NOT recover precision the double never had. If a provider sends more
 * significant digits than a double can hold, they were already lost upstream -
 * which is exactly why this platform's asset list is limited to 6-decimal
 * stablecoins, where every representable amount survives the round trip. An
 * 18-decimal asset would need the amount as a string from the provider, not a
 * number.
 */
export function decimalStringFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MoneyParseError(`Not a finite number: ${String(value)}`);
  }

  const s = String(value);
  if (!/[eE]/.test(s)) return s;

  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) throw new MoneyParseError(`Cannot expand exponent notation: ${s}`);

  const [, sign = '', whole = '0', frac = '', expText = '0'] = m;
  const exp = Number(expText);
  const digits = whole + frac;
  // Where the decimal point lands once the exponent is applied.
  const point = whole.length + exp;

  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Render integer minor units back to a decimal string for display/transport. */
export function formatDecimal(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}

export function fiat(input: string, currency: FiatCurrency): Money {
  const decimals = FIAT_DECIMALS[currency];
  return { amount: parseDecimal(input, decimals), decimals, currency };
}

export function crypto(input: string, asset: CryptoAsset, network: ChainNetwork): Money {
  const decimals = ASSET_DECIMALS[asset][network];
  return { amount: parseDecimal(input, decimals), decimals, currency: asset };
}

export function formatMoney(m: Money): string {
  return formatDecimal(m.amount, m.decimals);
}
