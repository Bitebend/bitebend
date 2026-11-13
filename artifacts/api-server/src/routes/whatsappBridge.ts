import { Router } from "express";
import { requireOwner } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { db, paymentScreenshotInbox, sessionBills } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { emitSessionScreenshotEvent, emitScreenshotInboxEvent } from "../lib/orderEvents";
import { matchAndAttachScreenshot } from "../lib/screenshotMatcher";
import { getBridgeState, isBridgeManaged } from "../lib/bridgeManager";
import type { RequestHandler } from "express";

const router = Router();

import { getWhatsAppBridgeConfig, validateWhatsAppConfig } from "../lib/whatsappConfig";
export { getWhatsAppBridgeConfig, validateWhatsAppConfig };

const {
  bridgeUrl: BRIDGE_URL,
  bridgeApiSecret: BRIDGE_API_SECRET,
  webhookSecret: BITEBEND_WEBHOOK_SECRET,
} = getWhatsAppBridgeConfig();

function isWebhookAuthorized(reqSecret: string | undefined): boolean {
  if (process.env.NODE_ENV === "production") {
    return Boolean(reqSecret && BITEBEND_WEBHOOK_SECRET && reqSecret === BITEBEND_WEBHOOK_SECRET);
  }
  // In development, require secret only if configured
  if (BITEBEND_WEBHOOK_SECRET) {
    return reqSecret === BITEBEND_WEBHOOK_SECRET;
  }
  return true;
}

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

