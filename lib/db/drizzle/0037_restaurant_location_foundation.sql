ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "locality" text;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "latitude" double precision;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "longitude" double precision;
