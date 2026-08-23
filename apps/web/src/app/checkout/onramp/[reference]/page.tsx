import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";
import { OnrampWidget } from "@/components/onramp-widget";
import { getOnrampHandle, getOrder, PaymentApiError } from "@/lib/payment-api";

export const metadata: Metadata = { title: "Complete your payment" };

/**
 * The payment step.
 *
 * The client secret is fetched here, on the server, and handed to exactly one
 * client component. It is never in the URL, never in the status API, and the
 * gateway refuses to issue one for an order that is no longer payable - so a
 * stale tab lands on the order page instead of a live payment form.
 */
export default async function OnrampPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;

  let handle;
  try {
    handle = await getOnrampHandle(reference);
  } catch (err) {
    if (err instanceof PaymentApiError && err.status === 404) {
      // Either the order does not exist or it has already reached a terminal
      // state. The order page tells the customer which, from the real record.
      redirect(`/orders/${encodeURIComponent(reference)}`);
    }
    throw err;
  }

  // Hosted mode never reaches this page in the normal flow (the BFF sends the
  // customer straight to Stripe), but a bookmarked URL might.
  if (handle.mode === "hosted") {
    redirect(`/orders/${encodeURIComponent(reference)}`);
  }

  const order = await getOrder(reference);

  return (
    <>
      <Header active="Products" />
      <main className="checkout-page">
        <div className="wrap">
          <div className="checkout-head">
            <p className="eyebrow">SECURE PAYMENT</p>
            <h1>Complete your payment</h1>
            <p>
              Paying {order.fiatAmount} {order.fiatCurrency} by card. Our payment partner handles
              the card details and identity checks &mdash; this site never sees them.
            </p>
          </div>

          <section className="checkout-card">
            <OnrampWidget
              reference={reference}
              clientSecret={handle.clientSecret}
              publishableKey={handle.publishableKey}
            />
          </section>

          <p className="secure-note">
            Order reference {order.reference}. Leaving this page will not cancel your order &mdash;
            you can return to it from your{" "}
            <Link href={`/orders/${encodeURIComponent(reference)}`}>order status page</Link>.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
