"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";

/**
 * Stripe's embedded fiat-to-crypto onramp.
 *
 * The two scripts are loaded from Stripe's own domains rather than bundled.
 * That is not a preference: Stripe requires it for PCI compliance, and a
 * vendored copy breaks without warning when they ship a change.
 *
 * `@stripe/crypto` exists as an npm wrapper around exactly this, but it does no
 * more than inject these tags and hand back `window.StripeOnramp`. Using the
 * tags directly keeps a payment dependency out of the tree for no loss.
 *
 * Docs: https://docs.stripe.com/crypto/onramp/embedded
 */

interface OnrampSessionSnapshot {
  id: string;
  status: string;
}

interface OnrampSessionHandle {
  mount: (target: string | HTMLElement) => OnrampSessionHandle;
  addEventListener: (
    type: string,
    handler: (event: { type: string; payload: { session: OnrampSessionSnapshot } }) => void,
  ) => OnrampSessionHandle;
}

interface StripeOnrampInstance {
  createSession: (opts: {
    clientSecret: string;
    appearance?: { theme: "light" | "dark" };
  }) => OnrampSessionHandle;
}

declare global {
  interface Window {
    StripeOnramp?: (publishableKey: string) => StripeOnrampInstance;
  }
}

export function OnrampWidget({
  reference,
  clientSecret,
  publishableKey,
}: {
  reference: string;
  clientSecret: string;
  publishableKey: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const [scriptsReady, setScriptsReady] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Both stripe.js and crypto-onramp-outer.js must have run; the outer script
    // is what defines window.StripeOnramp.
    if (scriptsReady < 2 || mountedRef.current) return;
    const container = containerRef.current;
    const factory = window.StripeOnramp;
    if (!container || !factory) return;

    // Guarded: React 18+ runs effects twice in development, and mounting the
    // widget twice into the same node leaves a duplicate iframe behind.
    mountedRef.current = true;
    let cancelled = false;

    // Mounting is an interaction with an external system; its outcome is
    // reported back asynchronously rather than as a synchronous setState in the
    // effect body, which would cascade a render.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        factory(publishableKey)
          .createSession({ clientSecret })
          .addEventListener("onramp_session_updated", (event) => {
            const status = event.payload.session.status;
            // The widget's own event is a UI signal, nothing more. It never
            // marks the order paid - it just stops making the customer stare at
            // a finished form. The order page reads the webhook-driven record.
            if (status === "fulfillment_processing" || status === "fulfillment_complete" || status === "rejected") {
              router.push(`/orders/${encodeURIComponent(reference)}`);
            }
          })
          .mount(container);
      } catch {
        if (!cancelled) setError("We could not load the payment form. Please refresh and try again.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [scriptsReady, clientSecret, publishableKey, reference, router]);

  return (
    <>
      <Script
        src="https://js.stripe.com/dahlia/stripe.js"
        strategy="afterInteractive"
        onLoad={() => setScriptsReady((n) => n + 1)}
        onError={() => setError("The payment provider could not be reached.")}
      />
      <Script
        src="https://crypto-js.stripe.com/crypto-onramp-outer.js"
        strategy="afterInteractive"
        onLoad={() => setScriptsReady((n) => n + 1)}
        onError={() => setError("The payment provider could not be reached.")}
      />

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <div ref={containerRef} id="onramp-element" />

      {scriptsReady < 2 && !error ? <p className="secure-note">Loading secure payment…</p> : null}
    </>
  );
}
