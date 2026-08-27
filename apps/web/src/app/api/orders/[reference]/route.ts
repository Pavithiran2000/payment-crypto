import { NextResponse } from "next/server";
import { getOrder, PaymentApiError } from "@/lib/payment-api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ reference: string }> },
): Promise<Response> {
  const { reference } = await params;

  try {
    const order = await getOrder(reference);
    // Status polling only needs to know where the order stands - omit PII
    // and internal fields the gateway response might otherwise carry.
    return NextResponse.json({
      reference: order.reference,
      status: order.status,
      // Lets the status page tell a donor "thank you" rather than "your order
      // is confirmed". Not sensitive: the customer chose it moments ago.
      orderType: order.orderType,
      donationCampaign: order.donationCampaign,
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      cryptoAsset: order.cryptoAsset,
      network: order.network,
      // What actually settled, once a verified webhook says so. The on-chain
      // transaction hash is deliberately NOT projected here: it resolves to the
      // merchant's deposit address, which is not the customer's to publish.
      cryptoAmountSettled: order.cryptoAmountSettled,
    });
  } catch (err) {
    if (err instanceof PaymentApiError) {
      return NextResponse.json({ error: "Order not found" }, { status: err.status === 404 ? 404 : 502 });
    }
    throw err;
  }
}
