CREATE TABLE IF NOT EXISTS "messaging_handoff_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"browser_bind_hash" text NOT NULL,
	"order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"restaurant_id" integer NOT NULL REFERENCES "restaurants"("id") ON DELETE cascade,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_handoff_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_msg_handoff_browser_bind" ON "messaging_handoff_tokens" ("browser_bind_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_msg_handoff_expires_at" ON "messaging_handoff_tokens" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_msg_handoff_order_id" ON "messaging_handoff_tokens" ("order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "internal_request_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_internal_nonces_expires_at" ON "internal_request_nonces" ("expires_at");
