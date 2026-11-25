import type { Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, profilePinOtpChallenges, restaurants } from "@workspace/db";
import { logger } from "./logger";

export type SecurityTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const DEFAULT_SECURITY_TX_TIMEOUTS = {
  lockTimeoutMs: 2000,
  statementTimeoutMs: 5000,
  idleInTxTimeoutMs: 5000,
} as const;

export interface SecurityTxOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleInTxTimeoutMs?: number;
}

export class SecurityContentionError extends Error {
  readonly status = 503;
  readonly code = "DB_CONTENTION_RETRY";
  readonly pgCode?: string;

  constructor(message: string, pgCode?: string) {
    super(message);
    this.name = "SecurityContentionError";
    this.pgCode = pgCode;
  }
}

const PG_CONTENTION_CODES = new Set([
  "55P03", // lock_not_available / lock timeout
  "57014", // query_canceled / statement timeout
  "25P03", // idle_in_transaction_session_timeout
  "40P01", // deadlock_detected
  "40001", // serialization_failure
]);

export function extractPgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const rec = cur as { code?: unknown; cause?: unknown; originalError?: unknown };
    if (typeof rec.code === "string" && rec.code.length > 0) {
      return rec.code;
    }
    cur = rec.cause ?? rec.originalError;
  }
  return undefined;
}

export function extractPgConstraintName(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const rec = cur as {
      constraint?: unknown;
      constraintName?: unknown;
      cause?: unknown;
      originalError?: unknown;
    };
    if (typeof rec.constraint === "string" && rec.constraint.length > 0) {
      return rec.constraint;
    }
    if (typeof rec.constraintName === "string" && rec.constraintName.length > 0) {
      return rec.constraintName;
    }
    cur = rec.cause ?? rec.originalError;
  }
  return undefined;
}

export const ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX = "uq_otp_challenges_one_active_per_owner_rest";

export function isActiveOtpChallengeUniqueViolation(err: unknown): boolean {
  return (
    extractPgErrorCode(err) === "23505" &&
    extractPgConstraintName(err) === ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX
  );
}

export function isPgContentionError(err: unknown): boolean {
  if (err instanceof SecurityContentionError) return true;
  const code = extractPgErrorCode(err);
  if (code && PG_CONTENTION_CODES.has(code)) {
    return true;
  }
  const messages: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const rec = cur as { message?: unknown; cause?: unknown; originalError?: unknown };
    if (typeof rec.message === "string") {
      messages.push(rec.message.toLowerCase());
    }
    cur = rec.cause ?? rec.originalError;
  }
  const combined = messages.join(" | ");
  return (
    combined.includes("lock timeout") ||
    combined.includes("statement timeout") ||
    combined.includes("idle-in-transaction session timeout") ||
    combined.includes("idle in transaction") ||
    combined.includes("could not obtain lock") ||
    combined.includes("deadlock detected")
  );
}

export function respondSecurityContention(res: Response, err: unknown): boolean {
  if (!isPgContentionError(err)) {
    return false;
  }
  const pgCode = err instanceof SecurityContentionError ? err.pgCode : extractPgErrorCode(err);
  logger.warn({ pgCode, err: (err as Error)?.message }, "Security transaction aborted due to DB contention");
  res.setHeader("Retry-After", "2");
  res.status(503).json({
    error: "Security operation is temporarily busy. Please try again in a moment.",
    code: "DB_CONTENTION_RETRY",
  });
  return true;
}

function sanitizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(50, Math.min(30_000, Math.floor(value)));
}

/**
 * Executes a security-critical database transaction with bounded PostgreSQL timeouts
 * (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`) and
 * normalizes lock/statement/deadlock errors into SecurityContentionError (HTTP 503).
 */
export async function withBoundedSecurityTx<T>(
  fn: (tx: SecurityTx) => Promise<T>,
  options: SecurityTxOptions = {},
): Promise<T> {
  const lockMs = sanitizeTimeoutMs(options.lockTimeoutMs, DEFAULT_SECURITY_TX_TIMEOUTS.lockTimeoutMs);
  const stmtMs = sanitizeTimeoutMs(options.statementTimeoutMs, DEFAULT_SECURITY_TX_TIMEOUTS.statementTimeoutMs);
  const idleMs = sanitizeTimeoutMs(options.idleInTxTimeoutMs, DEFAULT_SECURITY_TX_TIMEOUTS.idleInTxTimeoutMs);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockMs}ms'`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${stmtMs}ms'`));
      await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '${idleMs}ms'`));
      return await fn(tx);
    });
  } catch (err) {
    if (isPgContentionError(err)) {
      throw new SecurityContentionError(
        (err as Error)?.message ?? "Database contention timeout",
        extractPgErrorCode(err),
      );
    }
    throw err;
  }
}

