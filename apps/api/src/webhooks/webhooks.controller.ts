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

  @Post('transak')
  @HttpCode(200)
  async transak(@Req() req: RawBodyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (!req.rawBody) {
      // Without the exact received bytes the HMAC cannot be checked. Failing
      // loudly here beats silently verifying against re-serialized JSON.
      reply.status(500).send({ error: 'raw body unavailable' });
      return;
    }

    const outcome = await this.webhooks.ingest(req.rawBody, req.headers);

    if (!outcome.accepted) {
      // 401, not 400: an unverifiable webhook is an authentication failure, and
      // the provider should not treat it as retryable.
      reply.status(401).send({ error: 'signature verification failed' });
      return;
    }

    reply.status(200).send({ received: true, duplicate: outcome.duplicate });
  }
}
