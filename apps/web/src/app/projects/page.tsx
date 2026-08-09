import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site-shell";
import { images } from "@/lib/images";
export const metadata: Metadata = { title: "Projects" };
const projects = [[images.projectHome,"Creating a Modern Home Style","project-wide"],[images.projectJaali,"Light & Shadow",""],[images.projectWall,"Classic Looks with Wall Tiles",""],[images.villa,"The Heritage Villa","project-wide"]];
export default function Projects() { return <><Header active="Projects" /><main className="pale-page project-page"><section className="wrap project-head"><h1>Featured Architectural Projects</h1><p>A curated gallery of real-world applications showcasing the timeless elegance and<br className="desktop-only" /> sustainable craftsmanship of terracotta in contemporary design.</p><div className="project-grid">{projects.map(([src,title,cls])=><article className={cls} key={title}><img src={src} alt={title} /><div><h2>{title}</h2><span>View project →</span></div></article>)}</div><div className="project-cta"><h2>Ready to start your project?</h2><Link className="btn" href="/contact">Discuss Your Vision</Link></div></section></main><Footer /></>; }
