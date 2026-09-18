-- Migration 0030: analytics_enhancements
--
-- Extends the visitor analytics system (0029) with production-grade features:
--
--  1. Bot filtering
--     is_bot columns on visitor_sessions and page_views so crawlers and
--     monitoring tools can be excluded from all reporting queries without
--     losing the raw data for debugging.
--
--  2. Session duration
--     duration_seconds on page_views. The client fires navigator.sendBeacon
--     on page unload; the server updates the most recent page_view row for
--     that visitor+session. NULL means the user left before the beacon fired
--     (tab close, crash, etc.).
--
--  3. Pre-computed traffic source
--     traffic_source and referrer_domain are stored at INSERT time so read
--     queries can GROUP BY traffic_source directly instead of loading all
--     referrer/utm_source combinations into JS memory.
--
--  4. Generic event tracking
--     analytics_events stores named events (e.g. register_started,
--     plan_selected, subscription_purchased) with a JSON properties bag.
--     Events are linked to visitor_sessions when available. This table
--     powers the conversion funnel endpoint.

-- ── 1. Bot filtering ─────────────────────────────────────────────────────────

ALTER TABLE "visitor_sessions"
  ADD COLUMN IF NOT EXISTS "is_bot" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "page_views"
  ADD COLUMN IF NOT EXISTS "is_bot" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- ── 2. Session duration ───────────────────────────────────────────────────────

ALTER TABLE "page_views"
  ADD COLUMN IF NOT EXISTS "duration_seconds" integer;
--> statement-breakpoint
-- ── 3. Pre-computed referrer domain + traffic source ─────────────────────────

ALTER TABLE "page_views"
  ADD COLUMN IF NOT EXISTS "referrer_domain" text;
--> statement-breakpoint
ALTER TABLE "page_views"
  ADD COLUMN IF NOT EXISTS "traffic_source" text;
--> statement-breakpoint
-- ── 4. Generic event tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id"                  serial      PRIMARY KEY NOT NULL,
  "visitor_session_id"  integer     REFERENCES "visitor_sessions"("id") ON DELETE SET NULL,
  "session_id"          text        NOT NULL,
  "event_name"          text        NOT NULL,
  "page"                text,
  "properties"          jsonb,
  "is_bot"              boolean     NOT NULL DEFAULT false,
  "created_at"          timestamp   NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Partial indexes on is_bot=false are the fast path for all reporting queries
CREATE INDEX IF NOT EXISTS "idx_vs_is_bot"
  ON "visitor_sessions" ("is_bot") WHERE "is_bot" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pv_is_bot"
  ON "page_views" ("is_bot") WHERE "is_bot" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pv_traffic_source"
  ON "page_views" ("traffic_source") WHERE "traffic_source" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pv_referrer_domain"
  ON "page_views" ("referrer_domain") WHERE "referrer_domain" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ae_event_name"
  ON "analytics_events" ("event_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ae_session_id"
  ON "analytics_events" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ae_created_at"
  ON "analytics_events" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ae_visitor_session"
  ON "analytics_events" ("visitor_session_id");
