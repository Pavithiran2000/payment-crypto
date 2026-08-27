import { Body, Controller, Get, Headers, Inject, Param, Post, BadRequestException, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { createOrderSchema } from './dto.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';

@Controller('orders')
@UseGuards(ApiKeyGuard)
export class OrdersController {
  // Explicit token: type-only injection depends on `emitDecoratorMetadata`,
  // which tsx's esbuild-based dev transpile does not reliably emit - without
  // this, Nest silently constructs the controller with `orders` undefined
  // instead of failing at boot.
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Post()
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.orders.create(parsed.data, idempotencyKey);
  }

  /**
   * Status is read from our record, which is only ever advanced by a verified
   * webhook. The browser's return from MoonPay is a navigation event, not a
   * source of truth - it never marks an order complete.
   */
  @Get(':reference')
  async get(@Param('reference') reference: string) {
    return this.orders.findByReference(reference);
  }

  /**
   * Separate from the order projection so a signed widget URL is only ever
   * served to a caller that explicitly asked for one, and only while the order
   * is still payable.
   *
   * The payer's IP arrives in a header rather than a query parameter on purpose:
   * an IP is personal data, and query strings end up in access logs, proxy logs
   * and browser history. The BFF sets it; the browser never does.
   */
  @Get(':reference/onramp-session')
  async onrampSession(
    @Param('reference') reference: string,
    @Headers('x-customer-ip') customerIp?: string,
  ) {
    return this.orders.findOnrampHandle(reference, customerIp);
  }
}
