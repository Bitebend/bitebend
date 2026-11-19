import { Router, type Request, type Response, type RequestHandler } from "express";
import crypto from "node:crypto";
import { db, pool, orders, messagingHandoffTokens, internalRequestNonces } from "@workspace/db";
import { and, eq, gte, isNull, lte, gt } from "drizzle-orm";
import { createRateLimiter } from "../lib/rateLimiter";
import { logger } from "../lib/logger";

const router = Router();

const HANDOFF_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_CLOCK_SKEW_MS = 60 * 1000;   // +-60 seconds
const NONCE_TTL_MS = 5 * 60 * 1000;    // 5 minutes

const HANDOFF_COOKIE_PROD = "__Secure-bb_msg_handoff";
const HANDOFF_COOKIE_DEV = "bb_msg_handoff";
const BIND_COOKIE_PROD = "__Host-bb_handoff_src";
const BIND_COOKIE_DEV = "bb_handoff_src";

function parseHandoffMintBody(body: unknown): { restaurantId: number; orderId: number; customerPhone: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const restaurantId = Number(b["restaurantId"]);
  const orderId = Number(b["orderId"]);
  const rawPhone = typeof b["customerPhone"] === "string" ? b["customerPhone"].trim() : "";
  if (!Number.isInteger(restaurantId) || restaurantId <= 0) return null;
  if (!Number.isInteger(orderId) || orderId <= 0) return null;
  if (rawPhone.length < 6 || rawPhone.length > 24) return null;
  return { restaurantId, orderId, customerPhone: rawPhone };
}

function parseVerifyConsumeBody(body: unknown): { rawToken: string } | null {
  if (!body || typeof body !== "object") return null;
  const rawToken = (body as Record<string, unknown>)["rawToken"];
  if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 256) return null;
  return { rawToken };
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return null;
}

/**
 * Raw Cookie header parser — detects duplicate cookie names BEFORE a standard
 * Map-based parser silently picks one, blocking cookie-tossing collisions.
 */
function parseRawCookies(cookieHeader: string | undefined): {
  values: Map<string, string>;
  duplicates: Set<string>;
} {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  if (!cookieHeader) return { values, duplicates };

  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (!name) continue;
    if (values.has(name)) {
      duplicates.add(name);
    } else {
      values.set(name, decodeURIComponent(val));
    }
  }
  return { values, duplicates };
}

function isHttpsRequest(req: Request): boolean {
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
  return req.secure || xfProto === "https";
}

function getHostname(req: Request): string {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return host.split(",")[0].trim().split(":")[0].toLowerCase();
}

