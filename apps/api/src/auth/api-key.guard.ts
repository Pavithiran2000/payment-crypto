import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';

/**
 * Gate for /orders*. The gateway currently has no per-merchant auth model -
 * this is a single shared secret between apps/api and its one trusted caller
 * (the apps/web BFF), not a multi-tenant API key system.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject('APP_CONFIG') private readonly cfg: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers['x-api-key'];

    if (typeof provided !== 'string' || !provided) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }

    const expected = Buffer.from(this.cfg.apiKey);
    const actual = Buffer.from(provided);

    // Lengths must match before timingSafeEqual, and that early-exit itself
    // does not leak the secret since key length is not sensitive.
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
