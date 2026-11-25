import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  db,
  profilePinOtpChallenges,
  restaurantProfilePins,
  restaurants,
  users,
} from "@workspace/db";
import { requireOwner } from "../middlewares/auth";
import {
  cancelChatChallenge,
  dispatchOtpWithFreshMainDbTtl,
} from "../lib/chatSecurityClient";
import { logger } from "../lib/logger";
import { recordOwnerSecurityAudit } from "../lib/profilePinAudit";
import {
  computeOtpHmac,
  generateNumericOtp,
  hashProfilePin,
  maskPhone,
  PROFILE_PIN_UNLOCK_TTL_MS,
  signProfilePinUnlockToken,
  verifyOtpHmac,
  verifyProfilePin,
  verifyProfilePinUnlockToken,
} from "../lib/profilePinCrypto";
import {
  invalidateActiveOtpChallengesOrdered,
  isActiveOtpChallengeUniqueViolation,
  lockRestaurantAnchor,
  respondSecurityContention,
  runSecurityTestHook,
  withBoundedSecurityTx,
  type SecurityTx,
} from "../lib/securityTx";

const router = Router();

const PIN_RE = /^\d{4}$/;
const OTP_RE = /^\d{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OTP_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const OTP_COOLDOWN_MS = 60 * 1000;      // 60 seconds between requests
const OTP_MAX_PER_15M = 3;
const OTP_MAX_PER_24H = 10;
const LOCKOUT_LEVEL_1_MS = 15 * 60 * 1000;
const LOCKOUT_LEVEL_2_MS = 60 * 60 * 1000;

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function parseSetupPinBody(body: unknown): ValidationResult<{ pin: string; confirmPin: string }> {
  if (!isPlainRecord(body)) return { success: false, error: "Invalid request payload" };
  const pin = body["pin"];
  const confirmPin = body["confirmPin"];
  if (typeof pin !== "string" || !PIN_RE.test(pin)) {
    return { success: false, error: "PIN must be exactly 4 digits" };
  }
  if (typeof confirmPin !== "string" || !PIN_RE.test(confirmPin)) {
    return { success: false, error: "Confirmation PIN must be exactly 4 digits" };
  }
  return { success: true, data: { pin, confirmPin } };
}

function parseVerifyPinBody(body: unknown): ValidationResult<{ pin: string }> {
  if (!isPlainRecord(body)) return { success: false, error: "Invalid request payload" };
  const pin = body["pin"];
  if (typeof pin !== "string" || !PIN_RE.test(pin)) {
    return { success: false, error: "PIN must be exactly 4 digits" };
  }
  return { success: true, data: { pin } };
}

function parseChangePinBody(
  body: unknown,
): ValidationResult<{ currentPin: string; newPin: string; confirmPin: string }> {
  if (!isPlainRecord(body)) return { success: false, error: "Invalid request payload" };
  const currentPin = body["currentPin"];
  const newPin = body["newPin"];
  const confirmPin = body["confirmPin"];
  if (typeof currentPin !== "string" || !PIN_RE.test(currentPin)) {
    return { success: false, error: "Current PIN must be exactly 4 digits" };
  }
  if (typeof newPin !== "string" || !PIN_RE.test(newPin)) {
    return { success: false, error: "New PIN must be exactly 4 digits" };
  }
  if (typeof confirmPin !== "string" || !PIN_RE.test(confirmPin)) {
    return { success: false, error: "Confirmation PIN must be exactly 4 digits" };
  }
  return { success: true, data: { currentPin, newPin, confirmPin } };
}

function parseResetWithOtpBody(
  body: unknown,
): ValidationResult<{ challengeId?: string; otp: string; newPin: string; confirmPin: string }> {
  if (!isPlainRecord(body)) return { success: false, error: "Invalid request payload" };
  const rawChallengeId = body["challengeId"];
  let challengeId: string | undefined;
  if (rawChallengeId !== undefined && rawChallengeId !== null && rawChallengeId !== "") {
    if (typeof rawChallengeId !== "string" || !UUID_RE.test(rawChallengeId)) {
      return { success: false, error: "Invalid challenge ID format" };
    }
    challengeId = rawChallengeId;
  }
  const otp = body["otp"];
  const newPin = body["newPin"];
  const confirmPin = body["confirmPin"];
  if (typeof otp !== "string" || !OTP_RE.test(otp)) {
    return { success: false, error: "OTP must be a 6-digit code" };
  }
  if (typeof newPin !== "string" || !PIN_RE.test(newPin)) {
    return { success: false, error: "New PIN must be exactly 4 digits" };
  }
  if (typeof confirmPin !== "string" || !PIN_RE.test(confirmPin)) {
    return { success: false, error: "Confirmation PIN must be exactly 4 digits" };
  }
  return { success: true, data: { challengeId, otp, newPin, confirmPin } };
}

function setSessionUnlock(
  req: Request,
  restaurantId: number,
  pinVersion: number,
  expiresAt: number,
): void {
  if (!req.session) return;
  if (!req.session.profilePinUnlocks) {
    req.session.profilePinUnlocks = {};
  }
  req.session.profilePinUnlocks[String(restaurantId)] = { pinVersion, expiresAt };
}

function clearSessionUnlock(req: Request, restaurantId: number): void {
  if (req.session?.profilePinUnlocks) {
    delete req.session.profilePinUnlocks[String(restaurantId)];
  }
}

function isRequestCurrentlyUnlocked(
  req: Request,
  userId: number,
  restaurantId: number,
  currentPinVersion: number,
  lockedUntil: Date | null,
  nowDbMs: number,
): { unlocked: boolean; expiresAt: number | null } {
  if (lockedUntil && lockedUntil.getTime() > nowDbMs) {
    return { unlocked: false, expiresAt: null };
  }

  const rawHeader = req.headers["x-profile-pin-token"];
  const headerToken = typeof rawHeader === "string" ? rawHeader.trim() : "";
  if (headerToken) {
    const claims = verifyProfilePinUnlockToken(headerToken);
    if (
      claims &&
      claims.uid === userId &&
      claims.rid === restaurantId &&
      claims.pv === currentPinVersion &&
      nowDbMs < claims.exp
    ) {
      return { unlocked: true, expiresAt: claims.exp };
    }
    return { unlocked: false, expiresAt: null };
  }

  const sess = req.session?.profilePinUnlocks?.[String(restaurantId)];
  if (sess && sess.pinVersion === currentPinVersion && nowDbMs < sess.expiresAt) {
    return { unlocked: true, expiresAt: sess.expiresAt };
  }
  return { unlocked: false, expiresAt: null };
}

function computeNextLockoutState(params: {
  failedAttempts: number;
  lockoutLevel: number;
  nowDb: Date;
}): {
  nextFailedAttempts: number;
  nextLockoutLevel: number;
  nextLockedUntil: Date | null;
  remainingAttemptsBeforeLockout: number;
  triggeredLockout: boolean;
} {
  const nextFailedAttempts = params.failedAttempts + 1;
  let nextLockoutLevel = params.lockoutLevel;
  let nextLockedUntil: Date | null = null;
  let triggeredLockout = false;

  if (nextFailedAttempts >= 10 && nextFailedAttempts % 5 === 0) {
    nextLockoutLevel = 2;
    nextLockedUntil = new Date(params.nowDb.getTime() + LOCKOUT_LEVEL_2_MS);
    triggeredLockout = true;
  } else if (params.lockoutLevel === 0 && nextFailedAttempts >= 5) {
    nextLockoutLevel = 1;
    nextLockedUntil = new Date(params.nowDb.getTime() + LOCKOUT_LEVEL_1_MS);
    triggeredLockout = true;
  }

  const remainingAttemptsBeforeLockout = triggeredLockout
    ? 0
    : 5 - ((nextFailedAttempts - 1) % 5) - 1;

  return {
    nextFailedAttempts,
    nextLockoutLevel,
    nextLockedUntil,
    remainingAttemptsBeforeLockout,
    triggeredLockout,
  };
}

type OtpTx = SecurityTx;

type OtpRateBlock =
  | { kind: "cooldown"; retryAfterSeconds: number }
  | { kind: "rate_15m" }
  | { kind: "rate_24h" };

async function evaluateOtpRateLimitsAndNow(
  tx: OtpTx,
  ownerUserId: number,
  restaurantId: number,
): Promise<{ nowDb: Date; blocked: OtpRateBlock | null }> {
  const clockRows = await tx.execute<{ now_ts: Date | string }>(
    sql`SELECT clock_timestamp() AS now_ts`,
  );
  const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());
  const window24hStart = new Date(nowDb.getTime() - 24 * 60 * 60 * 1000);

  const recentRows = await tx
    .select({
      id: profilePinOtpChallenges.id,
      createdAt: profilePinOtpChallenges.createdAt,
      deliveryStatus: profilePinOtpChallenges.deliveryStatus,
      failureCode: profilePinOtpChallenges.failureCode,
    })
    .from(profilePinOtpChallenges)
    .where(
      and(
        eq(profilePinOtpChallenges.ownerUserId, ownerUserId),
        eq(profilePinOtpChallenges.restaurantId, restaurantId),
        gte(profilePinOtpChallenges.createdAt, window24hStart),
      ),
    )
    .orderBy(desc(profilePinOtpChallenges.createdAt));

  const latestCooldownCandidate = recentRows.find(
    (r) => r.failureCode !== "RECIPIENT_NOT_FOUND",
  );
  if (latestCooldownCandidate) {
    const elapsedMs = nowDb.getTime() - latestCooldownCandidate.createdAt.getTime();
    if (elapsedMs < OTP_COOLDOWN_MS) {
      return {
        nowDb,
        blocked: {
          kind: "cooldown",
          retryAfterSeconds: Math.max(1, Math.ceil((OTP_COOLDOWN_MS - elapsedMs) / 1000)),
        },
      };
    }
  }

  const last15mCount = recentRows.filter(
    (r) => nowDb.getTime() - r.createdAt.getTime() < 15 * 60 * 1000,
  ).length;
  if (last15mCount >= OTP_MAX_PER_15M) {
    return { nowDb, blocked: { kind: "rate_15m" } };
  }

  if (recentRows.length >= OTP_MAX_PER_24H) {
    return { nowDb, blocked: { kind: "rate_24h" } };
  }

  return { nowDb, blocked: null };
}

