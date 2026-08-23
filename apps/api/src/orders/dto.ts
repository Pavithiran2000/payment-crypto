import { z } from 'zod';
import { FIAT_DECIMALS, ASSET_DECIMALS } from '@pp/shared-types';

export const createOrderSchema = z.object({
  merchantId: z.string().uuid(),
  /** Amount as a plain decimal string. Never a JS number - floats lose money. */
  fiatAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string, max 2 dp'),
  fiatCurrency: z.enum(Object.keys(FIAT_DECIMALS) as [string, ...string[]]),
  cryptoAsset: z.enum(Object.keys(ASSET_DECIMALS) as [string, ...string[]]),
  network: z.enum(['polygon', 'ethereum']),
  customerEmail: z.string().email().optional(),
  customerCountry: z.string().length(2).optional(),
  /**
   * The payer's IP, forwarded by the BFF. Stripe uses it to reject
   * unsupportable geographies at session creation rather than showing the
   * customer a widget that will never work.
   */
  customerIpAddress: z.string().min(3).max(45).optional(),
});

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

/** What the caller needs to mount Stripe's widget. Never reaches the browser raw. */
export interface OnrampHandle {
  sessionId: string;
  clientSecret: string;
  publishableKey: string;
  mode: 'embedded' | 'hosted';
}

export interface OrderResponse {
  reference: string;
  status: string;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  /** Decimal string in the asset's own units. Null until Stripe reports delivery. */
  cryptoAmountSettled: string | null;
  /** On-chain transaction hash for the delivery, once there is one. */
  chainTxHash: string | null;
  /**
   * Where to send the customer. In `embedded` mode this is our own page, which
   * mounts Stripe's widget; in `hosted` mode it is Stripe's standalone page.
   */
  checkoutUrl?: string;
  onramp?: OnrampHandle;
  createdAt: string;
}
