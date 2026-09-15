ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "qr_stands_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD COLUMN IF NOT EXISTS "original_amount" double precision;
--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD COLUMN IF NOT EXISTS "discount_amount" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD COLUMN IF NOT EXISTS "discount_reason" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restaurant_hardware_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"restaurant_id" integer NOT NULL REFERENCES "restaurants"("id") ON DELETE cascade,
	"partner_id" integer REFERENCES "partners"("id") ON DELETE set null,
	"stand_quantity" integer NOT NULL,
	"unit_price" double precision NOT NULL,
	"total_amount" double precision NOT NULL,
	"collection_status" text NOT NULL DEFAULT 'pending',
	"collected_at" timestamp,
	"collected_by_partner_id" integer REFERENCES "partners"("id") ON DELETE set null,
	"waived_at" timestamp,
	"waived_by_user_id" integer REFERENCES "users"("id") ON DELETE set null,
	"waive_reason" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hardware_orders_restaurant" ON "restaurant_hardware_orders" ("restaurant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hardware_orders_partner" ON "restaurant_hardware_orders" ("partner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hardware_orders_status" ON "restaurant_hardware_orders" ("collection_status");
--> statement-breakpoint
INSERT INTO "platform_settings" ("key", "value", "updated_at") VALUES ('default_qr_stand_price', '30', now()) ON CONFLICT ("key") DO NOTHING;
