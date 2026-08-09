import type { Metadata } from "next";
import Link from "next/link";
import { CheckoutForm } from "@/components/checkout-form";
import { Footer, Header } from "@/components/site-shell";
import { SUPPORTED_FIAT_CURRENCIES, DEFAULT_FIAT_CURRENCY } from "@/lib/payment-config";
import { getProduct } from "@/lib/catalog";

export const metadata: Metadata = { title: "Checkout" };

export default async function Checkout({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const slug = typeof query.product === "string" ? query.product : "";
  const product = getProduct(slug);
  const price = typeof query.price === "string" ? Number(query.price) : 0;
  const currency = typeof query.currency === "string" && (SUPPORTED_FIAT_CURRENCIES as string[]).includes(query.currency) ? query.currency : DEFAULT_FIAT_CURRENCY;
  const quantityValue = typeof query.quantity === "string" ? Number(query.quantity) : 1;
  const quantity = Number.isFinite(quantityValue) ? Math.max(1, Math.min(999, Math.floor(quantityValue))) : 1;
  const valid = product && Number.isFinite(price) && price > 0;

  return <><Header active="Products" /><main className="checkout-page"><div className="wrap"><div className="checkout-head"><p className="eyebrow">SECURE CHECKOUT</p><h1>Complete your order</h1><p>Review your selection and provide your details below.</p></div>{valid ? <CheckoutForm product={product} price={price} currency={currency} quantity={quantity} /> : <section className="empty-checkout"><span>01</span><h1>Your checkout is empty</h1><p>Select a product, enter your preferred price and currency, then return here to complete your order.</p><Link className="btn" href="/products">Browse Products</Link></section>}</div></main><Footer /></>;
}
