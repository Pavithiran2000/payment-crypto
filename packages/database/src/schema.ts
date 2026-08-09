import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ORDER_STATUSES } from '@pp/shared-types';

export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);

/* ------------------------------------------------------------------ *
 * data_subjects - the erasure unit.
 * Holds no PII itself, only the wrapped key that makes PII readable.
 * Destroying dek_wrapped shreds every PII column that references this row.
 * ------------------------------------------------------------------ */
export const dataSubjects = pgTable(
  'data_subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL means erased. The row itself is retained as a tombstone. */
    dekWrapped: text('dek_wrapped'),
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    erasureReason: text('erasure_reason'),
    /** Blocks erasure while a dispute or investigation is open. */
    legalHold: boolean('legal_hold').notNull().default(false),
    /** Earliest date erasure is permitted: AML window end. Set on creation. */
    retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'erased_implies_no_dek',
      sql`(${t.erasedAt} IS NULL) = (${t.dekWrapped} IS NOT NULL)`,
    ),
  ],
);

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  legalName: text('legal_name').notNull(),
  /** Sumsub holds the KYB documents. We store only the reference and verdict. */
  sumsubApplicantId: text('sumsub_applicant_id'),
  kybStatus: text('kyb_status').notNull().default('NOT_STARTED'),
  kybDecidedAt: timestamp('kyb_decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * payout_destinations - the highest-value field in the system.
 * An attacker who changes the deposit address redirects all settlement,
 * irreversibly. Hence: allowlist, dual approval, and a cooling-off period
 * before a new address becomes usable.
 * ------------------------------------------------------------------ */
export const payoutDestinations = pgTable(
  'payout_destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    label: text('label').notNull(),
    asset: text('asset').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    /** Maker-checker: distinct admins, enforced by a CHECK plus service logic. */
    proposedBy: uuid('proposed_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Not usable until this time, even once approved. */
    activeFrom: timestamp('active_from', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payout_dest_unique_active').on(t.merchantId, t.asset, t.network, t.address),
    check('approver_differs_from_proposer', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.proposedBy}`),
  ],
);

/* ------------------------------------------------------------------ *
 * orders
 * ------------------------------------------------------------------ */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Public, non-guessable reference shown to the customer. */
    reference: text('reference').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** Caller-supplied key that makes order creation safely retryable. */
    idempotencyKey: text('idempotency_key').notNull(),

    /** Pseudonymous link to erasable PII. Never a name or email directly. */
    dataSubjectId: uuid('data_subject_id')
      .notNull()
      .references(() => dataSubjects.id),
    /** AES-GCM ciphertext under the subject's DEK. Unreadable after erasure. */
    customerEmailEnc: text('customer_email_enc'),
    /** HMAC blind index so support can look an order up without decrypting. */
    customerEmailIdx: text('customer_email_idx'),
    customerCountry: text('customer_country'),

    // --- money: integers only, never float ---
    fiatAmount: bigint('fiat_amount', { mode: 'bigint' }).notNull(),
    fiatCurrency: text('fiat_currency').notNull(),
    fiatDecimals: integer('fiat_decimals').notNull(),

    cryptoAsset: text('crypto_asset').notNull(),
    cryptoNetwork: text('crypto_network').notNull(),
    cryptoDecimals: integer('crypto_decimals').notNull(),
    /** Indicative at creation; the settled figure arrives by webhook. */
    cryptoAmountQuoted: bigint('crypto_amount_quoted', { mode: 'bigint' }),
    cryptoAmountSettled: bigint('crypto_amount_settled', { mode: 'bigint' }),

    /** Quotes expire. Displaying a stale rate as final invites disputes. */
    quoteId: text('quote_id'),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),

    payoutDestinationId: uuid('payout_destination_id').references(() => payoutDestinations.id),

    status: orderStatusEnum('status').notNull().default('CREATED'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),

    providerOrderId: text('provider_order_id'),
    chainTxHash: text('chain_tx_hash'),
    binanceCredited: boolean('binance_credited').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('orders_reference_unique').on(t.reference),
    uniqueIndex('orders_idempotency_unique').on(t.merchantId, t.idempotencyKey),
    uniqueIndex('orders_provider_order_unique')
      .on(t.providerOrderId)
      .where(sql`${t.providerOrderId} IS NOT NULL`),
    index('orders_email_idx').on(t.customerEmailIdx),
    /** Drives the reconciliation sweep for stalled orders. */
    index('orders_status_changed_idx').on(t.status, t.statusChangedAt),
    check('fiat_amount_positive', sql`${t.fiatAmount} > 0`),
  ],
);

/* ------------------------------------------------------------------ *
 * order_status_history - append-only. Answers "what did we believe, when,
 * and on the strength of which provider event".
 * ------------------------------------------------------------------ */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status').notNull(),
    reason: text('reason').notNull(),
    providerEventId: uuid('provider_event_id'),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('osh_order_idx').on(t.orderId, t.createdAt)],
);

/* ------------------------------------------------------------------ *
 * provider_events - inbound webhook ledger.
 * The unique constraint IS the deduplication mechanism. Insert first, process
 * after. Never dedupe in application logic; let the database be the arbiter.
 * ------------------------------------------------------------------ */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /** Provider's own event id. Missing ones fall back to a payload digest. */
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type'),
    /** Verbatim body as received. Never the re-serialized parse. */
    rawPayload: text('raw_payload').notNull(),
    parsedPayload: jsonb('parsed_payload'),
    signatureValid: boolean('signature_valid').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    uniqueIndex('provider_events_unique').on(t.provider, t.externalEventId),
    index('provider_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

/* ------------------------------------------------------------------ *
 * outbox - transactional outbox. Emails, merchant webhooks and chain anchors
 * are enqueued in the SAME transaction as the state change that caused them,
 * then drained by the worker. Without this you either double-send receipts or
 * lose them on crash.
 * ------------------------------------------------------------------ */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);
