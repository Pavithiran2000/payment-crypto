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
  { slug: "classic-square-floor-tile", sku: "FT-4022", name: "Classic Square Floor Tile", text: "Traditional smooth finish, ideal for high-traffic interior spaces.", image: images.floorTile, specs: [["Size", "300 x 300 mm"], ["Thickness", "15 mm"]] },
  { slug: "floral-pattern-jaali", sku: "JL-105", name: "Floral Pattern Jaali", text: "Elegant privacy screen blocks allowing natural light and ventilation.", image: images.jaaliProduct, specs: [["Size", "200 x 200 x 60 mm"], ["Weight", "2.5 kg"]] },
  { slug: "rustic-brick-cladding", sku: "WT-809", name: "Rustic Brick Cladding", text: "Textured exterior wall tiles for a warm, natural facade.", image: images.brickProduct, specs: [["Size", "225 x 75 mm"], ["Finish", "Wire-cut"]] },
];

export function getProduct(slug: string) {
  return products.find((product) => product.slug === slug);
}
