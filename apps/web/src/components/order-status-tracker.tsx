"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isTerminal, type OrderStatus } from "@pp/shared-types";

interface OrderSnapshot {
  reference: string;
  status: OrderStatus;
  orderType: "PURCHASE" | "DONATION";
  donationCampaign: string | null;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
}

const STATUS_COPY: Record<OrderStatus, { title: string; detail: string }> = {
  CREATED: { title: "Order created", detail: "Waiting for you to complete checkout." },
  CHECKOUT_OPENED: { title: "Checkout opened", detail: "Complete the payment steps in the checkout window." },
  KYC_PENDING: { title: "Verifying your identity", detail: "This is a one-time step required by our payment partner." },
  PAYMENT_PENDING: { title: "Processing payment", detail: "Your card payment is being processed." },
  PAYMENT_CONFIRMED: { title: "Payment confirmed", detail: "Your payment was received. Converting to settlement currency." },
  CRYPTO_CONVERTED: { title: "Conversion complete", detail: "Funds are being sent to complete your order." },
  CRYPTO_SENT: { title: "Settlement sent", detail: "Finalising your order." },
  COMPLETED: { title: "Order complete", detail: "Thank you - your order is confirmed." },
  KYC_FAILED: { title: "Verification failed", detail: "We could not verify your identity. Please contact support." },
  CARD_DECLINED: { title: "Card declined", detail: "Your card was declined. Please try again with a different card." },
  PAYMENT_FAILED: { title: "Payment failed", detail: "Your payment could not be completed. Please try again." },
  CONVERSION_FAILED: { title: "Processing issue", detail: "We hit an issue completing your order. Our team has been notified." },
  CRYPTO_TRANSFER_FAILED: { title: "Processing issue", detail: "We hit an issue completing your order. Our team has been notified." },
  CANCELLED: { title: "Order cancelled", detail: "This order was cancelled." },
  EXPIRED: { title: "Order expired", detail: "This checkout session expired. Please start a new order." },
  MANUAL_REVIEW: { title: "Under review", detail: "Your order needs a manual check. We'll be in touch shortly." },
  DISPUTED: { title: "Payment disputed", detail: "This order's payment has been disputed. Contact support for details." },
  CHARGEBACK_RECEIVED: { title: "Chargeback received", detail: "Contact support for details on this order." },
  REVERSED: { title: "Payment reversed", detail: "This payment was reversed. Contact support for details." },
};

/**
 * Copy that differs for a donation. Everything else - the states, the polling,
 * the fact that only a verified webhook advances anything - is identical,
 * because it is literally the same order running the same rails.
 */
const DONATION_COPY: Partial<Record<OrderStatus, { title: string; detail: string }>> = {
  CREATED: { title: "Donation started", detail: "Waiting for you to complete the payment step." },
  PAYMENT_CONFIRMED: { title: "Payment received", detail: "Thank you. We are settling your gift to the programme wallet." },
  COMPLETED: { title: "Thank you", detail: "Your donation is confirmed and settled to the programme." },
  CANCELLED: { title: "Donation cancelled", detail: "This donation was cancelled. Nothing was charged." },
  EXPIRED: { title: "Donation expired", detail: "This payment session expired. Please start again." },
};

const POLL_INTERVAL_MS = 4000;

export function OrderStatusTracker({ reference }: { reference: string }) {
  const [order, setOrder] = useState<OrderSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(reference)}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setError(res.status === 404 ? "We couldn't find this order." : "Unable to fetch order status.");
          return;
        }
        const data = (await res.json()) as OrderSnapshot;
        if (cancelled) return;
        setOrder(data);
        setError(null);

        // The redirect landing on this page proves nothing by itself - only a
        // verified webhook advances status server-side. Keep polling until
        // the gateway itself reports a terminal state.
        if (!isTerminal(data.status)) {
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setError("Network error while checking order status.");
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [reference]);

  if (error && !order) {
    return (
      <section className="checkout-success">
        <p className="eyebrow">ORDER STATUS</p>
        <h1>{error}</h1>
        <p>Order reference: {reference}</p>
        <Link className="btn" href="/products">
          Continue Shopping
        </Link>
      </section>
    );
  }

  if (!order) {
    return (
      <section className="checkout-success">
        <p className="eyebrow">ORDER STATUS</p>
        <h1>Loading order status…</h1>
      </section>
    );
  }

  const donation = order.orderType === "DONATION";
  const copy = (donation ? DONATION_COPY[order.status] : undefined) ?? STATUS_COPY[order.status];
  const terminal = isTerminal(order.status);

  return (
    <section className="checkout-success">
      <div className="success-mark">{terminal && order.status === "COMPLETED" ? "✓" : "…"}</div>
      <p className="eyebrow">{donation ? "DONATION STATUS" : terminal ? "ORDER STATUS" : "PROCESSING"}</p>
      <h1>{copy.title}</h1>
      <p>{copy.detail}</p>
      <div className="success-reference">
        <span>{donation ? "Donation reference" : "Order reference"}</span>
        <strong>{order.reference}</strong>
      </div>
      <div className="summary-total">
        <span>Amount</span>
        <strong>
          {order.fiatAmount} {order.fiatCurrency}
        </strong>
        <small>
          Settled as {order.cryptoAsset} on {order.network}
          {donation && order.donationCampaign ? ` · ${order.donationCampaign.replace(/-/g, " ")}` : ""}
        </small>
      </div>
      {!terminal && <p className="secure-note">This page updates automatically - no need to refresh.</p>}
      <Link className="btn" href={donation ? "/donate" : "/products"}>
        {donation ? "Back to Donations" : "Continue Shopping"}
      </Link>
    </section>
  );
}
