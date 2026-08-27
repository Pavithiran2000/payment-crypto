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
  decimalStringFromNumber,
  MoneyParseError,
  type OrderStatus,
} from '@pp/shared-types';
import {
  verifyWebhook,
  parseTransaction,
  mapTransactionStatus,
  isBuyEvent,
  type MoonPayTransaction,
} from '@pp/provider-moonpay';
import type { AppConfig } from '../config.js';

const PROVIDER = 'moonpay';
const PG_UNIQUE_VIOLATION = '23505';

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
   * downstream outage can never push us past MoonPay's five-second acknowledgement
   * window and start a retry storm for events we already hold.
   */
  async ingest(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IngestOutcome> {
    const result = verifyWebhook({
      webhookKey: this.cfg.moonpay.webhookKey,
      rawBody,
      headers,
      toleranceMs: this.cfg.moonpay.webhookToleranceMs,
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
          // Synthesised from (type, transaction id, updatedAt). MoonPay events
          // carry no id of their own; see deriveEventId.
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
      //
      // `identity_check_updated` lands here on purpose. It carries a customer
      // id and no transaction id, and this platform has no customer accounts to
      // join one to: every order gets its own pseudonymous data subject. The
      // event is kept verbatim in this table for the audit trail and otherwise
      // acknowledged. Acting on it would mean guessing which order it refers to.
      if (!isBuyEvent(event.eventType)) {
        this.log.debug(`Ignoring unhandled event type ${event.eventType ?? 'null'}`);
        await this.markProcessed(tx, eventRowId);
        return;
      }

      const payload = (event.parsedPayload ?? {}) as Record<string, unknown>;
      const data = parseTransaction(payload);

      // Two ways to find the order, in order of trust: the reference we put in
      // the widget URL as `externalTransactionId`, then MoonPay's transaction id
      // recorded on a previous event. The second covers a payload that lost the
      // external id to an API-version difference.
      const order = data.externalTransactionId
        ? await this.lockByReference(tx, data.externalTransactionId)
        : data.id
          ? await this.lockByTransactionId(tx, data.id)
          : undefined;

      if (!order) {
        await this.fail(
          tx,
          eventRowId,
          `no order for externalTransactionId=${data.externalTransactionId ?? '-'} transaction=${data.id || '-'}`,
        );
        return;
      }

      // First sight of MoonPay's own id. Recorded before anything else can fail,
      // so reconciliation can still find this order by transaction id later.
      await this.recordTransactionId(tx, order, data.id);

      // Delivery address check. A signed widget URL should make this impossible,
      // but "should be impossible" is not a control: if crypto went anywhere
      // other than the approved destination, a human decides what happens next
      // and the order does not advance on its own.
      const misdelivery = await this.checkDeliveryAddress(tx, order, data.walletAddress);
      if (misdelivery) {
        await this.moveTo(tx, order, 'MANUAL_REVIEW', misdelivery, eventRowId);
        await this.markProcessed(tx, eventRowId);
        return;
      }

      await this.captureSettlement(tx, order, data);

      const target = data.status
        ? (mapTransactionStatus(data.status, data.stages) as OrderStatus | null)
        : null;

      if (!target) {
        // Unrecognised provider status: escalate, never guess and never no-op.
        await this.moveTo(
          tx,
          order,
          'MANUAL_REVIEW',
          `unmapped MoonPay status: ${String(data.status)}`,
          eventRowId,
        );
        await this.markProcessed(tx, eventRowId);
        return;
      }

      const check = canTransition(order.status, target);
      if (!check.ok) {
        // 'backwards' and 'same-state' are expected under out-of-order or
        // duplicate delivery and are simply dropped. MoonPay explicitly warns
        // that events can arrive out of order, especially on retries, so this is
        // the normal case, not the odd one. A genuinely illegal transition is an
        // integrity problem and goes to a human.
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

      await this.moveTo(tx, order, target, this.transitionReason(data), eventRowId);
      await this.markProcessed(tx, eventRowId);
    });
  }

  /**
   * The audit trail's one chance to record WHY.
   *
   * MoonPay's `failureReason` is free text with no documented enum, so it is
   * never parsed for meaning - but it is the only human-readable account of a
   * failure that exists, and dropping it would leave support with a bare
   * `PAYMENT_FAILED` and nothing to tell the customer.
   */
  private transitionReason(data: MoonPayTransaction): string {
    const failedStage = data.stages?.find((s) => s.status === 'failed');
    const parts = [`MoonPay status ${String(data.status)}`];
    if (failedStage?.stage) parts.push(`failed at ${failedStage.stage}`);
    const reason = data.failureReason ?? failedStage?.failureReason;
    if (reason) parts.push(`reason: ${reason}`);
    return parts.join('; ');
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

  private async lockByTransactionId(tx: Tx, transactionId: string) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.providerOrderId, transactionId))
      .for('update');
    return order;
  }

  /**
   * Pin MoonPay's transaction id to the order the first time we see it.
   *
   * Only ever written once. If a later event carries a different id for the same
   * reference, that is two MoonPay transactions against one order - a double
   * payment - and it must not be papered over by overwriting the field.
   */
  private async recordTransactionId(
    tx: Tx,
    order: typeof orders.$inferSelect,
    transactionId: string,
  ): Promise<void> {
    if (!transactionId || order.providerOrderId === transactionId) return;

    if (order.providerOrderId !== null) {
      this.log.error(
        `Order ${order.reference} already bound to MoonPay transaction ${order.providerOrderId}, event carries ${transactionId}`,
      );
      return;
    }

    await tx.update(orders).set({ providerOrderId: transactionId }).where(eq(orders.id, order.id));
    order.providerOrderId = transactionId;
  }

  /** Returns a reason string when delivery did not go to the approved address. */
  private async checkDeliveryAddress(
    tx: Tx,
    order: typeof orders.$inferSelect,
    walletAddress: string | null,
  ): Promise<string | null> {
    // Absent until MoonPay has a wallet attached; nothing to check yet.
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
    data: MoonPayTransaction,
  ): Promise<void> {
    const patch: Partial<typeof orders.$inferInsert> = {};

    // MoonPay sends `quoteCurrencyAmount` as a JSON number, so it is already a
    // double by the time it reaches here. `decimalStringFromNumber` renders the
    // exact value that double holds rather than reformatting it - see money.ts
    // for why that is safe for 6-decimal stablecoins and nothing wider.
    if (data.quoteCurrencyAmount !== null && order.cryptoAmountSettled === null) {
      try {
        patch.cryptoAmountSettled = parseDecimalPadded(
          decimalStringFromNumber(data.quoteCurrencyAmount),
          order.cryptoDecimals,
        );
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

    if (data.cryptoTransactionId !== null && order.chainTxHash === null) {
      patch.chainTxHash = data.cryptoTransactionId;
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
        ...(target === 'COMPLETED' ? { completedAt: new Date() } : {}),
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
    // `order_type` rides along so the receipt worker can tell a donation
    // acknowledgement from a purchase receipt without re-reading the order.
    await tx.insert(outbox).values({
      topic: `order.${target.toLowerCase()}`,
      payload: {
        orderId: order.id,
        reference: order.reference,
        status: target,
        orderType: order.orderType,
        donationCampaign: order.donationCampaign,
      },
    });

    if (isTerminal(target)) {
      this.log.log(`Order ${order.reference} reached terminal state ${target}`);
    }
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
