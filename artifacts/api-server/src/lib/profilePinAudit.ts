import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db, ownerSecurityAuditLogs } from "@workspace/db";
import { logger } from "./logger";

const FORBIDDEN_META_KEYS = new Set([
  "pin",
  "currentPin",
  "newPin",
  "confirmPin",
  "otp",
  "pinHash",
  "otpHmac",
  "pepper",
  "unlockToken",
  "phone",
  "registrationPhone",
  "registrationPhoneNorm",
]);

function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

export async function recordOwnerSecurityAudit(params: {
  restaurantId?: number | null;
  ownerUserId?: number | null;
  actorUserId?: number | null;
  actorRole: "owner" | "super_admin" | "system";
  eventType: string;
  challengeId?: string | null;
  meta?: Record<string, unknown>;
  req?: Request;
}): Promise<void> {
  try {
    const rawIp = params.req?.ip ?? null;
    const uaHeader = params.req?.headers["user-agent"];
    const userAgent =
      typeof uaHeader === "string" ? uaHeader.slice(0, 255) : null;

    await db.insert(ownerSecurityAuditLogs).values({
      restaurantIdSnapshot: params.restaurantId ?? null,
      ownerUserIdSnapshot: params.ownerUserId ?? null,
      actorUserIdSnapshot: params.actorUserId ?? null,
      actorRole: params.actorRole,
      eventType: params.eventType,
      challengeId: params.challengeId ?? null,
      metaJson: sanitizeAuditMeta(params.meta),
      ip: rawIp ? String(rawIp).slice(0, 128) : null,
      userAgent,
      createdAt: sql`clock_timestamp()`,
    });
  } catch (err) {
    // Audit write failure should be logged visibly without crashing callers after commit unless critical
    logger.error({ err, eventType: params.eventType }, "Failed to record owner security audit log");
  }
}
