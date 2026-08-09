import Link from "next/link";
import { Footer, Header } from "@/components/site-shell";
import { images } from "@/lib/images";

export default function Home() {
  return <><Header active="Home" /><main>
    <section className="home-hero">
      <img src={images.productsHero} alt="Terracotta tiled modern home" />
      <div className="home-overlay" />
      <div className="home-copy wrap">
        <p className="eyebrow">ROOTED IN EARTH. REFINED FOR TODAY.</p>
        <h1>Timeless Terracotta<br />for Modern Spaces</h1>
        <p>Handcrafted clay tiles, jaalis and architectural elements made for beautiful, enduring spaces.</p>
        <div className="button-row"><Link className="btn" href="/products">Explore the Collection</Link><Link className="btn btn-light" href="/projects">View Projects</Link></div>
      </div>
    </section>
    <section className="intro-section wrap"><p className="eyebrow">BANGALORE CLAY TILES</p><h2>Natural materials. Architectural precision.</h2><p>We bring the warmth of traditional clay craftsmanship to contemporary homes, gardens and landmark spaces.</p></section>
  </main><Footer /></>;
}
