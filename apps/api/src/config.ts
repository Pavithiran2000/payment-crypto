import type { TransakConfig, VerificationScheme } from '@pp/provider-transak';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export interface AppConfig {
  port: number;
  transak: TransakConfig;
  webhookScheme: VerificationScheme;
  /** Retention window for contact PII, in days. See docs/pii-retention-policy.md. */
  amlRetentionDays: number;
  /** Shared secret required as X-API-Key on /orders*. Checked by ApiKeyGuard. */
  apiKey: string;
}

export function loadConfig(): AppConfig {
  // Fail fast at boot. A payments service that starts with a missing secret and
  // discovers it on the first webhook is worse than one that refuses to start.
  required('DATABASE_URL');
  required('PII_MASTER_KEK');
  required('PII_BLIND_INDEX_PEPPER');

  const env = required('TRANSAK_ENV');
  if (env !== 'staging' && env !== 'production') {
    throw new Error('TRANSAK_ENV must be "staging" or "production"');
  }

  const scheme = process.env['TRANSAK_WEBHOOK_SCHEME'] ?? 'hmac-header';
  if (scheme !== 'hmac-header' && scheme !== 'jwt-body') {
    throw new Error('TRANSAK_WEBHOOK_SCHEME must be "hmac-header" or "jwt-body"');
  }

  return {
    port: Number(process.env['PORT'] ?? 3000),
    transak: {
      env,
      apiKey: required('TRANSAK_API_KEY'),
      apiSecret: required('TRANSAK_API_SECRET'),
      redirectUrl: required('TRANSAK_REDIRECT_URL'),
    },
    webhookScheme: scheme,
    amlRetentionDays: Number(process.env['AML_RETENTION_DAYS'] ?? 1825),
    apiKey: required('PAYMENT_API_KEY'),
  };
}
