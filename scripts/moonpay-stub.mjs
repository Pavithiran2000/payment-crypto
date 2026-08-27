/**
 * A minimal stand-in for the two MoonPay endpoints this integration calls.
 *
 * MoonPay keys are gated behind account approval, so without this the
 * end-to-end suite could not run at all until MoonPay says yes - and the first
 * time anyone exercised order creation would be against real credentials.
 *
 * It is deliberately *not* a mock inside the API process. The real HTTP client,
 * the real query-string encoding and the real error handling all run; only
 * MoonPay's side is replaced. It asserts the parameters this integration
 * depends on, so a regression that drops `lockAmount` or the wallet address
 * fails here rather than in the wild, where the symptom is a customer changing
 * the amount or redirecting their own settlement.
 *
 * Reachable only because MOONPAY_API_BASE_URL points at it; apps/api refuses
 * that override whenever the keys are live.
 *
 * Endpoints:
 *   GET /v3/currencies/:code/buy_quote
 *   GET /v1/transactions/ext/:externalTransactionId
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PORT = 4599;

/** MoonPay's published per-currency card minimums, as of 2026-08-23. */
const MINIMUMS = { usd: 20, eur: 20, gbp: 20, aud: 35, lkr: 7000 };

/** Codes the stub will quote. Anything else is a 404, as MoonPay returns. */
const CURRENCIES = new Set(['usdc_polygon', 'usdt_polygon', 'usdc', 'usdt']);

/**
 * A reserved-documentation IP the suite uses to trigger a geography rejection.
 * MoonPay does the same thing behind the scenes off the real client IP.
 */
export const UNSUPPORTED_IP = '203.0.113.7';

/**
 * @param {{ port?: number }} [opts]
 * @returns {Promise<{ url: string, quotes: object[], transactions: Map<string, object>, close: () => Promise<void> }>}
 */
