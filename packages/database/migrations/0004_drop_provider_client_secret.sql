-- Drop the Stripe onramp session secret.
--
-- MoonPay has no session and no client secret. The customer-facing artefact is
-- a signed widget URL, and it is deliberately NOT stored: it is signed over a
-- hash of the payer's IP, so it belongs to one browser at one moment and is
-- rebuilt per request instead. Keeping a secret-bearing column with nothing
-- writing to it is a liability with no upside.
--
-- Irreversible by design. Any value still in this column belongs to a Stripe
-- session that no longer exists on Stripe's side either.

ALTER TABLE "orders" DROP COLUMN IF EXISTS "provider_client_secret";