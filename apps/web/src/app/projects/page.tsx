import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/site-shell";
import { images } from "@/lib/images";
export const metadata: Metadata = { title: "Projects" };
const projects = [[images.projectHome,"Terracotta Across the Modern Home","project-wide"],[images.projectJaali,"The Ventilated Façade",""],[images.projectWall,"The Warm Envelope",""],[images.villa,"Light, Filtered","project-wide"]];
export default function Projects() { return <><Header active="Projects" /><main className="pale-page project-page"><section className="wrap project-head"><h1>Selected Clay Applications</h1><p>Real projects showing how terracotta changes with its context—from breathable screens<br className="desktop-only" /> and warm wall surfaces to richly layered interiors.</p><div className="project-grid">{projects.map(([src,title,cls])=><article className={cls} key={title}><img src={src} alt={title} /><div><h2>{title}</h2><span>View application →</span></div></article>)}</div><div className="project-cta"><h2>Bring the brief. We&apos;ll bring the clay.</h2><Link className="btn" href="/contact">Plan Your Project</Link></div></section></main><Footer /></>; }