function isAllowedHandoffOrigin(originHeader: string | undefined, req: Request): boolean {
  // Same-origin browser navigation / curl tests without Origin on strict same-host
  // must still pass explicit check if Origin is present. If Origin is missing, require
  // Sec-Fetch-Site === 'same-origin' or non-browser local dev host.
  const configuredAllowed = (process.env["MENU_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const siteUrl = (process.env["SITE_URL"] ?? "").trim().toLowerCase().replace(/\/$/, "");

  if (!originHeader) {
    const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
    if (fetchSite === "cross-site") return false;
    return fetchSite === "same-origin" || fetchSite === "" || process.env["NODE_ENV"] !== "production";
  }

  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }

  const normalizedOrigin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  if (siteUrl && normalizedOrigin === siteUrl) return true;
  if (configuredAllowed.includes(normalizedOrigin)) return true;

  const h = parsed.hostname.toLowerCase();
  if (h === "menu.bitebend.in" || h === "bitebend.in" || h === "www.bitebend.in") {
    return parsed.protocol === "https:";
  }
  if (h === "localhost" || h === "127.0.0.1") {
    return true;
  }
  if (h.endsWith(".run.app") && parsed.protocol === "https:") {
    return true;
  }
  return false;
}

function getHmacSecret(): string | null {
  const explicit = process.env["CHAT_INTERNAL_HMAC_SECRET"]?.trim();
  if (explicit) return explicit;
  if (process.env["NODE_ENV"] === "production") {
    return null;
  }
  return process.env["SESSION_SECRET"]?.trim() || "bitebend-dev-chat-handoff-hmac-secret";
}

function clearHandoffCookies(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const hostname = getHostname(req);
  const useParentDomain = https && (hostname === "bitebend.in" || hostname.endsWith(".bitebend.in"));

  res.clearCookie(HANDOFF_COOKIE_PROD, {
    path: "/",
    ...(useParentDomain ? { domain: ".bitebend.in" } : {}),
  });
  res.clearCookie(HANDOFF_COOKIE_DEV, {
    path: "/",
    ...(useParentDomain ? { domain: ".bitebend.in" } : {}),
  });
  res.clearCookie(BIND_COOKIE_PROD, { path: "/" });
  res.clearCookie(BIND_COOKIE_DEV, { path: "/" });
}

const mintLimiter = createRateLimiter({
  maxRequests: 20,
  windowMs: 10 * 60 * 1000,
  label: "msg-handoff-mint",
  message: "Too many handoff requests. Please try again shortly.",
});

const verifyLimiter = createRateLimiter({
  maxRequests: 120,
  windowMs: 60 * 1000,
  label: "msg-handoff-verify",
});

/**
 * POST /api/menu/messaging-handoff
 *
 * Non-blocking post-order endpoint: verifies that { restaurantId, orderId, customerPhone }
 * matches a recently placed order (< 20 minutes old) without modifying `placeOrder`.
 * Issues a short-lived, single-use, hashed handoff cookie + issuing-origin binding lock.
 */
const issueMessagingHandoff: RequestHandler = async (req, res) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedHandoffOrigin(origin, req)) {
    res.status(403).json({ error: "Origin not authorized for messaging handoff", code: "FORBIDDEN_ORIGIN" });
    return;
  }

  const parsedCookies = parseRawCookies(req.headers.cookie);
  if (
    parsedCookies.duplicates.has(HANDOFF_COOKIE_PROD) ||
    parsedCookies.duplicates.has(HANDOFF_COOKIE_DEV) ||
    parsedCookies.duplicates.has(BIND_COOKIE_PROD) ||
    parsedCookies.duplicates.has(BIND_COOKIE_DEV)
  ) {
    clearHandoffCookies(req, res);
    res.status(400).json({ error: "Malformed duplicate handoff cookies detected", code: "DUPLICATE_COOKIE" });
    return;
  }

  const parsed = parseHandoffMintBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid handoff request parameters" });
    return;
  }

  const { restaurantId, orderId, customerPhone } = parsed;
  const normalizedInputPhone = normalizePhone(customerPhone);
  if (!normalizedInputPhone) {
    res.status(400).json({ error: "Invalid phone number format" });
    return;
  }

  // Verify recent order ownership window without modifying placeOrder
  const recentCutoff = new Date(Date.now() - HANDOFF_TTL_MS);
  const [order] = await db
    .select({
      id: orders.id,
      restaurantId: orders.restaurantId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.restaurantId, restaurantId),
        gte(orders.createdAt, recentCutoff),
      ),
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ error: "Eligible recent order not found", code: "ORDER_NOT_ELIGIBLE" });
    return;
  }

  const orderPhoneNormalized = normalizePhone(order.customerPhone) ?? order.customerPhone.replace(/\D/g, "");
  if (orderPhoneNormalized !== normalizedInputPhone) {
    res.status(403).json({ error: "Order details do not match", code: "PHONE_MISMATCH" });
    return;
  }

  const existingBindSecret =
    parsedCookies.values.get(BIND_COOKIE_PROD) ??
    parsedCookies.values.get(BIND_COOKIE_DEV) ??
    null;

  const bindSecret = existingBindSecret || crypto.randomBytes(32).toString("base64url");
  const browserBindHash = sha256Hex(bindSecret);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const handoffId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

  await db.transaction(async (tx) => {
    // Only invalidate prior unconsumed tokens belonging to the SAME issuing browser lock
    await tx
      .update(messagingHandoffTokens)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          eq(messagingHandoffTokens.browserBindHash, browserBindHash),
          isNull(messagingHandoffTokens.consumedAt),
          isNull(messagingHandoffTokens.invalidatedAt),
        ),
      );

    await tx.insert(messagingHandoffTokens).values({
      id: handoffId,
      tokenHash,
      browserBindHash,
      orderId: order.id,
      restaurantId: order.restaurantId,
      customerName: order.customerName,
      customerPhone: orderPhoneNormalized,
      expiresAt,
    });
  });

  const https = isHttpsRequest(req);
  const hostname = getHostname(req);
  const useParentDomain = https && (hostname === "bitebend.in" || hostname.endsWith(".bitebend.in"));

  const handoffCookieName = https ? HANDOFF_COOKIE_PROD : HANDOFF_COOKIE_DEV;
  const bindCookieName = https ? BIND_COOKIE_PROD : BIND_COOKIE_DEV;

  res.cookie(handoffCookieName, rawToken, {
    httpOnly: true,
    secure: https,
    sameSite: "lax",
    path: "/",
    maxAge: HANDOFF_TTL_MS,
    ...(useParentDomain ? { domain: ".bitebend.in" } : {}),
  });

  // Host-only replacement lock cookie (never has a Domain attribute)
  res.cookie(bindCookieName, bindSecret, {
    httpOnly: true,
    secure: https,
    sameSite: "lax",
    path: "/",
    maxAge: HANDOFF_TTL_MS,
  });

  logger.info(
    { event: "messaging_handoff_minted", handoffId, orderId: order.id, restaurantId: order.restaurantId },
    "Messaging handoff token minted",
  );

  res.status(201).json({
    ok: true,
    handoffId,
    expiresAt: expiresAt.toISOString(),
  });
};

/**
 * POST /api/internal/messaging/handoff/verify-consume
 *
 * Server-to-server HMAC-authenticated endpoint called exclusively by @workspace/chat-api
 * to verify and atomically consume a short-lived QR handoff token.
 */
