import type { Request, RequestHandler } from "express";
import { db } from "@workspace/db";
import { restaurantStaff, restaurants } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { verifyStaffToken } from "../lib/staffToken";

export async function resolveStaffFromRequest(req: Request) {
  const rawAuth = req.headers.authorization || (req.headers["x-staff-token"] as string | undefined);
  if (!rawAuth) return null;

  const tokenStr = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7).trim() : rawAuth.trim();
  const payload = verifyStaffToken(tokenStr);
  if (!payload || !payload.staffId || payload.tokenType !== "staff") {
    return null;
  }

  // Fetch staff record from DB
  const [staff] = await db
    .select()
    .from(restaurantStaff)
    .where(eq(restaurantStaff.id, payload.staffId))
    .limit(1);

  if (!staff) return null;

  // Check token version (instant revocation on disconnect or PIN reset)
  if (staff.tokenVersion !== payload.tokenVersion) {
    return null;
  }

  // Check active status
  if (!staff.isActive) {
    return null;
  }

  const [restaurant] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, staff.restaurantId))
    .limit(1);

  return { staff, restaurant: restaurant || null };
}

export const requireStaff: RequestHandler = async (req, res, next) => {
  const resolved = await resolveStaffFromRequest(req);
  if (!resolved || !resolved.staff) {
    res.status(401).json({ error: "Unauthorized: Invalid, expired, or disconnected staff session" });
    return;
  }

  req.staff = resolved.staff;
  if (resolved.restaurant) {
    req.restaurant = resolved.restaurant;
  }
  next();
};

export function requireStaffRole(allowedRole: "waiter" | "chef"): RequestHandler {
  return async (req, res, next) => {
    const resolved = await resolveStaffFromRequest(req);
    if (!resolved || !resolved.staff) {
      res.status(401).json({ error: "Unauthorized: Invalid, expired, or disconnected staff session" });
      return;
    }

    if (resolved.staff.role !== allowedRole) {
      res.status(403).json({ error: `Forbidden: Requires ${allowedRole} role` });
      return;
    }

    req.staff = resolved.staff;
    if (resolved.restaurant) {
      req.restaurant = resolved.restaurant;
    }
    next();
  };
}
