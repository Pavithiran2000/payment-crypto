import { NextResponse } from "next/server";
import { createOrder, PaymentApiError } from "@/lib/payment-api";
import { getCampaign } from "@/lib/campaigns";
import { clientIp } from "@/lib/client-ip";
import { SUPPORTED_CRYPTO_OPTIONS, fiatOption } from "@/lib/payment-config";
import type { FiatCurrency, CryptoAsset, ChainNetwork } from "@pp/shared-types";

interface DonateRequestBody {
  campaign?: unknown;
  amount?: unknown;
  currency?: unknown;
  donorName?: unknown;
  donorEmail?: unknown;
  anonymous?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Donations run the same fiat-to-crypto path as purchases.
 *
 * Same gateway, same MoonPay quote, same signed widget URL, same webhook, same
 * state machine, same payout destination. The only difference is `orderType`
 * and the campaign the gift is attributed to - which is the point: a second
 * payment path would be a second place for money to go missing.
 */
export async function POST(req: Request): Promise<Response> {
  let body: DonateRequestBody;
  try {
    body = (await req.json()) as DonateRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The campaign must be one WE published. A slug from the request is only ever
  // used to look one up, never stored as given.
  const campaign = typeof body.campaign === "string" ? getCampaign(body.campaign) : undefined;
  if (!campaign) {
    return NextResponse.json({ error: "Unknown campaign" }, { status: 400 });
  }

  const fiat = typeof body.currency === "string" ? fiatOption(body.currency) : undefined;
  if (!fiat) {
    return NextResponse.json({ error: "Unsupported currency" }, { status: 400 });
  }

  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Enter a donation amount greater than zero." }, { status: 400 });
  }

  // Rounded to the currency's minor unit before anything else looks at it, so
  // the amount validated is exactly the amount sent to the gateway.
  const fiatAmount = amount.toFixed(2);
  const rounded = Number(fiatAmount);

  if (rounded < fiat.minAmount) {
    return NextResponse.json(
      {
        error: `Card donations start at ${fiat.minAmount} ${fiat.code} - that is our payment partner's minimum, not ours.`,
      },
      { status: 400 },
    );
  }
  if (rounded > fiat.maxAmount) {
    return NextResponse.json(
      { error: `Card donations are capped at ${fiat.maxAmount} ${fiat.code}. Please contact us to give more.` },
      { status: 400 },
    );
  }

  const cryptoOption = SUPPORTED_CRYPTO_OPTIONS[0];
  if (!cryptoOption) {
    return NextResponse.json({ error: "Donations are temporarily unavailable" }, { status: 503 });
  }

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 16
      ? body.idempotencyKey
      : undefined;
  if (!idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey" }, { status: 400 });
  }

  // Anonymous is the default reading of an unticked box AND of an empty name:
  // the smallest amount of PII that satisfies the feature is the right amount,
  // and a donor who left the field blank did not consent to being named.
  const anonymous = body.anonymous === true;
  const rawName = typeof body.donorName === "string" ? body.donorName.trim() : "";
  const donorName = anonymous || rawName.length === 0 ? undefined : rawName.slice(0, 120);

  const donorEmail =
    typeof body.donorEmail === "string" && body.donorEmail.includes("@") ? body.donorEmail : undefined;
  const customerIpAddress = clientIp(req.headers);

  try {
    const order = await createOrder({
      fiatAmount,
      fiatCurrency: fiat.code as FiatCurrency,
      cryptoAsset: cryptoOption.asset as CryptoAsset,
      network: cryptoOption.network as ChainNetwork,
      orderType: "DONATION",
      donationCampaign: campaign.slug,
      ...(donorName ? { donorName } : {}),
      ...(donorEmail ? { customerEmail: donorEmail } : {}),
      ...(customerIpAddress ? { customerIpAddress } : {}),
      idempotencyKey,
    });

    return NextResponse.json({
      reference: order.reference,
      checkoutUrl:
        order.onramp?.mode === "redirect" && order.checkoutUrl
          ? order.checkoutUrl
          : `/checkout/onramp/${encodeURIComponent(order.reference)}`,
    });
  } catch (err) {
    if (err instanceof PaymentApiError) {
      const message =
        err.status === 400 && typeof (err.body as { message?: unknown } | undefined)?.message === "string"
          ? (err.body as { message: string }).message
          : "Unable to start your donation";
      return NextResponse.json({ error: message }, { status: err.status >= 500 ? 502 : 400 });
    }
    throw err;
  }
}
