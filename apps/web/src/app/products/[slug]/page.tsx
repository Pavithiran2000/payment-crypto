import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer, Header } from "@/components/site-shell";
import { ProductPurchase } from "@/components/product-purchase";
import { getProduct, products } from "@/lib/catalog";

export function generateStaticParams() { return products.map(product => ({ slug: product.slug })); }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const product = getProduct((await params).slug);
  return { title: product?.name ?? "Product" };
}

export default async function ProductDetail({ params }: { params: Promise<{ slug: string }> }) {
  const product = getProduct((await params).slug);
  if (!product) notFound();
  return <><Header active="Products" /><main className="pale-page detail-page"><div className="wrap"><p className="crumb"><Link href="/">Home</Link> / <Link href="/products">Products</Link> / <b>{product.name}</b></p><section className="detail-grid"><div className="detail-visual"><img src={product.image} alt={product.name} /><div className="material-note"><span>100%</span><p>Natural clay<br /><small>Crafted for enduring spaces</small></p></div></div><div className="detail-copy"><small>SKU: {product.sku}</small><h1>{product.name}</h1><p className="detail-lead">{product.text}</p><div className="detail-specs">{product.specs.map(([key,value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}</div><div className="detail-features"><span>✓ Natural terracotta</span><span>✓ Architectural grade</span><span>✓ Responsibly crafted</span></div><ProductPurchase slug={product.slug} /></div></section></div></main><Footer /></>;
}
