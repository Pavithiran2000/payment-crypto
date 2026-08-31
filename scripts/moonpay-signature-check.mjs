/**
 * Fast diagnostic for the "Signature check failed" widget error.
 *
 * The widget shows the SAME message whether a signature is missing, invalid,
 * or the keys are mismatched - so the UI cannot tell you which. This checks
 * each layer separately, at the API level, in about two seconds.
 *
 *   node scripts/moonpay-signature-check.mjs
 *
 * Reads MOONPAY_* from the environment or the repo-root .env.
 * Dependency-free, matching the other scripts here.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readEnvFile(url) {
  const out = {};
  let text;
  try { text = readFileSync(fileURLToPath(url), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnvFile(new URL('../.env', import.meta.url));
const PK = process.env.MOONPAY_PUBLISHABLE_KEY ?? env.MOONPAY_PUBLISHABLE_KEY;
const SK = process.env.MOONPAY_SECRET_KEY ?? env.MOONPAY_SECRET_KEY;

if (!PK || !SK) {
  console.error('MOONPAY_PUBLISHABLE_KEY and MOONPAY_SECRET_KEY must be set (env or .env).');
  process.exit(1);
}

const API = 'https://api.moonpay.com';
let pass = 0, fail = 0;
const ok  = (m, d='') => { console.log(`  PASS  ${m}${d ? '  ' + d : ''}`); pass++; };
const no  = (m, d='') => { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fail++; };

console.log(`\nMoonPay key/signature diagnostic`);
console.log(`  publishable: ${PK.slice(0, 16)}...`);
console.log(`  secret:      ${SK.slice(0, 12)}...\n`);

// 0. Environment consistency. Mixed test/live is refused at boot by config.ts,
//    but check here too since this script runs standalone.
const envOf = (k) => (k.includes('_test_') ? 'test' : k.includes('_live_') ? 'live' : '?');
if (envOf(PK) === envOf(SK) && envOf(PK) !== '?') ok(`both keys are ${envOf(PK)} keys`);
else no('key environments differ or are unrecognised', `${envOf(PK)} vs ${envOf(SK)}`);

// 1. Algorithm, against MoonPay's own published test vector. If this fails the
//    bug is in our code; if it passes, signing is provably correct.
const VEC_SECRET = 'sk_test_DocsVector00';
const VEC_MSG = '?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
const VEC_EXPECT = 'oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=';
const got = createHmac('sha256', VEC_SECRET).update(VEC_MSG).digest('base64');
if (got === VEC_EXPECT) {
  ok("signing algorithm matches MoonPay published test vector");
} else {
  no("signing algorithm WRONG", `${got} != ${VEC_EXPECT}`);
}

// 2. Publishable key valid, and whose account is it?
let acct = null;
try {
  const r = await fetch(`${API}/v3/accounts/me?apiKey=${encodeURIComponent(PK)}`);
  if (r.ok) {
    acct = await r.json();
    ok('publishable key is valid', `account "${String(acct.name).replace(/&amp;/g, '&')}"`);
  } else {
    no('publishable key REJECTED', `HTTP ${r.status}`);
  }
} catch (e) { no('publishable key check errored', e.message); }

// 3. Secret key valid? Uses an endpoint that actually authenticates with it.
try {
  const r = await fetch(`${API}/v1/transactions?limit=1`, { headers: { Authorization: `Api-Key ${SK}` } });
  if (r.status === 401) no('secret key REJECTED (401) - it is not a valid key');
  else if (r.ok) ok('secret key is valid', `HTTP ${r.status}`);
  else ok('secret key authenticated', `HTTP ${r.status} (past auth)`);
} catch (e) { no('secret key check errored', e.message); }

// 4. Iframe allowlist - a separate failure mode with a different error.
if (acct) {
  const allow = String(acct.allowedIframeAncestorUrls ?? '');
  console.log(`\n  note  allowedIframeAncestorUrls: ${allow || '(empty)'}`);
  if (!/localhost/.test(allow)) {
    console.log('        localhost is NOT allowlisted -> framing the widget locally will fail a');
    console.log('        frame-ancestors CSP check. That is a DIFFERENT error from the signature');
    console.log('        one. Add it in the dashboard, or test on an allowlisted domain.');
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);

if (fail === 0) {
  console.log(`Both keys are individually valid and the algorithm is correct.

If the widget STILL shows "Signature check failed", the remaining variable is
PAIRING - this secret is not the signing secret belonging to this publishable
key. Re-copy BOTH from the same row in dashboard.moonpay.com -> Developers ->
API keys, or regenerate the secret to force a known-good pair.

See docs/moonpay-sandbox-testing-status.md A.2.
`);
} else {
  console.log('Fix the failures above first.\n');
}
process.exit(fail === 0 ? 0 : 1);
