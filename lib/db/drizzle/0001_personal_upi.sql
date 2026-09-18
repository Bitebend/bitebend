ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "upi_name" text;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "personal_upi_enabled" boolean NOT NULL DEFAULT false;
