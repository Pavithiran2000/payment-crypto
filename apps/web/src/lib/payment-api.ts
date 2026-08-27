import "server-only";
import type { FiatCurrency, CryptoAsset, ChainNetwork } from "@pp/shared-types";

export class PaymentApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * What the browser needs to reach MoonPay.
 *
 * `widgetUrl` is signed over the deposit address, the amount, the asset and -
 * when IP matching is on - a hash of the payer's IP. It is a bearer credential
 * for one payment by one payer, so it is fetched server-side immediately before
 * render and handed to exactly one component. It is never in the status API and
 * never in a link the browser can share.
 */
export interface OnrampHandle {
  provider: "moonpay";
  widgetUrl: string;
  mode: "embedded" | "redirect";
}

export type OrderType = "PURCHASE" | "DONATION";

export interface OrderResponse {
  reference: string;
  status: string;
  orderType: OrderType;
  donationCampaign: string | null;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  cryptoAmountQuoted: string | null;
  cryptoAmountSettled: string | null;
  chainTxHash: string | null;
  quoteExpiresAt: string | null;
  checkoutUrl?: string;
  onramp?: OnrampHandle;
  createdAt: string;
}

export interface CreateOrderInput {
  fiatAmount: string;
  fiatCurrency: FiatCurrency;
  cryptoAsset: CryptoAsset;
  network: ChainNetwork;
  orderType?: OrderType;
  donationCampaign?: string;
  donorName?: string;
  customerEmail?: string;
  customerCountry?: string;
  /** Hashed into the widget URL so a signed URL cannot be reused elsewhere. */
  customerIpAddress?: string;
  idempotencyKey: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = env("PAYMENT_API_URL");
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": env("PAYMENT_API_KEY"),
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new PaymentApiError(`Payment gateway request failed: ${res.status}`, res.status, body);
  }

  return (await res.json()) as T;
}

// Merchant ID is a server-side constant, never accepted from the client -
// the browser must never be able to forge which merchant an order posts to.
export function createOrder(input: CreateOrderInput): Promise<OrderResponse> {
  const { idempotencyKey, ...body } = input;
  return request<OrderResponse>("/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ merchantId: env("PAYMENT_MERCHANT_ID"), ...body }),
  });
}

export function getOrder(reference: string): Promise<OrderResponse> {
  return request<OrderResponse>(`/orders/${encodeURIComponent(reference)}`, { method: "GET" });
}

/**
 * Fetched server-side, immediately before rendering the payment page.
 *
 * The payer's IP travels in a header, never a query string: an IP is personal
 * data and query strings end up in access logs, proxy logs and browser history.
 * The gateway hashes it into the signed URL so that URL only works from the
 * browser it was minted for.
 */
export function getOnrampHandle(reference: string, customerIpAddress?: string): Promise<OnrampHandle> {
  return request<OnrampHandle>(`/orders/${encodeURIComponent(reference)}/onramp-session`, {
    method: "GET",
    ...(customerIpAddress ? { headers: { "x-customer-ip": customerIpAddress } } : {}),
  });
}
