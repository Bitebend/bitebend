import { Router } from "express";
import { sql } from "drizzle-orm";
import { chatDb, chatPool, isExternalPostgres } from "../db";
import { requireChatAdmin } from "../middlewares/chatAuth";

const router = Router();

router.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "bitebend-chat-api" });
});

router.get("/health/db", async (_req, res) => {
  try {
    await chatPool.query("SELECT 1");
    res.json({
      ok: true,
      service: "bitebend-chat-api",
      storage: isExternalPostgres ? "postgres-isolated" : "pglite-chat-isolated",
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

// Aggregate metadata-only health/operational stats protected by CHAT_ADMIN_SECRET.
// Never exposes PII, phone numbers, usernames, keys, or message contents.
router.get("/chat/admin/stats", requireChatAdmin, async (_req, res) => {
  const [counts] = await chatDb.execute(sql`
    SELECT
      (SELECT count(*)::int FROM messaging_accounts) AS accounts,
      (SELECT count(*)::int FROM messaging_devices WHERE status = 'active' AND revoked_at IS NULL) AS active_devices,
      (SELECT count(*)::int FROM messaging_conversations) AS conversations,
      (SELECT count(*)::int FROM messaging_messages) AS messages,
      (SELECT count(*)::int FROM messaging_handoff_drafts WHERE status = 'pending') AS pending_drafts
  `).then((r) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Record<string, number>[]);

  res.json({
    ok: true,
    stats: counts ?? {
      accounts: 0,
      active_devices: 0,
      conversations: 0,
      messages: 0,
      pending_drafts: 0,
    },
  });
});

export default router;
