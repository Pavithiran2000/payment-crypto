import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption for erasable PII ("crypto-shredding").
 *
 * The GDPR erasure right and the AML 5-year retention duty appear to conflict.
 * They are reconciled here rather than argued about:
 *
 *   - Each data subject gets a random Data Encryption Key (DEK).
 *   - Every PII column is stored encrypted under that subject's DEK.
 *   - The DEK is stored wrapped under a master Key Encryption Key (KEK).
 *   - Erasure = destroy the wrapped DEK. One row update.
 *
 * After erasure the PII ciphertext is mathematically unrecoverable, while the
 * financial rows - amounts, timestamps, statuses, pseudonymous subject id -
 * survive intact for the AML/audit window. Both duties satisfied, no conflict.
 *
 * The KEK lives in env for local dev only. In production it MUST be a KMS key
 * (AWS KMS / Azure Key Vault / GCP KMS) so that wrap/unwrap is an audited API
 * call and the key material never lands in application memory or a heap dump.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export class ErasedSubjectError extends Error {
  constructor(subjectId: string) {
    super(`Data subject ${subjectId} has been erased; PII is unrecoverable by design`);
  }
}

function kek(): Buffer {
  const raw = process.env['PII_MASTER_KEK'];
  if (!raw) throw new Error('PII_MASTER_KEK is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PII_MASTER_KEK must be 32 bytes, base64-encoded');
  return key;
}

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function open(key: Buffer, packed: string): Buffer {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Mint a fresh DEK for a new data subject, returned wrapped under the KEK. */
export function createWrappedDek(): { dek: Buffer; wrapped: string } {
  const dek = randomBytes(32);
  return { dek, wrapped: seal(kek(), dek) };
}

export function unwrapDek(wrapped: string | null): Buffer {
  if (wrapped === null) throw new Error('DEK has been destroyed (subject erased)');
  return open(kek(), wrapped);
}

export function encryptPii(dek: Buffer, plaintext: string): string {
  return seal(dek, Buffer.from(plaintext, 'utf8'));
}

export function decryptPii(dek: Buffer, packed: string): string {
  return open(dek, packed).toString('utf8');
}

/**
 * Blind index for equality lookup on encrypted columns ("find by email") without
 * decrypting anything. HMAC, not a plain hash: a bare SHA-256 of an email is
 * still personal data because an attacker can confirm a guess. The pepper makes
 * that infeasible, and the pepper is NOT the KEK - it survives subject erasure,
 * so it must never be derivable from erased material.
 */
export function blindIndex(value: string): string {
  const pepper = process.env['PII_BLIND_INDEX_PEPPER'];
  if (!pepper) throw new Error('PII_BLIND_INDEX_PEPPER is not set');
  return createHmac('sha256', Buffer.from(pepper, 'base64'))
    .update(value.trim().toLowerCase())
    .digest('base64');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
