import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";

export const metadata: Metadata = { title: "Processing your payment" };

/**
 * Landing target for TRANSAK_REDIRECT_URL - a single static URL shared by
 * every order (checkout.ts sets it from one config value, there is no
 * per-order substitution). Transak appends its own query params identifying
 * the order; which key holds our reference is UNCONFIRMED against the actual
 * Transak account/environment (see docs/PAYMENT_INTEGRATION_PLAN.md §7.2) -
 * this checks the commonly documented ones and degrades gracefully if none
 * are present, since a botched redirect must never be read as "not paid".
 */
export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const candidateKeys = ["partnerOrderId", "orderId", "reference"];
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
