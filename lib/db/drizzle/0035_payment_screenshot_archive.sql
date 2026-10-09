-- Migration 0035: payment_screenshot_archive
--
-- Adds nullable archived_at timestamp to payment_screenshot_inbox.
-- Allows restaurant owners to archive / remove irrelevant screenshots from the main
-- inbox without permanently deleting media files or audit metadata before the
-- retention window elapses.

ALTER TABLE "payment_screenshot_inbox"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_psi_restaurant_archived"
  ON "payment_screenshot_inbox" ("restaurant_id", "archived_at");
