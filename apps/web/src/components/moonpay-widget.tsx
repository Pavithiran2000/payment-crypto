"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * MoonPay's on-ramp widget, framed on our own page.
 *
 * There is no script to load and no SDK in the bundle. MoonPay's widget IS a
 * page at `buy.moonpay.com`, and the entire instruction to it - asset, chain,
 * amount, and our deposit address - travels in a query string that our server
 * has already signed. Embedding the signed URL in an iframe is therefore the
 * whole integration; `@moonpay/moonpay-js` does no more than build this same
 * element, and pulling a payment SDK into the bundle to do it would add supply
 * chain surface for nothing.
 *
 * The URL is a bearer credential for one payment. It arrives as a prop from a
 * server component that fetched it moments ago and is never written to the
 * address bar, `localStorage`, or a link.
 *
 * `allow="camera"` is not optional: MoonPay's identity check asks the customer
 * to photograph an ID document, and a cross-origin iframe cannot reach the
 * camera unless the embedder delegates the permission. Without it KYC dead-ends
 * with no error the customer can act on.
 *
 * Apple Pay and Google Pay do NOT work here - MoonPay states mobile payment
 * sheets are unavailable inside an iframe. That is the price of keeping the
 * customer on our domain, and it is why `redirect` mode exists as a
 * configuration option rather than being deleted.
 *
 * Docs: https://dev.moonpay.com/widget/on-ramp/integration-methods/url
 */
export function MoonPayWidget({
  reference,
  widgetUrl,
}: {
  reference: string;
  widgetUrl: string;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [tooSlow, setTooSlow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A signed URL that MoonPay refuses - expired signature, IP mismatch,
    // suspended key - still renders *something* inside the frame, and the
    // cross-origin boundary means we cannot read what. All we can honestly
    // detect is that nothing has loaded, so after a generous wait the customer
    // gets a way out rather than an indefinite spinner.
    timerRef.current = setTimeout(() => setTooSlow(true), 15_000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (loaded && timerRef.current) clearTimeout(timerRef.current);
  }, [loaded]);

  return (
    <>
      <iframe
        title="Secure payment"
        src={widgetUrl}
        className="onramp-frame"
        onLoad={() => setLoaded(true)}
        // Camera and microphone for identity capture; payment for the Payment
        // Request API; accelerometer and gyroscope for MoonPay's liveness check.
        allow="accelerometer; autoplay; camera; gyroscope; microphone; payment"
        // MoonPay is a payment origin we deliberately trust with scripts, forms
        // and its own popups (3DS lands in one). It is still denied
        // `allow-top-navigation`, so it cannot navigate our page away.
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"
      />

      {!loaded && !tooSlow ? <p className="secure-note">Loading secure payment…</p> : null}

      {tooSlow && !loaded ? (
        <p className="field-error" role="alert">
          The payment form is taking longer than expected.{" "}
          <button type="button" className="linklike" onClick={() => router.refresh()}>
            Try reloading it
          </button>
          , or check your{" "}
          <button
            type="button"
            className="linklike"
            onClick={() => router.push(`/orders/${encodeURIComponent(reference)}`)}
          >
            order status
          </button>
          .
        </p>
      ) : null}
    </>
  );
}
