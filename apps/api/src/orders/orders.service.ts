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
  parseDecimalPadded,
  formatDecimal,
  decimalStringFromNumber,
  isTerminal,
  MoneyParseError,
  FIAT_DECIMALS,
  ASSET_DECIMALS,
  type FiatCurrency,
  type CryptoAsset,
  type ChainNetwork,
  type OrderStatus,
} from '@pp/shared-types';
import {
  buildWidgetUrl,
  fetchBuyQuote,
  MoonPayApiError,
  UnsupportedByMoonPayError,
  type BuyQuote,
} from '@pp/provider-moonpay';
import type { AppConfig } from '../config.js';
import type { CreateOrderDto, OrderResponse, OnrampHandle, OrderType } from './dto.js';

/**
 * Cards are the rail this platform exists for, so quotes are taken against
 * cards. Leaving it unset lets MoonPay quote a cheaper rail (SEPA, ACH) the
 * customer may have no access to, and the figure shown at checkout would then
 * not be the figure they are charged.
 */
const CARD_PAYMENT_METHOD = 'credit_debit_card';

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
    if (existing) return this.withCheckout(existing, dto.customerIpAddress);

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

    // The quote is taken BEFORE the order row exists, on purpose.
    //
    // MoonPay mints nothing at creation time - the widget URL is just a signed
    // string, and the transaction only comes into being when the customer
    // commits inside it. That removes the pre-flight a session-based provider
    // gave us for free, so the quote call takes its place: it is the one moment
    // before the customer is committed at which MoonPay will tell us that this
    // currency pair, this amount or this account cannot be served. If it
    // refuses, nothing is persisted and the caller gets a clean failure instead
    // of an order that can never be paid.
    const quote = await this.quote({
      reference,
      fiatAmount: dto.fiatAmount,
      fiatCurrency,
      cryptoAsset,
      network,
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
          orderType: dto.orderType,
          donationCampaign: dto.donationCampaign ?? null,
          donorNameEnc: dto.donorName ? encryptPii(dek, dto.donorName) : null,
          fiatAmount,
          fiatCurrency,
          fiatDecimals,
          cryptoAsset,
          cryptoNetwork: network,
          cryptoDecimals,
          cryptoAmountQuoted: this.quotedBaseUnits(quote, cryptoDecimals, reference),
          quoteExpiresAt: quote.expiresAt ? new Date(quote.expiresAt) : null,
          payoutDestinationId: destination.id,
          status: 'CREATED',
        })
        .returning();
      if (!order) throw new Error('failed to create order');

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: 'CREATED',
        reason: `${dto.orderType.toLowerCase()} created via API; quoted ${quote.quoteCurrencyAmount} ${quote.quoteCurrencyCode}`,
      });

      return order;
    });

    return this.withCheckout(created, dto.customerIpAddress);
  }

  async findByReference(reference: string): Promise<OrderResponse> {
    const order = await this.load(reference);
    return this.toResponse(order);
  }

  /**
   * The widget handle, fetched separately from the order itself so the ordinary
   * status projection never carries a signed payment URL.
   *
   * Refused once the order is terminal: a completed or failed order must not be
   * payable again, and a stale tab holding an old URL is exactly how that would
   * happen.
   *
   * The URL is built here rather than read from storage. It is signed over the
   * payer's IP hash, so it belongs to one browser at one moment; persisting one
   * would guarantee it is wrong for a customer who came back on another network.
   */
  async findOnrampHandle(reference: string, customerIpAddress?: string): Promise<OnrampHandle> {
    const order = await this.load(reference);

    if (isTerminal(order.status as OrderStatus)) {
      throw new NotFoundException('Order is no longer payable');
    }

    return this.buildHandle(order, customerIpAddress);
  }

  /**
   * Re-read the payout destination this order was created against.
   *
   * Deliberately re-read, not denormalised onto the order: the deposit address
   * is the highest-value field in the system, and keeping exactly one copy of
   * it means a revoked destination stops being payable everywhere at once. The
   * revocation check here is what makes that true - an order created yesterday
   * against a destination revoked this morning must not mint a payment URL.
   */
  private async payoutAddress(order: typeof orders.$inferSelect): Promise<string> {
    if (!order.payoutDestinationId) {
      throw new NotFoundException('Order has no payout destination');
    }

    const db = getDb();
    const destination = await db.query.payoutDestinations.findFirst({
      where: and(
        eq(payoutDestinations.id, order.payoutDestinationId),
        isNull(payoutDestinations.revokedAt),
      ),
    });
    if (!destination) {
      throw new BadRequestException('The payout destination for this order is no longer active');
    }
    return destination.address;
  }

  private async load(reference: string): Promise<typeof orders.$inferSelect> {
    const db = getDb();
    const order = await db.query.orders.findFirst({ where: eq(orders.reference, reference) });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Price the order with MoonPay, translating its refusals into the right kind
   * of failure for the caller.
   */
  private async quote(p: {
    reference: string;
    fiatAmount: string;
    fiatCurrency: string;
    cryptoAsset: string;
    network: string;
  }): Promise<BuyQuote> {
    try {
      return await fetchBuyQuote(this.cfg.moonpay, {
        fiatCurrency: p.fiatCurrency,
        fiatAmount: p.fiatAmount,
        cryptoAsset: p.cryptoAsset,
        network: p.network,
        paymentMethod: CARD_PAYMENT_METHOD,
      });
    } catch (err: unknown) {
      // A currency/asset/network MoonPay cannot serve is the caller's mistake,
      // and is caught before any network call.
      if (err instanceof UnsupportedByMoonPayError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof MoonPayApiError) {
        this.log.warn(
          `MoonPay refused a quote for ${p.reference}: ${err.moonPayErrorCode ?? err.errorType ?? err.message}`,
        );
        // 4xx is permanent for this request - an amount below the minimum, an
        // unsupported pair, a key without access. MoonPay's own message is
        // customer-actionable, so it is passed through rather than flattened.
        if (err.httpStatus >= 400 && err.httpStatus < 500) {
          throw new BadRequestException(
            err.httpStatus === 401 || err.httpStatus === 403
              ? 'Card-to-crypto payment is temporarily unavailable'
              : err.message,
          );
        }
        throw new ServiceUnavailableException('Payment provider is unavailable, please retry');
      }
      // fetch() itself failed: DNS, TLS, connection refused. Retryable.
      this.log.error(`MoonPay quote failed for ${p.reference}`, err);
      throw new ServiceUnavailableException('Payment provider is unavailable, please retry');
    }
  }

  /**
   * Convert the quoted crypto figure into base units.
   *
   * Indicative only, and never allowed to fail an order: MoonPay re-quotes
   * inside the widget and the settled figure arrives by webhook, so a value we
   * cannot represent is a display problem, not a payment problem.
   */
  private quotedBaseUnits(quote: BuyQuote, decimals: number, reference: string): bigint | null {
    try {
      return parseDecimalPadded(decimalStringFromNumber(quote.quoteCurrencyAmount), decimals);
    } catch (err: unknown) {
      if (err instanceof MoneyParseError) {
        this.log.warn(`Unrepresentable quote for ${reference}: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  private async buildHandle(
    order: typeof orders.$inferSelect,
    customerIpAddress?: string,
  ): Promise<OnrampHandle> {
    const destination = await this.payoutAddress(order);

    try {
      const widgetUrl = buildWidgetUrl(this.cfg.moonpay, {
        reference: order.reference,
        fiatAmount: order.fiatAmount,
        fiatDecimals: order.fiatDecimals,
        fiatCurrency: order.fiatCurrency,
        cryptoAsset: order.cryptoAsset,
        network: order.cryptoNetwork,
        walletAddress: destination,
        // MoonPay appends its own transactionId and status to this; the order
        // page ignores them and reads the webhook-driven record instead.
        redirectUrl: `${this.cfg.webBaseUrl}/orders/${encodeURIComponent(order.reference)}`,
        ...(customerIpAddress ? { customerIpAddress } : {}),
      });

      return { provider: 'moonpay', widgetUrl, mode: this.cfg.moonpay.mode };
    } catch (err: unknown) {
      if (err instanceof UnsupportedByMoonPayError) {
        // Reached only when IP matching is on and the payer IP is unknown, or
        // when a stored order names a pair MoonPay has since dropped.
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /** Attach the customer-facing entry point. */
  private async withCheckout(
    o: typeof orders.$inferSelect,
    customerIpAddress?: string,
  ): Promise<OrderResponse> {
    const base = this.toResponse(o);
    if (isTerminal(o.status as OrderStatus)) return base;

    const onramp = await this.buildHandle(o, customerIpAddress);

    // In `redirect` mode the customer goes straight to MoonPay. In `embedded`
    // mode they stay on our page, which frames the same signed URL.
    const checkoutUrl =
      this.cfg.moonpay.mode === 'redirect'
        ? onramp.widgetUrl
        : `${this.cfg.webBaseUrl}/checkout/onramp/${encodeURIComponent(o.reference)}`;

    return { ...base, checkoutUrl, onramp };
  }

  private toResponse(o: typeof orders.$inferSelect): OrderResponse {
    return {
      reference: o.reference,
      status: o.status,
      orderType: o.orderType as OrderType,
      donationCampaign: o.donationCampaign,
      fiatAmount: formatDecimal(o.fiatAmount, o.fiatDecimals),
      fiatCurrency: o.fiatCurrency,
      cryptoAsset: o.cryptoAsset,
      network: o.cryptoNetwork,
      cryptoAmountQuoted:
        o.cryptoAmountQuoted === null ? null : formatDecimal(o.cryptoAmountQuoted, o.cryptoDecimals),
      cryptoAmountSettled:
        o.cryptoAmountSettled === null
          ? null
          : formatDecimal(o.cryptoAmountSettled, o.cryptoDecimals),
      chainTxHash: o.chainTxHash,
      quoteExpiresAt: o.quoteExpiresAt ? o.quoteExpiresAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