async function invalidateOpenOtpChallenges(
  tx: OtpTx,
  ownerUserId: number,
  restaurantId: number,
): Promise<string[]> {
  return await invalidateActiveOtpChallengesOrdered(tx, {
    restaurantId,
    ownerUserId,
    reason: "superseded_by_resend",
  });
}

function respondOtpRateLimit(res: Response, blocked: OtpRateBlock): void {
  if (blocked.kind === "cooldown") {
    res.status(429).json({
      error: `Please wait ${blocked.retryAfterSeconds}s before requesting another OTP.`,
      code: "OTP_COOLDOWN",
      retryAfterSeconds: blocked.retryAfterSeconds,
    });
    return;
  }
  if (blocked.kind === "rate_15m") {
    res.status(429).json({
      error: "Too many OTP requests in 15 minutes. Please try again shortly.",
      code: "OTP_RATE_LIMIT_15M",
    });
    return;
  }
  res.status(429).json({
    error: "Daily OTP limit reached. Please try again tomorrow or contact Bitebend support.",
    code: "OTP_RATE_LIMIT_24H",
  });
}

/**
 * GET /api/owner/profile/pin/status
 * Returns PIN setup state, lockout status, session unlock status, and Messaging OTP eligibility.
 */
router.get("/owner/profile/pin/status", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const [pinRow] = await db
    .select({
      id: restaurantProfilePins.id,
      pinHash: restaurantProfilePins.pinHash,
      pinVersion: restaurantProfilePins.pinVersion,
      lockedUntil: restaurantProfilePins.lockedUntil,
      lockoutLevel: restaurantProfilePins.lockoutLevel,
      failedAttempts: restaurantProfilePins.failedAttempts,
      nowTs: sql<Date | string>`clock_timestamp()`.as("now_ts"),
    })
    .from(restaurantProfilePins)
    .where(eq(restaurantProfilePins.restaurantId, user.restaurantId))
    .limit(1);

  const hasActivePin = Boolean(pinRow && pinRow.pinHash !== null);
  const nowDbMs = pinRow ? new Date(pinRow.nowTs).getTime() : 0;

  const recoveryEligible = Boolean(
    user.registrationPhoneVerified &&
      user.registrationPhoneNorm &&
      user.registrationPhoneSource !== "legacy_restaurant_phone",
  );

  const [activeChallenge] = await db
    .select({
      id: profilePinOtpChallenges.id,
      deliveryStatus: profilePinOtpChallenges.deliveryStatus,
      failureCode: profilePinOtpChallenges.failureCode,
      attempts: profilePinOtpChallenges.attempts,
      maxAttempts: profilePinOtpChallenges.maxAttempts,
      expiresAt: profilePinOtpChallenges.expiresAt,
      createdAt: profilePinOtpChallenges.createdAt,
    })
    .from(profilePinOtpChallenges)
    .where(
      and(
        eq(profilePinOtpChallenges.ownerUserId, user.id),
        eq(profilePinOtpChallenges.restaurantId, user.restaurantId),
        isNull(profilePinOtpChallenges.invalidatedAt),
        isNull(profilePinOtpChallenges.consumedAt),
        sql`${profilePinOtpChallenges.expiresAt} > clock_timestamp()`,
      ),
    )
    .orderBy(desc(profilePinOtpChallenges.createdAt))
    .limit(1);

  const locked = Boolean(hasActivePin && pinRow?.lockedUntil && pinRow.lockedUntil.getTime() > nowDbMs);
  const unlockState =
    hasActivePin && pinRow
      ? isRequestCurrentlyUnlocked(
          req,
          user.id,
          user.restaurantId,
          pinRow.pinVersion,
          pinRow.lockedUntil,
          nowDbMs,
        )
      : { unlocked: false, expiresAt: null };

  res.json({
    configured: hasActivePin,
    locked,
    lockedUntil: locked && pinRow?.lockedUntil ? pinRow.lockedUntil.toISOString() : null,
    lockoutLevel: hasActivePin ? (pinRow?.lockoutLevel ?? 0) : 0,
    failedAttempts: hasActivePin ? (pinRow?.failedAttempts ?? 0) : 0,
    unlocked: unlockState.unlocked,
    unlockExpiresAt: unlockState.expiresAt ? new Date(unlockState.expiresAt).toISOString() : null,
    recoveryEligible,
    recoveryIneligibleReason: recoveryEligible
      ? null
      : "Verified registration phone number is required for Messaging OTP recovery. Please contact Bitebend support.",
    maskedRecoveryPhone: recoveryEligible ? maskPhone(user.registrationPhoneNorm) : null,
    activeChallenge: activeChallenge
      ? {
          challengeId: activeChallenge.id,
          deliveryStatus: activeChallenge.deliveryStatus,
          failureCode: activeChallenge.failureCode,
          remainingAttempts: Math.max(0, activeChallenge.maxAttempts - activeChallenge.attempts),
          expiresAt: activeChallenge.expiresAt.toISOString(),
          cooldownEndsAt: new Date(activeChallenge.createdAt.getTime() + OTP_COOLDOWN_MS).toISOString(),
        }
      : null,
  });
});

