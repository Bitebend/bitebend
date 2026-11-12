ALTER TABLE "restaurant_staff" ALTER COLUMN "phone" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "restaurant_staff" ALTER COLUMN "pin_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "restaurant_staff" ADD COLUMN IF NOT EXISTS "connection_pin_digest" text;
--> statement-breakpoint
ALTER TABLE "restaurant_staff" ADD COLUMN IF NOT EXISTS "connection_pin_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "restaurant_staff" ADD COLUMN IF NOT EXISTS "connection_pin_created_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "restaurant_staff" DROP CONSTRAINT IF EXISTS "restaurant_staff_restaurant_phone_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_restaurant_staff_pin_digest" ON "restaurant_staff" ("connection_pin_digest") WHERE "connection_pin_digest" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_restaurant_staff_phone_unique" ON "restaurant_staff" ("restaurant_id", "phone") WHERE "phone" IS NOT NULL;
