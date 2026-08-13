import { Router } from "express";
import { requireOwner } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { db, paymentScreenshotInbox } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { emitSessionScreenshotEvent, emitScreenshotInboxEvent } from "../lib/orderEvents";
import { matchAndAttachScreenshot } from "../lib/screenshotMatcher";
import { getBridgeState, isBridgeManaged } from "../lib/bridgeManager";
import type { RequestHandler } from "express";

const router = Router();

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3001";
const BRIDGE_API_SECRET = process.env.BRIDGE_API_SECRET ?? "";
const BITEBEND_WEBHOOK_SECRET = process.env.BITEBEND_WEBHOOK_SECRET ?? "";

function bridgeHeaders() {
  return {
    "Content-Type": "application/json",
    ...(BRIDGE_API_SECRET ? { "x-bridge-secret": BRIDGE_API_SECRET } : {}),
  };
}

async function callBridge(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: bridgeHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Owner: trigger WhatsApp QR / connect ──────────────────────────────────────
const connectHandler: RequestHandler = async (req, res) => {
  const restaurantId = req.user!.restaurantId;
  if (!restaurantId) {
    res.status(400).json({ error: "No restaurant associated with this account" });
    return;
  }
  try {
    const data = await callBridge("/api/whatsapp/connect", "POST", { restaurantId });
    res.json(data);
  } catch {
    const bridgeState = getBridgeState();
    const managed = isBridgeManaged();
    if (managed && (bridgeState === "starting" || bridgeState === "restarting")) {
      res.json({ success: true, status: "initialising", bridgeStarting: true });
    } else {
      res.status(503).json({ error: "WhatsApp Bridge is not available." });
    }
  }
};

// ── Owner: disconnect ─────────────────────────────────────────────────────────
const disconnectHandler: RequestHandler = async (req, res) => {
  const restaurantId = req.user!.restaurantId;
  if (!restaurantId) {
    res.status(400).json({ error: "No restaurant associated with this account" });
    return;
  }
  try {
    const data = await callBridge("/api/whatsapp/disconnect", "POST", { restaurantId });
    res.json(data);
  } catch {
    res.status(503).json({ error: "WhatsApp Bridge unreachable" });
  }
};

// ── Owner: get current status ─────────────────────────────────────────────────
const statusHandler: RequestHandler = async (req, res) => {
  const restaurantId = req.user!.restaurantId;
  if (!restaurantId) {
    res.status(400).json({ error: "No restaurant associated with this account" });
    return;
  }
  try {
    const data = await callBridge(`/api/whatsapp/status/${restaurantId}`, "GET");
    res.json({ ...data, bridgeReachable: true });
  } catch {
    const bridgeState = getBridgeState();
    const managed = isBridgeManaged();

    if (managed && (bridgeState === "starting" || bridgeState === "restarting")) {
      res.json({ success: true, status: "initialising", bridgeReachable: true, bridgeStarting: true, restaurantId });
    } else {
      res.json({ success: true, status: "not_initialised", bridgeReachable: false, restaurantId });
    }
  }
};

router.post("/owner/whatsapp/connect",    requireOwner, connectHandler);
router.post("/owner/whatsapp/disconnect", requireOwner, disconnectHandler);
router.get("/owner/whatsapp/status",      requireOwner, statusHandler);

// ── Incoming webhook from the bridge (general messages) ───────────────────────
router.post("/whatsapp/incoming", ((req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (BITEBEND_WEBHOOK_SECRET && secret !== BITEBEND_WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { restaurantId, customerPhone, messageType, text, imageUrl, timestamp } = req.body as {
    restaurantId: number;
    customerPhone: string;
    messageType: string;
    text?: string;
    imageUrl?: string;
    timestamp: string;
  };

  logger.info(
    { restaurantId, customerPhone, messageType, timestamp },
    "[whatsapp:incoming] message received"
  );

  void text; void imageUrl;

  res.json({ ok: true });
}) as RequestHandler);

// ── Payment screenshot webhook from the bridge ────────────────────────────────
// IMPORTANT: every screenshot is persisted in paymentScreenshotInbox BEFORE
// automatic matching. A failed/ambiguous match therefore remains visible in
// the owner's Payment Screenshot Inbox instead of being discarded.
router.post("/whatsapp/payment-screenshot", (async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (BITEBEND_WEBHOOK_SECRET && secret !== BITEBEND_WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as {
    restaurantId?: number;
    customerPhone?: string;
    senderJid?: string;
    imageUrl?: string;
    timestamp?: string;
  };

  const restaurantId = body.restaurantId;
  const customerPhone = body.customerPhone ?? "";
  const senderJid = body.senderJid;
  const imageUrl = body.imageUrl ?? "";
  const receivedAt = body.timestamp ? new Date(body.timestamp) : new Date();

  if (!restaurantId || !customerPhone || !imageUrl) {
    res.status(400).json({
      error: "restaurantId, customerPhone and imageUrl are required",
    });
    return;
  }

  if (Number.isNaN(receivedAt.getTime())) {
    res.status(400).json({ error: "timestamp must be a valid ISO date" });
    return;
  }

  logger.info(
    { restaurantId, customerPhone, senderJid, timestamp: receivedAt.toISOString() },
    "[whatsapp:payment-screenshot] screenshot received",
  );

  // Normalize the sender phone. For @lid messages the bridge may only be able
  // to provide an opaque LID number; those screenshots are still stored in the
  // inbox and can be manually attached by staff.
  const digits = customerPhone.replace(/\D/g, "").replace(/^0+/, "");
  let normalizedPhone: string | null = null;
  if (digits.length === 10) normalizedPhone = `91${digits}`;
  else if (digits.length === 12 && digits.startsWith("91")) normalizedPhone = digits;
  else if (digits.length === 11 && digits.startsWith("0")) normalizedPhone = `91${digits.slice(1)}`;

  // Download the image into the database-owned data URL. We do this before
  // inserting the inbox row so the inbox always contains a usable screenshot.
  let screenshotDataUrl: string;
  if (imageUrl.startsWith("data:")) {
    screenshotDataUrl = imageUrl;
  } else {
    try {
      const imageRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
      if (!imageRes.ok) throw new Error(`HTTP ${imageRes.status} fetching image`);
      const contentType = imageRes.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      screenshotDataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch (error) {
      logger.error(
        { restaurantId, imageUrl, error: (error as Error).message },
        "[whatsapp:payment-screenshot] failed to fetch image",
      );
      res.status(502).json({ error: "Failed to fetch image from bridge" });
      return;
    }
  }

  const { createHash } = await import("node:crypto");
  const imageHash = createHash("sha256").update(screenshotDataUrl).digest("hex");

  // Persist FIRST. Duplicate screenshots are retained for auditability but are
  // not automatically attached to another bill.
  const [existingDuplicate] = await db
    .select({ id: paymentScreenshotInbox.id })
    .from(paymentScreenshotInbox)
    .where(
      and(
        eq(paymentScreenshotInbox.restaurantId, restaurantId),
        eq(paymentScreenshotInbox.imageHash, imageHash),
      ),
    )
    .orderBy(desc(paymentScreenshotInbox.createdAt))
    .limit(1);

  const [inboxEntry] = await db
    .insert(paymentScreenshotInbox)
    .values({
      restaurantId,
      receivedAt,
      senderJid: senderJid ?? null,
      senderPhone: normalizedPhone ?? customerPhone,
      screenshotData: screenshotDataUrl,
      source: "whatsapp",
      matchStatus: "unmatched",
      imageHash,
      isDuplicate: !!existingDuplicate,
      duplicateOfId: existingDuplicate?.id ?? null,
    })
    .returning();

  if (!inboxEntry) {
    res.status(500).json({ error: "Failed to create screenshot inbox entry" });
    return;
  }

  // A duplicate is deliberately left in the inbox for staff visibility. It is
  // never allowed to overwrite/replace a bill automatically.
  if (existingDuplicate) {
    emitScreenshotInboxEvent(restaurantId, {
      inboxId: inboxEntry.id,
      matchStatus: "unmatched",
      receivedAt: receivedAt.toISOString(),
      isDuplicate: true,
    });

    logger.warn(
      { restaurantId, inboxId: inboxEntry.id, duplicateOfId: existingDuplicate.id },
      "[whatsapp:payment-screenshot] duplicate screenshot stored in inbox",
    );

    res.json({
      ok: true,
      inboxId: inboxEntry.id,
      matched: "none",
      reason: "duplicate",
    });
    return;
  }

  let outcome;
  try {
    outcome = await matchAndAttachScreenshot({
      restaurantId,
      senderJid,
      normalizedPhone,
      screenshotDataUrl,
      now: receivedAt,
    });
  } catch (error) {
    logger.error(
      { restaurantId, inboxId: inboxEntry.id, error: (error as Error).message },
      "[whatsapp:payment-screenshot] matching failed after inbox persistence",
    );
    // Keep the inbox row as unmatched. A later retry can safely run the matcher.
    emitScreenshotInboxEvent(restaurantId, {
      inboxId: inboxEntry.id,
      matchStatus: "unmatched",
      receivedAt: receivedAt.toISOString(),
      isDuplicate: false,
    });
    res.status(202).json({ ok: true, inboxId: inboxEntry.id, matched: "none", reason: "matching_failed" });
    return;
  }

  if (outcome.ok) {
    await db
      .update(paymentScreenshotInbox)
      .set({
        matchStatus: "matched",
        matchedSessionId: outcome.sessionId,
        matchedBillId: outcome.sessionBillId,
        matchingStrategy: outcome.strategy,
        updatedAt: new Date(),
      })
      .where(eq(paymentScreenshotInbox.id, inboxEntry.id));

    emitSessionScreenshotEvent(restaurantId, {
      sessionId: outcome.sessionId,
      billId: outcome.sessionBillId,
      tableNumber: outcome.tableNumber,
      billNumber: outcome.billNumber,
      total: outcome.total,
      customerPhone: outcome.effectivePhone ?? normalizedPhone ?? customerPhone,      
    });

    emitScreenshotInboxEvent(restaurantId, {
      inboxId: inboxEntry.id,
      matchStatus: "matched",
      receivedAt: receivedAt.toISOString(),
      isDuplicate: false,
    });

    logger.info(
      {
        event: "screenshot_matched",
        restaurantId,
        inboxId: inboxEntry.id,
        sessionBillId: outcome.sessionBillId,
        strategy: outcome.strategy,
      },
      "[whatsapp:payment-screenshot] screenshot matched and attached",
    );

    res.json({
      ok: true,
      inboxId: inboxEntry.id,
      matched: "session_bill",
      sessionBillId: outcome.sessionBillId,
    });
    return;
  }

  const matchStatus = outcome.reason === "ambiguous_phone_multiple_bills"
    ? "ambiguous"
    : "unmatched";

  await db
    .update(paymentScreenshotInbox)
    .set({
      matchStatus,
      matchingStrategy: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentScreenshotInbox.id, inboxEntry.id));

  emitScreenshotInboxEvent(restaurantId, {
    inboxId: inboxEntry.id,
    matchStatus,
    receivedAt: receivedAt.toISOString(),
    isDuplicate: false,
  });

  logger.warn(
    {
      event: "screenshot_unmatched",
      restaurantId,
      inboxId: inboxEntry.id,
      reason: outcome.reason,
      candidates: outcome.candidates,
    },
    "[whatsapp:payment-screenshot] screenshot retained in inbox for manual review",
  );

  res.json({
    ok: true,
    inboxId: inboxEntry.id,
    matched: "none",
    reason: outcome.reason,
  });
}) as RequestHandler);

export default router;
