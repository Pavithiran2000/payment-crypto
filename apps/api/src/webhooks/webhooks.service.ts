import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  getDb,
  orders,
  orderStatusHistory,
  providerEvents,
  outbox,
} from '@pp/database';
import { canTransition, isTerminal, type OrderStatus } from '@pp/shared-types';
import { verifyWebhook, mapTransakStatus } from '@pp/provider-transak';
import type { AppConfig } from '../config.js';

const PG_UNIQUE_VIOLATION = '23505';

export type IngestOutcome =
  | { accepted: true; duplicate: boolean; eventId: string }
  | { accepted: false; reason: string };

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(@Inject('APP_CONFIG') private readonly cfg: AppConfig) {}

  /**
   * Ingest is deliberately thin: verify, persist verbatim, acknowledge.
   * Business processing happens after the response so that a slow database or a
   * downstream outage can never cause the provider to see a timeout and start
   * retrying a webhook we already hold.
   */
  async ingest(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<IngestOutcome> {
    const result = verifyWebhook({
      scheme: this.cfg.webhookScheme,
      secret: this.cfg.transak.apiSecret,
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
          provider: 'transak',
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
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_UNIQUE_VIOLATION) {
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

      const payload = (event.parsedPayload ?? {}) as Record<string, unknown>;
      const reference = payload['partnerOrderId'];
      const providerStatus = payload['status'];

      if (typeof reference !== 'string') {
        await this.fail(tx, eventRowId, 'payload has no partnerOrderId');
        return;
      }

      // Lock the order row: concurrent webhooks for the same order are common
      // and must serialise, or two transitions race and one is lost.
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.reference, reference))
        .for('update');

      if (!order) {
        await this.fail(tx, eventRowId, `no order for reference ${reference}`);
        return;
      }

      const target =
        typeof providerStatus === 'string' ? (mapTransakStatus(providerStatus) as OrderStatus | null) : null;

      if (!target) {
        // Unrecognised provider status: escalate, never guess and never no-op.
        await this.moveTo(tx, order, 'MANUAL_REVIEW', `unmapped provider status: ${String(providerStatus)}`, eventRowId);
        await this.markProcessed(tx, eventRowId);
        return;
      }

      const check = canTransition(order.status, target);
      if (!check.ok) {
        // 'backwards' and 'same-state' are expected under out-of-order or
        // duplicate delivery and are simply dropped. A genuinely illegal
        // transition is an integrity problem and goes to a human.
        if (check.reason === 'not-allowed') {
          await this.moveTo(
            tx,
            order,
            'MANUAL_REVIEW',
            `illegal transition ${order.status} -> ${target}`,
            eventRowId,
          );
        } else {
          this.log.debug(`Dropping ${order.status} -> ${target} (${check.reason}) for ${reference}`);
        }
        await this.markProcessed(tx, eventRowId);
        return;
      }

      await this.moveTo(tx, order, target, `provider status ${String(providerStatus)}`, eventRowId);
      await this.markProcessed(tx, eventRowId);
    });
  }

  private async moveTo(
    tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
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

  private async markProcessed(
    tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
    eventRowId: string,
  ): Promise<void> {
    await tx
      .update(providerEvents)
      .set({ processedAt: new Date(), attempts: sql`${providerEvents.attempts} + 1` })
      .where(eq(providerEvents.id, eventRowId));
  }

  private async fail(
    tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
    eventRowId: string,
    error: string,
  ): Promise<void> {
    // Left unprocessed on purpose so the reconciliation sweep retries it; the
    // order may simply not exist yet if webhook and redirect raced.
    await tx
      .update(providerEvents)
      .set({ processingError: error, attempts: sql`${providerEvents.attempts} + 1` })
      .where(eq(providerEvents.id, eventRowId));
    this.log.warn(`Event ${eventRowId}: ${error}`);
  }
}
