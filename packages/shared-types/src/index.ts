export * from './money.js';
export * from './order-status.js';

/** Retention tier drives how long a column lives and whether erasure may touch it. */
export type RetentionTier = 'financial' | 'contact-pii' | 'kyb-reference';
