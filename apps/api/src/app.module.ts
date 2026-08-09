import { Module } from '@nestjs/common';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { WebhooksService } from './webhooks/webhooks.service.js';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import { loadConfig } from './config.js';

@Module({
  controllers: [OrdersController, WebhooksController],
  providers: [
    { provide: 'APP_CONFIG', useFactory: loadConfig },
    OrdersService,
    WebhooksService,
    ApiKeyGuard,
  ],
})
export class AppModule {}
