import type { Metadata } from "next";
import { Footer, Header } from "@/components/site-shell";
import { OrderStatusTracker } from "@/components/order-status-tracker";

export const metadata: Metadata = { title: "Order status" };

export default async function OrderStatusPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;

  return (
    <>
      <Header active="Products" />
      <main className="checkout-page">
        <div className="wrap">
          <OrderStatusTracker reference={reference} />
        </div>
      </main>
      <Footer />
    </>
  );
}
