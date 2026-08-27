import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";
import { MoonPayWidget } from "@/components/moonpay-widget";
import { clientIp } from "@/lib/client-ip";
import { getOnrampHandle, getOrder, PaymentApiError } from "@/lib/payment-api";

export const metadata: Metadata = { title: "Complete your payment" };

/**
 * The payment step.
 *
 * The signed widget URL is minted here, on the server, at render time, and
 * handed to exactly one client component. It is never in our URL, never in the
 * status API, and the gateway refuses to issue one for an order that is no
 * longer payable - so a stale tab lands on the order page instead of a live
 * payment form.
 *
 * Minting it per render rather than storing it is what makes IP matching work:
 * the URL is signed over a hash of the IP this request came from, so a customer
 * who returns on a different network gets a fresh, correctly-bound URL instead
 * of MoonPay's "Unverified Connection" error.
 */
export default async function OnrampPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  const payerIp = clientIp(await headers());

  let handle;
  try {
    handle = await getOnrampHandle(reference, payerIp);
  } catch (err) {
    if (err instanceof PaymentApiError && err.status === 404) {
      // Either the order does not exist or it has already reached a terminal
      // state. The order page tells the customer which, from the real record.
      redirect(`/orders/${encodeURIComponent(reference)}`);
    }
    throw err;
  }

  // In redirect mode the BFF sends the customer straight to MoonPay, so nothing
  // routes here - but a bookmarked URL might, and framing a widget that expects
  // a full-page context would silently break Apple Pay and 3DS.
  if (handle.mode === "redirect") {
    redirect(handle.widgetUrl);
  }

  const order = await getOrder(reference);
  const isDonation = order.orderType === "DONATION";

  return (
    <>
      <Header active={isDonation ? "Donate" : "Products"} />
      <main className="checkout-page">
        <div className="wrap">
          <div className="checkout-head">
            <p className="eyebrow">SECURE PAYMENT</p>
            <h1>{isDonation ? "Complete your donation" : "Complete your payment"}</h1>
            <p>
              {isDonation ? "Donating" : "Paying"} {order.fiatAmount} {order.fiatCurrency} by card.
              Our payment partner handles the card details and identity checks &mdash; this site
              never sees them.
            </p>
          </div>

          <section className="checkout-card">
            <MoonPayWidget reference={reference} widgetUrl={handle.widgetUrl} />
          </section>

          <p className="secure-note">
            Reference {order.reference}. Leaving this page will not cancel it &mdash; you can return
            from your{" "}
            <Link href={`/orders/${encodeURIComponent(reference)}`}>status page</Link>.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
