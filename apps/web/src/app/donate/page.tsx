import type { Metadata } from "next";
import { DonationForm } from "@/components/donation-form";
import { Footer, Header } from "@/components/site-shell";
import { campaigns, getCampaign } from "@/lib/campaigns";

export const metadata: Metadata = {
  title: "Donate",
  description: "Support terracotta craft apprenticeships, kiln restoration and clay conservation.",
};

/**
 * Donations use exactly the same fiat-to-crypto rail as a purchase: the same
 * gateway, the same MoonPay quote, the same signed widget URL, the same
 * webhook-driven state machine and the same approved payout destination. Only
 * the framing differs.
 */
export default async function Donate({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const requested = typeof query.campaign === "string" ? query.campaign : "";
  // A campaign slug from the URL is only ever used to preselect one of ours.
  const initial = getCampaign(requested)?.slug ?? campaigns[0]?.slug ?? "";

  return (
    <>
      <Header active="Donate" />
      <main className="checkout-page">
        <div className="wrap">
          <div className="checkout-head">
            <p className="eyebrow">SUPPORT THE CRAFT</p>
            <h1>Keep terracotta work alive</h1>
            <p>
              Three programmes, one card payment. Give to apprenticeships, kiln restoration or clay
              conservation &mdash; your card is charged in your own currency and settled to the
              programme wallet automatically.
            </p>
          </div>

          <DonationForm campaigns={campaigns} initialCampaign={initial} />

          <section className="campaign-detail">
            {campaigns.map((c) => (
              <article key={c.slug}>
                <h3>{c.name}</h3>
                <p>{c.detail}</p>
              </article>
            ))}
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
