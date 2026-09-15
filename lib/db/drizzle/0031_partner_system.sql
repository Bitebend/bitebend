CREATE TABLE IF NOT EXISTS "partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"referral_code" text NOT NULL,
	"commission_percentage" double precision DEFAULT 10 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"payout_details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partners_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "partners_email_unique" UNIQUE("email"),
	CONSTRAINT "partners_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partner_commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL REFERENCES "partners"("id") ON DELETE cascade,
	"restaurant_id" integer NOT NULL REFERENCES "restaurants"("id") ON DELETE cascade,
	"subscription_transaction_id" integer NOT NULL REFERENCES "subscription_transactions"("id") ON DELETE cascade,
	"transaction_amount" double precision NOT NULL,
	"commission_rate" double precision NOT NULL,
	"commission_amount" double precision NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payout_reference" text,
	"paid_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_commissions_subscription_transaction_id_unique" UNIQUE("subscription_transaction_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partner_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer REFERENCES "partners"("id") ON DELETE set null,
	"restaurant_id" integer REFERENCES "restaurants"("id") ON DELETE set null,
	"action" text NOT NULL,
	"performed_by" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "partner_id" integer REFERENCES "partners"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_partner_commissions_partner_id" ON "partner_commissions" ("partner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_partner_commissions_restaurant_id" ON "partner_commissions" ("restaurant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restaurants_partner_id" ON "restaurants" ("partner_id");
