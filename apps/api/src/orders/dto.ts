import { z } from 'zod';
import { FIAT_DECIMALS, ASSET_DECIMALS } from '@pp/shared-types';

/**
 * A donation and a purchase are the same order down the same rails. The only
 * thing this discriminator changes is what the storefront renders and how the
 * receipt reads - never how the money moves.
 */
export const ORDER_TYPES = ['PURCHASE', 'DONATION'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const createOrderSchema = z
  .object({
    merchantId: z.string().uuid(),
    /** Amount as a plain decimal string. Never a JS number - floats lose money. */
    fiatAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string, max 2 dp'),
    fiatCurrency: z.enum(Object.keys(FIAT_DECIMALS) as [string, ...string[]]),
    cryptoAsset: z.enum(Object.keys(ASSET_DECIMALS) as [string, ...string[]]),
    network: z.enum(['polygon', 'ethereum']),
    orderType: z.enum(ORDER_TYPES).default('PURCHASE'),
    /**
     * Slug of the cause a donation supports. Constrained to a slug rather than
     * left as free text because it is rendered back to donors - the format is
     * the sanitisation.
     */
    donationCampaign: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'must be a lowercase slug')
      .optional(),
    /** Donor's chosen display name. Stored encrypted; optional by design. */
    donorName: z.string().min(1).max(120).optional(),
    customerEmail: z.string().email().optional(),
    customerCountry: z.string().length(2).optional(),
    /**
     * The payer's IP, forwarded by the BFF. Hashed into the widget URL as
     * `allowedIpAddress` so a signed URL cannot be lifted into another browser.
     */
    customerIpAddress: z.string().min(3).max(45).optional(),
  })
  .refine((v) => v.orderType === 'DONATION' || (!v.donationCampaign && !v.donorName), {
    message: 'donationCampaign and donorName are only valid on a DONATION order',
    path: ['orderType'],
  })
  .refine((v) => v.orderType !== 'DONATION' || !!v.donationCampaign, {
    message: 'donationCampaign is required on a DONATION order',
    path: ['donationCampaign'],
  });

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

/**
 * What the caller needs to put the customer in front of MoonPay.
 *
 * `widgetUrl` is signed, and the signature covers the deposit address, the
 * amount, the asset and - when IP matching is on - a hash of the payer's IP.
 * It is therefore a bearer credential for one payment by one payer, and is
 * treated like one: never logged, never in the public order projection, and
 * built fresh per request rather than persisted, so it can never outlive the
 * IP it was bound to.
 */
export interface OnrampHandle {
  provider: 'moonpay';
  widgetUrl: string;
  mode: 'embedded' | 'redirect';
}

export interface OrderResponse {
  reference: string;
  status: string;
  orderType: OrderType;
  donationCampaign: string | null;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  /** Indicative, from the quote taken at creation. Not what the customer receives. */
  cryptoAmountQuoted: string | null;
  /** Decimal string in the asset's own units. Null until MoonPay reports delivery. */
  cryptoAmountSettled: string | null;
  /** On-chain transaction hash for the delivery, once there is one. */
  chainTxHash: string | null;
  /** When the creation-time quote stops being meaningful. */
  quoteExpiresAt: string | null;
  /**
   * Where to send the customer. In `embedded` mode this is our own page, which
   * frames MoonPay; in `redirect` mode it is MoonPay's signed widget URL.
   */
  checkoutUrl?: string;
  onramp?: OnrampHandle;
  createdAt: string;
}
