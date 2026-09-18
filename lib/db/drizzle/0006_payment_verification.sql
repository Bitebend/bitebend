ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ocr_data TEXT;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_verification_status TEXT;
