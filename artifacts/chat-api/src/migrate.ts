import { chatPool, ensureChatDbReady, isExternalPostgres } from "./db";

const REQUIRED_TABLES = [
  "rate_limit_windows",
  "messaging_accounts",
  "messaging_contact_claims",
  "messaging_devices",
  "messaging_one_time_prekeys",
  "messaging_fallback_keys",
  "messaging_sessions",
  "messaging_handoff_drafts",
  "messaging_device_link_tokens",
  "messaging_conversations",
  "messaging_conversation_members",
  "messaging_messages",
  "messaging_to_device_events",
  "messaging_device_list_changes",
  "messaging_attachments",
  "messaging_audit_events",
  "messaging_login_challenges",
  "chat_internal_request_nonces",
  "messaging_security_otp_deliveries",
];

async function main() {
  console.log(`[chat-migrate] Applying migrations (${isExternalPostgres ? "CHAT_DATABASE_URL PostgreSQL" : "isolated PGlite"})...`);
  await ensureChatDbReady();
  const res = await chatPool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const existing = new Set(res.rows.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    throw new Error(`Missing required messaging tables after migration: ${missing.join(", ")}`);
  }
  console.log(`[chat-migrate] Verified all ${REQUIRED_TABLES.length} messaging tables.`);
  await chatPool.end();
}

main().catch(async (err) => {
  console.error("[chat-migrate] FAILED:", err);
  await chatPool.end().catch(() => {});
  process.exit(1);
});
