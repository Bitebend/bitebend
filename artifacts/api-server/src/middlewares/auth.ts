import type { Request, RequestHandler } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyToken } from "../lib/token";

export async function resolveUserFromRequest(req: Request) {
  let userId: number | undefined = req.session?.userId;

  if (!userId) {
    const rawAuth = req.headers.authorization || (req.headers["x-auth-token"] as string | undefined);
    if (rawAuth) {
      const tokenStr = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7).trim() : rawAuth.trim();
      const payload = verifyToken(tokenStr);
      if (payload?.userId) {
        userId = payload.userId;
        if (req.session) {
          req.session.userId = payload.userId;
        }
      }
    }
  }

  if (!userId) return null;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user || null;
}

// requireSensitiveAuth — must follow requireAdmin in the middleware chain.
// Checks that the current session has an unexpired sensitive-action unlock.
// Returns 403 with a machine-readable `code` so the frontend can distinguish
// "needs password" (SENSITIVE_AUTH_REQUIRED) from "unlock expired" (SENSITIVE_AUTH_EXPIRED).
export const requireSensitiveAuth: RequestHandler = (req, res, next) => {
  const expiresAt = req.session?.sensitiveActionExpiresAt;
  if (!expiresAt) {
    res.status(403).json({
      error: "Sensitive action authentication required",
      code: "SENSITIVE_AUTH_REQUIRED",
    });
    return;
  }
  if (Date.now() >= expiresAt) {
    if (req.session) {
      delete req.session.sensitiveActionExpiresAt;
    }
    res.status(403).json({
      error: "Sensitive action authentication expired",
      code: "SENSITIVE_AUTH_EXPIRED",
    });
    return;
  }
  next();
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  const user = await resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.user = user;
  if (req.session) {
    req.session.userId = user.id;
  }
  next();
};

export const requireOwner: RequestHandler = async (req, res, next) => {
  const user = await resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "owner") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  req.user = user;
  if (req.session) {
    req.session.userId = user.id;
  }
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const user = await resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  req.user = user;
  if (req.session) {
    req.session.userId = user.id;
  }
  next();
};

export const requirePartner: RequestHandler = async (req, res, next) => {
  const user = await resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "partner") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  req.user = user;
  if (req.session) {
    req.session.userId = user.id;
  }
  next();
};


