import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  getDb,
  orders,
  orderStatusHistory,
  payoutDestinations,
  providerEvents,
  outbox,
} from '@pp/database';
import {
  canTransition,
  isTerminal,
  parseDecimalPadded,
  MoneyParseError,
  type OrderStatus,
} from '@pp/shared-types';
import { verifyWebhook, parseOnrampEvent, mapOnrampStatus } from '@pp/provider-stripe-onramp';
import type { AppConfig } from '../config.js';

const PROVIDER = 'stripe';
const PG_UNIQUE_VIOLATION = '23505';

/** The only event this integration acts on. Anything else is acknowledged and dropped. */
const ONRAMP_EVENT_TYPE = 'crypto.onramp_session.updated';

export type IngestOutcome =
  | { accepted: true; duplicate: boolean; eventId: string }
  | { accepted: false; reason: string };

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(@Inject('APP_CONFIG') private readonly cfg: AppConfig) {}

  /**
   * Ingest is deliberately thin: verify, persist verbatim, acknowledge.
   * Business processing happens after the response so that a slow database or a
   * downstream outage can never cause Stripe to see a timeout and start
   * retrying a webhook we already hold.
   */
  async ingest(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IngestOutcome> {
    const result = verifyWebhook({
      secret: this.cfg.stripe.webhookSecret,
      rawBody,
      headers,
    });

    if (!result.valid) {
      // Rejected events are not persisted against the unique key - an attacker
      // must not be able to poison the dedupe table with forged event ids.
      this.log.warn(`Rejected webhook: ${result.reason}`);
      return { accepted: false, reason: result.reason };
    }

    const db = getDb();
    try {
      const [row] = await db
        .insert(providerEvents)
        .values({
          provider: PROVIDER,
          externalEventId: result.eventId,
          eventType: result.eventType,
          rawPayload: rawBody.toString('utf8'),
          parsedPayload: result.payload,
          signatureValid: true,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');

      // Fire-and-forget: the response is already committed to the provider.
      // The reconciliation sweep re-drives anything left unprocessed.
      void this.process(row.id).catch((err: unknown) => {
        this.log.error(`Processing failed for event ${row.id}`, err);
      });

      return { accepted: true, duplicate: false, eventId: result.eventId };
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === PG_UNIQUE_VIOLATION
      ) {
        // The unique constraint IS the deduplication. Providers retry freely;
        // a repeat delivery is a normal, successful, no-op outcome.
        return { accepted: true, duplicate: true, eventId: result.eventId };
      }
      throw err;
    }
  }

  async process(eventRowId: string): Promise<void> {
    const db = getDb();

    await db.transaction(async (tx) => {
      const event = await tx.query.providerEvents.findFirst({
        where: eq(providerEvents.id, eventRowId),
      });
      if (!event || event.processedAt) return;

      // Subscribing an endpoint to more events than it handles is common and
      // harmless. Escalating on them is not - it would flood MANUAL_REVIEW.
      if (event.eventType !== null && event.eventType !== ONRAMP_EVENT_TYPE) {
        this.log.debug(`Ignoring unrelated event type ${event.eventType}`);
        await this.markProcessed(tx, eventRowId);
        return;
      }

      const payload = (event.parsedPayload ?? {}) as Record<string, unknown>;
      const data = parseOnrampEvent(payload);

      // Two ways to find the order, in order of trust: the reference we put in
      // the session's metadata, then the session id we recorded at creation.
      // The second covers a session created outside this flow or metadata lost
      // to an API-version difference.
      const order = data.partnerOrderId
        ? await this.lockByReference(tx, data.partnerOrderId)
        : data.sessionId
          ? await this.lockBySessionId(tx, data.sessionId)
          : undefined;

      if (!order) {
        await this.fail(
          tx,
          eventRowId,
          `no order for partner_order_id=${data.partnerOrderId ?? '-'} session=${data.sessionId ?? '-'}`,
        );
        return;
      }

      // Delivery address check. `lock_wallet_address` should make this
      // impossible, but "should be impossible" is not a control: if crypto went
      // anywhere other than the approved destination, a human decides what
      // happens next and the order does not advance on its own.
      const misdelivery = await this.checkDeliveryAddress(tx, order, data.walletAddress);
      if (misdelivery) {
        await this.moveTo(tx, order, 'MANUAL_REVIEW', misdelivery, eventRowId);
        await this.markProcessed(tx, eventRowId);
        return;
      }

      await this.captureSettlement(tx, order, data.destinationAmount, data.transactionId);

      const target = data.status ? (mapOnrampStatus(data.status) as OrderStatus | null) : null;

      if (!target) {
        // Unrecognised provider status: escalate, never guess and never no-op.
        await this.moveTo(
          tx,
          order,
          'MANUAL_REVIEW',
          `unmapped onramp status: ${String(data.status)}`,
          eventRowId,
        );
        await this.markProcessed(tx, eventRowId);
        return;
      }

      const check = canTransition(order.status, target);
      if (!check.ok) {
        // 'backwards' and 'same-state' are expected under out-of-order or
        // duplicate delivery and are simply dropped. Stripe explicitly does not
        // guarantee event ordering, so this is the normal case, not the odd one.
        // A genuinely illegal transition is an integrity problem and goes to a human.
        if (check.reason === 'not-allowed') {
          await this.moveTo(
            tx,
            order,
            'MANUAL_REVIEW',
            `illegal transition ${order.status} -> ${target}`,
            eventRowId,
          );
        } else {
          this.log.debug(
            `Dropping ${order.status} -> ${target} (${check.reason}) for ${order.reference}`,
          );
        }
        await this.markProcessed(tx, eventRowId);
        return;
      }

      await this.moveTo(tx, order, target, `onramp status ${String(data.status)}`, eventRowId);
      await this.markProcessed(tx, eventRowId);
    });
  }

  /**
   * Lock the order row: concurrent webhooks for the same order are common and
   * must serialise, or two transitions race and one is lost.
   */
  private async lockByReference(tx: Tx, reference: string) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.reference, reference))
      .for('update');
    return order;
  }

  private async lockBySessionId(tx: Tx, sessionId: string) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.providerOrderId, sessionId))
      .for('update');
    return order;
  }

  /** Returns a reason string when delivery did not go to the approved address. */
  private async checkDeliveryAddress(
    tx: Tx,
    order: typeof orders.$inferSelect,
    walletAddress: string | null,
  ): Promise<string | null> {
    // Absent until Stripe has a wallet attached; nothing to check yet.
    if (!walletAddress || !order.payoutDestinationId) return null;

    const destination = await tx.query.payoutDestinations.findFirst({
      where: eq(payoutDestinations.id, order.payoutDestinationId),
    });
    if (!destination) return 'order references a payout destination that no longer exists';

    // Case-insensitive: EVM addresses are hex and providers differ on EIP-55
    // checksum casing. This is only safe while every supported network is EVM;
    // a case-sensitive chain (Solana, Stellar) needs an exact compare.
    if (destination.address.toLowerCase() === walletAddress.toLowerCase()) return null;

    // Deliberately not logged or recorded in full - a partial is enough to
    // investigate with, and full addresses do not belong in the status trail.
    return `delivery address does not match approved destination (got ...${walletAddress.slice(-6)})`;
  }

  /**
   * Record what actually settled. Kept separate from the state transition
   * because a late event can carry the figures after the order has already
   * moved on, and losing them would break reconciliation against Binance.
   */
  private async captureSettlement(
    tx: Tx,
    order: typeof orders.$inferSelect,
    destinationAmount: string | null,
    transactionId: string | null,
  ): Promise<void> {
    const patch: Partial<typeof orders.$inferInsert> = {};

    if (destinationAmount !== null && order.cryptoAmountSettled === null) {
      try {
        patch.cryptoAmountSettled = parseDecimalPadded(destinationAmount, order.cryptoDecimals);
      } catch (err: unknown) {
        // Never fail a webhook over a display field. The raw payload is stored
        // verbatim, so the true figure is always recoverable.
        if (err instanceof MoneyParseError) {
          this.log.warn(`Unparseable settled amount for ${order.reference}: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    if (transactionId !== null && order.chainTxHash === null) {
      patch.chainTxHash = transactionId;
    }

    if (Object.keys(patch).length > 0) {
      await tx.update(orders).set(patch).where(eq(orders.id, order.id));
    }
  }

  private async moveTo(
    tx: Tx,
    order: typeof orders.$inferSelect,
    target: OrderStatus,
    reason: string,
    eventRowId: string,
  ): Promise<void> {
    await tx
      .update(orders)
      .set({
        status: target,
        statusChangedAt: new Date(),
        ...(isTerminal(target) && target === 'COMPLETED' ? { completedAt: new Date() } : {}),
        // A terminal order has no live session. Dropping the secret keeps a
        // stale browser tab from re-mounting a widget for a finished order.
        ...(isTerminal(target) ? { providerClientSecret: null } : {}),
      })
      .where(eq(orders.id, order.id));

    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: order.status,
      toStatus: target,
      reason,
      providerEventId: eventRowId,
    });

    // Enqueued in the same transaction as the state change. Either both land or
    // neither does - no duplicate receipts, no silently lost notifications.
    await tx.insert(outbox).values({
      topic: `order.${target.toLowerCase()}`,
      payload: { orderId: order.id, reference: order.reference, status: target },
    });
  }

  private async markProcessed(tx: Tx, eventRowId: string): Promise<void> {
    await tx
      .update(providerEvents)
      .set({ processedAt: new Date(), attempts: sql`${providerEvents.attempts} + 1` })
      .where(eq(providerEvents.id, eventRowId));
  }

  private async fail(tx: Tx, eventRowId: string, error: string): Promise<void> {
    // Left unprocessed on purpose so the reconciliation sweep retries it; the
    // order may simply not exist yet if webhook and redirect raced.
    await tx
      .update(providerEvents)
      .set({ processingError: error, attempts: sql`${providerEvents.attempts} + 1` })
      .where(eq(providerEvents.id, eventRowId));
    this.log.warn(`Event ${eventRowId}: ${error}`);
  }
}
