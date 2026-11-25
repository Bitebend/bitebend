ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_phone" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_phone_norm" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_phone_source" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_phone_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_phone_captured_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_registration_phone_source'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "chk_users_registration_phone_source"
      CHECK ("registration_phone_source" IS NULL OR "registration_phone_source" IN ('registration', 'legacy_restaurant_phone', 'admin_rebind'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_registration_phone_norm" ON "users" ("registration_phone_norm");
--> statement-breakpoint
WITH owner_phones AS (
  SELECT
    u.id AS user_id,
    btrim(r.phone) AS raw_phone,
    regexp_replace(regexp_replace(btrim(r.phone), '[^0-9]', '', 'g'), '^0+', '') AS stripped_digits,
    u.created_at AS captured_at
  FROM "users" u
  JOIN "restaurants" r ON r.id = u.restaurant_id
  WHERE u.role = 'owner'
    AND u.registration_phone IS NULL
    AND r.phone IS NOT NULL
    AND btrim(r.phone) <> ''
)
UPDATE "users" u
SET
  "registration_phone" = op.raw_phone,
  "registration_phone_norm" = CASE
    WHEN length(op.stripped_digits) = 10 THEN '91' || op.stripped_digits
    WHEN length(op.stripped_digits) = 12 AND left(op.stripped_digits, 2) = '91' THEN op.stripped_digits
    WHEN length(op.stripped_digits) BETWEEN 8 AND 15 THEN op.stripped_digits
    ELSE NULL
  END,
  "registration_phone_source" = 'legacy_restaurant_phone',
  "registration_phone_verified" = false,
  "registration_phone_captured_at" = op.captured_at
FROM owner_phones op
WHERE u.id = op.user_id
  AND u.registration_phone IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restaurant_profile_pins" (
	"id" serial PRIMARY KEY NOT NULL,
	"restaurant_id" integer NOT NULL REFERENCES "restaurants"("id") ON DELETE cascade,
	"owner_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"pin_hash" text NOT NULL,
	"pepper_version" integer DEFAULT 1 NOT NULL,
	"pin_version" integer DEFAULT 1 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"lockout_level" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"pin_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_profile_pins_restaurant_id_unique" UNIQUE("restaurant_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restaurant_profile_pins_owner" ON "restaurant_profile_pins" ("owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_pin_otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"restaurant_id" integer NOT NULL REFERENCES "restaurants"("id") ON DELETE cascade,
	"owner_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"otp_hmac" text NOT NULL,
	"otp_pepper_version" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"delivered_at" timestamp with time zone,
	"chat_committed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"cancel_sync_status" text DEFAULT 'not_required' NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_otp_challenges_delivery_status" CHECK ("delivery_status" IN ('pending', 'uncertain', 'delivered', 'failed', 'cancelled')),
	CONSTRAINT "chk_otp_challenges_cancel_sync_status" CHECK ("cancel_sync_status" IN ('not_required', 'pending', 'confirmed_cancelled', 'confirmed_failed', 'confirmed_already_delivered'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otp_challenges_owner_rest_created" ON "profile_pin_otp_challenges" ("owner_user_id", "restaurant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otp_challenges_expires_at" ON "profile_pin_otp_challenges" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otp_challenges_cancel_sync" ON "profile_pin_otp_challenges" ("cancel_sync_status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_otp_challenge_monotonic_state"()
RETURNS trigger AS $$
BEGIN
  IF OLD.delivery_status IN ('delivered', 'failed', 'cancelled')
     AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    RAISE EXCEPTION 'OTP challenge % is in terminal delivery_status (%) and cannot transition to %',
      OLD.id, OLD.delivery_status, NEW.delivery_status;
  END IF;

  IF OLD.delivery_status = 'uncertain' AND NEW.delivery_status = 'pending' THEN
    RAISE EXCEPTION 'OTP challenge % cannot downgrade delivery_status from uncertain to pending', OLD.id;
  END IF;

  IF OLD.invalidated_at IS NOT NULL
     AND (NEW.invalidated_at IS NULL OR NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) THEN
    RAISE EXCEPTION 'OTP challenge % invalidated_at is immutable once set', OLD.id;
  END IF;

  IF OLD.consumed_at IS NOT NULL
     AND (NEW.consumed_at IS NULL OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'OTP challenge % consumed_at is immutable once set', OLD.id;
  END IF;

  IF OLD.delivered_at IS NOT NULL
     AND (NEW.delivered_at IS NULL OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
    RAISE EXCEPTION 'OTP challenge % delivered_at is immutable once set', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_otp_challenge_monotonic" ON "profile_pin_otp_challenges";
--> statement-breakpoint
CREATE TRIGGER "trg_otp_challenge_monotonic"
  BEFORE UPDATE ON "profile_pin_otp_challenges"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_otp_challenge_monotonic_state"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "owner_security_audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"restaurant_id_snapshot" integer,
	"owner_user_id_snapshot" integer,
	"actor_user_id_snapshot" integer,
	"actor_role" text NOT NULL,
	"event_type" text NOT NULL,
	"challenge_id" uuid,
	"meta_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_sec_audit_rest_created" ON "owner_security_audit_logs" ("restaurant_id_snapshot", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_sec_audit_owner_created" ON "owner_security_audit_logs" ("owner_user_id_snapshot", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_sec_audit_event_created" ON "owner_security_audit_logs" ("event_type", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_owner_security_audit_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'owner_security_audit_logs is append-only; % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_owner_sec_audit_no_update_delete" ON "owner_security_audit_logs";
--> statement-breakpoint
CREATE TRIGGER "trg_owner_sec_audit_no_update_delete"
  BEFORE UPDATE OR DELETE ON "owner_security_audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_owner_security_audit_append_only"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_owner_sec_audit_no_truncate" ON "owner_security_audit_logs";
--> statement-breakpoint
CREATE TRIGGER "trg_owner_sec_audit_no_truncate"
  BEFORE TRUNCATE ON "owner_security_audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "enforce_owner_security_audit_append_only"();
--> statement-breakpoint
DO $$
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "owner_security_audit_logs" FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
