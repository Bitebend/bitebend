import http from "node:http";
import { lte, and, eq } from "drizzle-orm";
import { createChatApp } from "./app";
import {
  chatDb,
  chatPool,
  ensureChatDbReady,
  messagingDeviceLinkTokens,
  messagingHandoffDrafts,
  messagingLoginChallenges,
} from "./db";
import { attachChatWebSocketServer } from "./ws";
import { logger } from "./lib/logger";

const port = Number(
  (process.env["RAILWAY_ENVIRONMENT"] ? process.env["PORT"] : undefined) ??
    process.env["CHAT_PORT"] ??
    process.env["PORT"] ??
    3002,
);

async function purgeExpiredChatRecords(): Promise<void> {
  try {
    const now = new Date();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await chatDb
      .update(messagingHandoffDrafts)
      .set({ status: "expired" })
      .where(and(eq(messagingHandoffDrafts.status, "pending"), lte(messagingHandoffDrafts.expiresAt, now)));

    await chatDb
      .delete(messagingHandoffDrafts)
      .where(lte(messagingHandoffDrafts.expiresAt, dayAgo));

    await chatDb
      .delete(messagingDeviceLinkTokens)
      .where(lte(messagingDeviceLinkTokens.expiresAt, dayAgo));

    await chatDb
      .delete(messagingLoginChallenges)
      .where(lte(messagingLoginChallenges.expiresAt, dayAgo));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Expired chat token cleanup skipped");
  }
}

async function start(): Promise<void> {
  await ensureChatDbReady();

  const app = createChatApp();
  const server = http.createServer(app);
  attachChatWebSocketServer(server);

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", resolve);
  });

  logger.info({ port }, "Bitebend Messaging API listening");

  setInterval(() => {
    void purgeExpiredChatRecords();
  }, 30 * 60 * 1000).unref();

  const shutdown = async () => {
    logger.info("Shutting down Bitebend Messaging API...");
    server.close();
    await chatPool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "Failed to start Bitebend Messaging API");
  process.exit(1);
});
