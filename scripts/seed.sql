-- Local development seed: one merchant with approved payout destinations.
--
-- Destinations are inserted pre-approved and pre-matured purely so local work
-- is not blocked. In any real environment a destination only becomes usable via
-- the maker-checker flow plus the cooling-off period - see the CHECK constraint
-- `approver_differs_from_proposer` on payout_destinations.

INSERT INTO merchants (id, legal_name, kyb_status)
VALUES ('11111111-1111-1111-1111-111111111111', 'Acme Test Merchant Pvt Ltd', 'APPROVED')
ON CONFLICT (id) DO NOTHING;

-- USDC on Polygon is the default pair: MoonPay lists `usdc_polygon` as live,
-- unsuspended and unrestricted, and Polygon's network fee on a stablecoin
-- transfer is a fraction of Ethereum's. USDT (`usdt_polygon`) is equally
-- available at MoonPay but is seeded second, behind written confirmation from
-- the exchange that it will credit USDT to the entity account.
--
-- Note for sandbox work: MoonPay's sandbox holds no testnet liquidity for
-- `usdc_polygon`, so a sandbox purchase of this pair fails at delivery however
-- correct the integration is. The third destination below exists so the full
-- happy path can be rehearsed on USDC (Ethereum), which does support test mode.
INSERT INTO payout_destinations
  (id, merchant_id, label, asset, network, address, proposed_by, approved_by, approved_at, active_from)
VALUES (
  '22222222-2222-2222-2222-222222222223',
  '11111111-1111-1111-1111-111111111111',
  'Binance Entity Account USDC',
  'USDC', 'polygon',
  '0x2222222222222222222222222222222222222222',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  now(),
  now() - interval '1 day'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO payout_destinations
  (id, merchant_id, label, asset, network, address, proposed_by, approved_by, approved_at, active_from)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'Binance Entity Account USDT',
  'USDT', 'polygon',
  '0x1111111111111111111111111111111111111111',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  now(),
  now() - interval '1 day'
) ON CONFLICT (id) DO NOTHING;

-- Sandbox rehearsal only. MoonPay's `usdc` (Ethereum) is the sole USDC code
-- with `supportsTestMode: true`, so it is the only way to drive a sandbox
-- transaction all the way to delivery. Do NOT approve an Ethereum destination
-- in production without deciding that the network fee is acceptable.
INSERT INTO payout_destinations
  (id, merchant_id, label, asset, network, address, proposed_by, approved_by, approved_at, active_from)
VALUES (
  '22222222-2222-2222-2222-222222222224',
  '11111111-1111-1111-1111-111111111111',
  'Binance Entity Account USDC (Ethereum, sandbox rehearsal)',
  'USDC', 'ethereum',
  '0x3333333333333333333333333333333333333333',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  now(),
  now() - interval '1 day'
) ON CONFLICT (id) DO NOTHING;
