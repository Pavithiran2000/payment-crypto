import {
  STRIPE_API_BASE_URL,
  type StripeOnrampConfig,
  type OnrampMode,
} from '@pp/provider-stripe-onramp';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export interface AppConfig {
  port: number;
  stripe: StripeOnrampConfig;
  /**
   * Base URL of the storefront that mounts the embedded onramp widget. The
   * checkout URL handed back with a new order is built from this, so the
   * customer stays on our domain for the whole payment.
   */
  webBaseUrl: string;
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

  const mode = process.env['STRIPE_ONRAMP_MODE'] ?? 'embedded';
  if (mode !== 'embedded' && mode !== 'hosted') {
    throw new Error('STRIPE_ONRAMP_MODE must be "embedded" or "hosted"');
  }

  const secretKey = required('STRIPE_SECRET_KEY');
  const apiBaseUrl = process.env['STRIPE_API_BASE_URL'] ?? STRIPE_API_BASE_URL;

  // A live key pointed at anything but Stripe means either a misconfiguration
  // or an exfiltration attempt. Neither should be allowed to reach a request.
  if (secretKey.startsWith('sk_live_') && apiBaseUrl !== STRIPE_API_BASE_URL) {
    throw new Error('STRIPE_API_BASE_URL may not be overridden with a live secret key');
  }

  return {
    port: Number(process.env['PORT'] ?? 3000),
    stripe: {
      secretKey,
      publishableKey: required('STRIPE_PUBLISHABLE_KEY'),
      webhookSecret: required('STRIPE_ONRAMP_WEBHOOK_SECRET'),
      mode: mode as OnrampMode,
      apiBaseUrl,
    },
    webBaseUrl: (process.env['WEB_BASE_URL'] ?? 'http://localhost:3001').replace(/\/+$/, ''),
    amlRetentionDays: Number(process.env['AML_RETENTION_DAYS'] ?? 1825),
    apiKey: required('PAYMENT_API_KEY'),
  };
}
