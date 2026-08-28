/**
 * MoonPay Commerce (Helio) sandbox probe — answers ONE question:
 *
 *   Can a customer pay by CARD and have us receive native BTC?
 *
 * That combination is documented nowhere (see docs/moonpay-commerce-assessment.md
 * §5.2). Both halves are confirmed independently — the checkout takes cards, and
 * BTC is PAYMENT_RECIPIENT-capable — but nothing says they work together. It is
 * plausible the card on-ramp only settles into stablecoins on EVM/SVM chains.
 *
 * This script does not migrate anything and touches no existing code. It creates
 * one sandbox pay link and hands you a URL to open. If the checkout shows a
 * "Pay with card" option, the answer is yes.
 *
 *   1. Create a sandbox account at https://app.dev.hel.io (you must do this;
 *      see docs/moonpay-commerce-assessment.md §6)
 *   2. Add a BTC wallet under Settings -> Wallets
 *   3. Dashboard -> Developer -> API -> generate keys
 *   4. HELIO_API_KEY=<public key> node scripts/commerce-probe.mjs
 *
 * Dependency-free on purpose, matching scripts/smoke.mjs — this must run from
 * anywhere, including a box with no workspace install.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readEnvFile(url) {
  const out = {};
  let text;
  try {
    text = readFileSync(fileURLToPath(url), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = readEnvFile(new URL('../.env', import.meta.url));
const API_KEY = process.env.HELIO_API_KEY ?? fileEnv.HELIO_API_KEY;
// Several endpoints (e.g. /v1/wallet/all) require BOTH the public key as an
// `apiKey` query parameter AND the secret as a bearer token - they answer
// {"message":"Please provide apiKey and bearer token"} with only one of them.
const SECRET_KEY = process.env.HELIO_SECRET_KEY ?? fileEnv.HELIO_SECRET_KEY;

// Sandbox by default. Override only when you deliberately want production.
const BASE = process.env.HELIO_BASE_URL ?? 'https://api.dev.hel.io';
const APP = BASE.includes('dev') ? 'https://app.dev.hel.io' : 'https://app.hel.io';

if (!API_KEY) {
  console.error(`
HELIO_API_KEY not set.

  1. Sign up:  https://app.dev.hel.io          (sandbox, free, self-serve)
  2. Settings -> Wallets  -> add a BTC wallet
  3. Developer -> API     -> generate keys
  4. Re-run:   HELIO_API_KEY=<public key> node scripts/commerce-probe.mjs

The SECRET key is not needed for this probe - paylink creation authenticates
with the public key as an "apiKey" query parameter.
`);
  process.exit(1);
}

/**
 * Currencies are resolved live by SYMBOL below, never by hardcoded id - ids
 * differ between sandbox and production (USD is 637ca18d... in production but
 * 63777da9... in sandbox), so a hardcoded id silently targets the wrong thing.
 */
const WANT_PRICING = process.env.PRICING_SYMBOL ?? 'USD';

/**
 * The recipient asset under test. BTC by default.
 *
 * CONTROL TEST: a negative BTC result is ambiguous - it could mean card->BTC is
 * unsupported (the real answer we want), or that the card flow is simply not
 * wired into devnet at all. Re-run with a stablecoin to tell those apart:
 *
 *   RECIPIENT_SYMBOL=USDC node scripts/commerce-probe.mjs
 *
 *   card appears for USDC but not BTC -> real BTC limitation. Decisive.
 *   card appears for neither          -> devnet limitation. Says nothing about BTC.
 *
 * See docs/commerce-sandbox-setup.md "Read this before you start".
 */
const WANT_RECIPIENT = process.env.RECIPIENT_SYMBOL ?? 'BTC';

/**
 * Helio prices in the currency's OWN base units, and those decimals are NOT the
 * familiar 2. USD and EUR are 6; GBP, AUD and LKR are 9. This platform's
 * FIAT_DECIMALS says 2 for all of them, so any real integration needs a
 * conversion layer here - see docs/moonpay-commerce-assessment.md §3.
 */