const verifyAndConsumeHandoff: RequestHandler = async (req, res) => {
  const secret = getHmacSecret();
  if (!secret) {
    res.status(503).json({ error: "Messaging handoff secret is not configured", code: "HMAC_NOT_CONFIGURED" });
    return;
  }

  const tsHeader = String(req.headers["x-bitebend-ts"] ?? "");
  const nonceHeader = String(req.headers["x-bitebend-nonce"] ?? "");
  const sigHeader = String(req.headers["x-bitebend-sig"] ?? "");

  const tsMs = Number(tsHeader);
  if (!tsHeader || !Number.isFinite(tsMs) || !nonceHeader || nonceHeader.length < 16 || !sigHeader) {
    res.status(401).json({ error: "Missing S2S authentication headers", code: "UNAUTHORIZED" });
    return;
  }

  if (Math.abs(Date.now() - tsMs) > MAX_CLOCK_SKEW_MS) {
    res.status(401).json({ error: "Request timestamp outside allowed clock skew", code: "STALE_TIMESTAMP" });
    return;
  }

  const parsedBody = parseVerifyConsumeBody(req.body);
  if (!parsedBody) {
    res.status(400).json({ error: "Invalid verification payload" });
    return;
  }

  const bodyCanonical = JSON.stringify(parsedBody);
  const fullPath = `${req.baseUrl}${req.path}`;
  const signingInput = `POST\n${fullPath}\n${tsHeader}\n${nonceHeader}\n${sha256Hex(bodyCanonical)}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");

  const sigBuf = Buffer.from(sigHeader, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    res.status(401).json({ error: "Invalid HMAC signature", code: "INVALID_SIGNATURE" });
    return;
  }

  // Atomic replay check via internal_request_nonces
  const nonceHash = sha256Hex(nonceHeader);
  const nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);
  const insertedNonce = await db
    .insert(internalRequestNonces)
    .values({ nonceHash, expiresAt: nonceExpiresAt })
    .onConflictDoNothing({ target: internalRequestNonces.nonceHash })
    .returning({ nonceHash: internalRequestNonces.nonceHash });

  if (insertedNonce.length === 0) {
    res.status(409).json({ error: "Replay nonce rejected", code: "REPLAY_DETECTED" });
    return;
  }

  const tokenHash = sha256Hex(parsedBody.rawToken);
  const now = new Date();

  const [consumed] = await db
    .update(messagingHandoffTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(messagingHandoffTokens.tokenHash, tokenHash),
        isNull(messagingHandoffTokens.consumedAt),
        isNull(messagingHandoffTokens.invalidatedAt),
        gt(messagingHandoffTokens.expiresAt, now),
      ),
    )
    .returning({
      id: messagingHandoffTokens.id,
      restaurantId: messagingHandoffTokens.restaurantId,
      customerName: messagingHandoffTokens.customerName,
      customerPhone: messagingHandoffTokens.customerPhone,
      createdAt: messagingHandoffTokens.createdAt,
    });

  if (!consumed) {
    // Distinguish already consumed vs unknown/expired without leaking tokens
    const [existing] = await db
      .select({
        consumedAt: messagingHandoffTokens.consumedAt,
        invalidatedAt: messagingHandoffTokens.invalidatedAt,
        expiresAt: messagingHandoffTokens.expiresAt,
      })
      .from(messagingHandoffTokens)
      .where(eq(messagingHandoffTokens.tokenHash, tokenHash))
      .limit(1);

    if (existing?.consumedAt) {
      res.status(409).json({ valid: false, code: "HANDOFF_ALREADY_CONSUMED" });
      return;
    }
    res.status(410).json({ valid: false, code: "HANDOFF_EXPIRED_OR_INVALID" });
    return;
  }

  res.status(200).json({
    valid: true,
    handoffId: consumed.id,
    restaurantId: consumed.restaurantId,
    customerName: consumed.customerName,
    customerPhone: consumed.customerPhone,
    issuedAt: consumed.createdAt.toISOString(),
  });
};

export async function purgeExpiredHandoffRecords(): Promise<void> {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .delete(messagingHandoffTokens)
      .where(lte(messagingHandoffTokens.expiresAt, dayAgo));
    await db
      .delete(internalRequestNonces)
      .where(lte(internalRequestNonces.expiresAt, new Date()));
  } catch (err) {
    logger.warn({ err }, "Expired handoff cleanup skipped");
  }
}

// Strict Origin/CORS guard overriding permissive app.ts global CORS on this route
const handoffOriginCors: RequestHandler = (req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin && isAllowedHandoffOrigin(origin, req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else if (origin) {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Credentials");
    if (req.method === "OPTIONS") {
      res.status(403).end();
      return;
    }
  }
  next();
};

router.options("/menu/messaging-handoff", handoffOriginCors, (_req, res) => res.status(204).end());
router.post("/menu/messaging-handoff", handoffOriginCors, mintLimiter, issueMessagingHandoff);
router.post("/internal/messaging/handoff/verify-consume", verifyLimiter, verifyAndConsumeHandoff);

export default router;
