-- Local development seed: one merchant with one approved payout destination.
--
-- The destination is inserted pre-approved and pre-matured purely so local work
-- is not blocked. In any real environment a destination only becomes usable via
-- the maker-checker flow plus the cooling-off period - see the CHECK constraint
-- `approver_differs_from_proposer` on payout_destinations.

INSERT INTO merchants (id, legal_name, kyb_status)
VALUES ('11111111-1111-1111-1111-111111111111', 'Acme Test Merchant Pvt Ltd', 'APPROVED')
ON CONFLICT (id) DO NOTHING;

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
