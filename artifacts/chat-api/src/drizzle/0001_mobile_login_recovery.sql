ALTER TABLE "messaging_accounts" ADD COLUMN IF NOT EXISTS "login_phone_hmac" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messaging_accounts_login_phone_hmac" ON "messaging_accounts" ("login_phone_hmac") WHERE "login_phone_hmac" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "messaging_handoff_drafts" ADD COLUMN IF NOT EXISTS "suggested_username_base" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "messaging_devices"("id") ON DELETE cascade,
	"matrix_device_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_login_challenges_account_expires" ON "messaging_login_challenges" ("account_id", "expires_at");
