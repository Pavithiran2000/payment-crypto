/**
 * Unit / mock tests for @pp/provider-commerce.
 *
 * Fully OFFLINE - `fetch` is mocked, so this runs anywhere with no credentials
 * and no network. That matters: the provider's riskiest logic is arithmetic and
 * signature verification, and neither should need a live account to test.
 *
 *   pnpm build            # the provider must be compiled first
 *   node scripts/commerce-check.mjs
 *
 * What this covers, roughly in order of how much damage a bug would do:
 *
 *   1. Money conversion   - a wrong factor here undercharges by 10,000x
 *   2. Webhook verification - the only thing standing between a forged payload
 *                             and an order marked paid
 *   3. Config safety      - the secret is a transmitted bearer token here, so a
 *                           wrong host is an exfiltration, not a 404
 *   4. Currency resolution - native BTC vs wrapped BTC is a fund-loss decision
 *   5. Status mapping     - unknown must escalate, never assume success
 *
 * Dependency-free and relative-imported, matching scripts/erasure-check.mjs.
 */
import { createHmac } from 'node:crypto';

const C = await import('../packages/providers/commerce/dist/index.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    failed++;
  }
}

/** Assert a call throws, and optionally that the message matches. */
function throws(name, fn, match) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, match ? new RegExp(match, 'i').test(err.message) : true, err.message);
  }
}

// ===========================================================================
console.log('\nmoney conversion — the highest-consequence logic here');
// ===========================================================================
// This platform stores fiat as minor units at 2 decimals. Commerce prices in
// each currency's own base units: USD/EUR are 6, GBP/AUD/LKR are 9. Getting the
// factor wrong is not a rounding error, it is three to seven orders of magnitude.

check('$30.00 (2dp) -> USD 6dp', C.toCommerceBaseUnits(3000n, 2, 6) === '30000000', C.toCommerceBaseUnits(3000n, 2, 6));
check('$5.00 (2dp) -> USD 6dp', C.toCommerceBaseUnits(500n, 2, 6) === '5000000', C.toCommerceBaseUnits(500n, 2, 6));
check('LKR 30.00 (2dp) -> 9dp', C.toCommerceBaseUnits(3000n, 2, 9) === '30000000000', C.toCommerceBaseUnits(3000n, 2, 9));
check('GBP 7000.00 minimum (2dp) -> 9dp', C.toCommerceBaseUnits(700000n, 2, 9) === '7000000000000');
check('zero stays zero', C.toCommerceBaseUnits(0n, 2, 6) === '0');
check('same decimals is identity', C.toCommerceBaseUnits(1234n, 6, 6) === '1234');

// A float-based implementation loses precision well below this. bigint does not.
const huge = 999999999999n; // 9,999,999,999.99 in minor units
check(
  'very large amount stays exact (no float drift)',
  C.toCommerceBaseUnits(huge, 2, 9) === (huge * 10000000n).toString(),
  C.toCommerceBaseUnits(huge, 2, 9),
);

check('round-trips exactly (USD)', C.fromCommerceBaseUnits(C.toCommerceBaseUnits(3000n, 2, 6), 6, 2) === 3000n);
check('round-trips exactly (LKR)', C.fromCommerceBaseUnits(C.toCommerceBaseUnits(3000n, 2, 9), 9, 2) === 3000n);

// Narrowing must refuse rather than silently round someone's money.
throws('refuses lossy narrowing instead of rounding', () => C.toCommerceBaseUnits(3001n, 2, 1), 'precision');
throws('refuses lossy narrowing on the way back', () => C.fromCommerceBaseUnits('12345', 6, 2), 'precision');
check('lossless narrowing is allowed', C.toCommerceBaseUnits(300000n, 6, 2) === '30', C.toCommerceBaseUnits(300000n, 6, 2));
throws('rejects non-integer decimals', () => C.toCommerceBaseUnits(1n, 2.5, 6), 'integer');
throws('rejects negative decimals', () => C.toCommerceBaseUnits(1n, -1, 6), 'negative');
throws('rejects a non-numeric base-unit string', () => C.fromCommerceBaseUnits('12.5', 6, 2), 'integer');

