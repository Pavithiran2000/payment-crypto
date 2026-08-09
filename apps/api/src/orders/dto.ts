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
});

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export interface OrderResponse {
  reference: string;
  status: string;
  fiatAmount: string;
  fiatCurrency: string;
  cryptoAsset: string;
  network: string;
  checkoutUrl?: string;
  createdAt: string;
}
