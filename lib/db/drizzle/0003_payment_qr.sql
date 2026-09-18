ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "qr_image_data" text;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "qr_decoded_payload" text;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "qr_merchant_name" text;
