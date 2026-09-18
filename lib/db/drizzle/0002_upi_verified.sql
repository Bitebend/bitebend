ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "upi_verified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "verified_at" timestamp;