// ===========================================================================
console.log('\nwebhook verification');
// ===========================================================================
const TOKEN = 'shared_token_for_tests';
const bodyObj = { event: 'COMPLETED', id: 'evt_abc', transactionId: 'tx_1' };
const raw = Buffer.from(JSON.stringify(bodyObj));
const sign = (buf, key = TOKEN) => createHmac('sha256', key).update(buf).digest('hex');
const hdrs = (sig, token = TOKEN) => ({ 'x-signature': sig, authorization: `Bearer ${token}` });

const ok = C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: hdrs(sign(raw)) });
check('accepts a correctly signed delivery', ok.valid === true, ok.valid ? '' : ok.reason);
check('extracts the event type', ok.valid && ok.eventType === 'COMPLETED');
check('derives a stable event id', ok.valid && ok.eventId === 'COMPLETED:evt_abc', ok.valid ? ok.eventId : '');

// The single most important negative: a body altered in flight must not verify.
const tamperedRaw = Buffer.from(JSON.stringify({ ...bodyObj, amount: '999999' }));
const tampered = C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: tamperedRaw, headers: hdrs(sign(raw)) });
check('rejects a tampered body', tampered.valid === false, tampered.valid ? '' : tampered.reason);

const wrongKey = C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: hdrs(sign(raw, 'other_token')) });
check('rejects a signature made with the wrong token', wrongKey.valid === false);

check(
  'rejects a missing X-Signature',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: { authorization: `Bearer ${TOKEN}` } }).valid === false,
);
check(
  'rejects a missing bearer by default',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: { 'x-signature': sign(raw) } }).valid === false,
);
check(
  'rejects a mismatched bearer',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: hdrs(sign(raw), 'not_the_token') }).valid === false,
);
check(
  'bearer check can be disabled explicitly',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: { 'x-signature': sign(raw) }, requireBearer: false }).valid === true,
);
check(
  'rejects when no shared token is configured',
  C.verifyCommerceWebhook({ sharedToken: '', rawBody: raw, headers: hdrs(sign(raw)) }).valid === false,
);

// Garbage in the signature header must not throw - a crash in a webhook handler
// is a denial of service reachable by anyone who can POST to the endpoint.
for (const bad of ['', 'not-hex', 'zz', 'deadbeef', '../../etc/passwd', 'a'.repeat(1000)]) {
  const r = C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: hdrs(bad) });
  if (r.valid !== false) { check(`rejects malformed signature ${JSON.stringify(bad.slice(0, 12))}`, false); break; }
}
check('rejects every malformed signature without throwing', true);

const notJson = Buffer.from('this is not json');
check(
  'rejects a non-JSON body (after signature passes)',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: notJson, headers: hdrs(sign(notJson)) }).valid === false,
);
const jsonArray = Buffer.from('[1,2,3]');
check(
  'rejects a JSON array body',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: jsonArray, headers: hdrs(sign(jsonArray)) }).valid === false,
);

// Node lowercases incoming header names, but a caller passing them through a
// map should not silently fail closed on casing.
check(
  'header lookup is case-insensitive',
  C.verifyCommerceWebhook({ sharedToken: TOKEN, rawBody: raw, headers: { 'X-Signature': sign(raw), Authorization: `Bearer ${TOKEN}` } }).valid === true,
);

