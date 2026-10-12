-- Migration 0036: payment_screenshot_attached_at
--
-- Adds nullable attached_at timestamp to payment_screenshot_inbox.
-- Supports the 24-hour media retention cleanup policy for successfully attached screenshots.

ALTER TABLE "payment_screenshot_inbox"
  ADD COLUMN IF NOT EXISTS "attached_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_psi_restaurant_attached"
  ON "payment_screenshot_inbox" ("restaurant_id", "attached_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_bills_screenshot_cleanup"
  ON "session_bills" ("screenshot_received_at")
  WHERE "screenshot_url" IS NOT NULL;
