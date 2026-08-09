import { NextResponse } from "next/server";
import { createOrder, PaymentApiError } from "@/lib/payment-api";
import { getProduct } from "@/lib/catalog";
import { SUPPORTED_FIAT_CURRENCIES, SUPPORTED_CRYPTO_OPTIONS } from "@/lib/payment-config";
import type { FiatCurrency, CryptoAsset, ChainNetwork } from "@pp/shared-types";

interface CheckoutRequestBody {
  productSlug?: unknown;
  price?: unknown;
  quantity?: unknown;
  currency?: unknown;
  cryptoAsset?: unknown;
  network?: unknown;
  customerEmail?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: CheckoutRequestBody;
  try {
    body = (await req.json()) as CheckoutRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Every value below is attacker-controlled. Nothing here is trusted as-is -
  // it is re-validated against server-known constraints before being sent on.
  const product = typeof body.productSlug === "string" ? getProduct(body.productSlug) : undefined;
  if (!product) {
    return NextResponse.json({ error: "Unknown product" }, { status: 400 });
  }

  const price = typeof body.price === "number" ? body.price : Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return NextResponse.json({ error: "Invalid price" }, { status: 400 });
  }

  const quantityRaw = typeof body.quantity === "number" ? body.quantity : Number(body.quantity);
  const quantity = Number.isFinite(quantityRaw) ? Math.max(1, Math.min(999, Math.floor(quantityRaw))) : NaN;
  if (!Number.isFinite(quantity)) {
    return NextResponse.json({ error: "Invalid quantity" }, { status: 400 });
  }

  const currency = typeof body.currency === "string" ? body.currency : "";
  if (!(SUPPORTED_FIAT_CURRENCIES as string[]).includes(currency)) {
    return NextResponse.json({ error: "Unsupported currency" }, { status: 400 });
  }

  const cryptoOption = SUPPORTED_CRYPTO_OPTIONS.find(
    (opt) => opt.asset === body.cryptoAsset && opt.network === body.network,
  );
  if (!cryptoOption) {
    return NextResponse.json({ error: "Unsupported crypto asset/network combination" }, { status: 400 });
  }

  // This storefront sells custom-quoted orders (there is no fixed catalog
  // price, see lib/catalog.ts) - the agreed price is legitimately entered by
  // the customer on the product page. What's re-derived server-side here is
  // the *total* from price x quantity, formatted deterministically to 2dp,
  // rather than trusting a client-formatted amount string directly.
  const fiatAmount = (price * quantity).toFixed(2);

  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 16
    ? body.idempotencyKey
    : undefined;
  if (!idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey" }, { status: 400 });
  }

  const customerEmail = typeof body.customerEmail === "string" && body.customerEmail ? body.customerEmail : undefined;

  try {
    const order = await createOrder({
      fiatAmount,
      fiatCurrency: currency as FiatCurrency,
      cryptoAsset: cryptoOption.asset as CryptoAsset,
      network: cryptoOption.network as ChainNetwork,
      customerEmail,
      idempotencyKey,
    });

    // Only what the client needs to proceed - the full gateway response
    // (status, timestamps, internal fields) is not the frontend's concern.
    return NextResponse.json({ reference: order.reference, checkoutUrl: order.checkoutUrl });
  } catch (err) {
    if (err instanceof PaymentApiError) {
      return NextResponse.json({ error: "Unable to create order" }, { status: err.status >= 500 ? 502 : 400 });
    }
    throw err;
  }
}