function toBaseUnits(amount, decimals) {
  const [whole = '0', frac = ''] = String(amount).split('.');
  if (frac.length > decimals) throw new Error(`${amount} exceeds ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, '0')).toString();
}

async function api(path, init = {}) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(SECRET_KEY ? { authorization: `Bearer ${SECRET_KEY}` } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

function fail(msg, detail) {
  console.error(`\n  FAIL  ${msg}`);
  if (detail !== undefined) console.error(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
}

async function main() {
  console.log(`\nMoonPay Commerce probe against ${BASE}\n`);

  // --- 1. currencies ------------------------------------------------------
  const cur = await api('/v1/currency/all');
  if (!cur.ok) fail(`could not list currencies (HTTP ${cur.status})`, cur.body);
  const currencies = Array.isArray(cur.body) ? cur.body : (cur.body.currencies ?? cur.body.data ?? []);
  console.log(`  ok    ${currencies.length} currencies visible`);

  const usd = currencies.find((c) => c.type === 'FIAT' && c.symbol === WANT_PRICING);
  if (!usd) fail(`no ${WANT_PRICING} pricing currency in this environment`);

  // For BTC insist on the NATIVE asset: the catalogue also carries cbBTC, BBTC,
  // BTCB and tBTC, which are wrapped tokens on EVM chains with 0x addresses.
  // Sending one of those to a native Bitcoin address loses the funds.
  const btc =
    WANT_RECIPIENT === 'BTC'
      ? currencies.find((c) => c.symbol === 'BTC' && c.mintAddress === 'btc')
      : currencies.find((c) => c.symbol === WANT_RECIPIENT && (c.features ?? []).includes('PAYMENT_RECIPIENT'));

  if (!btc) {
    fail(
      `${WANT_RECIPIENT} not available as a recipient in this environment`,
      WANT_RECIPIENT === 'BTC'
        ? 'native BTC absent (wrapped variants like cbBTC/BBTC/BTCB do not count). This is itself a finding - record it.'
        : `no PAYMENT_RECIPIENT-capable ${WANT_RECIPIENT} found`,
    );
  }

  console.log(`  ok    ${WANT_PRICING} pricing currency  id=${usd.id} decimals=${usd.decimals}`);
  console.log(`  ok    ${WANT_RECIPIENT} recipient        id=${btc.id} decimals=${btc.decimals} chain=${btc.blockchain?.name}`);

  const feats = btc.features ?? [];
  if (!feats.includes('PAYMENT_RECIPIENT')) {
    fail(`${WANT_RECIPIENT} is NOT PAYMENT_RECIPIENT-capable here`, feats);
  }
  console.log(`  ok    ${WANT_RECIPIENT} features: ${feats.join(', ')}`);

  // Present in production, absent in sandbox. Worth surfacing rather than
  // discovering later that the Binance leg was never testable.
  if (!feats.includes('WITHDRAWAL_DESTINATION')) {
    console.log(
      `  note  ${WANT_RECIPIENT} has NO WITHDRAWAL_DESTINATION here - the withdraw-to-Binance\n` +
        `        leg cannot be tested in this environment. Expected in sandbox; see\n` +
        `        docs/moonpay-commerce-assessment.md §5.2a.`,
    );
  }

  // --- 2. wallets ---------------------------------------------------------
  const wal = await api('/v1/wallet/all');
  if (!wal.ok) fail(`could not list wallets (HTTP ${wal.status})`, wal.body);
  const wallets = Array.isArray(wal.body) ? wal.body : (wal.body.wallets ?? wal.body.data ?? []);

  if (wallets.length === 0) {
    fail('no wallets configured', 'Add a BTC wallet in the dashboard: Settings -> Wallets');
  }
  console.log(`\n  ok    ${wallets.length} wallet(s) configured:`);
  for (const w of wallets) {
    console.log(`          ${String(w.blockchainEngineType).padEnd(6)} ${String(w.walletCategory ?? '').padEnd(10)} ${w.name ?? ''}  id=${w.id}`);
  }

  const wantEngine = btc.blockchain?.engine?.type;
  const btcWallet = wallets.find((w) => w.blockchainEngineType === wantEngine);
  if (!btcWallet) {
    fail(
      `no ${wantEngine} wallet configured (needed for ${WANT_RECIPIENT})`,
      'Add one in the dashboard under Settings -> Wallets, then re-run. ' +
        'For sandbox use a TESTNET address you control - not a Binance address ' +
        '(Binance issues no testnet BTC addresses; see the assessment doc §5.2).',
    );
  }
  console.log(`\n  ok    ${wantEngine} wallet found: id=${btcWallet.id}`);

  // --- 3. the actual question --------------------------------------------
  const price = toBaseUnits('30.00', usd.decimals);
  console.log(`\n  ..    creating pay link: 30.00 ${WANT_PRICING} priced (${price} base units) -> ${WANT_RECIPIENT} recipient, card enabled`);

  const created = await api('/v1/paylink/create/api-key', {
    method: 'POST',
    body: JSON.stringify({
      name: `Commerce probe - card to ${WANT_RECIPIENT}`,
      description: `Sandbox probe: $30.00 USD priced, settling to native ${WANT_RECIPIENT}. Tests whether the card on-ramp is offered for a ${WANT_RECIPIENT} recipient. Not a real product - safe to ignore.`,
      price,
      pricingCurrency: usd.id,
      features: {
        // THE flag under test.
        canPayWithCard: true,
        requireEmail: false,
      },
      recipients: [{ currencyId: btc.id, walletId: btcWallet.id }],
    }),
  });

  if (!created.ok) {
    console.error(`\n  FAIL  pay link rejected (HTTP ${created.status})`);
    console.error(`        ${JSON.stringify(created.body)}`);
    console.error(`
  This is a MEANINGFUL result, not just an error. If the rejection names the
  card feature or the BTC recipient, it is evidence that card -> BTC is not a
  supported combination - which is exactly what this probe exists to find out.
  Record the message in docs/moonpay-commerce-assessment.md §5.2.
`);
    process.exit(1);
  }

  const link = created.body;
  console.log(`  ok    pay link created: id=${link.id}`);

  const cardEnabled = link.features?.canPayWithCard;
  console.log(`\n  ${cardEnabled ? 'ok  ' : 'WARN'}  server echoed canPayWithCard=${cardEnabled}`);
  if (cardEnabled === false) {
    console.log(`
  The API accepted the request but turned the card feature OFF. That usually
  means card payment is not available for this recipient currency - strong
  evidence against card -> BTC. Confirm by opening the link below.
`);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────
  OPEN THIS AND LOOK FOR A "Pay with card" OPTION:

    ${APP}/pay/${link.id}

  Card option present  -> card -> ${WANT_RECIPIENT} WORKS. Gate 5.2 cleared.
  Crypto wallet only   -> ambiguous. Re-run the CONTROL TEST before concluding:
                            RECIPIENT_SYMBOL=USDC node scripts/commerce-probe.mjs
                          card for USDC but not BTC -> real BTC limit (decisive)
                          card for neither          -> devnet limit (tells you nothing)

  Then pay it with a test card and confirm funds arrive at your address on a
  block explorer - mempool.space/testnet - the webhook alone is not proof.
────────────────────────────────────────────────────────────────────────
`);
}

main().catch((err) => {
  console.error('\n  FAIL  probe threw:', err.message);
  process.exit(1);
});
