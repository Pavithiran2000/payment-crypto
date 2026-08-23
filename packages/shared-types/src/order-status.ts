/**
 * Order lifecycle.
 *
 * The spec listed statuses as a straight line. Reality is not a straight line:
 * webhooks arrive out of order, duplicated, and late. Two mechanisms guard that:
 *
 *  1. `RANK` - a monotonic progress score. A webhook may never move an order
 *     backwards. A late PAYMENT_PENDING arriving after COMPLETED is dropped.
 *  2. `ALLOWED` - an explicit transition table. Anything not listed is rejected
 *     and routed to MANUAL_REVIEW rather than silently applied.
 *
 * Post-settlement states (DISPUTED/CHARGEBACK/REVERSED) are deliberately ranked
 * ABOVE COMPLETED: a card dispute can land 120+ days after delivery, and an order
 * model that terminates at COMPLETED has nowhere to put it.
 */

export const ORDER_STATUSES = [
  'CREATED',
  'CHECKOUT_OPENED',
  'KYC_PENDING',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'CRYPTO_CONVERTED',
  'CRYPTO_SENT',
  'COMPLETED',
  // failure states
  'KYC_FAILED',
  'CARD_DECLINED',
  'PAYMENT_FAILED',
  'CONVERSION_FAILED',
  'CRYPTO_TRANSFER_FAILED',
  'CANCELLED',
  'EXPIRED',
  // operational
  'MANUAL_REVIEW',
  // post-settlement
  'DISPUTED',
  'CHARGEBACK_RECEIVED',
  'REVERSED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Monotonic progress. Equal ranks are alternate outcomes at the same stage. */
export const RANK: Record<OrderStatus, number> = {
  CREATED: 10,
  CHECKOUT_OPENED: 20,
  KYC_PENDING: 30,
  KYC_FAILED: 35,
  PAYMENT_PENDING: 40,
  CARD_DECLINED: 45,
  PAYMENT_FAILED: 45,
  PAYMENT_CONFIRMED: 50,
  CRYPTO_CONVERTED: 60,
  CONVERSION_FAILED: 65,
  CRYPTO_SENT: 70,
  CRYPTO_TRANSFER_FAILED: 75,
  COMPLETED: 80,
  CANCELLED: 85,
  EXPIRED: 85,
  MANUAL_REVIEW: 90,
  DISPUTED: 100,
  CHARGEBACK_RECEIVED: 110,
  REVERSED: 120,
};

/** Terminal for the *payment* flow. Post-settlement states may still follow. */
export const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'COMPLETED',
  'KYC_FAILED',
  'CARD_DECLINED',
  'PAYMENT_FAILED',
  'CONVERSION_FAILED',
  'CRYPTO_TRANSFER_FAILED',
  'CANCELLED',
  'EXPIRED',
  'REVERSED',
]);

/**
 * Max time an order may dwell in a non-terminal state before the reconciliation
 * job escalates it to MANUAL_REVIEW. Every non-terminal state needs a timeout;
 * orders that quietly stall forever are how money goes missing.
 */
export const DWELL_TIMEOUT_MS: Partial<Record<OrderStatus, number>> = {
  CREATED: 30 * 60 * 1000,
  CHECKOUT_OPENED: 60 * 60 * 1000,
  KYC_PENDING: 24 * 60 * 60 * 1000,
  PAYMENT_PENDING: 2 * 60 * 60 * 1000,
  PAYMENT_CONFIRMED: 6 * 60 * 60 * 1000,
  CRYPTO_CONVERTED: 6 * 60 * 60 * 1000,
  CRYPTO_SENT: 24 * 60 * 60 * 1000,
};

/**
 * The happy path, in order.
 *
 * Forward movement along this sequence is always legal, INCLUDING SKIPS.
 * Providers do not reliably report every intermediate state: a fast card
 * authorisation can surface as PAYMENT_CONFIRMED with no preceding
 * PAYMENT_PENDING, and we may never observe CHECKOUT_OPENED at all. Requiring
 * each step in turn causes perfectly ordinary orders to be flagged as integrity
 * failures - which is exactly what the smoke test caught on the first run.
 */
const MAIN_SEQUENCE: readonly OrderStatus[] = [
  'CREATED',
  'CHECKOUT_OPENED',
  'KYC_PENDING',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'CRYPTO_CONVERTED',
  'CRYPTO_SENT',
  'COMPLETED',
];

/**
 * Edges off the happy path. Every one is deliberate and enumerated.
 *
 * `KYC_FAILED` is reachable from every pre-settlement state, not only from
 * `KYC_PENDING`. On a provider that screens the payer inside its own hosted
 * flow (Stripe onramp: one `rejected` status covering KYC failure, sanctions
 * screening and fraud checks) we never observe a `KYC_PENDING` of our own -
 * the rejection lands directly on whatever state the order was in. Requiring
 * `KYC_PENDING` first would route every legitimately-rejected payer to
 * MANUAL_REVIEW instead of recording why they were declined.
 */
const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['KYC_FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  CHECKOUT_OPENED: ['KYC_FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  KYC_PENDING: ['KYC_FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  PAYMENT_PENDING: ['KYC_FAILED', 'CARD_DECLINED', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  PAYMENT_CONFIRMED: ['CONVERSION_FAILED', 'MANUAL_REVIEW', 'DISPUTED'],
  CRYPTO_CONVERTED: ['CRYPTO_TRANSFER_FAILED', 'MANUAL_REVIEW', 'DISPUTED'],
  CRYPTO_SENT: ['CRYPTO_TRANSFER_FAILED', 'MANUAL_REVIEW', 'DISPUTED'],
  COMPLETED: ['DISPUTED', 'MANUAL_REVIEW'],

  KYC_FAILED: ['MANUAL_REVIEW'],
  CARD_DECLINED: ['MANUAL_REVIEW'],
  PAYMENT_FAILED: ['MANUAL_REVIEW'],
  CONVERSION_FAILED: ['MANUAL_REVIEW'],
  CRYPTO_TRANSFER_FAILED: ['MANUAL_REVIEW'],
  CANCELLED: ['MANUAL_REVIEW'],
  EXPIRED: ['MANUAL_REVIEW'],

  // Only an operator resolves a review, and only into an explicit outcome.
  MANUAL_REVIEW: ['COMPLETED', 'CANCELLED', 'REVERSED', 'DISPUTED', 'CHARGEBACK_RECEIVED'],

  DISPUTED: ['CHARGEBACK_RECEIVED', 'COMPLETED', 'MANUAL_REVIEW'],
  CHARGEBACK_RECEIVED: ['REVERSED', 'COMPLETED', 'MANUAL_REVIEW'],
  REVERSED: ['MANUAL_REVIEW'],
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'same-state' | 'backwards' | 'not-allowed' };

export function canTransition(from: OrderStatus, to: OrderStatus): TransitionResult {
  if (from === to) return { ok: false, reason: 'same-state' };

  // Checked before anything else: a late or duplicated webhook must never undo
  // progress, regardless of which edges are otherwise legal.
  if (RANK[to] < RANK[from]) return { ok: false, reason: 'backwards' };

  const fromIdx = MAIN_SEQUENCE.indexOf(from);
  const toIdx = MAIN_SEQUENCE.indexOf(to);
  if (fromIdx !== -1 && toIdx > fromIdx) return { ok: true };

  if (!ALLOWED[from].includes(to)) return { ok: false, reason: 'not-allowed' };
  return { ok: true };
}

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL.has(s);
}