/**
 * POST /api/owner/profile/pin/setup
 * First-time 4-digit Profile PIN setup. Fails with 409 if PIN already exists.
 */
router.post("/owner/profile/pin/setup", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const parsed = parseSetupPinBody(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.data.pin !== parsed.data.confirmPin) {
    res.status(400).json({ error: "PIN and confirmation PIN do not match" });
    return;
  }

  const restaurantId = user.restaurantId;
  const { pinHash, pepperVersion } = await hashProfilePin({
    ownerUserId: user.id,
    restaurantId,
    pin: parsed.data.pin,
  });

  let setupOutcome:
    | { kind: "restaurant_not_found" }
    | { kind: "already_set" }
    | { kind: "ok"; pinVersion: number; nowDb: Date };

  try {
    setupOutcome = await withBoundedSecurityTx(async (tx) => {
      // (0) Stable parent restaurant lock prevents F-06 missing-PIN-row race vs admin reset / OTP reset
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) {
        return { kind: "restaurant_not_found" as const };
      }

      // (2) Check & lock child PIN row (active or F-11 tombstone) if present
      const [existing] = await tx
        .select({
          id: restaurantProfilePins.id,
          pinHash: restaurantProfilePins.pinHash,
          pinVersion: restaurantProfilePins.pinVersion,
        })
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");

      if (existing && existing.pinHash !== null) {
        return { kind: "already_set" as const };
      }

      const clockRows = await tx.execute<{ now_ts: Date | string }>(
        sql`SELECT clock_timestamp() AS now_ts`,
      );
      const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());

      if (existing) {
        // F-11: Setting a new PIN on an admin-reset tombstone MUST monotonically increment existing pin_version
        const nextPinVersion = existing.pinVersion + 1;
        const [updated] = await tx
          .update(restaurantProfilePins)
          .set({
            ownerUserId: user.id,
            pinHash,
            pepperVersion,
            pinVersion: nextPinVersion,
            failedAttempts: 0,
            lockoutLevel: 0,
            lockedUntil: null,
            lastFailedAt: null,
            pinSetAt: nowDb,
            updatedAt: nowDb,
          })
          .where(eq(restaurantProfilePins.id, existing.id))
          .returning({
            pinVersion: restaurantProfilePins.pinVersion,
          });

        return { kind: "ok" as const, pinVersion: updated?.pinVersion ?? nextPinVersion, nowDb };
      }

      const [inserted] = await tx
        .insert(restaurantProfilePins)
        .values({
          restaurantId,
          ownerUserId: user.id,
          pinHash,
          pepperVersion,
          pinVersion: 1,
          failedAttempts: 0,
          lockoutLevel: 0,
          lockedUntil: null,
          pinSetAt: nowDb,
          updatedAt: nowDb,
        })
        .onConflictDoNothing({ target: restaurantProfilePins.restaurantId })
        .returning({
          pinVersion: restaurantProfilePins.pinVersion,
        });

      if (!inserted) {
        return { kind: "already_set" as const };
      }

      return { kind: "ok" as const, pinVersion: inserted.pinVersion, nowDb };
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (setupOutcome.kind === "restaurant_not_found") {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  if (setupOutcome.kind === "already_set") {
    res.status(409).json({
      error: "Profile PIN is already configured. Please unlock or change your existing PIN.",
      code: "PIN_ALREADY_SET",
    });
    return;
  }

  const { token, expiresAt } = signProfilePinUnlockToken({
    ownerUserId: user.id,
    restaurantId,
    pinVersion: setupOutcome.pinVersion,
    ttlMs: PROFILE_PIN_UNLOCK_TTL_MS,
    nowMs: setupOutcome.nowDb.getTime(),
  });
  setSessionUnlock(req, restaurantId, setupOutcome.pinVersion, expiresAt);

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "profile_pin_set",
    meta: { pepperVersion, pinVersion: setupOutcome.pinVersion },
    req,
  });

  res.status(201).json({
    ok: true,
    pinVersion: setupOutcome.pinVersion,
    unlockToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

/**
 * POST /api/owner/profile/pin/verify
 * Verifies 4-digit Profile PIN under FOR UPDATE lock with progressive lockout (5 / 10 failures)
 * and transparent pepper-version rehash on success.
 */
router.post("/owner/profile/pin/verify", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const parsed = parseVerifyPinBody(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const restaurantId = user.restaurantId;

  type VerifyTx1Outcome =
    | { kind: "not_set" }
    | { kind: "locked"; lockedUntil: Date; lockoutLevel: number }
    | {
        kind: "just_locked";
        failedAttempts: number;
        lockoutLevel: number;
        lockedUntil: Date;
        remainingAttemptsBeforeLockout: number;
      }
    | {
        kind: "invalid";
        failedAttempts: number;
        lockoutLevel: number;
        lockedUntil: Date | null;
        remainingAttemptsBeforeLockout: number;
      }
    | {
        kind: "ok";
        pinRowId: number;
        pinVersion: number;
        pepperVersion: number;
        pinHash: string;
        needsRehash: boolean;
        nowDb: Date;
      };

  let outcome: VerifyTx1Outcome;
  try {
    outcome = await withBoundedSecurityTx(async (tx): Promise<VerifyTx1Outcome> => {
      // (2) Acquire PIN row lock before lockout evaluation and bcrypt comparison (F-12)
      const [row] = await tx
        .select()
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");

      if (!row || row.pinHash === null) {
        return { kind: "not_set" };
      }
      const storedPinHash = row.pinHash;

      await runSecurityTestHook("onVerifyLockAcquired", {
        restaurantId,
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
        readBackendPid: async () => {
          const r = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
          return Number(r.rows[0]?.pid ?? 0);
        },
      });

      const clockRows = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
      const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());

      // Pre-bcrypt lockout check under FOR UPDATE lock
      if (row.lockedUntil && row.lockedUntil.getTime() > nowDb.getTime()) {
        return {
          kind: "locked",
          lockedUntil: row.lockedUntil,
          lockoutLevel: row.lockoutLevel,
        };
      }

      // F-12: Keep verifyProfilePin() serialized inside the DB transaction under row lock
      const check = await verifyProfilePin({
        ownerUserId: user.id,
        restaurantId,
        pin: parsed.data.pin,
        storedHash: storedPinHash,
        storedPepperVersion: row.pepperVersion,
      });

      if (!check.valid) {
        const next = computeNextLockoutState({
          failedAttempts: row.failedAttempts,
          lockoutLevel: row.lockoutLevel,
          nowDb,
        });

        await tx
          .update(restaurantProfilePins)
          .set({
            failedAttempts: next.nextFailedAttempts,
            lockoutLevel: next.nextLockoutLevel,
            lockedUntil: next.nextLockedUntil,
            lastFailedAt: nowDb,
            updatedAt: nowDb,
          })
          .where(eq(restaurantProfilePins.id, row.id));

        if (next.triggeredLockout) {
          return {
            kind: "just_locked",
            failedAttempts: next.nextFailedAttempts,
            lockoutLevel: next.nextLockoutLevel,
            lockedUntil: next.nextLockedUntil!,
            remainingAttemptsBeforeLockout: 0,
          };
        }
        return {
          kind: "invalid",
          failedAttempts: next.nextFailedAttempts,
          lockoutLevel: next.nextLockoutLevel,
          lockedUntil: next.nextLockedUntil,
          remainingAttemptsBeforeLockout: next.remainingAttemptsBeforeLockout,
        };
      }

      // G-01: Clear lockout counters cleanly without running hashProfilePin or mutating pinVersion / pinSetAt
      if (row.failedAttempts !== 0 || row.lockoutLevel !== 0 || row.lockedUntil !== null) {
        await tx
          .update(restaurantProfilePins)
          .set({
            failedAttempts: 0,
            lockoutLevel: 0,
            lockedUntil: null,
            updatedAt: nowDb,
          })
          .where(eq(restaurantProfilePins.id, row.id));
      }

      return {
        kind: "ok",
        pinRowId: row.id,
        pinVersion: row.pinVersion,
        pepperVersion: row.pepperVersion,
        pinHash: storedPinHash,
        needsRehash: check.needsRehash,
        nowDb,
      };
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (outcome.kind === "not_set") {
    res.status(404).json({ error: "Profile PIN has not been set up yet", code: "PIN_SETUP_REQUIRED" });
    return;
  }

  if (outcome.kind === "locked") {
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: "profile_pin_verify_blocked_locked",
      meta: { lockoutLevel: outcome.lockoutLevel },
      req,
    });
    res.status(429).json({
      error: "Profile PIN is temporarily locked. Use Forgot PIN or wait for the cooldown to expire.",
      code: "PIN_LOCKED",
      lockedUntil: outcome.lockedUntil.toISOString(),
      lockoutLevel: outcome.lockoutLevel,
    });
    return;
  }

  if (outcome.kind !== "ok") {
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: outcome.kind === "just_locked" ? "profile_pin_lockout_triggered" : "profile_pin_verify_failed",
      meta: {
        failedAttempts: outcome.failedAttempts,
        lockoutLevel: outcome.lockoutLevel,
      },
      req,
    });
    if (outcome.kind === "just_locked") {
      res.status(429).json({
        error: `Too many incorrect PIN attempts. Profile access is locked until ${outcome.lockedUntil.toISOString()}.`,
        code: "PIN_LOCKED",
        lockedUntil: outcome.lockedUntil.toISOString(),
        lockoutLevel: outcome.lockoutLevel,
        remainingAttemptsBeforeLockout: 0,
      });
    } else {
      res.status(401).json({
        error: `Incorrect Profile PIN (${outcome.remainingAttemptsBeforeLockout} attempt${outcome.remainingAttemptsBeforeLockout === 1 ? "" : "s"} remaining before lockout).`,
        code: "PIN_INVALID",
        remainingAttemptsBeforeLockout: outcome.remainingAttemptsBeforeLockout,
      });
    }
    return;
  }

  // G-01: Hash maintenance outside Tx1, then commit in a (2)-only snapshot-validated Tx2
  let rehashed = false;
  if (outcome.needsRehash) {
    await runSecurityTestHook("onVerifyBeforeRehashTx", {
      restaurantId,
      pinRowId: outcome.pinRowId,
      pinVersion: outcome.pinVersion,
    });

    const newPepperDigest = await hashProfilePin({
      ownerUserId: user.id,
      restaurantId,
      pin: parsed.data.pin,
    });

    try {
      rehashed = await withBoundedSecurityTx(async (tx) => {
        const [current] = await tx
          .select({
            id: restaurantProfilePins.id,
            pinVersion: restaurantProfilePins.pinVersion,
            pepperVersion: restaurantProfilePins.pepperVersion,
            pinHash: restaurantProfilePins.pinHash,
          })
          .from(restaurantProfilePins)
          .where(eq(restaurantProfilePins.restaurantId, restaurantId))
          .for("update");

        if (
          !current ||
          current.id !== outcome.pinRowId ||
          current.pinVersion !== outcome.pinVersion ||
          current.pepperVersion !== outcome.pepperVersion ||
          current.pinHash !== outcome.pinHash
        ) {
          return false;
        }

        await tx
          .update(restaurantProfilePins)
          .set({
            pinHash: newPepperDigest.pinHash,
            pepperVersion: newPepperDigest.pepperVersion,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(restaurantProfilePins.id, outcome.pinRowId),
              eq(restaurantProfilePins.pinVersion, outcome.pinVersion),
              eq(restaurantProfilePins.pepperVersion, outcome.pepperVersion),
              eq(restaurantProfilePins.pinHash, outcome.pinHash),
            ),
          );

        return true;
      });
    } catch (rehashErr) {
      logger.warn(
        { err: (rehashErr as Error)?.message, restaurantId },
        "Pepper rehash maintenance skipped cleanly due to lock contention",
      );
      rehashed = false;
    }
  }

  const { token, expiresAt } = signProfilePinUnlockToken({
    ownerUserId: user.id,
    restaurantId,
    pinVersion: outcome.pinVersion,
    ttlMs: PROFILE_PIN_UNLOCK_TTL_MS,
    nowMs: outcome.nowDb.getTime(),
  });
  setSessionUnlock(req, restaurantId, outcome.pinVersion, expiresAt);

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "profile_pin_verify_success",
    meta: { pinVersion: outcome.pinVersion, rehashed },
    req,
  });

  res.json({
    ok: true,
    pinVersion: outcome.pinVersion,
    unlockToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

/**
 * POST /api/owner/profile/pin/change
 * Verifies current PIN, updates PIN, increments pin_version (globally revoking prior unlock tokens),
 * and invalidates any open OTP challenges.
 */
router.post("/owner/profile/pin/change", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const parsed = parseChangePinBody(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.data.newPin !== parsed.data.confirmPin) {
    res.status(400).json({ error: "New PIN and confirmation PIN do not match" });
    return;
  }
  if (parsed.data.currentPin === parsed.data.newPin) {
    res.status(400).json({ error: "New PIN must be different from your current PIN", code: "NEW_PIN_SAME_AS_CURRENT" });
    return;
  }

  const restaurantId = user.restaurantId;

  type ChangeOutcome =
    | { kind: "not_set" }
    | { kind: "locked"; lockedUntil: Date; lockoutLevel: number }
    | {
        kind: "just_locked";
        lockoutLevel: number;
        lockedUntil: Date;
        remainingAttemptsBeforeLockout: number;
      }
    | {
        kind: "invalid";
        lockoutLevel: number;
        lockedUntil: Date | null;
        remainingAttemptsBeforeLockout: number;
      }
    | { kind: "ok"; pinVersion: number; pepperVersion: number; toCancelIds: string[]; nowDb: Date };

  let outcome: ChangeOutcome;
  try {
    outcome = await withBoundedSecurityTx(async (tx): Promise<ChangeOutcome> => {
      // Canonical lock order: (0) restaurants -> (2) restaurant_profile_pins -> (3) profile_pin_otp_challenges
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) return { kind: "not_set" };

      const [row] = await tx
        .select()
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");

      if (!row || row.pinHash === null) return { kind: "not_set" };

      const clockRows = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
      const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());

      if (row.lockedUntil && row.lockedUntil.getTime() > nowDb.getTime()) {
        return { kind: "locked", lockedUntil: row.lockedUntil, lockoutLevel: row.lockoutLevel };
      }

      // F-12: Current PIN comparison serialized inside DB tx under row lock
      const check = await verifyProfilePin({
        ownerUserId: user.id,
        restaurantId,
        pin: parsed.data.currentPin,
        storedHash: row.pinHash,
        storedPepperVersion: row.pepperVersion,
      });

      if (!check.valid) {
        const next = computeNextLockoutState({
          failedAttempts: row.failedAttempts,
          lockoutLevel: row.lockoutLevel,
          nowDb,
        });

        await tx
          .update(restaurantProfilePins)
          .set({
            failedAttempts: next.nextFailedAttempts,
            lockoutLevel: next.nextLockoutLevel,
            lockedUntil: next.nextLockedUntil,
            lastFailedAt: nowDb,
            updatedAt: nowDb,
          })
          .where(eq(restaurantProfilePins.id, row.id));

        if (next.triggeredLockout) {
          return {
            kind: "just_locked",
            lockoutLevel: next.nextLockoutLevel,
            lockedUntil: next.nextLockedUntil!,
            remainingAttemptsBeforeLockout: 0,
          };
        }
        return {
          kind: "invalid",
          lockoutLevel: next.nextLockoutLevel,
          lockedUntil: next.nextLockedUntil,
          remainingAttemptsBeforeLockout: next.remainingAttemptsBeforeLockout,
        };
      }

      const { pinHash, pepperVersion } = await hashProfilePin({
        ownerUserId: user.id,
        restaurantId,
        pin: parsed.data.newPin,
      });

      const postHashClock = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
      const setNowDb = new Date(postHashClock.rows[0]?.now_ts ?? nowDb.getTime());

      const newPinVersion = row.pinVersion + 1;
      await tx
        .update(restaurantProfilePins)
        .set({
          pinHash,
          pepperVersion,
          pinVersion: newPinVersion,
          failedAttempts: 0,
          lockoutLevel: 0,
          lockedUntil: null,
          pinSetAt: setNowDb,
          updatedAt: setNowDb,
        })
        .where(eq(restaurantProfilePins.id, row.id));

      const toCancelIds = await invalidateActiveOtpChallengesOrdered(tx, {
        restaurantId,
        ownerUserId: user.id,
        reason: "pin_changed",
      });

      return { kind: "ok", pinVersion: newPinVersion, pepperVersion, toCancelIds, nowDb: setNowDb };
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (outcome.kind === "not_set") {
    res.status(404).json({ error: "Profile PIN has not been set up yet", code: "PIN_SETUP_REQUIRED" });
    return;
  }
  if (outcome.kind === "locked") {
    res.status(429).json({
      error: "Profile PIN is temporarily locked.",
      code: "PIN_LOCKED",
      lockedUntil: outcome.lockedUntil.toISOString(),
      lockoutLevel: outcome.lockoutLevel,
    });
    return;
  }
  if (outcome.kind !== "ok") {
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: "profile_pin_change_failed_current",
      req,
    });
    if (outcome.kind === "just_locked") {
      res.status(429).json({
        error: "Too many incorrect PIN attempts. Profile access is temporarily locked.",
        code: "PIN_LOCKED",
        lockedUntil: outcome.lockedUntil.toISOString(),
        lockoutLevel: outcome.lockoutLevel,
      });
    } else {
      res.status(401).json({
        error: `Current PIN is incorrect (${outcome.remainingAttemptsBeforeLockout} attempt${outcome.remainingAttemptsBeforeLockout === 1 ? "" : "s"} remaining before lockout).`,
        code: "PIN_INVALID",
        remainingAttemptsBeforeLockout: outcome.remainingAttemptsBeforeLockout,
      });
    }
    return;
  }

  for (const cid of outcome.toCancelIds) {
    void cancelChatChallenge(cid);
  }

  const { token, expiresAt } = signProfilePinUnlockToken({
    ownerUserId: user.id,
    restaurantId,
    pinVersion: outcome.pinVersion,
    ttlMs: PROFILE_PIN_UNLOCK_TTL_MS,
    nowMs: outcome.nowDb.getTime(),
  });
  setSessionUnlock(req, restaurantId, outcome.pinVersion, expiresAt);

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "profile_pin_changed",
    meta: { pinVersion: outcome.pinVersion, pepperVersion: outcome.pepperVersion },
    req,
  });

  res.json({
    ok: true,
    pinVersion: outcome.pinVersion,
    unlockToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

/**
 * POST /api/owner/profile/pin/lock
 * Globally revokes ALL unlock sessions & X-Profile-Pin-Token values across every browser/tab
 * by atomically incrementing restaurant_profile_pins.pin_version and clearing session unlock.
 */
router.post("/owner/profile/pin/lock", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const restaurantId = user.restaurantId;

  let updatedPinVersion: number | null = null;
  try {
    updatedPinVersion = await withBoundedSecurityTx(async (tx) => {
      // Canonical lock order: (0) restaurants -> (2) restaurant_profile_pins
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) return null;

      const [existingPin] = await tx
        .select({
          id: restaurantProfilePins.id,
          pinHash: restaurantProfilePins.pinHash,
          pinVersion: restaurantProfilePins.pinVersion,
        })
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");

      if (!existingPin || existingPin.pinHash === null) return null;

      const [updated] = await tx
        .update(restaurantProfilePins)
        .set({
          pinVersion: existingPin.pinVersion + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(restaurantProfilePins.id, existingPin.id))
        .returning({ pinVersion: restaurantProfilePins.pinVersion });

      return updated?.pinVersion ?? null;
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  clearSessionUnlock(req, restaurantId);

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "profile_pin_locked_global",
    meta: { pinVersion: updatedPinVersion },
    req,
  });

  res.json({
    ok: true,
    locked: true,
    pinVersion: updatedPinVersion,
  });
});

/**
 * POST /api/owner/profile/pin/forgot-otp
 * Generates a 6-digit OTP and dispatches it via S2S to Bitebend Messaging (@bitebend.security_otp)
 * ONLY when owner has a verified registration/admin-rebound phone number.
 */
router.post("/owner/profile/pin/forgot-otp", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const restaurantId = user.restaurantId;

  // Strictly enforce verified registration phone — never fall back to legacy unverified restaurants.phone
  if (
    !user.registrationPhoneVerified ||
    !user.registrationPhoneNorm ||
    user.registrationPhoneSource === "legacy_restaurant_phone"
  ) {
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: "otp_request_rejected_unverified_phone",
      meta: { source: user.registrationPhoneSource ?? null },
      req,
    });
    res.status(403).json({
      error:
        "OTP recovery requires a verified owner mobile number from registration. Legacy accounts must verify identity through Bitebend Support.",
      code: "PHONE_NOT_VERIFIED_FOR_OTP",
    });
    return;
  }

  const [restRow] = await db
    .select({ name: restaurants.name })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  const restaurantName = restRow?.name ?? "Your Restaurant";

  // Step 1: Canonical lock order (0) restaurants -> (1) users -> (2) restaurant_profile_pins -> (3) invalidate open challenges
  type ForgotTx1Outcome =
    | { kind: "pin_not_set" }
    | { kind: "blocked"; blocked: OtpRateBlock }
    | { kind: "ok"; toCancelIds: string[] };

  let preCancel: ForgotTx1Outcome;
  try {
    preCancel = await withBoundedSecurityTx(async (tx): Promise<ForgotTx1Outcome> => {
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) return { kind: "pin_not_set" };

      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");

      const [pinRow] = await tx
        .select({ id: restaurantProfilePins.id, pinHash: restaurantProfilePins.pinHash })
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");
      if (!pinRow || pinRow.pinHash === null) return { kind: "pin_not_set" };

      const { blocked } = await evaluateOtpRateLimitsAndNow(tx, user.id, restaurantId);
      if (blocked) {
        return { kind: "blocked", blocked };
      }

      const toCancelIds = await invalidateOpenOtpChallenges(tx, user.id, restaurantId);
      return { kind: "ok", toCancelIds };
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (preCancel.kind === "pin_not_set") {
    res.status(400).json({ error: "No Profile PIN is currently configured", code: "PIN_SETUP_REQUIRED" });
    return;
  }

  if (preCancel.kind === "blocked") {
    respondOtpRateLimit(res, preCancel.blocked);
    return;
  }

  // Synchronously cancel any pending/uncertain prior challenge before creating/dispatching new challenge
  for (const oldId of preCancel.toCancelIds) {
    await cancelChatChallenge(oldId);
  }

  const challengeId = crypto.randomUUID();
  const otp = generateNumericOtp();
  const { otpHmac, otpPepperVersion } = computeOtpHmac({
    challengeId,
    ownerUserId: user.id,
    restaurantId,
    otp,
  });

  // Step 2: Re-acquire (0) -> (1) -> (2), re-check limits, re-invalidate (3), assign post-lock clock_timestamp() (C-01)
  type ForgotTx2Outcome =
    | { kind: "pin_not_set" }
    | { kind: "blocked"; blocked: OtpRateBlock }
    | {
        kind: "ok";
        inserted: typeof profilePinOtpChallenges.$inferSelect;
        nowDb: Date;
        toCancelIds: string[];
      };

  let created: ForgotTx2Outcome;
  try {
    created = await withBoundedSecurityTx(async (tx): Promise<ForgotTx2Outcome> => {
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) return { kind: "pin_not_set" };

      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");

      const [pinRow] = await tx
        .select({ id: restaurantProfilePins.id, pinHash: restaurantProfilePins.pinHash })
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");
      if (!pinRow || pinRow.pinHash === null) return { kind: "pin_not_set" };

      const { blocked } = await evaluateOtpRateLimitsAndNow(tx, user.id, restaurantId);
      if (blocked) {
        return { kind: "blocked", blocked };
      }

      const toCancelIds = await invalidateOpenOtpChallenges(tx, user.id, restaurantId);

      await runSecurityTestHook("onForgotOtpTx2AfterLock", {
        restaurantId,
        ownerUserId: user.id,
        readTxClock: async () => {
          const r = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
          return new Date(r.rows[0]?.now_ts ?? Date.now());
        },
      });

      // C-01: Explicitly query fresh clock_timestamp() AFTER acquiring all locks & invalidations
      // so created_at/updated_at reflect actual lock-acquired issuance time rather than tx-start now().
      const postLockClock = await tx.execute<{ now_ts: Date | string }>(
        sql`SELECT clock_timestamp() AS now_ts`,
      );
      const issuedAt = new Date(postLockClock.rows[0]?.now_ts ?? Date.now());
      const expiresAt = new Date(issuedAt.getTime() + OTP_TTL_MS);

      const [inserted] = await tx
        .insert(profilePinOtpChallenges)
        .values({
          id: challengeId,
          restaurantId,
          ownerUserId: user.id,
          otpHmac,
          otpPepperVersion,
          attempts: 0,
          maxAttempts: 5,
          deliveryStatus: "pending",
          expiresAt,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        })
        .returning();

      return { kind: "ok", inserted: inserted!, nowDb: issuedAt, toCancelIds };
    });
  } catch (err) {
    if (isActiveOtpChallengeUniqueViolation(err)) {
      respondOtpRateLimit(res, {
        kind: "cooldown",
        retryAfterSeconds: OTP_COOLDOWN_MS / 1000,
      });
      return;
    }
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (created.kind === "pin_not_set") {
    res.status(400).json({ error: "No Profile PIN is currently configured", code: "PIN_SETUP_REQUIRED" });
    return;
  }

  if (created.kind === "blocked") {
    respondOtpRateLimit(res, created.blocked);
    return;
  }

  // Synchronously cancel any concurrent pending/uncertain challenge caught by Transaction 2 re-invalidation
  for (const oldId of created.toCancelIds) {
    await cancelChatChallenge(oldId);
  }

  // Step 3: Fresh main-DB TTL dispatch to chat-api
  const dispatchResult = await dispatchOtpWithFreshMainDbTtl({
    challengeId,
    restaurantId,
    restaurantName,
    ownerPhoneNorm: user.registrationPhoneNorm,
    otp,
    issuedAt: created.nowDb,
  });

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "otp_requested",
    challengeId,
    meta: {
      deliveryStatus: dispatchResult.deliveryStatus,
      failureCode: dispatchResult.failureCode ?? null,
    },
    req,
  });

  if (dispatchResult.deliveryStatus === "failed") {
    const statusCode =
      dispatchResult.failureCode === "RECIPIENT_NOT_FOUND" ? 404 : 502;
    res.status(statusCode).json({
      ok: false,
      challengeId,
      deliveryStatus: "failed",
      failureCode: dispatchResult.failureCode,
      error:
        dispatchResult.failureCode === "RECIPIENT_NOT_FOUND"
          ? "No active Bitebend Messaging account is registered with your owner mobile number. Sign up in Bitebend Messaging with your registered phone first."
          : "Unable to deliver OTP via Bitebend Messaging right now. Please try again.",
    });
    return;
  }

  res.status(201).json({
    ok: true,
    challengeId,
    deliveryStatus: dispatchResult.deliveryStatus,
    maskedPhone: maskPhone(user.registrationPhoneNorm),
    expiresAt: created.inserted.expiresAt.toISOString(),
    cooldownSeconds: OTP_COOLDOWN_MS / 1000,
  });
});