// ===========================================================================
console.log('\nconfig safety');
// ===========================================================================
check('defaults to sandbox, never production', C.resolveCommerceConfig({ publicKey: 'a', secretKey: 'b' }).mode === 'sandbox');
check(
  'production is opt-in and detected',
  C.resolveCommerceConfig({ publicKey: 'a', secretKey: 'b', apiBaseUrl: C.COMMERCE_API_BASE_URL_LIVE }).mode === 'live',
);
check(
  'isLive reflects the mode',
  C.isLive(C.resolveCommerceConfig({ publicKey: 'a', secretKey: 'b', apiBaseUrl: C.COMMERCE_API_BASE_URL_LIVE })) === true,
);
// The secret is sent as a bearer token on every call, so an unknown host is an
// exfiltration risk rather than a mere misconfiguration.
throws('refuses an unrecognised API host', () => C.resolveCommerceConfig({ publicKey: 'a', secretKey: 'b', apiBaseUrl: 'https://evil.example.com' }), 'unrecognised');
throws('refuses a missing public key', () => C.resolveCommerceConfig({ publicKey: '', secretKey: 'b' }), 'public key');
throws('refuses a missing secret key', () => C.resolveCommerceConfig({ publicKey: 'a', secretKey: '' }), 'secret key');
check(
  'trailing slash on the base URL is tolerated',
  C.resolveCommerceConfig({ publicKey: 'a', secretKey: 'b', apiBaseUrl: `${C.COMMERCE_API_BASE_URL_LIVE}/` }).mode === 'live',
);

const sandboxCfg = C.resolveCommerceConfig({ publicKey: 'pub', secretKey: 'sec' });
check('sandbox checkout URL points at the sandbox app', C.payLinkUrl(sandboxCfg, 'abc') === 'https://app.dev.hel.io/pay/abc', C.payLinkUrl(sandboxCfg, 'abc'));
const liveCfg = C.resolveCommerceConfig({ publicKey: 'pub', secretKey: 'sec', apiBaseUrl: C.COMMERCE_API_BASE_URL_LIVE });
check('live checkout URL points at the live app', C.payLinkUrl(liveCfg, 'abc') === 'https://app.hel.io/pay/abc');
check('pay link ids are URL-encoded', C.payLinkUrl(liveCfg, 'a/b?c') === 'https://app.hel.io/pay/a%2Fb%3Fc', C.payLinkUrl(liveCfg, 'a/b?c'));

// ===========================================================================
console.log('\ncurrency resolution — native BTC vs wrapped is a fund-loss decision');
// ===========================================================================
const CATALOGUE = [
  { id: 'usd1', symbol: 'USD', name: 'US Dollar', type: 'FIAT', decimals: 6, features: ['PAYMENT_PRICING'] },
  { id: 'lkr1', symbol: 'LKR', name: 'Sri Lankan Rupee', type: 'FIAT', decimals: 9, features: ['PAYMENT_PRICING'] },
  {
    id: 'btc1', symbol: 'BTC', name: 'Bitcoin', decimals: 8, mintAddress: 'btc', isNative: true,
    features: ['PAYMENT_PRICING', 'PAYMENT_RECIPIENT', 'WITHDRAWAL_DESTINATION'],
    blockchain: { name: 'BITCOIN', engine: { type: 'BTC' } },
  },
  // Wrapped impostors - EVM tokens that must never satisfy a BTC lookup.
  { id: 'cbbtc', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, mintAddress: '0xcbB7', features: ['PAYMENT_RECIPIENT'], blockchain: { name: 'BASE', engine: { type: 'EVM' } } },
  { id: 'btcb', symbol: 'BTCB', name: 'BTCB Token', decimals: 18, mintAddress: '0x7130', features: ['PAYMENT_RECIPIENT'], blockchain: { name: 'BSC', engine: { type: 'EVM' } } },
  { id: 'usdc1', symbol: 'USDC', name: 'USD Coin', decimals: 6, mintAddress: 'EPjF', features: ['PAYMENT_RECIPIENT'], blockchain: { name: 'SOL', engine: { type: 'SOL' } } },
  { id: 'pricing_only', symbol: 'XYZ', name: 'Pricing Only', decimals: 6, features: ['PAYMENT_PRICING'], blockchain: { name: 'ETH', engine: { type: 'EVM' } } },
];

check('resolves USD by symbol', C.findFiatCurrency(CATALOGUE, 'USD')?.id === 'usd1');
check('fiat lookup is case-insensitive', C.findFiatCurrency(CATALOGUE, 'usd')?.id === 'usd1');
check('resolves LKR with its 9 decimals', C.findFiatCurrency(CATALOGUE, 'LKR')?.decimals === 9);
check('unknown fiat resolves to null', C.findFiatCurrency(CATALOGUE, 'XXX') === null);
// A crypto asset must never satisfy a fiat lookup.
check('BTC is not returned as a fiat pricing currency', C.findFiatCurrency(CATALOGUE, 'BTC') === null);

