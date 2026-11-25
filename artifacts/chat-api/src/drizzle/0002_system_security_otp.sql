ALTER TABLE "messaging_accounts" ADD COLUMN IF NOT EXISTS "account_type" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messaging_accounts_account_type'
  ) THEN
    ALTER TABLE "messaging_accounts"
      ADD CONSTRAINT "chk_messaging_accounts_account_type"
      CHECK ("account_type" IN ('user', 'system_security'));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messages_system_security_otp_challenge" ON "messaging_messages" ("client_msg_id") WHERE "event_type" = 'bb.system.security_otp';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_internal_request_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_internal_nonces_expires_at" ON "chat_internal_request_nonces" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_security_otp_deliveries" (
	"challenge_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipient_account_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"server_seq" bigint,
	"signing_key_id" text,
	"failure_code" text,
	"delivery_deadline_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_sec_otp_delivery_status" CHECK ("status" IN ('pending', 'delivered', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sec_otp_deliveries_recipient" ON "messaging_security_otp_deliveries" ("recipient_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sec_otp_deliveries_status_expires" ON "messaging_security_otp_deliveries" ("status", "expires_at");
--> statement-breakpoint
DO $$
DECLARE
  existing_by_id RECORD;
  existing_by_uname RECORD;
BEGIN
  SELECT id, username_lower, account_type
  INTO existing_by_id
  FROM "messaging_accounts"
  WHERE id = '00000000-0000-4000-8000-000000000001';

  IF FOUND THEN
    IF existing_by_id.username_lower <> 'bitebend.security_otp' OR existing_by_id.account_type <> 'system_security' THEN
      RAISE EXCEPTION 'System security account UUID reserved collision (username_lower=%, account_type=%)',
        existing_by_id.username_lower, existing_by_id.account_type;
    END IF;
  END IF;

  SELECT id, account_type
  INTO existing_by_uname
  FROM "messaging_accounts"
  WHERE username_lower = 'bitebend.security_otp';

  IF FOUND THEN
    IF existing_by_uname.id <> '00000000-0000-4000-8000-000000000001'::uuid OR existing_by_uname.account_type <> 'system_security' THEN
      RAISE EXCEPTION 'System security username bitebend.security_otp reserved collision (id=%, account_type=%)',
        existing_by_uname.id, existing_by_uname.account_type;
    END IF;
  END IF;

  INSERT INTO "messaging_accounts" (
    "id", "username", "username_lower", "display_name", "login_phone_hmac", "identity_status", "account_type"
  ) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'bitebend.security_otp',
    'bitebend.security_otp',
    'Bitebend Security',
    NULL,
    'active',
    'system_security'
  ) ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "messaging_devices" (
    "id", "account_id", "device_label", "matrix_device_id", "identity_key_ed25519", "identity_key_curve25519", "device_keys_json", "status"
  ) VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'Bitebend Security Signer',
    'SYSTEM_SECURITY_V1',
    'system_security_ed25519_signer',
    'system_security_no_e2ee',
    '{"system":true,"purpose":"profile_pin_reset"}'::jsonb,
    'active'
  ) ON CONFLICT ("id") DO NOTHING;
END $$;
