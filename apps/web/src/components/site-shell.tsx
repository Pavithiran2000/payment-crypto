import Link from "next/link";
import { images } from "@/lib/images";

const nav = ["Home", "Products", "Applications", "About Us", "Projects", "Donate", "Contact"] as const;
const hrefs: Record<(typeof nav)[number], string> = { Home: "/", Products: "/products", Applications: "/applications", "About Us": "/about", Projects: "/projects", Donate: "/donate", Contact: "/contact" };

export function Header({ active }: { active: (typeof nav)[number] }) {
  return <header className="site-header"><div className="wrap nav-wrap">
    <Link className="brand" href="/"><img src={images.logo} alt="" /><span>Biswa Clay Tiles</span></Link>
    <nav className="desktop-nav" aria-label="Primary">{nav.map(item => <Link key={item} className={active === item ? "active" : ""} href={hrefs[item]}>{item}</Link>)}</nav>
    <Link className="search" href="/products" aria-label="Search products">⌕</Link>
    <details className="mobile-menu"><summary aria-label="Open menu">☰</summary><nav>{nav.map(item => <Link key={item} href={hrefs[item]}>{item}</Link>)}</nav></details>
  </div></header>;
}

export function Footer() {
  return <footer><div className="wrap footer-grid"><div className="footer-brand"><img src={images.logo} alt="" /><h3>Biswa Clay Tiles</h3><p>Dealers and wholesalers in natural clay products for architectural spaces.</p></div><div><h3>Explore</h3><Link href="/products">Products</Link><Link href="/projects">Projects</Link><Link href="/applications">Applications</Link></div><div><h3>Support Us</h3><Link href="/donate">Donate</Link><Link href="/donate?campaign=artisan-apprenticeships">Apprenticeships</Link></div><div><h3>Contact</h3><a href="tel:+918722181271">+91 87221 81271</a><a href="tel:+919482481271">+91 94824 81271</a><a href="mailto:bctiles5@gmail.com">bctiles5@gmail.com</a></div></div></footer>;
}