const btc = C.findCryptoCurrency(CATALOGUE, 'BTC');
check('resolves NATIVE BTC only', btc?.id === 'btc1', btc?.id);
check('native BTC is on the BITCOIN chain', btc?.blockchain?.name === 'BITCOIN');
check('does NOT return a wrapped BTC variant', btc?.mintAddress === 'btc');
check('resolves USDC', C.findCryptoCurrency(CATALOGUE, 'USDC')?.id === 'usdc1');
check('will not return a pricing-only currency as a recipient', C.findCryptoCurrency(CATALOGUE, 'XYZ') === null);
check('unknown crypto resolves to null', C.findCryptoCurrency(CATALOGUE, 'NOPE') === null);

// Same-symbol catalogue with ONLY wrapped entries must not resolve to one.
const wrappedOnly = CATALOGUE.filter((c) => c.id !== 'btc1');
check('BTC lookup returns null when only wrapped variants exist', C.findCryptoCurrency(wrappedOnly, 'BTC') === null);

check('assertCanReceive passes for BTC', (() => { try { C.assertCanReceive(btc); return true; } catch { return false; } })());
throws('assertCanReceive rejects a pricing-only currency', () => C.assertCanReceive(CATALOGUE.find((c) => c.id === 'pricing_only')), 'PAYMENT_RECIPIENT');

// ===========================================================================
console.log('\nwallet matching');
// ===========================================================================
const WALLETS = [
  { id: 'w_sol', publicKey: 'D5Jh', blockchainEngineType: 'SOL', walletCategory: 'CONNECTED' },
  { id: 'w_btc', publicKey: 'tb1q', blockchainEngineType: 'BTC', walletCategory: 'PAYOUT', name: 'payout' },
];
check('matches the BTC wallet to the BTC currency', C.findWalletForCurrency(WALLETS, btc)?.id === 'w_btc');
check('matches the SOL wallet to a SOL currency', C.findWalletForCurrency(WALLETS, CATALOGUE.find((c) => c.id === 'usdc1'))?.id === 'w_sol');
// The real bug this guards: pairing BTC with a Solana wallet, which the API
// rejects with "The currency and wallet blockchain do not match".
check('does NOT cross-match BTC to a Solana wallet', C.findWalletForCurrency([WALLETS[0]], btc) === null);
check('returns null when a currency has no chain engine', C.findWalletForCurrency(WALLETS, { id: 'x', symbol: 'X', decimals: 2, name: 'X' }) === null);

// ===========================================================================
console.log('\nstatus mapping — unknown must escalate, never assume success');
// ===========================================================================
check('COMPLETED -> COMPLETED', C.mapTransactionStatus('COMPLETED') === 'COMPLETED');
check('SUCCESS -> COMPLETED', C.mapTransactionStatus('SUCCESS') === 'COMPLETED');
check('PAID -> COMPLETED', C.mapTransactionStatus('PAID') === 'COMPLETED');
check('mapping is case-insensitive', C.mapTransactionStatus('completed') === 'COMPLETED');
check('PENDING -> PAYMENT_PENDING', C.mapTransactionStatus('PENDING') === 'PAYMENT_PENDING');
check('PROCESSING -> PAYMENT_CONFIRMED', C.mapTransactionStatus('PROCESSING') === 'PAYMENT_CONFIRMED');
check('FAILED -> PAYMENT_FAILED', C.mapTransactionStatus('FAILED') === 'PAYMENT_FAILED');
check('EXPIRED -> PAYMENT_FAILED', C.mapTransactionStatus('EXPIRED') === 'PAYMENT_FAILED');
// The safety property. A status Commerce adds later must NOT be read as success.
check('an unknown status maps to null (caller escalates)', C.mapTransactionStatus('SOME_NEW_STATUS_2027') === null);
check('null status maps to null', C.mapTransactionStatus(null) === null);
check('empty status maps to null', C.mapTransactionStatus('') === null);

