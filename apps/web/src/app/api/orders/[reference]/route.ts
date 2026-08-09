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
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      cryptoAsset: order.cryptoAsset,
      network: order.network,
    });
  } catch (err) {
    if (err instanceof PaymentApiError) {
      return NextResponse.json({ error: "Order not found" }, { status: err.status === 404 ? 404 : 502 });
    }
    throw err;
  }
}
