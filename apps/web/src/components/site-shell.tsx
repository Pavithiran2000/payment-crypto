import Link from "next/link";

const nav = ["Home", "Products", "Applications", "About Us", "Projects", "Contact"] as const;
const hrefs: Record<(typeof nav)[number], string> = { Home: "/", Products: "/products", Applications: "/applications", "About Us": "/about", Projects: "/projects", Contact: "/contact" };

export function Header({ active }: { active: (typeof nav)[number] }) {
  return <header className="site-header"><div className="wrap nav-wrap">
    <Link className="brand" href="/">Bangalore Clay Tiles</Link>
    <nav className="desktop-nav" aria-label="Primary">{nav.map(item => <Link key={item} className={active === item ? "active" : ""} href={hrefs[item]}>{item}</Link>)}</nav>
    <Link className="search" href="/products" aria-label="Search products">⌕</Link>
    <details className="mobile-menu"><summary aria-label="Open menu">☰</summary><nav>{nav.map(item => <Link key={item} href={hrefs[item]}>{item}</Link>)}</nav></details>
  </div></header>;
}

export function Footer() {
  return <footer><div className="wrap footer-grid"><div><h3>Bangalore Clay Tiles</h3><p>© 2024 Bangalore Clay Tiles.<br />Architectural Excellence in Terracotta.</p></div><div><h3>Legal</h3><Link href="#">Privacy Policy</Link><Link href="#">Terms of Service</Link></div><div><h3>Resources</h3><Link href="#">Sustainability</Link><Link href="#">Installation Guide</Link></div></div></footer>;
}
