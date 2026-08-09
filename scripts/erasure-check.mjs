/**
 * Verifies the crypto-shredding guarantee end to end:
 *   PII is readable while the DEK exists, and permanently unreadable after
 *   erasure, while the financial record survives untouched.
 *
 * Run after `pnpm -r build` and `pnpm db:migrate`:
 *   node scripts/erasure-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envText = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const db = await import('../packages/database/dist/index.js');
const { getDb, closeDb, orders, dataSubjects, eraseSubject, unwrapDek, decryptPii } = db;
const { eq, desc } = await import('drizzle-orm');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
};

const d = getDb();

const [order] = await d
  .select()
  .from(orders)
  .where(eq(orders.status, 'COMPLETED'))
  .orderBy(desc(orders.createdAt))
  .limit(1);

if (!order) {
  console.error('No COMPLETED order found. Run scripts/smoke.mjs first.');
  await closeDb();
  process.exit(1);
}

console.log('\nerasure guarantees\n');

// --- before erasure ---
const [subjectBefore] = await d
  .select()
  .from(dataSubjects)
  .where(eq(dataSubjects.id, order.dataSubjectId));

const dek = unwrapDek(subjectBefore.dekWrapped);
const email = decryptPii(dek, order.customerEmailEnc);
check('PII decrypts while DEK exists', email === 'payer@example.com', email);

// --- retention window must defer, not delete ---
const deferred = await eraseSubject(order.dataSubjectId, 'subject request');
check(
  'erasure deferred inside AML retention window',
  deferred.erased === false && deferred.refusal === 'retention-window',
  JSON.stringify(deferred),
);

// --- legal hold must block outright ---
await d
  .update(dataSubjects)
  .set({ retentionUntil: new Date(Date.now() - 86_400_000), legalHold: true })
  .where(eq(dataSubjects.id, order.dataSubjectId));

const held = await eraseSubject(order.dataSubjectId, 'subject request');
check(
  'legal hold blocks erasure even past retention',
  held.erased === false && held.refusal === 'legal-hold',
  JSON.stringify(held),
);

// --- window closed, hold cleared: erase ---
await d
  .update(dataSubjects)
  .set({ legalHold: false })
  .where(eq(dataSubjects.id, order.dataSubjectId));

const done = await eraseSubject(order.dataSubjectId, 'subject request');
check('erasure proceeds once permitted', done.erased === true, JSON.stringify(done));

// --- after erasure ---
const [subjectAfter] = await d
  .select()
  .from(dataSubjects)
  .where(eq(dataSubjects.id, order.dataSubjectId));

check('DEK destroyed', subjectAfter.dekWrapped === null);
check('erasure timestamped', subjectAfter.erasedAt !== null);

let stillReadable = false;
try {
  decryptPii(unwrapDek(subjectAfter.dekWrapped), order.customerEmailEnc);
  stillReadable = true;
} catch {
  /* expected */
}
check('PII is unrecoverable after erasure', !stillReadable);

// --- the financial record must survive ---
const [orderAfter] = await d.select().from(orders).where(eq(orders.id, order.id));
check('order row retained', orderAfter !== undefined);
check('amount retained', orderAfter.fiatAmount === order.fiatAmount);
check('status retained', orderAfter.status === 'COMPLETED');
check('pseudonymous subject link retained', orderAfter.dataSubjectId === order.dataSubjectId);
check('ciphertext retained but inert', orderAfter.customerEmailEnc !== null);

console.log(`\n${passed} passed, ${failed} failed\n`);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
