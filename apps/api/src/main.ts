import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Anchored to the repo root rather than cwd, so the API picks up the same .env
// regardless of where it is launched from.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppModule } from './app.module.js';
import { closeDb } from '@pp/database';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    // Preserves the exact request bytes on req.rawBody. Without this the
    // webhook HMAC is computed over re-serialized JSON and never matches.
    { rawBody: true },
  );

  await app.register(helmet);
  // Blunt global cap. Order creation gets a tighter per-merchant limit of its
  // own so the endpoint cannot be used for card testing or enumeration.
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`api listening on :${port}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeDb().finally(() => process.exit(0));
  });
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