check('event id prefers a provider id', C.deriveEventId({ event: 'PAID', id: 'e1' }, 'sha') === 'PAID:e1');
check('event id falls back to the body hash', C.deriveEventId({ event: 'PAID' }, 'abc123') === 'PAID:sha256:abc123');
check('event id handles a missing event name', C.deriveEventId({ id: 'e1' }, 'sha') === 'unknown:e1');
// Two genuinely different events must not collide into one dedupe key.
check(
  'different events produce different ids',
  C.deriveEventId({ event: 'PAID', id: 'e1' }, 'x') !== C.deriveEventId({ event: 'FAILED', id: 'e1' }, 'x'),
);

// ===========================================================================
console.log('\nAPI layer — mocked fetch, no network');
// ===========================================================================
const realFetch = globalThis.fetch;
let lastRequest = null;

function mockFetch(status, body) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

const apiCfg = C.resolveCommerceConfig({ publicKey: 'PUBKEY', secretKey: 'SECRET' });

try {
  mockFetch(200, CATALOGUE);
  const cur = await C.fetchCurrencies(apiCfg);
  check('fetchCurrencies returns the catalogue', cur.length === CATALOGUE.length);
  check('public key travels as an apiKey query parameter', lastRequest.url.includes('apiKey=PUBKEY'), lastRequest.url);
  // The catalogue endpoint is public; sending the bearer needlessly widens exposure.
  check('currencies call sends NO bearer', !lastRequest.init.headers.authorization);

  mockFetch(200, WALLETS);
  await C.fetchWallets(apiCfg);
  check('wallets call DOES send the bearer', lastRequest.init.headers.authorization === 'Bearer SECRET');

  // Both credentials are required together - undocumented, found by hitting it.
  mockFetch(401, { message: 'Please provide apiKey and bearer token', code: 401 });
  let apiErr = null;
  try { await C.fetchWallets(apiCfg); } catch (e) { apiErr = e; }
  check('surfaces a 401 as CommerceApiError', apiErr?.name === 'CommerceApiError');
  check('preserves the provider message', apiErr?.message.includes('apiKey and bearer'), apiErr?.message);
  check('preserves the HTTP status', apiErr?.httpStatus === 401);
  check('preserves the provider code', apiErr?.commerceCode === 401);

  mockFetch(200, { id: 'pl_1', name: 'X', features: { canPayWithCard: true } });
  const link = await C.createPayLink(apiCfg, {
    name: 'Test', price: '5000000', pricingCurrencyId: 'usd1',
    recipientCurrencyId: 'btc1', recipientWalletId: 'w_btc', canPayWithCard: true,
  });
  check('createPayLink returns the id', link.id === 'pl_1');
  check('createPayLink builds the checkout URL', link.url === 'https://app.dev.hel.io/pay/pl_1', link.url);
  check('createPayLink reports the echoed card flag', link.canPayWithCard === true);
  const sent = JSON.parse(lastRequest.init.body);
  check('sends price as an integer string', sent.price === '5000000');
  check('sends the recipient as currency+wallet', sent.recipients[0].currencyId === 'btc1' && sent.recipients[0].walletId === 'w_btc');
  check('sends canPayWithCard in features', sent.features.canPayWithCard === true);

  // A server that silently downgrades the card flag must be visible, not assumed.
  mockFetch(200, { id: 'pl_2', features: { canPayWithCard: false } });
  const downgraded = await C.createPayLink(apiCfg, {
    name: 'T', price: '1', pricingCurrencyId: 'usd1', recipientCurrencyId: 'btc1', recipientWalletId: 'w_btc', canPayWithCard: true,
  });
  check('reports a server-side card downgrade rather than hiding it', downgraded.canPayWithCard === false);

  mockFetch(200, { noId: true });
  let noIdErr = null;
  try { await C.createPayLink(apiCfg, { name: 'T', price: '1', pricingCurrencyId: 'u', recipientCurrencyId: 'c', recipientWalletId: 'w' }); } catch (e) { noIdErr = e; }
  check('throws when the response has no pay link id', noIdErr?.name === 'CommerceApiError');
} finally {
  globalThis.fetch = realFetch;
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
