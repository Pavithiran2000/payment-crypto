import { toBaseCurrency, toQuoteCurrency } from './mapping.js';
import { UnsupportedByMoonPayError } from './widget.js';
import type { MoonPayConfig } from './config.js';

/**
 * The two MoonPay REST calls this integration makes.
 *
 * MoonPay's server SDK is a thin wrapper over the same public endpoints and
 * would be one dependency used for two methods, so these are hand-written -
 * the same reasoning the previous provider used, and the same discipline:
 * every response is parsed defensively, never cast.
 *
 * Both endpoints authenticate with the PUBLISHABLE key in the `apiKey` query
 * parameter. That is not a mistake or a downgrade: MoonPay's widget API is
 * designed that way, and it is why the secret key never leaves this process.
 *
 * Sources (fetched 2026-08-23):
 *   https://dev.moonpay.com/api-reference/widget/getbuyquote
 *   https://dev.moonpay.com/api-reference/widget/getbuytransactionbyexternalid
 */

export class MoonPayApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /** MoonPay's machine-readable code, e.g. `4_SYS_NOT_AUTHORIZED`. */
    readonly moonPayErrorCode: string | null,
    /** MoonPay's error class, e.g. `UnauthorizedError`, `BadRequestError`. */
    readonly errorType: string | null,
  ) {
    super(message);
    this.name = 'MoonPayApiError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function readError(res: Response): Promise<MoonPayApiError> {
  const body: unknown = await res.json().catch(() => undefined);
  if (!isRecord(body)) return new MoonPayApiError(`MoonPay returned ${res.status}`, res.status, null, null);
  return new MoonPayApiError(
    str(body['message']) ?? `MoonPay returned ${res.status}`,
    res.status,
    str(body['moonPayErrorCode']),
    str(body['type']),
  );
}

export interface BuyQuoteParams {
  fiatCurrency: string;
  /** Plain decimal string, e.g. "150.00". Sent as a number, per the API. */
  fiatAmount: string;
  cryptoAsset: string;
  network: string;
  /**
   * Restricting the quote to cards makes the returned figure the one the
   * customer will actually be shown. Omitting it lets MoonPay quote against a
   * cheaper rail (SEPA, ACH) the customer may not be able to use.
   */
  paymentMethod?: string | undefined;
}

export interface BuyQuote {
  baseCurrencyCode: string;
  baseCurrencyAmount: number;
  quoteCurrencyCode: string;
  /** What the customer receives, net of every fee below. */
  quoteCurrencyAmount: number;
  quoteCurrencyPrice: number | null;
  feeAmount: number | null;
  extraFeeAmount: number | null;
  networkFeeAmount: number | null;
  /** What the card is charged. Not equal to `baseCurrencyAmount` when fees are added on top. */
  totalAmount: number | null;
  paymentMethod: string | null;
  /** Seconds the quote is good for, when MoonPay returns one. */
  expiresIn: number | null;
  expiresAt: string | null;
}

function parseQuote(body: unknown): BuyQuote {
  if (!isRecord(body)) throw new MoonPayApiError('Malformed quote response', 502, null, null);

  const baseCurrencyCode = str(body['baseCurrencyCode']);
  const quoteCurrencyCode = str(body['quoteCurrencyCode']);
  const baseCurrencyAmount = num(body['baseCurrencyAmount']);
  const quoteCurrencyAmount = num(body['quoteCurrencyAmount']);

  if (!baseCurrencyCode || !quoteCurrencyCode || baseCurrencyAmount === null || quoteCurrencyAmount === null) {
    throw new MoonPayApiError('Quote response missing currency codes or amounts', 502, null, null);
  }

  return {
    baseCurrencyCode,
    baseCurrencyAmount,
    quoteCurrencyCode,
    quoteCurrencyAmount,
    quoteCurrencyPrice: num(body['quoteCurrencyPrice']),
    feeAmount: num(body['feeAmount']),
    extraFeeAmount: num(body['extraFeeAmount']),
    networkFeeAmount: num(body['networkFeeAmount']),
    totalAmount: num(body['totalAmount']),
    paymentMethod: str(body['paymentMethod']),
    expiresIn: num(body['expiresIn']),
    expiresAt: str(body['expiresAt']),
  };
}

/**
 * Price the order before anything is persisted.
 *
 * This is the pre-flight the previous provider got for free from session
 * creation. MoonPay mints nothing up front, so without this call the first time
 * anyone discovers that a currency pair, an amount or a geography is
 * unsupported is when the customer is already staring at the widget.
 *
 * It also fills `crypto_amount_quoted` and `quote_expires_at`, which have
 * existed on `orders` since the first migration with nothing populating them.
 */
