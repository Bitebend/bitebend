import {
  db,
  orders,
  paymentScreenshotInbox,
  sessionBills,
} from "@workspace/db";
import { and, isNotNull, isNull, lte, or, eq, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Screenshot Media Retention Policy:
 *
 * 1. 24-Hour Policy (PAYMENT_SCREENSHOT_RETENTION_HOURS, default: 24):
 *    - Archived screenshots: permanently delete media 24h after `archivedAt`.
 *    - Attached screenshots: permanently delete media 24h after `attachedAt`
 *      (and from `session_bills.screenshot_url` 24h after `screenshotReceivedAt`).
 *    - Deterministic precedence: if a screenshot is both attached and archived,
 *      delete media once EITHER 24-hour deadline has elapsed.
 *
 * 2. 30-Day Policy (PAYMENT_SCREENSHOT_RETENTION_DAYS, default: 30):
 *    - Unattached / unmatched screenshots: permanently delete media 30 days after `receivedAt`.
 *    - Orders terminal payment screenshots (legacy): delete media 30 days after `updatedAt`.
 *
 * In all cases: non-media metadata, audit history, bill records, orders,
 * table associations, and payment records are strictly PRESERVED. Only the
 * raw image base64 blobs are set to NULL to reclaim database memory and storage.
 */

export function getShortRetentionMs(): number {
  const hours = parseInt(
    process.env["PAYMENT_SCREENSHOT_RETENTION_HOURS"] ?? "24",
    10,
  );
  const resolved = Number.isNaN(hours) || hours <= 0 ? 24 : hours;
  return resolved * 60 * 60 * 1000;
}

export function getLegacyRetentionMs(): number {
  const days = parseInt(
    process.env["PAYMENT_SCREENSHOT_RETENTION_DAYS"] ?? "30",
    10,
  );
  const resolved = Number.isNaN(days) || days <= 0 ? 30 : days;
  return resolved * 24 * 60 * 60 * 1000;
}

export interface PurgeResult {
  archivedInboxPurged: number;
  attachedInboxPurged: number;
  attachedBillsPurged: number;
  unattachedInboxPurged: number;
  ordersPurged: number;
  totalMediaPurged: number;
  cutoff24h: Date;
  cutoff30d: Date;
}

let isCleanupRunning = false;
const ADVISORY_LOCK_ID = 1396920910; // Fixed lock identifier (ASCII for "SCRN")

export async function purgeExpiredScreenshots(customNow?: Date): Promise<PurgeResult> {
  if (isCleanupRunning) {
    logger.info("screenshot_cleanup: job already running in this instance, skipping concurrent call");
    const now = customNow ?? new Date();
    return {
      archivedInboxPurged: 0,
      attachedInboxPurged: 0,
      attachedBillsPurged: 0,
      unattachedInboxPurged: 0,
      ordersPurged: 0,
      totalMediaPurged: 0,
      cutoff24h: new Date(now.getTime() - getShortRetentionMs()),
      cutoff30d: new Date(now.getTime() - getLegacyRetentionMs()),
    };
  }

  isCleanupRunning = true;
  let hasAdvisoryLock = false;

  const now = customNow ?? new Date();
  const cutoff24h = new Date(now.getTime() - getShortRetentionMs());
  const cutoff30d = new Date(now.getTime() - getLegacyRetentionMs());

  let archivedInboxPurged = 0;
  let attachedInboxPurged = 0;
  let attachedBillsPurged = 0;
  let unattachedInboxPurged = 0;
  let ordersPurged = 0;

  try {
    // Try to acquire distributed advisory lock for multi-replica setups
    try {
      const lockRes = await db.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS locked`,
      ).then((r: any) => r.rows ?? [{ locked: true }]);
      if (lockRes && lockRes.length > 0 && lockRes[0].locked === false) {
        logger.info("screenshot_cleanup: another instance holds advisory lock, skipping");
        return {
          archivedInboxPurged: 0,
          attachedInboxPurged: 0,
          attachedBillsPurged: 0,
          unattachedInboxPurged: 0,
          ordersPurged: 0,
          totalMediaPurged: 0,
          cutoff24h,
          cutoff30d,
        };
      }
      hasAdvisoryLock = true;
    } catch {
      // In local environments or databases that don't support pg_try_advisory_lock,
      // proceed safely using the in-process lock.
      hasAdvisoryLock = false;
    }

    // ── 1. Archived Screenshots Media (24-Hour Policy) ──────────────────────
    try {
      const purged = await db
        .update(paymentScreenshotInbox)
        .set({ screenshotData: null, updatedAt: now })
        .where(
          and(
            isNotNull(paymentScreenshotInbox.screenshotData),
            isNotNull(paymentScreenshotInbox.archivedAt),
            lte(paymentScreenshotInbox.archivedAt, cutoff24h),
          ),
        )
        .returning({ id: paymentScreenshotInbox.id });
      archivedInboxPurged = purged.length;
    } catch (err) {
      logger.error({ err }, "screenshot_cleanup: failed to purge archived screenshots");
    }

    // ── 2. Attached Screenshots Media (24-Hour Policy) ──────────────────────
    // Only delete media when attachedAt is explicitly recorded and <= cutoff24h.
    // Legacy records with attachedAt IS NULL are preserved rather than deleting
    // based on an unverified row-level updatedAt modification timestamp.
    try {
      const purged = await db
        .update(paymentScreenshotInbox)
        .set({ screenshotData: null, updatedAt: now })
        .where(
          and(
            isNotNull(paymentScreenshotInbox.screenshotData),
            eq(paymentScreenshotInbox.matchStatus, "matched"),
            isNotNull(paymentScreenshotInbox.attachedAt),
            lte(paymentScreenshotInbox.attachedAt, cutoff24h),
          ),
        )
        .returning({ id: paymentScreenshotInbox.id });
      attachedInboxPurged = purged.length;
    } catch (err) {
      logger.error({ err }, "screenshot_cleanup: failed to purge attached inbox screenshots");
    }

    // ── 3. Session Bills Screenshot Media (24-Hour Policy) ──────────────────
    try {
      const purged = await db
        .update(sessionBills)
        .set({ screenshotUrl: null, updatedAt: now })
        .where(
          and(
            isNotNull(sessionBills.screenshotUrl),
            isNotNull(sessionBills.screenshotReceivedAt),
            lte(sessionBills.screenshotReceivedAt, cutoff24h),
          ),
        )
        .returning({ id: sessionBills.id });
      attachedBillsPurged = purged.length;
    } catch (err) {
      logger.error({ err }, "screenshot_cleanup: failed to purge session bills screenshots");
    }

    // ── 4. Unattached, Unarchived Inbox Media (30-Day Policy) ───────────────
    try {
      const purged = await db
        .update(paymentScreenshotInbox)
        .set({ screenshotData: null, updatedAt: now })
        .where(
          and(
            isNotNull(paymentScreenshotInbox.screenshotData),
            isNull(paymentScreenshotInbox.archivedAt),
            or(
              eq(paymentScreenshotInbox.matchStatus, "unmatched"),
              eq(paymentScreenshotInbox.matchStatus, "ambiguous"),
            ),
            lte(paymentScreenshotInbox.receivedAt, cutoff30d),
          ),
        )
        .returning({ id: paymentScreenshotInbox.id });
      unattachedInboxPurged = purged.length;
    } catch (err) {
      logger.error({ err }, "screenshot_cleanup: failed to purge unattached screenshots");
    }

    // ── 5. Legacy Orders Screenshot Media (30-Day Policy) ───────────────────
    try {
      const purged = await db
        .update(orders)
        .set({ paymentScreenshotUrl: null })
        .where(
          and(
            isNotNull(orders.paymentScreenshotUrl),
            or(
              eq(orders.paymentStatus, "paid"),
              eq(orders.paymentVerificationStatus, "rejected"),
            ),
            lte(orders.updatedAt, cutoff30d),
          ),
        )
        .returning({ id: orders.id });
      ordersPurged = purged.length;
    } catch (err) {
      logger.error({ err }, "screenshot_cleanup: failed to purge orders payment screenshots");
    }

    const totalMediaPurged =
      archivedInboxPurged +
      attachedInboxPurged +
      attachedBillsPurged +
      unattachedInboxPurged +
      ordersPurged;

    if (totalMediaPurged > 0) {
      logger.info(
        {
          archivedInboxPurged,
          attachedInboxPurged,
          attachedBillsPurged,
          unattachedInboxPurged,
          ordersPurged,
          totalMediaPurged,
          cutoff24h: cutoff24h.toISOString(),
          cutoff30d: cutoff30d.toISOString(),
        },
        "screenshot_cleanup: successfully purged expired payment screenshot media",
      );
    }

    return {
      archivedInboxPurged,
      attachedInboxPurged,
      attachedBillsPurged,
      unattachedInboxPurged,
      ordersPurged,
      totalMediaPurged,
      cutoff24h,
      cutoff30d,
    };
  } finally {
    if (hasAdvisoryLock) {
      try {
        await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`);
      } catch {
        /* ignore unlock errors */
      }
    }
    isCleanupRunning = false;
  }
}