export function normalizeInboundPhone(
  customerPhone: string,
  senderJid?: string,
): string | null {
  const digits = customerPhone.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;

  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;

  // For non-@lid senders (or @lid senders whose contact resolved to a real phone
  // rather than the opaque LID user ID), accept standard E.164 international numbers.
  const senderUser = senderJid?.split("@")[0] ?? "";
  const isOpaqueLid = Boolean(senderJid?.endsWith("@lid") && digits === senderUser);
  if (!isOpaqueLid && digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  return null;
}

function sniffImageMimeFromBuffer(buf: Buffer): string | null {
  if (buf.byteLength < 3) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.byteLength >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  if (
    buf.byteLength >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  if (
    buf.byteLength >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return "image/gif";
  return null;
}

export function sanitizeScreenshotDataUrl(
  rawUrl: string,
): { ok: true; dataUrl: string } | { ok: false; error: string } {
  const match = rawUrl.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/is);
  if (!match) {
    return { ok: false, error: "Invalid image data URI format" };
  }
  const rawMime = (match[1] ?? "").trim().toLowerCase();
  const base64Payload = (match[2] ?? "").replace(/\s+/g, "");
  if (!base64Payload) {
    return { ok: false, error: "Empty payment screenshot image data" };
  }
  const decoded = Buffer.from(base64Payload, "base64");
  if (decoded.byteLength === 0) {
    return { ok: false, error: "Corrupt or empty payment screenshot image payload" };
  }
  const sniffed = sniffImageMimeFromBuffer(decoded);
  const mime = sniffed ?? (rawMime.startsWith("image/") ? rawMime : "image/jpeg");
  return { ok: true, dataUrl: `data:${mime};base64,${base64Payload}` };
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

// ── Owner: get QR status (REST poll fallback) ──────────────────────────────────
const qrStatusHandler: RequestHandler = async (req, res) => {
  const restaurantId = req.user!.restaurantId;
  if (!restaurantId) {
    res.status(400).json({ error: "No restaurant associated with this account" });
    return;
  }
  try {
    const data = await callBridge(`/api/whatsapp/qr-status/${restaurantId}`, "GET");
    res.json({ ...data, bridgeReachable: true });
  } catch {
    const bridgeState = getBridgeState();
    const managed = isBridgeManaged();

    if (managed && (bridgeState === "starting" || bridgeState === "restarting")) {
      res.json({
        success: true,
        restaurantId,
        status: "initialising",
        qr: null,
        generatedAt: null,
        expiresAt: null,
        bridgeReachable: true,
        bridgeStarting: true,
      });
    } else {
      res.json({
        success: false,
        restaurantId,
        status: "not_initialised",
        qr: null,
        generatedAt: null,
        expiresAt: null,
        bridgeReachable: false,
      });
    }
  }
};

router.post("/owner/whatsapp/connect",    requireOwner, connectHandler);
router.post("/owner/whatsapp/disconnect", requireOwner, disconnectHandler);
router.get("/owner/whatsapp/status",      requireOwner, statusHandler);
router.get("/owner/whatsapp/qr-status",   requireOwner, qrStatusHandler);

// ── Incoming webhook from the bridge (general messages) ───────────────────────
router.post("/whatsapp/incoming", ((req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!isWebhookAuthorized(typeof secret === "string" ? secret : undefined)) {
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
  if (!isWebhookAuthorized(typeof secret === "string" ? secret : undefined)) {
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
  const normalizedPhone = normalizeInboundPhone(customerPhone, senderJid);

  // Download the image into the database-owned data URL. We do this before
  // inserting the inbox row so the inbox always contains a usable screenshot.
  let screenshotDataUrl: string;
  if (imageUrl.startsWith("data:")) {
    const sanitized = sanitizeScreenshotDataUrl(imageUrl);
    if (!sanitized.ok) {
      logger.warn(
        { restaurantId, customerPhone, senderJid, error: sanitized.error },
        "[whatsapp:payment-screenshot] rejected invalid or empty data URI",
      );
      res.status(400).json({ error: sanitized.error });
      return;
    }
    screenshotDataUrl = sanitized.dataUrl;
  } else {
    try {
      const imageRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
      if (!imageRes.ok) throw new Error(`HTTP ${imageRes.status} fetching image`);
      const rawContentType = imageRes.headers.get("content-type") ?? "image/jpeg";
      const headerMime = rawContentType.split(";")[0]?.trim().toLowerCase() || "image/jpeg";
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      if (buffer.byteLength === 0) {
        throw new Error("Bridge returned an empty image body");
      }
      const finalMime = sniffImageMimeFromBuffer(buffer) ?? (headerMime.startsWith("image/") ? headerMime : "image/jpeg");
      screenshotDataUrl = `data:${finalMime};base64,${buffer.toString("base64")}`;
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

  // Persist FIRST. Duplicate screenshots are retained for auditability.
  // Only skip auto-matching when an active matched bill is still awaiting_verification
  // or paid — if the prior copy was unmatched or its bill was rejected back to 'sent',
  // allow this resend to run through the matcher normally.
  const [existingDuplicate] = await db
    .select({
      id: paymentScreenshotInbox.id,
      matchStatus: paymentScreenshotInbox.matchStatus,
      matchedBillId: paymentScreenshotInbox.matchedBillId,
    })
    .from(paymentScreenshotInbox)
    .where(
      and(
        eq(paymentScreenshotInbox.restaurantId, restaurantId),
        eq(paymentScreenshotInbox.imageHash, imageHash),
      ),
    )
    .orderBy(desc(paymentScreenshotInbox.createdAt))
    .limit(1);

  let shouldSkipDuplicateMatch = false;
  if (existingDuplicate?.matchStatus === "matched") {
    if (existingDuplicate.matchedBillId) {
      const [priorBill] = await db
        .select({ status: sessionBills.status })
        .from(sessionBills)
        .where(eq(sessionBills.id, existingDuplicate.matchedBillId))
        .limit(1);
      shouldSkipDuplicateMatch = !priorBill || priorBill.status === "awaiting_verification" || priorBill.status === "paid";
    } else {
      shouldSkipDuplicateMatch = true;
    }
  }

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

  // An active-matched duplicate is deliberately left in the inbox for staff visibility.
  // It is never allowed to overwrite/replace an active verified/pending bill automatically.
  if (shouldSkipDuplicateMatch && existingDuplicate) {
    emitScreenshotInboxEvent(restaurantId, {
      inboxId: inboxEntry.id,
      matchStatus: "unmatched",
      receivedAt: receivedAt.toISOString(),
      isDuplicate: true,
    });

    logger.warn(
      { restaurantId, inboxId: inboxEntry.id, duplicateOfId: existingDuplicate.id },
      "[whatsapp:payment-screenshot] duplicate of active-matched screenshot stored in inbox",
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
        attachedAt: new Date(),
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
