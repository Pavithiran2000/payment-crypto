import { images } from "@/lib/images";

/**
 * The causes a donation may be given to.
 *
 * A server-side list, not a database table and not free text from the form.
 * The slug is rendered back to donors on the status page and travels into the
 * gateway, so constraining it to a value from this file is the sanitisation -
 * there is no path by which a donor supplies a campaign name we did not write.
 *
 * `suggested` amounts are in the donor's chosen currency and are filtered
 * against MoonPay's per-currency minimum at render time. A £5 chip that MoonPay
 * would refuse is worse than no chip at all.
 */
export type Campaign = {
  slug: string;
  name: string;
  blurb: string;
  detail: string;
  image: string;
  suggested: number[];
};

export const campaigns: Campaign[] = [
  {
    slug: "artisan-apprenticeships",
    name: "Artisan Apprenticeships",
    blurb: "Fund a year of training for a young terracotta craftsperson.",
    detail:
      "Hand-forming, glazing and kiln work are taught one apprentice at a time. A full year covers tools, clay, kiln time and a living stipend.",
    image: images.jaaliProduct,
    suggested: [25, 50, 100, 250],
  },
  {
    slug: "kiln-restoration",
    name: "Kiln Restoration",
    blurb: "Rebuild the wood-fired kilns that traditional tiles depend on.",
    detail:
      "Traditional kilns need relining every few years. Restoration keeps older firing techniques alive instead of replacing them with gas.",
    image: images.brickProduct,
    suggested: [50, 100, 500, 1000],
  },
  {
    slug: "clay-conservation",
    name: "Clay & Water Conservation",
    blurb: "Protect the clay beds and reclaim water used in production.",
    detail:
      "Settling tanks and closed-loop water reclamation cut fresh water use substantially and keep the clay beds workable for the next generation.",
    image: images.story,
    suggested: [25, 75, 150, 300],
  },
];

export function getCampaign(slug: string): Campaign | undefined {
  return campaigns.find((c) => c.slug === slug);
}
