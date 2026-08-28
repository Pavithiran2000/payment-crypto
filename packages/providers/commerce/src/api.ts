/**
 * MoonPay Commerce REST calls.
 *
 * Endpoints and auth verified against a live sandbox account on 2026-08-28
 * (see docs/moonpay-commerce-assessment.md §5.2-RESULT):
 *
 *   GET  /v1/currency/all              currencies. PUBLIC - no auth needed
 *   GET  /v1/wallet/all                registered payout wallets
 *   POST /v1/paylink/create/api-key    create a checkout
 *
 * ⚠️ AUTH IS DOUBLE. `/v1/wallet/all` and paylink creation require BOTH the
 * public key as an `apiKey` query parameter AND the secret as a bearer token.
 * With only one they answer:
 *     {"message":"Please provide apiKey and bearer token","code":401}
 * That is not documented anywhere; it was found by hitting it.
 */
import type { CommerceConfig } from './config.js';
import { payLinkUrl } from './config.js';
import type { CommerceCurrency } from './mapping.js';

export class CommerceApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body?: unknown,
    public readonly commerceCode?: number | undefined,
  ) {
    super(message);
    this.name = 'CommerceApiError';
  }
}

/** Registered payout wallet, from `GET /v1/wallet/all`. */
export interface CommerceWallet {
  id: string;
  publicKey: string;
  name?: string | undefined;
  /** `BTC`, `SOL`, `ETH`… Match this to the recipient currency's chain engine. */
  blockchainEngineType?: string | undefined;
  /** `CONNECTED` (a signed-in wallet) or `PAYOUT` (an address you pasted in). */
  walletCategory?: string | undefined;
}

export interface CommercePayLink {
  id: string;
  name?: string | undefined;
  /** Customer-facing checkout URL, derived from the id. */
  url: string;
  /**
   * What the server actually stored. Worth reading rather than assuming: a
   * request may be accepted with `canPayWithCard: true` and echoed back false
   * if card is unavailable for that recipient currency.
   */
  canPayWithCard: boolean | null;
  raw: Record<string, unknown>;
}

const TIMEOUT_MS = 15_000;

async function request<T>(
  cfg: CommerceConfig,
  path: string,
  init: RequestInit & { authenticated?: boolean } = {},
): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${cfg.apiBaseUrl}${path}${sep}apiKey=${encodeURIComponent(cfg.publicKey)}`;

  const { authenticated = true, ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // Both are required together; see the header note.
        ...(authenticated ? { authorization: `Bearer ${cfg.secretKey}` } : {}),
        ...rest.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['message'] === 'string'
        ? ((body as Record<string, unknown>)['message'] as string)
        : `Commerce request failed: ${res.status}`;
    const code =
      typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['code'] === 'number'
        ? ((body as Record<string, unknown>)['code'] as number)
        : undefined;
    throw new CommerceApiError(msg, res.status, body, code);
  }

  return body as T;
}

/** Unwrap the array shapes this API returns in different places. */
function asArray<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (typeof body === 'object' && body !== null) {
    const o = body as Record<string, unknown>;
    for (const key of ['data', 'currencies', 'wallets', 'items']) {
      if (Array.isArray(o[key])) return o[key] as T[];
    }
  }
  return [];
}

/**
 * The full currency catalogue.
 *
 * Public - no credentials required, which is why a production catalogue can be
 * inspected from a sandbox-only account. Resolve ids from this at runtime;
 * never hardcode them (see mapping.ts §1).
 */
export async function fetchCurrencies(cfg: CommerceConfig): Promise<CommerceCurrency[]> {
  const body = await request<unknown>(cfg, '/v1/currency/all', { authenticated: false });
  return asArray<CommerceCurrency>(body);
}

/** Payout wallets registered in the dashboard under Settings -> Wallets. */
export async function fetchWallets(cfg: CommerceConfig): Promise<CommerceWallet[]> {
  const body = await request<unknown>(cfg, '/v1/wallet/all');
  return asArray<CommerceWallet>(body);
}

/**
 * Find the registered wallet able to receive a given currency.
 *
 * Matches on the currency's own chain engine rather than a hardcoded symbol.
 * Getting this wrong is not a cosmetic bug: pairing a BTC recipient currency
 * with a Solana wallet is rejected by the API with "The currency and wallet
 * blockchain do not match", and the inverse mistake - a wallet on the wrong
 * chain that IS accepted - would send funds somewhere unrecoverable.
 */
export function findWalletForCurrency(
  wallets: CommerceWallet[],
  currency: CommerceCurrency,
): CommerceWallet | null {
  const engine = currency.blockchain?.engine?.type;
  if (!engine) return null;
  return wallets.find((w) => w.blockchainEngineType === engine) ?? null;
}

export interface CreatePayLinkInput {
  /** Shown on the checkout page. */
  name: string;
  description?: string | undefined;
  /** Already converted to the pricing currency's base units - see mapping.ts §2. */
  price: string;
  pricingCurrencyId: string;
  recipientCurrencyId: string;
  recipientWalletId: string;
  /**
   * Offer the fiat/card on-ramp alongside crypto.
   *
   * Whether a card option actually renders for a native-BTC recipient is
   * UNCONFIRMED - it does not appear in devnet for any currency, including
   * stablecoins, so the environment cannot answer it. Read `canPayWithCard`
   * off the response rather than assuming the request was honoured.
   */
  canPayWithCard?: boolean | undefined;
  requireEmail?: boolean | undefined;
  redirectUrl?: string | undefined;
}

export async function createPayLink(
  cfg: CommerceConfig,
  input: CreatePayLinkInput,
): Promise<CommercePayLink> {
  const body = await request<Record<string, unknown>>(cfg, '/v1/paylink/create/api-key', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      price: input.price,
      pricingCurrency: input.pricingCurrencyId,
      features: {
        canPayWithCard: input.canPayWithCard ?? true,
        requireEmail: input.requireEmail ?? false,
        ...(input.redirectUrl ? { shouldRedirectOnSuccess: true } : {}),
      },
      recipients: [
        { currencyId: input.recipientCurrencyId, walletId: input.recipientWalletId },
      ],
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
    }),
  });

  const id = typeof body['id'] === 'string' ? body['id'] : null;
  if (!id) {
    throw new CommerceApiError('Commerce pay link response had no id', 200, body);
  }

  const features =
    typeof body['features'] === 'object' && body['features'] !== null
      ? (body['features'] as Record<string, unknown>)
      : {};

  return {
    id,
    name: typeof body['name'] === 'string' ? body['name'] : undefined,
    url: payLinkUrl(cfg, id),
    canPayWithCard:
      typeof features['canPayWithCard'] === 'boolean' ? (features['canPayWithCard'] as boolean) : null,
    raw: body,
  };
}
