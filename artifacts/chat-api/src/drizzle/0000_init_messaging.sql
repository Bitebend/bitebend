CREATE TABLE IF NOT EXISTS "rate_limit_windows" (
	"key" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"username_lower" text NOT NULL,
	"display_name" text NOT NULL,
	"identity_status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messaging_accounts_username_lower" ON "messaging_accounts" ("username_lower");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_contact_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"phone_hmac" text NOT NULL,
	"phone_masked" text NOT NULL,
	"source" text DEFAULT 'qr_order_handoff' NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_claims_account" ON "messaging_contact_claims" ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_claims_phone_hmac" ON "messaging_contact_claims" ("phone_hmac");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"device_label" text NOT NULL,
	"matrix_device_id" text NOT NULL,
	"identity_key_ed25519" text NOT NULL,
	"identity_key_curve25519" text NOT NULL,
	"device_keys_json" jsonb NOT NULL,
	"endorsed_by_device_id" uuid,
	"endorsement_sig" text,
	"status" text DEFAULT 'pending_link' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messaging_devices_account_matrix" ON "messaging_devices" ("account_id", "matrix_device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messaging_devices_account_status" ON "messaging_devices" ("account_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_one_time_prekeys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "messaging_devices"("id") ON DELETE cascade,
	"key_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_key_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_otpk_device_key" ON "messaging_one_time_prekeys" ("device_id", "key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otpk_device_id" ON "messaging_one_time_prekeys" ("device_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_fallback_keys" (
	"device_id" uuid PRIMARY KEY NOT NULL REFERENCES "messaging_devices"("id") ON DELETE cascade,
	"key_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_key_json" jsonb NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "messaging_devices"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messaging_sessions_token_hash" ON "messaging_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messaging_sessions_account" ON "messaging_sessions" ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_handoff_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_token_hash" text NOT NULL,
	"source_handoff_id" uuid NOT NULL,
	"restaurant_id" integer NOT NULL,
	"masked_name" text NOT NULL,
	"masked_phone" text NOT NULL,
	"phone_hmac" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activated_account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_handoff_drafts_token_hash" ON "messaging_handoff_drafts" ("draft_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_handoff_drafts_source_handoff" ON "messaging_handoff_drafts" ("source_handoff_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_device_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"short_code" text NOT NULL,
	"short_code_expires_at" timestamp with time zone NOT NULL,
	"claim_cookie_hash" text NOT NULL,
	"account_id" uuid,
	"approving_device_id" uuid,
	"device2_label" text NOT NULL,
	"device2_matrix_id" text NOT NULL,
	"device2_ed25519" text NOT NULL,
	"device2_curve25519" text NOT NULL,
	"device2_keys_json" jsonb NOT NULL,
	"device2_otpk_json" jsonb NOT NULL,
	"device2_ecies_pub" text NOT NULL,
	"device1_ecies_out_msg" text,
	"device1_endorsement_sig" text,
	"device2_device_id" uuid,
	"sas_confirmed_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_scan' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_link_secret_hash" ON "messaging_device_link_tokens" ("secret_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_device_link_short_code" ON "messaging_device_link_tokens" ("short_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"direct_pair_key" text,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"next_seq" bigint DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conversations_direct_pair" ON "messaging_conversations" ("direct_pair_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_conversation_members" (
	"conversation_id" uuid NOT NULL REFERENCES "messaging_conversations"("id") ON DELETE cascade,
	"account_id" uuid NOT NULL REFERENCES "messaging_accounts"("id") ON DELETE cascade,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_conversation_members_pkey" PRIMARY KEY("conversation_id", "account_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conv_members_account" ON "messaging_conversation_members" ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "messaging_conversations"("id") ON DELETE cascade,
	"sender_account_id" uuid NOT NULL,
	"sender_device_id" uuid NOT NULL,
	"client_msg_id" uuid NOT NULL,
	"server_seq" bigint NOT NULL,
	"event_type" text DEFAULT 'm.room.encrypted' NOT NULL,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"payload_json" jsonb NOT NULL,
	"attachment_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messages_idempotency" ON "messaging_messages" ("conversation_id", "sender_device_id", "client_msg_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_messages_server_seq" ON "messaging_messages" ("conversation_id", "server_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_conv_seq" ON "messaging_messages" ("conversation_id", "server_seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_to_device_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient_account_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"sender_account_id" uuid NOT NULL,
	"sender_device_id" uuid NOT NULL,
	"txn_id" text NOT NULL,
	"event_type" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_to_device_idemp" ON "messaging_to_device_events" ("sender_device_id", "recipient_device_id", "event_type", "txn_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_to_device_recipient" ON "messaging_to_device_events" ("recipient_device_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_device_list_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"observer_account_id" uuid NOT NULL,
	"subject_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_device_list_observer" ON "messaging_device_list_changes" ("observer_account_id", "consumed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ciphertext_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"blob_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attachments_uploader" ON "messaging_attachments" ("uploader_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attachments_conversation" ON "messaging_attachments" ("conversation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"account_id" uuid,
	"device_id" uuid,
	"meta_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_type" ON "messaging_audit_events" ("event_type", "created_at");