export async function fetchBuyQuote(cfg: MoonPayConfig, p: BuyQuoteParams): Promise<BuyQuote> {
  const base = toBaseCurrency(p.fiatCurrency);
  if (!base) throw new UnsupportedByMoonPayError(`MoonPay cannot fund from ${p.fiatCurrency}`);

  const quote = toQuoteCurrency(p.cryptoAsset, p.network);
  if (!quote) throw new UnsupportedByMoonPayError(`MoonPay does not support ${p.cryptoAsset} on ${p.network}`);

  const search = new URLSearchParams({
    apiKey: cfg.publishableKey,
    baseCurrencyCode: base.code,
    baseCurrencyAmount: p.fiatAmount,
  });
  if (p.paymentMethod) search.set('paymentMethod', p.paymentMethod);

  const res = await fetch(
    `${cfg.apiBaseUrl}/v3/currencies/${encodeURIComponent(quote.code)}/buy_quote?${search.toString()}`,
    { headers: { accept: 'application/json' } },
  );

  if (!res.ok) throw await readError(res);
  return parseQuote(await res.json());
}

/**
 * The MoonPay buy transaction, flattened to the fields this platform acts on.
 *
 * Shared by the webhook path and the reconciliation path so both produce the
 * same shape and flow through the same transition logic - two paths diverge and
 * one of them will be wrong.
 */
export interface MoonPayTransaction {
  id: string;
  status: string | null;
  failureReason: string | null;
  /** Our order reference, echoed back from the widget URL. */
  externalTransactionId: string | null;
  externalCustomerId: string | null;
  customerId: string | null;
  /** Where MoonPay actually delivered. Must equal our approved destination. */
  walletAddress: string | null;
  walletAddressTag: string | null;
  /** On-chain transaction hash once delivery has happened. */
  cryptoTransactionId: string | null;
  /** JSON number. Rendered to a decimal string by the caller, never floated. */
  quoteCurrencyAmount: number | null;
  baseCurrencyAmount: number | null;
  /** MoonPay's own currency ids; the human codes live on nested objects. */
  currencyCode: string | null;
  baseCurrencyCode: string | null;
  country: string | null;
  createdAt: string | null;
  /** Drives ordering and deduplication. MoonPay events carry no event id. */
  updatedAt: string | null;
  stages: { stage: string | null; status: string | null; failureReason: string | null }[] | null;
}

function parseStages(v: unknown): MoonPayTransaction['stages'] {
  if (!Array.isArray(v)) return null;
  return v.filter(isRecord).map((s) => ({
    stage: str(s['stage']),
    status: str(s['status']),
    failureReason: str(s['failureReason']),
  }));
}

/**
 * Read a MoonPay buy transaction into our shape.
 *
 * Accepts either a webhook envelope (`{ type, data: {...} }`) or a bare
 * transaction object, because the reconciliation path fetches transactions
 * directly from the API and must produce the same result as the webhook path.
 */
export function parseTransaction(payload: Record<string, unknown>): MoonPayTransaction {
  const tx = isRecord(payload['data']) ? payload['data'] : payload;

  // The human-readable codes sit on the nested currency objects; the top-level
  // `currencyId` / `baseCurrencyId` are MoonPay UUIDs and useless to us.
  const currency = isRecord(tx['currency']) ? tx['currency'] : {};
  const baseCurrency = isRecord(tx['baseCurrency']) ? tx['baseCurrency'] : {};

  return {
    id: str(tx['id']) ?? '',
    status: str(tx['status']),
    failureReason: str(tx['failureReason']),
    externalTransactionId: str(tx['externalTransactionId']),
    externalCustomerId: str(tx['externalCustomerId']) ?? str(payload['externalCustomerId']),
    customerId: str(tx['customerId']),
    walletAddress: str(tx['walletAddress']),
    walletAddressTag: str(tx['walletAddressTag']),
    cryptoTransactionId: str(tx['cryptoTransactionId']),
    quoteCurrencyAmount: num(tx['quoteCurrencyAmount']),
    baseCurrencyAmount: num(tx['baseCurrencyAmount']),
    currencyCode: str(currency['code']),
    baseCurrencyCode: str(baseCurrency['code']),
    country: str(tx['country']),
    createdAt: str(tx['createdAt']),
    updatedAt: str(tx['updatedAt']),
    stages: parseStages(tx['stages']),
  };
}

/**
 * Look a transaction up by our own reference.
 *
 * This is the reconciliation entry point: when a webhook never arrives, the
 * provider's own record - not our belief about it - is the tiebreaker. Returns
 * null on 404, because "the customer never started" is a normal outcome and not
 * an error worth throwing over.
 */
export async function fetchTransactionByExternalId(
  cfg: MoonPayConfig,
  reference: string,
): Promise<MoonPayTransaction | null> {
  const res = await fetch(
    `${cfg.apiBaseUrl}/v1/transactions/ext/${encodeURIComponent(reference)}?apiKey=${encodeURIComponent(cfg.publishableKey)}`,
    { headers: { accept: 'application/json' } },
  );

  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res);

  const body: unknown = await res.json();
  // MoonPay returns an array for this route when more than one transaction
  // shares an external id; take the most recently updated.
  if (Array.isArray(body)) {
    const rows = body.filter(isRecord);
    if (rows.length === 0) return null;
    const newest = rows.reduce((a, b) => ((str(b['updatedAt']) ?? '') > (str(a['updatedAt']) ?? '') ? b : a));
    return parseTransaction(newest);
  }

  if (!isRecord(body)) throw new MoonPayApiError('Malformed transaction response', 502, null, null);
  return parseTransaction(body);
}
