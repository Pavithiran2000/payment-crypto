import { Controller, Inject, Post, Req, Res, HttpCode } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { WebhooksService } from './webhooks.service.js';

/** NestJS populates `rawBody` when the app is created with `{ rawBody: true }`. */
type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

@Controller('webhooks')
export class WebhooksController {
  // See orders.controller.ts: explicit token avoids depending on
  // emitDecoratorMetadata, which tsx's dev transpile does not reliably emit.
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Post('moonpay')
  @HttpCode(200)
  async moonpay(@Req() req: RawBodyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (!req.rawBody) {
      // Without the exact received bytes the HMAC cannot be checked. Failing
      // loudly here beats silently verifying against re-serialized JSON.
      reply.status(500).send({ error: 'raw body unavailable' });
      return;
    }

    const outcome = await this.webhooks.ingest(req.rawBody, req.headers);

    if (!outcome.accepted) {
      // 400. MoonPay retries any non-2xx up to nine times with exponential
      // backoff, which is the behaviour we want if the cause is a webhook key
      // caught mid-rotation rather than a forgery.
      reply.status(400).send({ error: 'signature verification failed' });
      return;
    }

    // MoonPay expects a 2xx within five seconds. Everything expensive happens
    // after this response - see WebhooksService.ingest.
    reply.status(200).send({ received: true, duplicate: outcome.duplicate });
  }
}
