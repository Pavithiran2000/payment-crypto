import { NextResponse } from "next/server";
import { createOrder, PaymentApiError } from "@/lib/payment-api";
import { getProduct } from "@/lib/catalog";
import { clientIp } from "@/lib/client-ip";
import { SUPPORTED_CRYPTO_OPTIONS, fiatOption } from "@/lib/payment-config";
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

  const fiat = typeof body.currency === "string" ? fiatOption(body.currency) : undefined;
  if (!fiat) {
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
  const total = price * quantity;
  const fiatAmount = total.toFixed(2);

  // MoonPay enforces a per-currency minimum and the gateway's quote call would
  // surface the refusal - but as a 400 the customer sees only after committing
  // to a checkout. Checking it here turns that into an answer they can act on.
  if (total < fiat.minAmount) {
    return NextResponse.json(
      {
        error: `The minimum card payment in ${fiat.code} is ${fiat.minAmount}. Increase the quantity or choose another currency.`,
      },
      { status: 400 },
    );
  }
  if (total > fiat.maxAmount) {
    return NextResponse.json(
      { error: `The maximum card payment in ${fiat.code} is ${fiat.maxAmount}. Please contact us for larger orders.` },
      { status: 400 },
    );
  }

  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 16
    ? body.idempotencyKey
    : undefined;
  if (!idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey" }, { status: 400 });
  }

  const customerEmail = typeof body.customerEmail === "string" && body.customerEmail ? body.customerEmail : undefined;
  const customerIpAddress = clientIp(req.headers);

  try {
    const order = await createOrder({
      fiatAmount,
      fiatCurrency: fiat.code as FiatCurrency,
      cryptoAsset: cryptoOption.asset as CryptoAsset,
      network: cryptoOption.network as ChainNetwork,
      orderType: "PURCHASE",
      ...(customerEmail ? { customerEmail } : {}),
      ...(customerIpAddress ? { customerIpAddress } : {}),
      idempotencyKey,
    });

    // Only the reference and where to go next. The signed widget URL stays on
    // the server in embedded mode: the payment page mints its own, server-side,
    // bound to the IP of the request that renders it.
    return NextResponse.json({
      reference: order.reference,
      checkoutUrl:
        order.onramp?.mode === "redirect" && order.checkoutUrl
          ? order.checkoutUrl
          : `/checkout/onramp/${encodeURIComponent(order.reference)}`,
    });
  } catch (err) {
    if (err instanceof PaymentApiError) {
      // The gateway's 400s are customer-actionable ("not available in your
      // country", "below the minimum") and worth passing through verbatim;
      // everything else stays generic.
      const message =
        err.status === 400 && typeof (err.body as { message?: unknown } | undefined)?.message === "string"
          ? ((err.body as { message: string }).message)
          : "Unable to create order";
      return NextResponse.json({ error: message }, { status: err.status >= 500 ? 502 : 400 });
    }
    throw err;
  }
}
