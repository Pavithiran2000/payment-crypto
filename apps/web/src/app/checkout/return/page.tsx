import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";

export const metadata: Metadata = { title: "Processing your payment" };

/**
 * A soft landing, not part of the normal flow.
 *
 * The embedded onramp keeps the customer on `/checkout/onramp/[reference]` and
 * moves them to the order page itself, so nothing routes here. It is kept for
 * two cases that do happen: a bookmark from the old hosted-redirect flow, and
 * the Stripe-hosted standalone page, which accepts no return URL at all - a
 * customer who finds their own way back needs somewhere sensible to land.
 *
 * Which query key would carry a reference is unknowable in advance, so this
 * checks the plausible ones and degrades gracefully. A botched return must
 * never be read as "not paid".
 */
export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const candidateKeys = ["reference", "partner_order_id", "partnerOrderId", "orderId"];
  let reference: string | undefined;
  for (const key of candidateKeys) {
    const value = query[key];
    if (typeof value === "string" && value) {
      reference = value;
      break;
    }
  }

  if (reference) {
    redirect(`/orders/${encodeURIComponent(reference)}`);
  }

  return (
    <>
      <Header active="Products" />
      <main className="checkout-page">
        <div className="wrap">
          <section className="checkout-success">
            <div className="success-mark">✓</div>
            <p className="eyebrow">RETURNED FROM PAYMENT</p>
            <h1>We&apos;re checking your payment</h1>
            <p>
              We could not automatically identify your order from this page. This does not mean your
              payment failed &mdash; please check your email for a confirmation, or contact us with your
              order reference if you have one.
            </p>
            <Link className="btn" href="/products">
              Continue Shopping
            </Link>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
