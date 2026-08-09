import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Bangalore Clay Tiles", template: "%s | Bangalore Clay Tiles" },
  description: "Premium natural terracotta tiles and architectural elements for modern spaces.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
