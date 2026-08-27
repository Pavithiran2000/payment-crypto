-- Donations ride the same rails as purchases.
--
-- `order_type` discriminates what an order IS, not how it is paid: a donation
-- takes the same quote, the same signed widget URL, the same webhook and the
-- same state machine as a purchase. Splitting them into two tables would have
-- duplicated the state machine, which is the one thing here that must have a
-- single implementation.
--
-- `donor_name_enc` is ciphertext under the data subject's DEK, like every other
-- identifier in this schema, so a donor erasure request destroys it with one
-- key deletion. The CHECK keeps donation-only fields off purchase rows, so the
-- table cannot drift into holding a donor name on an order nobody donated.

ALTER TABLE "orders" ADD COLUMN "order_type" text DEFAULT 'PURCHASE' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "donation_campaign" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "donor_name_enc" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_type_campaign_idx" ON "orders" USING btree ("order_type","donation_campaign");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "order_type_known" CHECK ("orders"."order_type" IN ('PURCHASE', 'DONATION'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "donation_fields_require_donation" CHECK ("orders"."order_type" = 'DONATION' OR ("orders"."donation_campaign" IS NULL AND "orders"."donor_name_enc" IS NULL));