ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "verification_method" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "verified_by" integer;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "verified_at" timestamp;
