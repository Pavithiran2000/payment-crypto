import { images } from "@/lib/images";

export type Product = {
  slug: string;
  sku: string;
  name: string;
  text: string;
  image: string;
  specs: [string, string][];
};

export const products: Product[] = [
  { slug: "nuvocotto-roof-tile", sku: "RT-NUVO", name: "Nuvocotto Roof Tile", text: "A refined natural-clay roof tile for sloped RCC and fabricated structures.", image: images.roofTile, specs: [["Size", "19.5 x 11.5 in"], ["Source", "Vietnam"]] },
  { slug: "edan-jaali", sku: "JL-EDAN", name: "Edan Jaali", text: "A sculptural terracotta screen that filters daylight and supports natural airflow.", image: images.jaaliProduct, specs: [["Size", "300 x 200 x 100 mm"], ["Coverage", "1.55 pcs / sq.ft."]] },
  { slug: "natural-red-floor-tile", sku: "FT-NR300", name: "Natural Red Floor Tile", text: "A warm, matte clay surface for interiors, terraces and courtyards.", image: images.floorTile, specs: [["Size", "300 x 300 x 10 mm"], ["Use", "Indoor + outdoor"]] },
  { slug: "wire-cut-wall-tile", sku: "WT-WC", name: "Wire Cut Wall Tile", text: "Textured terracotta cladding for precise interior and exterior wall applications.", image: images.brickProduct, specs: [["Material", "Natural clay"], ["Finish", "Wire cut"]] },
];

export function getProduct(slug: string) {
  return products.find((product) => product.slug === slug);
}
