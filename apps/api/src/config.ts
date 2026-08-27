import {
  MOONPAY_API_BASE_URL,
  resolveMoonPayConfig,
  type MoonPayConfig,
  type WidgetMode,
} from '@pp/provider-moonpay';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function boolean(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export interface AppConfig {
  port: number;
  moonpay: MoonPayConfig;
  /**
   * Base URL of the storefront. The checkout URL handed back with a new order
   * and MoonPay's `redirectURL` are both built from this, so it must be the
   * address the customer's browser can actually reach.
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

  const mode = process.env['MOONPAY_WIDGET_MODE'] ?? 'embedded';
  if (mode !== 'embedded' && mode !== 'redirect') {
    throw new Error('MOONPAY_WIDGET_MODE must be "embedded" or "redirect"');
  }

  const toleranceSeconds = optional('MOONPAY_WEBHOOK_TOLERANCE_SECONDS');

  // resolveMoonPayConfig does the real validation: all three keys present, all
  // three from the same environment, and no base-URL override once they are live.
  const moonpay = resolveMoonPayConfig({
    publishableKey: required('MOONPAY_PUBLISHABLE_KEY'),
    secretKey: required('MOONPAY_SECRET_KEY'),
    webhookKey: required('MOONPAY_WEBHOOK_KEY'),
    mode: mode as WidgetMode,
    apiBaseUrl: process.env['MOONPAY_API_BASE_URL'] ?? MOONPAY_API_BASE_URL,
    widgetBaseUrl: optional('MOONPAY_WIDGET_BASE_URL'),
    requireIpMatch: boolean('MOONPAY_REQUIRE_IP_MATCH', false),
    ...(toleranceSeconds ? { webhookToleranceMs: Number(toleranceSeconds) * 1000 } : {}),
    theme: optional('MOONPAY_THEME') as 'light' | 'dark' | undefined,
    themeId: optional('MOONPAY_THEME_ID'),
  });

  return {
    port: Number(process.env['PORT'] ?? 3000),
    moonpay,
    webBaseUrl: (process.env['WEB_BASE_URL'] ?? 'http://localhost:3001').replace(/\/+$/, ''),
    amlRetentionDays: Number(process.env['AML_RETENTION_DAYS'] ?? 1825),
    apiKey: required('PAYMENT_API_KEY'),
  };
}
