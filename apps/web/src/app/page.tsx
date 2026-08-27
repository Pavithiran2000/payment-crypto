import Link from "next/link";
import { Footer, Header } from "@/components/site-shell";
import { images } from "@/lib/images";

export default function Home() {
  return <><Header active="Home" /><main>
    <section className="home-hero">
      <img src={images.productsHero} alt="Terracotta tiled modern home" />
      <div className="home-overlay" />
      <div className="home-copy wrap">
        <p className="eyebrow">ARCHITECTURAL TERRACOTTA · BENGALURU</p>
        <h1>Earth, shaped for<br />modern life.</h1>
        <p>Natural clay roofing, façades, floors and screens—selected, supplied and installed for spaces that age with character.</p>
        <div className="button-row"><Link className="btn" href="/products">Explore the Collection</Link><Link className="btn btn-light" href="/projects">View Projects</Link></div>
      </div>
    </section>
    <section className="intro-section wrap"><p className="eyebrow">BISWA CLAY TILES</p><h2>A clay language for every surface.</h2><p>Roof tiles, architectural jaalis, wall cladding, floors, bricks, ceiling tiles and accessories—supported by practical material guidance for every project.</p></section>
  </main><Footer /></>;
}
