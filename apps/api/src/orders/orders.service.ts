import { Injectable, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  getDb,
  orders,
  dataSubjects,
  payoutDestinations,
  orderStatusHistory,
  createWrappedDek,
  encryptPii,
  blindIndex,
} from '@pp/database';
import {
  parseDecimal,
  formatDecimal,
  FIAT_DECIMALS,
  ASSET_DECIMALS,
  type FiatCurrency,
  type CryptoAsset,
  type ChainNetwork,
} from '@pp/shared-types';
import { buildCheckoutUrl } from '@pp/provider-transak';
import type { AppConfig } from '../config.js';
import type { CreateOrderDto, OrderResponse } from './dto.js';

@Injectable()
export class OrdersService {
  constructor(@Inject('APP_CONFIG') private readonly cfg: AppConfig) {}

  async create(dto: CreateOrderDto, idempotencyKey: string): Promise<OrderResponse> {
    const db = getDb();

    // Idempotent by (merchant, key). A retried request returns the original
    // order rather than creating a second charge.
    const existing = await db.query.orders.findFirst({
      where: and(eq(orders.merchantId, dto.merchantId), eq(orders.idempotencyKey, idempotencyKey)),
    });
    if (existing) return this.toResponse(existing);

    const fiatCurrency = dto.fiatCurrency as FiatCurrency;
    const cryptoAsset = dto.cryptoAsset as CryptoAsset;
    const network = dto.network as ChainNetwork;

    const fiatDecimals = FIAT_DECIMALS[fiatCurrency];
    const cryptoDecimals = ASSET_DECIMALS[cryptoAsset][network];
    const fiatAmount = parseDecimal(dto.fiatAmount, fiatDecimals);

    // Only an approved, matured, unrevoked destination may receive funds.
    const destination = await db.query.payoutDestinations.findFirst({
      where: and(
        eq(payoutDestinations.merchantId, dto.merchantId),
        eq(payoutDestinations.asset, cryptoAsset),
        eq(payoutDestinations.network, network),
        isNull(payoutDestinations.revokedAt),
        sql`${payoutDestinations.approvedAt} IS NOT NULL`,
        sql`${payoutDestinations.activeFrom} <= now()`,
      ),
    });
    if (!destination) {
      throw new BadRequestException(
        'No approved and active payout destination for this merchant/asset/network',
      );
    }

    const retentionUntil = new Date(Date.now() + this.cfg.amlRetentionDays * 86_400_000);
    const reference = `ord_${randomBytes(12).toString('base64url')}`;

    const created = await db.transaction(async (tx) => {
      // Every order gets its own data subject and DEK, so erasing one customer
      // never touches another's records.
      const { dek, wrapped } = createWrappedDek();
      const [subject] = await tx
        .insert(dataSubjects)
        .values({ dekWrapped: wrapped, retentionUntil })
        .returning();
      if (!subject) throw new Error('failed to create data subject');

      const [order] = await tx
        .insert(orders)
        .values({
          reference,
          merchantId: dto.merchantId,
          idempotencyKey,
          dataSubjectId: subject.id,
          customerEmailEnc: dto.customerEmail ? encryptPii(dek, dto.customerEmail) : null,
          customerEmailIdx: dto.customerEmail ? blindIndex(dto.customerEmail) : null,
          customerCountry: dto.customerCountry ?? null,
          fiatAmount,
          fiatCurrency,
          fiatDecimals,
          cryptoAsset,
          cryptoNetwork: network,
          cryptoDecimals,
          payoutDestinationId: destination.id,
          status: 'CREATED',
        })
        .returning();
      if (!order) throw new Error('failed to create order');

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: 'CREATED',
        reason: 'order created via API',
      });

      return order;
    });

    const checkoutUrl = buildCheckoutUrl(this.cfg.transak, {
      partnerOrderId: created.reference,
      fiatAmount: created.fiatAmount,
      fiatDecimals: created.fiatDecimals,
      fiatCurrency: created.fiatCurrency,
      cryptoAsset: created.cryptoAsset,
      network: created.cryptoNetwork,
      walletAddress: destination.address,
      customerEmail: dto.customerEmail,
    });

    return { ...this.toResponse(created), checkoutUrl };
  }

  async findByReference(reference: string): Promise<OrderResponse> {
    const db = getDb();
    const order = await db.query.orders.findFirst({
      where: eq(orders.reference, reference),
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.toResponse(order);
  }

  private toResponse(o: typeof orders.$inferSelect): OrderResponse {
    return {
      reference: o.reference,
      status: o.status,
      fiatAmount: formatDecimal(o.fiatAmount, o.fiatDecimals),
      fiatCurrency: o.fiatCurrency,
      cryptoAsset: o.cryptoAsset,
      network: o.cryptoNetwork,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
