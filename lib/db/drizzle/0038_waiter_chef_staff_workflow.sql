ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "chef_dashboard_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'table_sessions_restaurant_id_id_unique'
  ) THEN
    ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_restaurant_id_id_unique" UNIQUE ("restaurant_id", "id");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_restaurant_id_id_unique'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_id_unique" UNIQUE ("restaurant_id", "id");
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restaurant_staff" (
  "id" serial PRIMARY KEY NOT NULL,
  "restaurant_id" integer NOT NULL,
  "name" text NOT NULL,
  "phone" text NOT NULL,
  "role" text NOT NULL,
  "pin_hash" text NOT NULL,
  "token_version" integer DEFAULT 1 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "restaurant_staff_restaurant_phone_unique" UNIQUE("restaurant_id", "phone"),
  CONSTRAINT "restaurant_staff_restaurant_id_unique" UNIQUE("restaurant_id", "id"),
  CONSTRAINT "restaurant_staff_role_check" CHECK ("role" IN ('waiter', 'chef')),
  CONSTRAINT "fk_restaurant_staff_restaurant" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restaurant_staff_restaurant" ON "restaurant_staff" ("restaurant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restaurant_staff_role" ON "restaurant_staff" ("role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restaurant_staff_is_active" ON "restaurant_staff" ("is_active");
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD COLUMN IF NOT EXISTS "assigned_waiter_id" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_sessions_assigned_waiter" ON "table_sessions" ("restaurant_id", "assigned_waiter_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_sessions_staff'
  ) THEN
    ALTER TABLE "table_sessions" ADD CONSTRAINT "fk_table_sessions_staff"
      FOREIGN KEY ("restaurant_id", "assigned_waiter_id")
      REFERENCES "restaurant_staff"("restaurant_id", "id")
      ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_waiter_id" integer;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assignment_source" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_assigned_waiter" ON "orders" ("restaurant_id", "assigned_waiter_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_staff'
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_staff"
      FOREIGN KEY ("restaurant_id", "assigned_waiter_id")
      REFERENCES "restaurant_staff"("restaurant_id", "id")
      ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_activity_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "restaurant_id" integer NOT NULL,
  "session_id" integer NOT NULL,
  "action" text NOT NULL,
  "actor_type" text NOT NULL,
  "user_actor_id" integer,
  "staff_actor_id" integer,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "fk_session_activity_restaurant" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_session_activity_sessions" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT,
  CONSTRAINT "fk_session_activity_table_sessions" FOREIGN KEY ("restaurant_id", "session_id") REFERENCES "table_sessions"("restaurant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fk_session_activity_restaurant_staff" FOREIGN KEY ("restaurant_id", "staff_actor_id") REFERENCES "restaurant_staff"("restaurant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fk_session_activity_user_actor" FOREIGN KEY ("user_actor_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "session_activity_actor_check" CHECK (
    ("user_actor_id" IS NOT NULL AND "staff_actor_id" IS NULL) OR
    ("user_actor_id" IS NULL AND "staff_actor_id" IS NOT NULL) OR
    ("user_actor_id" IS NULL AND "staff_actor_id" IS NULL AND "actor_type" = 'system')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_activity_session" ON "session_activity_logs" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_activity_restaurant" ON "session_activity_logs" ("restaurant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_activity_created_at" ON "session_activity_logs" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_activity_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "restaurant_id" integer NOT NULL,
  "session_id" integer,
  "order_id" integer NOT NULL,
  "action" text NOT NULL,
  "previous_status" text,
  "new_status" text,
  "actor_type" text NOT NULL,
  "user_actor_id" integer,
  "staff_actor_id" integer,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "fk_order_activity_restaurant" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_order_activity_session" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT,
  CONSTRAINT "fk_order_activity_orders" FOREIGN KEY ("restaurant_id", "order_id") REFERENCES "orders"("restaurant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fk_order_activity_restaurant_staff" FOREIGN KEY ("restaurant_id", "staff_actor_id") REFERENCES "restaurant_staff"("restaurant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fk_order_activity_user_actor" FOREIGN KEY ("user_actor_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "order_activity_actor_check" CHECK (
    ("user_actor_id" IS NOT NULL AND "staff_actor_id" IS NULL) OR
    ("user_actor_id" IS NULL AND "staff_actor_id" IS NOT NULL) OR
    ("user_actor_id" IS NULL AND "staff_actor_id" IS NULL AND "actor_type" = 'system')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_activity_order" ON "order_activity_logs" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_activity_restaurant" ON "order_activity_logs" ("restaurant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_activity_session" ON "order_activity_logs" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_activity_created_at" ON "order_activity_logs" ("created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are immutable. UPDATE and DELETE operations are prohibited.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_session_activity_logs'
  ) THEN
    CREATE TRIGGER trg_protect_session_activity_logs
    BEFORE UPDATE OR DELETE ON "session_activity_logs"
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_order_activity_logs'
  ) THEN
    CREATE TRIGGER trg_protect_order_activity_logs
    BEFORE UPDATE OR DELETE ON "order_activity_logs"
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_log_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are immutable. TRUNCATE operation is prohibited.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_truncate_session_activity_logs'
  ) THEN
    CREATE TRIGGER trg_truncate_session_activity_logs
    BEFORE TRUNCATE ON "session_activity_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_truncate();
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_truncate_order_activity_logs'
  ) THEN
    CREATE TRIGGER trg_truncate_order_activity_logs
    BEFORE TRUNCATE ON "order_activity_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_truncate();
  END IF;
END $$;
