"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/currencies";
import { SUPPORTED_FIAT_CURRENCIES, DEFAULT_FIAT_CURRENCY } from "@/lib/payment-config";

export function ProductPurchase({ slug }: { slug: string }) {
  const router = useRouter();
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<string>(DEFAULT_FIAT_CURRENCY);
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState("");
  const currencies = SUPPORTED_FIAT_CURRENCIES;
  const numericPrice = Number(price);
  const total = Number.isFinite(numericPrice) ? numericPrice * quantity : 0;

  function continueToCheckout() {
    if (!price || !Number.isFinite(numericPrice) || numericPrice <= 0) {
      setError("Enter a valid price greater than zero.");
      return;
    }
    setError("");
    const params = new URLSearchParams({ product: slug, price: numericPrice.toString(), currency, quantity: quantity.toString() });
    router.push(`/checkout?${params.toString()}`);
  }

  return <div className="purchase-box"><div className="purchase-heading"><span>Custom order</span><h2>Set your order value</h2><p>Enter your agreed price and choose the currency you would like to use.</p></div><div className="money-row"><label className="price-field">Price<input aria-label="Product price" min="0" step="any" inputMode="decimal" placeholder="0.00" type="number" value={price} onChange={e => setPrice(e.target.value)} /></label><label className="currency-field">Currency<select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)}>{currencies.map(code => <option key={code} value={code}>{code}</option>)}</select></label></div><label className="quantity-field">Quantity<div><button type="button" onClick={() => setQuantity(q => Math.max(1, q - 1))} aria-label="Decrease quantity">-</button><input aria-label="Quantity" type="number" min="1" max="999" value={quantity} onChange={e => setQuantity(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} /><button type="button" onClick={() => setQuantity(q => Math.min(999, q + 1))} aria-label="Increase quantity">+</button></div></label><div className="order-preview"><span>Estimated total</span><strong>{price && numericPrice > 0 ? formatMoney(total, currency) : `${currency} 0.00`}</strong></div>{error && <p className="field-error" role="alert">{error}</p>}<button className="btn checkout-btn" type="button" onClick={continueToCheckout}>Continue to Checkout　→</button><p className="secure-note">Secure checkout · Price is reviewed with your order</p></div>;
}
