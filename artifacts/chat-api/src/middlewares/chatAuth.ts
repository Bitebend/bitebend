import type { Request, Response, NextFunction, RequestHandler } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { chatDb, messagingAccounts, messagingDevices, messagingSessions } from "../db";
import { sha256Hex, safeEqualHex } from "../lib/crypto";
import {
  COOKIE_NAMES,
  clearHostCookie,
  hasDuplicateCookie,
  parseRawCookies,
  pickCookieValue,
} from "../lib/cookies";

export interface ChatAuthContext {
  sessionId: string;
  accountId: string;
  deviceId: string;
  matrixDeviceId: string;
  username: string;
  displayName: string;
}

export interface AuthedChatRequest extends Request {
  chatAuth: ChatAuthContext;
}

export async function resolveSessionFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<
  | { status: "ok"; auth: ChatAuthContext }
  | { status: "duplicate" }
  | { status: "none" }
  | { status: "invalid_or_revoked" }
> {
  const { values, duplicates } = parseRawCookies(cookieHeader);
  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV])) {
    return { status: "duplicate" };
  }

  const rawSession = pickCookieValue(values, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
  if (!rawSession) {
    return { status: "none" };
  }

  const tokenHash = sha256Hex(rawSession);
  const now = new Date();

  const rows = await chatDb
    .select({
      sessionId: messagingSessions.id,
      accountId: messagingSessions.accountId,
      deviceId: messagingSessions.deviceId,
      deviceStatus: messagingDevices.status,
      deviceRevokedAt: messagingDevices.revokedAt,
      matrixDeviceId: messagingDevices.matrixDeviceId,
      username: messagingAccounts.username,
      displayName: messagingAccounts.displayName,
    })
    .from(messagingSessions)
    .innerJoin(messagingDevices, eq(messagingDevices.id, messagingSessions.deviceId))
    .innerJoin(messagingAccounts, eq(messagingAccounts.id, messagingSessions.accountId))
    .where(
      and(
        eq(messagingSessions.tokenHash, tokenHash),
        isNull(messagingSessions.revokedAt),
        gt(messagingSessions.expiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.deviceStatus !== "active" || row.deviceRevokedAt !== null) {
    return { status: "invalid_or_revoked" };
  }

  return {
    status: "ok",
    auth: {
      sessionId: row.sessionId,
      accountId: row.accountId,
      deviceId: row.deviceId,
      matrixDeviceId: row.matrixDeviceId,
      username: row.username,
      displayName: row.displayName,
    },
  };
}

export const requireChatAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSessionFromCookieHeader(req.headers.cookie);
    if (resolved.status === "duplicate") {
      clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
      res.status(401).json({ error: "Duplicate session cookie rejected", code: "DUPLICATE_COOKIE" });
      return;
    }
    if (resolved.status === "none") {
      res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
      return;
    }
    if (resolved.status === "invalid_or_revoked") {
      clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
      res.status(401).json({ error: "Session or device was revoked", code: "SESSION_REVOKED" });
      return;
    }

    (req as AuthedChatRequest).chatAuth = resolved.auth;
    // Best-effort touch lastSeenAt without blocking hot path
    chatDb
      .update(messagingSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(messagingSessions.id, resolved.auth.sessionId))
      .catch(() => {});

    next();
  } catch (err) {
    next(err);
  }
};

export const requireChatAdmin: RequestHandler = (req, res, next) => {
  const configured = process.env["CHAT_ADMIN_SECRET"]?.trim();
  if (!configured) {
    res.status(503).json({ error: "Messaging admin secret not configured" });
    return;
  }
  const provided = String(req.headers["x-chat-admin-secret"] ?? "");
  if (!provided || !safeEqualHex(sha256Hex(provided), sha256Hex(configured))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
};