export async function startMoonPayStub(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  /** Every quote request the API made, for assertions. */
  const quotes = [];
  /** Transactions the suite has declared, keyed by externalTransactionId. */
  const transactions = new Map();

  const server = createServer((req, res) => {
    const send = (status, payload) => {
      const json = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
      });
      res.end(json);
    };

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const apiKey = url.searchParams.get('apiKey');

    // MoonPay authenticates these routes with the PUBLISHABLE key. A secret key
    // arriving here would mean the integration leaked one into a URL.
    if (apiKey && apiKey.startsWith('sk_')) {
      return send(400, {
        errors: [],
        moonPayErrorCode: 'stub_secret_key_in_url',
        message: 'a secret key must never appear in a URL',
        type: 'BadRequestError',
      });
    }
    if (!apiKey || !apiKey.startsWith('pk_')) {
      return send(401, {
        errors: [],
        moonPayErrorCode: '4_SYS_NOT_AUTHORIZED',
        message: 'Not authorized',
        type: 'UnauthorizedError',
      });
    }

    const quote = /^\/v3\/currencies\/([^/]+)\/buy_quote$/.exec(url.pathname);
    if (req.method === 'GET' && quote) {
      const code = decodeURIComponent(quote[1]);
      const baseCurrencyCode = url.searchParams.get('baseCurrencyCode') ?? '';
      const baseCurrencyAmount = Number(url.searchParams.get('baseCurrencyAmount'));
      quotes.push({ code, baseCurrencyCode, baseCurrencyAmount, paymentMethod: url.searchParams.get('paymentMethod') });

      if (!CURRENCIES.has(code)) {
        return send(404, {
          errors: [],
          moonPayErrorCode: '4_SYS_NOT_FOUND',
          message: 'No resource matches the given identifier.',
          type: 'NotFoundError',
        });
      }

      const minimum = MINIMUMS[baseCurrencyCode];
      if (minimum === undefined) {
        return send(400, {
          errors: [],
          moonPayErrorCode: 'stub_unsupported_base_currency',
          message: `Base currency ${baseCurrencyCode} is not supported`,
          type: 'BadRequestError',
        });
      }
      if (!Number.isFinite(baseCurrencyAmount) || baseCurrencyAmount < minimum) {
        return send(400, {
          errors: [],
          moonPayErrorCode: 'stub_below_minimum',
          message: `Minimum purchase amount is ${minimum} ${baseCurrencyCode.toUpperCase()}`,
          type: 'BadRequestError',
        });
      }

      // Flat fee plus a network fee, close enough in shape to MoonPay's real
      // response that the parsing code is exercised for real.
      const feeAmount = 3.99;
      const networkFeeAmount = 0.5;
      const net = Number((baseCurrencyAmount - feeAmount - networkFeeAmount).toFixed(2));

      return send(200, {
        accountId: '00000000-0000-0000-0000-000000000000',
        baseCurrencyCode,
        baseCurrencyAmount,
        quoteCurrencyCode: code,
        // Stablecoin, so ~1:1 net of fees. Sent as a JSON number, exactly as
        // MoonPay does - which is what the decimal-string handling exists for.
        quoteCurrencyAmount: net,
        quoteCurrencyPrice: 1,
        paymentMethod: url.searchParams.get('paymentMethod'),
        feeAmount,
        extraFeePercentage: 0,
        extraFeeAmount: 0,
        networkFeeAmount,
        totalAmount: baseCurrencyAmount,
        expiresIn: 1800,
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      });
    }

    const byExternal = /^\/v1\/transactions\/ext\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && byExternal) {
      const reference = decodeURIComponent(byExternal[1]);
      const found = transactions.get(reference);
      return found
        ? send(200, found)
        : send(404, {
            errors: [],
            moonPayErrorCode: '4_SYS_NOT_FOUND',
            message: 'No resource matches the given identifier.',
            type: 'NotFoundError',
          });
    }

    return send(404, {
      errors: [],
      moonPayErrorCode: 'stub_unstubbed_route',
      message: `unstubbed route ${req.method} ${url.pathname}`,
      type: 'NotFoundError',
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    quotes,
    transactions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Shape a buy transaction the way MoonPay's webhook `data` object looks. */
export function buyTransaction({
  id = `mp_${randomUUID()}`,
  reference,
  status,
  failureReason = null,
  walletAddress,
  quoteCurrencyAmount = null,
  cryptoTransactionId = null,
  stages = null,
  updatedAt = new Date().toISOString(),
} = {}) {
  return {
    id,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt,
    baseCurrencyAmount: 150,
    quoteCurrencyAmount,
    feeAmount: 3.99,
    extraFeeAmount: 0,
    networkFeeAmount: 0.5,
    areFeesIncluded: true,
    paymentMethod: 'credit_debit_card',
    status,
    failureReason,
    walletAddress,
    walletAddressTag: null,
    cryptoTransactionId,
    redirectUrl: null,
    returnUrl: 'https://buy-sandbox.moonpay.com',
    widgetRedirectUrl: null,
    eurRate: 0.92,
    usdRate: 1,
    gbpRate: 0.78,
    currencyId: '1501ea35-9c89-4c1e-ae57-4a19d5a635db',
    currency: { code: 'usdc_polygon', name: 'USD Coin', decimals: 6 },
    baseCurrencyId: '71435a8d-211c-4664-a59e-2a5361a6c5a7',
    baseCurrency: { code: 'usd', name: 'US Dollar', precision: 2 },
    customerId: '00000000-0000-0000-0000-0000000000c0',
    cardId: null,
    bankAccountId: null,
    externalCustomerId: null,
    externalTransactionId: reference,
    country: 'GBR',
    state: null,
    stages,
  };
}

// Runnable on its own (`node scripts/moonpay-stub.mjs`) so the API can be
// developed against it without the smoke suite driving the lifecycle.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const stub = await startMoonPayStub();
  console.log(`moonpay stub listening on ${stub.url}`);
}
