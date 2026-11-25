DO $$
DECLARE
  v_count bigint;
  v_sample text;
BEGIN
  -- 1. Validate pin_version (>= 1 and NOT NULL)
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "pin_version" IS NULL OR "pin_version" < 1
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Invalid pin_version (< 1 or NULL) in % restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;

  -- 2. Validate pepper_version (>= 1 and NOT NULL)
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "pepper_version" IS NULL OR "pepper_version" < 1
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Invalid pepper_version (< 1 or NULL) in % restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;

  -- 3. Validate failed_attempts and lockout_level (>= 0 and NOT NULL)
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "failed_attempts" IS NULL OR "failed_attempts" < 0
       OR "lockout_level" IS NULL OR "lockout_level" < 0
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Invalid failed_attempts or lockout_level (< 0 or NULL) in % restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;

  -- 4. Reject empty, whitespace-only, or malformed non-bcrypt pin_hash values
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "pin_hash" IS NOT NULL
      AND (btrim("pin_hash") = '' OR "pin_hash" !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Empty or invalid bcrypt pin_hash in % restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;

  -- 5. Reject dirty tombstone states (pin_hash IS NULL paired with non-null pin_set_at or active failure/lockout fields)
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "pin_hash" IS NULL
      AND (
        "pin_set_at" IS NOT NULL
        OR "failed_attempts" <> 0
        OR "lockout_level" <> 0
        OR "locked_until" IS NOT NULL
        OR "last_failed_at" IS NOT NULL
      )
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Dirty tombstone state in % restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;

  -- 6. Deterministic backfill of missing pin_set_at for active PIN rows (audit logs first, updated_at fallback)
  UPDATE "restaurant_profile_pins" p
  SET "pin_set_at" = sub."audit_ts"
  FROM (
    SELECT
      l."restaurant_id_snapshot" AS restaurant_id,
      MAX(l."created_at") AS audit_ts
    FROM "owner_security_audit_logs" l
    WHERE l."restaurant_id_snapshot" IS NOT NULL
      AND l."event_type" IN ('profile_pin_set', 'profile_pin_changed', 'profile_pin_reset_with_otp')
    GROUP BY l."restaurant_id_snapshot"
  ) sub
  WHERE p."restaurant_id" = sub.restaurant_id
    AND p."pin_hash" IS NOT NULL
    AND p."pin_set_at" IS NULL
    AND sub."audit_ts" IS NOT NULL;

  UPDATE "restaurant_profile_pins"
  SET "pin_set_at" = "updated_at"
  WHERE "pin_hash" IS NOT NULL
    AND "pin_set_at" IS NULL
    AND "updated_at" IS NOT NULL;

  -- 7. Abort cleanly if any active PIN row still lacks pin_set_at
  SELECT COUNT(*), COALESCE(string_agg(id::text, ', '), '')
  INTO v_count, v_sample
  FROM (
    SELECT id FROM "restaurant_profile_pins"
    WHERE "pin_hash" IS NOT NULL AND "pin_set_at" IS NULL
    ORDER BY id ASC LIMIT 5
  ) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Unable to deterministically backfill missing pin_set_at for % active restaurant_profile_pins row(s) [sample ids: %]', v_count, v_sample;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "pin_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "pin_set_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "pin_set_at" DROP DEFAULT;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_profile_pins_tombstone_consistency'
  ) THEN
    ALTER TABLE "restaurant_profile_pins"
      ADD CONSTRAINT "chk_restaurant_profile_pins_tombstone_consistency"
      CHECK (
        ("pin_hash" IS NULL AND "pin_set_at" IS NULL AND "failed_attempts" = 0 AND "lockout_level" = 0 AND "locked_until" IS NULL AND "last_failed_at" IS NULL)
        OR ("pin_hash" IS NOT NULL AND "pin_set_at" IS NOT NULL AND length(btrim("pin_hash")) > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_profile_pins_versions_positive'
  ) THEN
    ALTER TABLE "restaurant_profile_pins"
      ADD CONSTRAINT "chk_restaurant_profile_pins_versions_positive"
      CHECK ("pin_version" >= 1 AND "pepper_version" >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_profile_pins_counters_non_negative'
  ) THEN
    ALTER TABLE "restaurant_profile_pins"
      ADD CONSTRAINT "chk_restaurant_profile_pins_counters_non_negative"
      CHECK ("failed_attempts" >= 0 AND "lockout_level" >= 0);
  END IF;
END $$;
--> statement-breakpoint
WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "owner_user_id", "restaurant_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn
  FROM "profile_pin_otp_challenges"
  WHERE "invalidated_at" IS NULL
    AND "consumed_at" IS NULL
)
UPDATE "profile_pin_otp_challenges" c
SET
  "invalidated_at" = clock_timestamp(),
  "invalidation_reason" = COALESCE(c."invalidation_reason", 'superseded_by_migration_0042'),
  "updated_at" = clock_timestamp()
FROM ranked_active ra
WHERE c."id" = ra."id"
  AND ra.rn > 1
  AND c."invalidated_at" IS NULL
  AND c."consumed_at" IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  v_dup_groups bigint;
BEGIN
  SELECT COUNT(*)
  INTO v_dup_groups
  FROM (
    SELECT "owner_user_id", "restaurant_id"
    FROM "profile_pin_otp_challenges"
    WHERE "invalidated_at" IS NULL
      AND "consumed_at" IS NULL
    GROUP BY "owner_user_id", "restaurant_id"
    HAVING COUNT(*) > 1
  ) dup;

  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION '[MIGRATION_0042_PREFLIGHT_ABORT] Duplicate active OTP challenges still exist for % (owner_user_id, restaurant_id) group(s) after deduplication', v_dup_groups;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_otp_challenges_one_active_per_owner_rest"
  ON "profile_pin_otp_challenges" ("owner_user_id", "restaurant_id")
  WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL;
