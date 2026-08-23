import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
  Logger,
} from '@nestjs/common';
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
  isTerminal,
  FIAT_DECIMALS,
  ASSET_DECIMALS,
  type FiatCurrency,
  type CryptoAsset,
  type ChainNetwork,
  type OrderStatus,
} from '@pp/shared-types';
import {
  createOnrampSession,
  StripeOnrampError,
  UnsupportedByOnrampError,
} from '@pp/provider-stripe-onramp';
import type { AppConfig } from '../config.js';
import type { CreateOrderDto, OrderResponse, OnrampHandle } from './dto.js';

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(@Inject('APP_CONFIG') private readonly cfg: AppConfig) {}

  async create(dto: CreateOrderDto, idempotencyKey: string): Promise<OrderResponse> {
    const db = getDb();

    // Idempotent by (merchant, key). A retried request returns the original
    // order rather than creating a second charge.
    const existing = await db.query.orders.findFirst({
      where: and(eq(orders.merchantId, dto.merchantId), eq(orders.idempotencyKey, idempotencyKey)),
    });
    if (existing) return this.withCheckout(existing);

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

    const reference = `ord_${randomBytes(12).toString('base64url')}`;

    // The session is minted BEFORE the order row exists, on purpose. If Stripe
    // refuses - unsupported geography, unsupported currency pair, onramp
    // disabled - nothing is persisted and the caller gets a clean failure. The
    // reverse order would leave orders that can never be paid. An orphaned
    // session costs nothing: no money has moved and Stripe's idempotency key
    // means the retry returns the same one rather than minting a second.
    const session = await this.mintSession({
      reference,
      fiatAmount,
      fiatDecimals,
      fiatCurrency,
      cryptoAsset,
      network,
      walletAddress: destination.address,
      customerIpAddress: dto.customerIpAddress,
      idempotencyKey: `${dto.merchantId}:${idempotencyKey}`,
    });

    const retentionUntil = new Date(Date.now() + this.cfg.amlRetentionDays * 86_400_000);

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
          providerOrderId: session.id,
          providerClientSecret: session.clientSecret,
          status: 'CREATED',
        })
        .returning();
      if (!order) throw new Error('failed to create order');

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: 'CREATED',
        reason: `order created via API; onramp session ${session.id}`,
      });

      return order;
    });

    return this.withCheckout(created, session.redirectUrl);
  }

  async findByReference(reference: string): Promise<OrderResponse> {
    const order = await this.load(reference);
    return this.toResponse(order);
  }

  /**
   * The widget handle, fetched separately from the order itself so the ordinary
   * status projection never carries a client secret.
   *
   * Refused once the order is terminal: a completed or failed order has no live
   * session, and handing one out would let a stale page take a second payment.
   */
  async findOnrampHandle(reference: string): Promise<OnrampHandle> {
    const order = await this.load(reference);

    if (isTerminal(order.status as OrderStatus)) {
      throw new NotFoundException('Order is no longer payable');
    }
    if (!order.providerOrderId || !order.providerClientSecret) {
      throw new NotFoundException('Order has no onramp session');
    }

    return {
      sessionId: order.providerOrderId,
      clientSecret: order.providerClientSecret,
      publishableKey: this.cfg.stripe.publishableKey,
      mode: this.cfg.stripe.mode,
    };
  }

  private async load(reference: string): Promise<typeof orders.$inferSelect> {
    const db = getDb();
    const order = await db.query.orders.findFirst({ where: eq(orders.reference, reference) });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async mintSession(p: {
    reference: string;
    fiatAmount: bigint;
    fiatDecimals: number;
    fiatCurrency: string;
    cryptoAsset: string;
    network: string;
    walletAddress: string;
    customerIpAddress: string | undefined;
    idempotencyKey: string;
  }) {
    try {
      return await createOnrampSession(this.cfg.stripe, {
        partnerOrderId: p.reference,
        fiatAmount: p.fiatAmount,
        fiatDecimals: p.fiatDecimals,
        fiatCurrency: p.fiatCurrency,
        cryptoAsset: p.cryptoAsset,
        network: p.network,
        walletAddress: p.walletAddress,
        customerIpAddress: p.customerIpAddress,
        idempotencyKey: p.idempotencyKey,
      });
    } catch (err: unknown) {
      // A currency/asset/network Stripe cannot serve is the caller's mistake.
      if (err instanceof UnsupportedByOnrampError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof StripeOnrampError) {
        // Geography and eligibility rejections are 4xx and permanent for this
        // customer; anything else is Stripe being unavailable and is retryable.
        this.log.warn(`Stripe onramp refused session for ${p.reference}: ${err.code ?? err.message}`);
        if (err.httpStatus >= 400 && err.httpStatus < 500) {
          throw new BadRequestException(
            err.code === 'crypto_onramp_unsupportable_customer' ||
            err.code === 'crypto_onramp_unsupported_country'
              ? 'Card-to-crypto payment is not available in your country'
              : 'Unable to start a payment session for this order',
          );
        }
        throw new ServiceUnavailableException('Payment provider is unavailable, please retry');
      }
      throw err;
    }
  }

  /** Attach the customer-facing entry point, whichever integration is in use. */
  private withCheckout(
    o: typeof orders.$inferSelect,
    redirectUrl?: string | null,
  ): OrderResponse {
    const base = this.toResponse(o);
    if (isTerminal(o.status as OrderStatus) || !o.providerOrderId || !o.providerClientSecret) {
      return base;
    }

    const onramp: OnrampHandle = {
      sessionId: o.providerOrderId,
      clientSecret: o.providerClientSecret,
      publishableKey: this.cfg.stripe.publishableKey,
      mode: this.cfg.stripe.mode,
    };

    // Hosted mode sends the customer to Stripe's standalone page. The URL is
    // only ever returned by Stripe at creation - if a later read needs it, the
    // embedded page is the fallback, because a wrong guess strands the payer.
    const checkoutUrl =
      this.cfg.stripe.mode === 'hosted' && redirectUrl
        ? redirectUrl
        : `${this.cfg.webBaseUrl}/checkout/onramp/${encodeURIComponent(o.reference)}`;

    return { ...base, checkoutUrl, onramp };
  }

  private toResponse(o: typeof orders.$inferSelect): OrderResponse {
    return {
      reference: o.reference,
      status: o.status,
      fiatAmount: formatDecimal(o.fiatAmount, o.fiatDecimals),
      fiatCurrency: o.fiatCurrency,
      cryptoAsset: o.cryptoAsset,
      network: o.cryptoNetwork,
      cryptoAmountSettled:
        o.cryptoAmountSettled === null
          ? null
          : formatDecimal(o.cryptoAmountSettled, o.cryptoDecimals),
      chainTxHash: o.chainTxHash,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
