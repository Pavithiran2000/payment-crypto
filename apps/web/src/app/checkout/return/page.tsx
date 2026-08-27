import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";

export const metadata: Metadata = { title: "Processing your payment" };

/**
 * A soft landing, not part of the normal flow.
 *
 * MoonPay's `redirectURL` points at `/orders/:reference` directly - we know the
 * reference when we mint the widget URL, so there is no reason to bounce the
 * customer through a page that has to guess it. This route exists for the two
 * cases that still happen: a bookmark from an earlier integration, and a
 * customer who found their own way back after a 3DS or app-switch detour.
 *
 * Which query key would carry a reference is unknowable in advance, so this
 * checks the plausible ones and degrades gracefully. `transactionId` is
 * deliberately absent from the list: it is MoonPay's identifier, not ours, and
 * `/orders/:reference` would not resolve it. A botched return must never be
 * read as "not paid".
 */
export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const candidateKeys = ["reference", "externalTransactionId", "partnerOrderId", "orderId"];
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
