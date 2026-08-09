CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'CHECKOUT_OPENED', 'KYC_PENDING', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'CRYPTO_CONVERTED', 'CRYPTO_SENT', 'COMPLETED', 'KYC_FAILED', 'CARD_DECLINED', 'PAYMENT_FAILED', 'CONVERSION_FAILED', 'CRYPTO_TRANSFER_FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW', 'DISPUTED', 'CHARGEBACK_RECEIVED', 'REVERSED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dek_wrapped" text,
	"erased_at" timestamp with time zone,
	"erasure_reason" text,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erased_implies_no_dek" CHECK (("data_subjects"."erased_at" IS NULL) = ("data_subjects"."dek_wrapped" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"sumsub_applicant_id" text,
	"kyb_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"kyb_decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"reason" text NOT NULL,
	"provider_event_id" uuid,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"data_subject_id" uuid NOT NULL,
	"customer_email_enc" text,
	"customer_email_idx" text,
	"customer_country" text,
	"fiat_amount" bigint NOT NULL,
	"fiat_currency" text NOT NULL,
	"fiat_decimals" integer NOT NULL,
	"crypto_asset" text NOT NULL,
	"crypto_network" text NOT NULL,
	"crypto_decimals" integer NOT NULL,
	"crypto_amount_quoted" bigint,
	"crypto_amount_settled" bigint,
	"quote_id" text,
	"quote_expires_at" timestamp with time zone,
	"payout_destination_id" uuid,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_order_id" text,
	"chain_tx_hash" text,
	"zebpay_credited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "fiat_amount_positive" CHECK ("orders"."fiat_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"active_from" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approver_differs_from_proposer" CHECK ("payout_destinations"."approved_by" IS NULL OR "payout_destinations"."approved_by" <> "payout_destinations"."proposed_by")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text,
	"raw_payload" text NOT NULL,
	"parsed_payload" jsonb,
	"signature_valid" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_data_subject_id_data_subjects_id_fk" FOREIGN KEY ("data_subject_id") REFERENCES "public"."data_subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_payout_destination_id_payout_destinations_id_fk" FOREIGN KEY ("payout_destination_id") REFERENCES "public"."payout_destinations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "osh_order_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_reference_unique" ON "orders" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_idempotency_unique" ON "orders" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_provider_order_unique" ON "orders" USING btree ("provider_order_id") WHERE "orders"."provider_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_email_idx" ON "orders" USING btree ("customer_email_idx");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_changed_idx" ON "orders" USING btree ("status","status_changed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_dest_unique_active" ON "payout_destinations" USING btree ("merchant_id","asset","network","address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_events_unique" ON "provider_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_events_unprocessed_idx" ON "provider_events" USING btree ("received_at") WHERE "provider_events"."processed_at" IS NULL;