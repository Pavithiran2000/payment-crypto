"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import type { Product } from "@/lib/catalog";
import { formatMoney } from "@/lib/currencies";
import { SUPPORTED_CRYPTO_OPTIONS } from "@/lib/payment-config";

export function CheckoutForm({ product, price, currency, quantity }: { product: Product; price: number; currency: string; quantity: number }) {
  const [cryptoChoice, setCryptoChoice] = useState(() => SUPPORTED_CRYPTO_OPTIONS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  // Generated once per checkout attempt and reused across retries - the
  // gateway treats (merchantId, idempotencyKey) as the dedupe key, so a fresh
  // key on every submit would let a double-click create two paid orders.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const subtotal = price * quantity;

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);

    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement | null)?.value ?? "";

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productSlug: product.slug,
          price,
          quantity,
          currency,
          cryptoAsset: cryptoChoice?.asset,
          network: cryptoChoice?.network,
          customerEmail: email || undefined,
          idempotencyKey,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { checkoutUrl?: string; error?: string };

      if (!res.ok || !data.checkoutUrl) {
        setError(data.error ?? "We couldn't start checkout. Please try again.");
        setSubmitting(false);
        return;
      }

      setCheckoutUrl(data.checkoutUrl);
      window.location.href = data.checkoutUrl;
    } catch {
      setError("Network error - please check your connection and try again.");
      setSubmitting(false);
    }
  }

  if (checkoutUrl) {
    return (
      <section className="checkout-success">
        <div className="success-mark">→</div>
        <p className="eyebrow">REDIRECTING</p>
        <h1>Taking you to secure payment</h1>
        <p>
          If you are not redirected automatically,{" "}
          <a href={checkoutUrl}>click here to continue</a>.
        </p>
        <p className="secure-note">Your order has been created &mdash; it is safe to retry this link.</p>
      </section>
    );
  }

  return (
    <form className="checkout-layout" onSubmit={submitOrder}>
      <div className="checkout-fields">
        <section className="checkout-card">
          <div className="step-title">
            <span>1</span>
            <div>
              <h2>Contact information</h2>
              <p>We will use this to confirm your custom order.</p>
            </div>
          </div>
          <div className="checkout-inputs two-col">
            <label>
              First name
              <input name="firstName" autoComplete="given-name" required />
            </label>
            <label>
              Last name
              <input name="lastName" autoComplete="family-name" required />
            </label>
            <label>
              Email address
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <label>
              Phone number
              <input type="tel" name="phone" autoComplete="tel" required />
            </label>
          </div>
        </section>

        <section className="checkout-card">
          <div className="step-title">
            <span>2</span>
            <div>
              <h2>Billing address</h2>
              <p>Enter the address associated with your order.</p>
            </div>
          </div>
          <div className="checkout-inputs">
            <label>
              Street address
              <input name="address" autoComplete="street-address" required />
            </label>
            <div className="two-col">
              <label>
                City
                <input name="city" autoComplete="address-level2" required />
              </label>
              <label>
                State / Province
                <input name="state" autoComplete="address-level1" required />
              </label>
            </div>
            <div className="two-col">
              <label>
                Postal code
                <input name="postal" autoComplete="postal-code" required />
              </label>
              <label>
                Country
                <input name="country" autoComplete="country-name" required />
              </label>
            </div>
          </div>
        </section>

        <section className="checkout-card">
          <div className="step-title">
            <span>3</span>
            <div>
              <h2>Payment method</h2>
              <p>Pay by card. Our payment partner handles the card details and identity checks - this site never sees them - and settles to our custodial wallet.</p>
            </div>
          </div>
          <div className="payment-options">
            {SUPPORTED_CRYPTO_OPTIONS.map((option) => (
              <label
                className={cryptoChoice?.asset === option.asset && cryptoChoice?.network === option.network ? "selected" : ""}
                key={`${option.asset}-${option.network}`}
              >
                <input
                  type="radio"
                  name="cryptoOption"
                  value={`${option.asset}-${option.network}`}
                  checked={cryptoChoice?.asset === option.asset && cryptoChoice?.network === option.network}
                  onChange={() => setCryptoChoice(option)}
                />
                <span>
                  <b>{option.label}</b>
                  <small>Card payment, converted and settled automatically</small>
                </span>
                <i>CARD</i>
              </label>
            ))}
          </div>
        </section>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <aside className="order-summary">
        <p className="eyebrow">YOUR ORDER</p>
        <h2>Order summary</h2>
        <div className="summary-product">
          <img src={product.image} alt={product.name} />
          <div>
            <strong>{product.name}</strong>
            <span>SKU: {product.sku}</span>
            <span>Quantity: {quantity}</span>
          </div>
        </div>
        <div className="summary-lines">
          <div>
            <span>Unit price</span>
            <b>{formatMoney(price, currency)}</b>
          </div>
          <div>
            <span>Subtotal</span>
            <b>{formatMoney(subtotal, currency)}</b>
          </div>
          <div>
            <span>Delivery</span>
            <b>Calculated later</b>
          </div>
        </div>
        <div className="summary-total">
          <span>Total</span>
          <strong>{formatMoney(subtotal, currency)}</strong>
          <small>Selected currency: {currency}</small>
        </div>
        <button className="btn checkout-btn" type="submit" disabled={submitting || !cryptoChoice}>
          {submitting ? "Starting checkout…" : "Place Order　→"}
        </button>
        <p className="secure-note">By placing the order, you will be taken to our secure payment step. Your card details are entered into our payment partner&apos;s form, never into this site.</p>
        <Link className="edit-order" href={`/products/${product.slug}`}>
          ← Edit price or currency
        </Link>
      </aside>
    </form>
  );
}
