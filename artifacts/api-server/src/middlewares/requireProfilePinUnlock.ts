import type { RequestHandler } from "express";
import { db, restaurantProfilePins } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { verifyProfilePinUnlockToken } from "../lib/profilePinCrypto";

/**
 * Enforces Stage 2 Profile 4-Digit PIN protection strictly on Profile endpoints
 * (GET /api/owner/profile and PUT /api/owner/profile).
 * Must run AFTER requireOwner.
 * Checks live DB row (pin_version, locked_until) and PostgreSQL clock_timestamp()
 * on every request so global locks, PIN changes, PIN resets, and Admin resets revoke
 * all sessions & X-Profile-Pin-Token values immediately without Node/DB clock skew.
 */
export const requireProfilePinUnlock: RequestHandler = async (req, res, next) => {
  const user = req.user;
  if (!user || user.role !== "owner") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const restaurantId = user.restaurantId;
  const [pinRow] = await db
    .select({
      id: restaurantProfilePins.id,
      pinHash: restaurantProfilePins.pinHash,
      pinVersion: restaurantProfilePins.pinVersion,
      lockedUntil: restaurantProfilePins.lockedUntil,
      lockoutLevel: restaurantProfilePins.lockoutLevel,
      nowTs: sql<Date | string>`clock_timestamp()`.as("now_ts"),
    })
    .from(restaurantProfilePins)
    .where(eq(restaurantProfilePins.restaurantId, restaurantId))
    .limit(1);

  if (!pinRow || pinRow.pinHash === null) {
    res.status(403).json({
      error: "Set up a 4-digit Profile PIN before accessing Profile settings.",
      code: "PIN_SETUP_REQUIRED",
    });
    return;
  }

  const nowDbMs = new Date(pinRow.nowTs).getTime();

  if (pinRow.lockedUntil && pinRow.lockedUntil.getTime() > nowDbMs) {
    res.status(403).json({
      error: "Profile PIN is temporarily locked due to too many incorrect attempts.",
      code: "PIN_LOCKED",
      lockedUntil: pinRow.lockedUntil.toISOString(),
      lockoutLevel: pinRow.lockoutLevel,
    });
    return;
  }

  const rawHeaderToken = req.headers["x-profile-pin-token"];
  const headerToken = typeof rawHeaderToken === "string" ? rawHeaderToken.trim() : "";

  if (headerToken) {
    const claims = verifyProfilePinUnlockToken(headerToken);
    if (!claims || claims.uid !== user.id || claims.rid !== restaurantId) {
      res.status(403).json({
        error: "Profile PIN verification required.",
        code: "PIN_REQUIRED",
      });
      return;
    }
    if (claims.pv !== pinRow.pinVersion) {
      res.status(403).json({
        error: "Profile PIN session was locked or updated. Please re-enter your PIN.",
        code: "PIN_REQUIRED",
      });
      return;
    }
    if (nowDbMs >= claims.exp) {
      res.status(403).json({
        error: "Profile PIN session expired. Please re-enter your PIN.",
        code: "PIN_EXPIRED",
      });
      return;
    }
    req.profilePinUnlock = {
      restaurantId,
      ownerUserId: user.id,
      pinVersion: pinRow.pinVersion,
      source: "header",
    };
    next();
    return;
  }

  const sessionEntry = req.session?.profilePinUnlocks?.[String(restaurantId)];
  if (!sessionEntry) {
    res.status(403).json({
      error: "Profile PIN verification required.",
      code: "PIN_REQUIRED",
    });
    return;
  }

  if (sessionEntry.pinVersion !== pinRow.pinVersion) {
    if (req.session?.profilePinUnlocks) {
      delete req.session.profilePinUnlocks[String(restaurantId)];
    }
    res.status(403).json({
      error: "Profile PIN session was locked or updated. Please re-enter your PIN.",
      code: "PIN_REQUIRED",
    });
    return;
  }

  if (nowDbMs >= sessionEntry.expiresAt) {
    if (req.session?.profilePinUnlocks) {
      delete req.session.profilePinUnlocks[String(restaurantId)];
    }
    res.status(403).json({
      error: "Profile PIN session expired. Please re-enter your PIN.",
      code: "PIN_EXPIRED",
    });
    return;
  }

  req.profilePinUnlock = {
    restaurantId,
    ownerUserId: user.id,
    pinVersion: pinRow.pinVersion,
    source: "session",
  };
  next();
};
