import type { RequestHandler } from "express";
import { chatDb, chatPool, messagingAuditEvents } from "../db";

let cleanupScheduled = false;

function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setInterval(async () => {
    try {
      await chatPool.query("DELETE FROM rate_limit_windows WHERE expires_at < NOW()");
    } catch {
      // Non-fatal cleanup optimization
    }
  }, 5 * 60 * 1000).unref();
}

export function createChatRateLimiter(opts: {
  maxRequests: number;
  windowMs: number;
  label: string;
  message?: string;
}): RequestHandler {
  const { maxRequests, windowMs, label, message = "Too many requests. Please try again later." } = opts;
  scheduleCleanup();

  return async (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const bucketStart = Math.floor(Date.now() / windowMs) * windowMs;
    const key = `chat:${label}:${ip}:${bucketStart}`;
    const expiresAt = new Date(bucketStart + windowMs);

    try {
      const result = await chatPool.query<{ count: number }>(
        `INSERT INTO rate_limit_windows (key, expires_at, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE
           SET count = rate_limit_windows.count + 1
         RETURNING count`,
        [key, expiresAt],
      );
      const count = result.rows[0]?.count ?? 1;
      if (count > maxRequests) {
        const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({ error: message, code: "RATE_LIMITED" });
        return;
      }
      next();
    } catch {
      next();
    }
  };
}

export async function recordAuditEvent(
  eventType: string,
  accountId?: string | null,
  deviceId?: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await chatDb.insert(messagingAuditEvents).values({
      eventType,
      accountId: accountId ?? null,
      deviceId: deviceId ?? null,
      metaJson: meta,
    });
  } catch {
    // Audit write is non-blocking
  }
}
