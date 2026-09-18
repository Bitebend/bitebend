ALTER TABLE "session_bills" ADD COLUMN "sender_phone" text;
--> statement-breakpoint
ALTER TABLE "session_bills" ADD COLUMN "phone_mismatch" boolean NOT NULL DEFAULT false;