/**
 * POST /api/owner/profile/pin/reset-with-otp
 * Verifies 6-digit OTP against non-invalidated, unconsumed, unexpired challenge under FOR UPDATE,
 * sets a new 4-digit PIN, increments pin_version (globally revoking all old unlock tokens),
 * and unlocks the Profile for the caller.
 */
router.post("/owner/profile/pin/reset-with-otp", requireOwner, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.restaurantId) {
    res.status(404).json({ error: "No restaurant found for this account" });
    return;
  }

  const parsed = parseResetWithOtpBody(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.data.newPin !== parsed.data.confirmPin) {
    res.status(400).json({ error: "New PIN and confirmation PIN do not match" });
    return;
  }

  const restaurantId = user.restaurantId;

  type ResetOtpOutcome =
    | { kind: "not_found" }
    | { kind: "invalidated"; challengeId: string; reason: string | null }
    | { kind: "consumed"; challengeId: string }
    | { kind: "expired"; challengeId: string; needsCancelSync: boolean }
    | { kind: "max_attempts"; challengeId: string; needsCancelSync: boolean }
    | { kind: "invalid_otp"; challengeId: string; remainingAttempts: number }
    | {
        kind: "ok";
        challengeId: string;
        pinVersion: number;
        pepperVersion: number;
        nowDb: Date;
      };

  let outcome: ResetOtpOutcome;
  try {
    outcome = await withBoundedSecurityTx(async (tx): Promise<ResetOtpOutcome> => {
      // Canonical lock order: (0) restaurants -> (2) restaurant_profile_pins -> (3) profile_pin_otp_challenges
      // Locking (0) prevents F-06 missing-PIN-row race against concurrent admin reset or setup.
      const anchor = await lockRestaurantAnchor(tx, restaurantId);
      if (!anchor) {
        return { kind: "not_found" };
      }

      await runSecurityTestHook("onResetWithOtpAnchorAcquired", {
        restaurantId,
        readBackendPid: async () => {
          const r = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
          return Number(r.rows[0]?.pid ?? 0);
        },
      });

      const [existingPin] = await tx
        .select()
        .from(restaurantProfilePins)
        .where(eq(restaurantProfilePins.restaurantId, restaurantId))
        .for("update");

      const challengeQuery = parsed.data.challengeId
        ? tx
            .select()
            .from(profilePinOtpChallenges)
            .where(
              and(
                eq(profilePinOtpChallenges.id, parsed.data.challengeId.toLowerCase()),
                eq(profilePinOtpChallenges.ownerUserId, user.id),
                eq(profilePinOtpChallenges.restaurantId, restaurantId),
              ),
            )
            .for("update")
        : tx
            .select()
            .from(profilePinOtpChallenges)
            .where(
              and(
                eq(profilePinOtpChallenges.ownerUserId, user.id),
                eq(profilePinOtpChallenges.restaurantId, restaurantId),
                isNull(profilePinOtpChallenges.invalidatedAt),
                isNull(profilePinOtpChallenges.consumedAt),
              ),
            )
            .orderBy(desc(profilePinOtpChallenges.createdAt))
            .limit(1)
            .for("update");

      const [challenge] = await challengeQuery;
      if (!challenge) {
        return { kind: "not_found" };
      }

      const clockRows = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
      const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());

      if (challenge.invalidatedAt) {
        return {
          kind: "invalidated",
          challengeId: challenge.id,
          reason: challenge.invalidationReason,
        };
      }
      if (challenge.consumedAt) {
        return { kind: "consumed", challengeId: challenge.id };
      }
      if (challenge.expiresAt.getTime() <= nowDb.getTime()) {
        await tx.execute(sql`
          UPDATE profile_pin_otp_challenges
          SET
            invalidated_at = clock_timestamp(),
            invalidation_reason = 'expired',
            cancel_sync_status = CASE
              WHEN delivery_status IN ('pending', 'uncertain') THEN 'pending'
              ELSE cancel_sync_status
            END,
            updated_at = clock_timestamp()
          WHERE id = ${challenge.id}::uuid
            AND invalidated_at IS NULL
        `);
        return {
          kind: "expired",
          challengeId: challenge.id,
          needsCancelSync:
            challenge.deliveryStatus === "pending" || challenge.deliveryStatus === "uncertain",
        };
      }

      if (challenge.attempts >= challenge.maxAttempts) {
        return { kind: "max_attempts", challengeId: challenge.id, needsCancelSync: false };
      }

      const otpValid = verifyOtpHmac({
        challengeId: challenge.id,
        ownerUserId: user.id,
        restaurantId,
        otp: parsed.data.otp,
        storedOtpHmac: challenge.otpHmac,
        storedOtpPepperVersion: challenge.otpPepperVersion,
      });

      if (!otpValid) {
        const nextAttempts = challenge.attempts + 1;
        const reachedMax = nextAttempts >= challenge.maxAttempts;
        if (reachedMax) {
          await tx.execute(sql`
            UPDATE profile_pin_otp_challenges
            SET
              attempts = ${nextAttempts},
              invalidated_at = clock_timestamp(),
              invalidation_reason = 'max_attempts',
              cancel_sync_status = CASE
                WHEN delivery_status IN ('pending', 'uncertain') THEN 'pending'
                ELSE cancel_sync_status
              END,
              updated_at = clock_timestamp()
            WHERE id = ${challenge.id}::uuid
          `);
          return {
            kind: "max_attempts",
            challengeId: challenge.id,
            needsCancelSync:
              challenge.deliveryStatus === "pending" || challenge.deliveryStatus === "uncertain",
          };
        }

        await tx
          .update(profilePinOtpChallenges)
          .set({ attempts: nextAttempts, updatedAt: nowDb })
          .where(eq(profilePinOtpChallenges.id, challenge.id));

        return {
          kind: "invalid_otp",
          challengeId: challenge.id,
          remainingAttempts: challenge.maxAttempts - nextAttempts,
        };
      }

      // Valid OTP: hash new PIN, consume challenge, reset lockout & set/increment pinVersion
      const { pinHash, pepperVersion } = await hashProfilePin({
        ownerUserId: user.id,
        restaurantId,
        pin: parsed.data.newPin,
      });

      const postHashClock = await tx.execute<{ now_ts: Date | string }>(sql`SELECT clock_timestamp() AS now_ts`);
      const setNowDb = new Date(postHashClock.rows[0]?.now_ts ?? nowDb.getTime());

      const consumedRows = await tx
        .update(profilePinOtpChallenges)
        .set({
          consumedAt: setNowDb,
          updatedAt: setNowDb,
        })
        .where(
          and(
            eq(profilePinOtpChallenges.id, challenge.id),
            isNull(profilePinOtpChallenges.consumedAt),
            isNull(profilePinOtpChallenges.invalidatedAt),
          ),
        )
        .returning({ id: profilePinOtpChallenges.id });

      if (!consumedRows[0]) {
        return { kind: "consumed", challengeId: challenge.id };
      }

      let newPinVersion = 1;
      if (existingPin) {
        newPinVersion = existingPin.pinVersion + 1;
        await tx
          .update(restaurantProfilePins)
          .set({
            ownerUserId: user.id,
            pinHash,
            pepperVersion,
            pinVersion: newPinVersion,
            failedAttempts: 0,
            lockoutLevel: 0,
            lockedUntil: null,
            lastFailedAt: null,
            pinSetAt: setNowDb,
            updatedAt: setNowDb,
          })
          .where(eq(restaurantProfilePins.id, existingPin.id));
      } else {
        await tx.insert(restaurantProfilePins).values({
          restaurantId,
          ownerUserId: user.id,
          pinHash,
          pepperVersion,
          pinVersion: 1,
          failedAttempts: 0,
          lockoutLevel: 0,
          lockedUntil: null,
          pinSetAt: setNowDb,
          updatedAt: setNowDb,
        });
      }

      return {
        kind: "ok",
        challengeId: challenge.id,
        pinVersion: newPinVersion,
        pepperVersion,
        nowDb: setNowDb,
      };
    });
  } catch (err) {
    if (respondSecurityContention(res, err)) return;
    throw err;
  }

  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "No active OTP challenge found. Request a new OTP.", code: "OTP_CHALLENGE_NOT_FOUND" });
    return;
  }
  if (outcome.kind === "invalidated") {
    res.status(400).json({ error: "This OTP challenge is no longer valid. Request a new code.", code: "OTP_INVALIDATED" });
    return;
  }
  if (outcome.kind === "consumed") {
    res.status(400).json({ error: "This OTP code has already been used.", code: "OTP_ALREADY_USED" });
    return;
  }
  if (outcome.kind === "expired") {
    if (outcome.needsCancelSync) void cancelChatChallenge(outcome.challengeId);
    res.status(400).json({ error: "This OTP code has expired. Request a new code.", code: "OTP_EXPIRED" });
    return;
  }
  if (outcome.kind === "max_attempts") {
    if (outcome.needsCancelSync) void cancelChatChallenge(outcome.challengeId);
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: "otp_verify_failed_max_attempts",
      challengeId: outcome.challengeId,
      req,
    });
    res.status(429).json({ error: "Too many incorrect OTP attempts. Request a new code.", code: "OTP_MAX_ATTEMPTS" });
    return;
  }
  if (outcome.kind === "invalid_otp") {
    await recordOwnerSecurityAudit({
      restaurantId,
      ownerUserId: user.id,
      actorUserId: user.id,
      actorRole: "owner",
      eventType: "otp_verify_failed",
      challengeId: outcome.challengeId,
      meta: { remainingAttempts: outcome.remainingAttempts },
      req,
    });
    res.status(401).json({
      error: `Incorrect OTP code (${outcome.remainingAttempts} attempt${outcome.remainingAttempts === 1 ? "" : "s"} remaining).`,
      code: "OTP_INVALID",
      remainingAttempts: outcome.remainingAttempts,
    });
    return;
  }

  const { token, expiresAt } = signProfilePinUnlockToken({
    ownerUserId: user.id,
    restaurantId,
    pinVersion: outcome.pinVersion,
    ttlMs: PROFILE_PIN_UNLOCK_TTL_MS,
    nowMs: outcome.nowDb.getTime(),
  });
  setSessionUnlock(req, restaurantId, outcome.pinVersion, expiresAt);

  await recordOwnerSecurityAudit({
    restaurantId,
    ownerUserId: user.id,
    actorUserId: user.id,
    actorRole: "owner",
    eventType: "profile_pin_reset_with_otp",
    challengeId: outcome.challengeId,
    meta: { pinVersion: outcome.pinVersion, pepperVersion: outcome.pepperVersion },
    req,
  });

  res.json({
    ok: true,
    pinVersion: outcome.pinVersion,
    unlockToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

export default router;
