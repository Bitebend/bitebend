ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "state" text;
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "city" text;
