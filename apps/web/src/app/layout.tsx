import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://terracottatiles.online"),
  title: { default: "Biswa Clay Tiles", template: "%s | Biswa Clay Tiles" },
  description: "Bengaluru dealer and wholesaler for clay roof tiles, jaalis, wall cladding, floor tiles and architectural terracotta.",
  icons: { icon: "/assets/logo.png" },
  openGraph: {
    title: "Biswa Clay Tiles",
    description: "Natural clay products for roofs, walls, floors and spaces that breathe.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
