import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site-shell";
import { images } from "@/lib/images";
import { products } from "@/lib/catalog";

export const metadata: Metadata = { title: "Products" };

export default function Products() {
  return <><Header active="Products" /><main className="pale-page"><section className="wrap products-head"><p className="crumb"><Link href="/">Home</Link> / <b>Products</b></p><h1>Explore Our Terracotta<br />Collection</h1><p>Natural clay tiles and jaalis designed for beautiful, durable indoor and outdoor<br className="desktop-only" /> spaces. Meticulously crafted for architectural precision.</p><img className="products-hero" src={images.productsHero} alt="Modern living space with terracotta flooring" /></section><section className="wrap product-list"><div className="filters"><button className="selected">ALL PRODUCTS</button><button>FLOOR TILES</button><button>WALL TILES</button><button>CEILING TILES</button><button>ROOF TILES</button><button>STEP TILES</button><button>TERRACOTTA JAALIS</button></div><div className="product-grid">{products.map(p => <Link className="product-card" href={`/products/${p.slug}`} key={p.sku}><div className="product-image"><img src={p.image} alt={p.name} /><span>View product</span></div><small>SKU: {p.sku}</small><h2>{p.name}</h2><p>{p.text}</p>{p.specs.map(([k,v]) => <div className="spec" key={k}><span>{k}</span><span>{v}</span></div>)}<strong className="product-action">Select price and currency →</strong></Link>)}</div></section></main><Footer /></>;
}
