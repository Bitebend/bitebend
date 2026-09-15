ALTER TABLE "partners" ALTER COLUMN "referral_code" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_partners_status" ON "partners" ("status");