/**
 * Canonical lock hierarchy level (0):
 * Acquires FOR UPDATE on the parent `restaurants` row as a stable serialization anchor
 * even when child `restaurant_profile_pins` rows do not yet exist or are deleted concurrently.
 */
export async function lockRestaurantAnchor(
  tx: SecurityTx,
  restaurantId: number,
): Promise<{ id: number; ownerId: number | null } | null> {
  const [rest] = await tx
    .select({ id: restaurants.id, ownerId: restaurants.ownerId })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .for("update");
  return rest ?? null;
}

/**
 * F-13: Deterministic multi-row OTP challenge invalidation.
 * Step 1: SELECT matching challenge IDs in strict ORDER BY id ASC FOR UPDATE order.
 * Step 2: UPDATE only those locked IDs with active-state predicates.
 */
export async function invalidateActiveOtpChallengesOrdered(
  tx: SecurityTx,
  params: {
    restaurantId: number;
    ownerUserId?: number;
    reason: string;
  },
): Promise<string[]> {
  const conditions = [
    eq(profilePinOtpChallenges.restaurantId, params.restaurantId),
    isNull(profilePinOtpChallenges.invalidatedAt),
    isNull(profilePinOtpChallenges.consumedAt),
  ];
  if (params.ownerUserId !== undefined) {
    conditions.push(eq(profilePinOtpChallenges.ownerUserId, params.ownerUserId));
  }

  const lockedRows = await tx
    .select({ id: profilePinOtpChallenges.id })
    .from(profilePinOtpChallenges)
    .where(and(...conditions))
    .orderBy(asc(profilePinOtpChallenges.id))
    .for("update");

  if (lockedRows.length === 0) {
    return [];
  }

  const lockedIds = lockedRows.map((r) => r.id);
  const updatedRows = await tx
    .update(profilePinOtpChallenges)
    .set({
      invalidatedAt: sql`clock_timestamp()`,
      invalidationReason: params.reason,
      cancelSyncStatus: sql`CASE WHEN ${profilePinOtpChallenges.deliveryStatus} IN ('pending', 'uncertain') THEN 'pending' ELSE ${profilePinOtpChallenges.cancelSyncStatus} END`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        inArray(profilePinOtpChallenges.id, lockedIds),
        isNull(profilePinOtpChallenges.invalidatedAt),
        isNull(profilePinOtpChallenges.consumedAt),
      ),
    )
    .returning({
      id: profilePinOtpChallenges.id,
      deliveryStatus: profilePinOtpChallenges.deliveryStatus,
    });

  return updatedRows
    .filter((r) => r.deliveryStatus === "pending" || r.deliveryStatus === "uncertain")
    .map((r) => r.id);
}

/**
 * Deterministic concurrency test hooks (inactive in production unless explicitly registered
 * by automated test suites). Zero runtime cost when no hooks are registered.
 */
export interface SecurityTestHooks {
  onVerifyLockAcquired?: (ctx: {
    restaurantId: number;
    failedAttempts: number;
    lockedUntil: Date | null;
    readBackendPid?: () => Promise<number>;
  }) => Promise<void> | void;
  onVerifyBeforeRehashTx?: (ctx: { restaurantId: number; pinRowId: number; pinVersion: number }) => Promise<void> | void;
  onResetWithOtpAnchorAcquired?: (ctx: {
    restaurantId: number;
    readBackendPid?: () => Promise<number>;
  }) => Promise<void> | void;
  onAdminResetAnchorAcquired?: (ctx: {
    restaurantId: number;
    readBackendPid?: () => Promise<number>;
  }) => Promise<void> | void;
  onForgotOtpTx2AfterLock?: (ctx: {
    restaurantId: number;
    ownerUserId: number;
    readTxClock: () => Promise<Date>;
  }) => Promise<void> | void;
}

let activeTestHooks: SecurityTestHooks | null = null;

export function registerSecurityTestHooks(hooks: SecurityTestHooks | null): void {
  activeTestHooks = hooks;
}

export function clearSecurityTestHooks(): void {
  activeTestHooks = null;
}

export async function runSecurityTestHook<K extends keyof SecurityTestHooks>(
  hookName: K,
  ctx: Parameters<NonNullable<SecurityTestHooks[K]>>[0],
): Promise<void> {
  const fn = activeTestHooks?.[hookName] as
    | ((arg: Parameters<NonNullable<SecurityTestHooks[K]>>[0]) => Promise<void> | void)
    | undefined;
  if (fn) {
    await fn(ctx);
  }
}
