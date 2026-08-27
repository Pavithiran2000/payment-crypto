"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import type { Campaign } from "@/lib/campaigns";
import { formatMoney } from "@/lib/currencies";
import { SUPPORTED_FIAT, DEFAULT_FIAT_CURRENCY, fiatOption } from "@/lib/payment-config";

export function DonationForm({
  campaigns,
  initialCampaign,
}: {
  campaigns: Campaign[];
  initialCampaign: string;
}) {
  const [campaignSlug, setCampaignSlug] = useState(initialCampaign);
  const [currency, setCurrency] = useState<string>(DEFAULT_FIAT_CURRENCY);
  const [amount, setAmount] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [redirecting, setRedirecting] = useState<string | null>(null);

  // Generated once per attempt and reused across retries - the gateway treats
  // (merchantId, idempotencyKey) as the dedupe key, so a fresh key on every
  // submit would let a double-click create two donations.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const campaign = campaigns.find((c) => c.slug === campaignSlug) ?? campaigns[0];
  const limits = fiatOption(currency);
  const numericAmount = Number(amount);

  // MoonPay's minimum is per-currency and, in some currencies, well above a
  // typical suggested gift. Showing a chip the payment partner would refuse is
  // worse than showing fewer chips, so they are filtered rather than clamped.
  const chips = useMemo(() => {
    if (!campaign || !limits) return [];
    const usable = campaign.suggested.filter((v) => v >= limits.minAmount);
    // In a currency where every suggestion is below the floor (LKR, where the
    // minimum is ~7000), offer the floor itself and sensible multiples instead
    // of an empty row.
    return usable.length > 0 ? usable : [1, 2, 5, 10].map((m) => limits.minAmount * m);
  }, [campaign, limits]);

  async function submitDonation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !campaign || !limits) return;
    setError("");

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Enter a donation amount greater than zero.");
      return;
    }
    if (numericAmount < limits.minAmount) {
      setError(
        `Card donations start at ${formatMoney(limits.minAmount, currency)} - that is our payment partner's minimum, not ours.`,
      );
      return;
    }

    setSubmitting(true);
    const form = event.currentTarget;
    const donorName = (form.elements.namedItem("donorName") as HTMLInputElement | null)?.value ?? "";
    const donorEmail = (form.elements.namedItem("donorEmail") as HTMLInputElement | null)?.value ?? "";

    try {
      const res = await fetch("/api/donate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaign: campaign.slug,
          amount: numericAmount,
          currency,
          donorName: anonymous ? undefined : donorName || undefined,
          donorEmail: donorEmail || undefined,
          anonymous,
          idempotencyKey,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { checkoutUrl?: string; error?: string };

      if (!res.ok || !data.checkoutUrl) {
        setError(data.error ?? "We couldn't start your donation. Please try again.");
        setSubmitting(false);
        return;
      }

      setRedirecting(data.checkoutUrl);
      window.location.href = data.checkoutUrl;
    } catch {
      setError("Network error - please check your connection and try again.");
      setSubmitting(false);
    }
  }

  if (redirecting) {
    return (
      <section className="checkout-success">
        <div className="success-mark">→</div>
        <p className="eyebrow">REDIRECTING</p>
        <h1>Taking you to secure payment</h1>
        <p>
          If you are not redirected automatically, <a href={redirecting}>click here to continue</a>.
        </p>
        <p className="secure-note">Your donation has been created &mdash; it is safe to retry this link.</p>
      </section>
    );
  }

  if (!campaign || !limits) return null;

  return (
    <form className="donate-layout" onSubmit={submitDonation}>
      <div className="checkout-fields">
        <section className="checkout-card">
          <div className="step-title">
            <span>1</span>
            <div>
              <h2>Choose a cause</h2>
              <p>Every gift is attributed to exactly one programme.</p>
            </div>
          </div>
          <div className="campaign-options">
            {campaigns.map((option) => (
              <label className={option.slug === campaign.slug ? "selected" : ""} key={option.slug}>
                <input
                  type="radio"
                  name="campaign"
                  value={option.slug}
                  checked={option.slug === campaign.slug}
                  onChange={() => setCampaignSlug(option.slug)}
                />
                <span>
                  <b>{option.name}</b>
                  <small>{option.blurb}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="checkout-card">
          <div className="step-title">
            <span>2</span>
            <div>
              <h2>Choose an amount</h2>
              <p>Paid by card and settled to our programme wallet automatically.</p>
            </div>
          </div>

          <div className="amount-chips">
            {chips.map((value) => (
              <button
                type="button"
                key={value}
                className={Number(amount) === value ? "chip selected" : "chip"}
                onClick={() => setAmount(String(value))}
              >
                {formatMoney(value, currency)}
              </button>
            ))}
          </div>

          <div className="money-row">
            <label className="price-field">
              Other amount
              <input
                aria-label="Donation amount"
                min={limits.minAmount}
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="currency-field">
              Currency
              <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {SUPPORTED_FIAT.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.code}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="secure-note">
            Minimum {formatMoney(limits.minAmount, currency)} &middot; maximum{" "}
            {formatMoney(limits.maxAmount, currency)} per card donation.
          </p>
        </section>

        <section className="checkout-card">
          <div className="step-title">
            <span>3</span>
            <div>
              <h2>About you</h2>
              <p>Optional. We store only what you give us, encrypted, and only for as long as the law requires.</p>
            </div>
          </div>
          <div className="checkout-inputs">
            <label className="checkbox-field">
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              <span>Give anonymously</span>
            </label>
            <label>
              Display name
              <input name="donorName" autoComplete="name" disabled={anonymous} placeholder={anonymous ? "Anonymous" : ""} />
            </label>
            <label>
              Email for your receipt
              <input type="email" name="donorEmail" autoComplete="email" />
            </label>
          </div>
        </section>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <aside className="order-summary">
        <p className="eyebrow">YOUR DONATION</p>
        <h2>{campaign.name}</h2>
        <div className="summary-product">
          <img src={campaign.image} alt="" />
          <div>
            <strong>{campaign.name}</strong>
            <span>{campaign.blurb}</span>
          </div>
        </div>
        <div className="summary-total">
          <span>Total</span>
          <strong>
            {Number.isFinite(numericAmount) && numericAmount > 0
              ? formatMoney(numericAmount, currency)
              : `${currency} 0.00`}
          </strong>
          <small>{anonymous ? "Given anonymously" : "Attributed to your display name"}</small>
        </div>
        <button className="btn checkout-btn" type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "Donate　→"}
        </button>
        <p className="secure-note">
          Card details and identity checks are handled by our payment partner &mdash; this site never
          sees them. Donations are not tax-deductible unless your receipt says otherwise.
        </p>
        <Link className="edit-order" href="/about">
          ← Learn more about our work
        </Link>
      </aside>
    </form>
  );
}
