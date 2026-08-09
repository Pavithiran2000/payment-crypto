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

export interface OrderResponse {
  reference: string;
  status: string;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  checkoutUrl?: string;
  createdAt: string;
}

export interface CreateOrderInput {
  fiatAmount: string;
  fiatCurrency: FiatCurrency;
  cryptoAsset: CryptoAsset;
  network: ChainNetwork;
  customerEmail?: string;
  customerCountry?: string;
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
