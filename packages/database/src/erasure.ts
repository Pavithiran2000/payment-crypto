import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { dataSubjects } from './schema.js';

/**
 * Executable half of docs/pii-retention-policy.md.
 *
 * Erasure destroys the wrapped DEK and nothing else. Financial rows keep their
 * amounts, timestamps, statuses and pseudonymous subject id; the PII ciphertext
 * they carry simply stops being decryptable. That is what lets us honour an
 * erasure request without breaching the AML retention duty.
 */

export type ErasureRefusal = 'not-found' | 'already-erased' | 'legal-hold' | 'retention-window';

export type ErasureResult = { erased: true } | { erased: false; refusal: ErasureRefusal };

export async function eraseSubject(subjectId: string, reason: string): Promise<ErasureResult> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [subject] = await tx
      .select()
      .from(dataSubjects)
      .where(eq(dataSubjects.id, subjectId))
      .for('update');

    if (!subject) return { erased: false, refusal: 'not-found' };
    if (subject.erasedAt) return { erased: false, refusal: 'already-erased' };

    // A dispute or investigation freezes deletion outright.
    if (subject.legalHold) return { erased: false, refusal: 'legal-hold' };

    // GDPR Art. 17(3)(b): the erasure right yields to a legal retention duty.
    // We do not refuse the request - we defer it, and the sweep below completes
    // it automatically the day the AML window closes.
    if (subject.retentionUntil > new Date()) {
      return { erased: false, refusal: 'retention-window' };
    }

    await tx
      .update(dataSubjects)
      .set({ dekWrapped: null, erasedAt: new Date(), erasureReason: reason })
      .where(eq(dataSubjects.id, subjectId));

    return { erased: true };
  });
}

/**
 * Scheduled sweep: erase everything whose retention window has closed and which
 * is not under legal hold. Retention is enforced as an expiry, not as a request
 * queue - data nobody asked us to delete still must not be kept forever.
 */
export async function sweepExpiredSubjects(limit = 500): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(dataSubjects)
    .set({ dekWrapped: null, erasedAt: new Date(), erasureReason: 'retention window expired' })
    .where(
      and(
        isNull(dataSubjects.erasedAt),
        eq(dataSubjects.legalHold, false),
        lte(dataSubjects.retentionUntil, sql`now()`),
        sql`${dataSubjects.id} IN (
          SELECT id FROM data_subjects
          WHERE erased_at IS NULL AND legal_hold = false AND retention_until <= now()
          LIMIT ${limit}
        )`,
      ),
    )
    .returning({ id: dataSubjects.id });

  return rows.length;
}

export async function setLegalHold(subjectId: string, held: boolean): Promise<void> {
  const db = getDb();
  await db.update(dataSubjects).set({ legalHold: held }).where(eq(dataSubjects.id, subjectId));
}
