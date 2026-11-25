import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, profilePinOtpChallenges } from "@workspace/db";
import { logger } from "./logger";
import { hmacChatPhoneDigest } from "./profilePinCrypto";
import { withBoundedSecurityTx } from "./securityTx";

const DEFAULT_DELIVERY_DEADLINE_MS = 12_000;
const S2S_HTTP_TIMEOUT_MS = 8_000;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function getChatApiInternalUrl(): string {
  return (
    process.env["CHAT_API_INTERNAL_URL"]?.trim() ||
    "http://localhost:3002"
  ).replace(/\/$/, "");
}

function getInternalHmacSecret(): string | null {
  const explicit = process.env["CHAT_INTERNAL_HMAC_SECRET"]?.trim();
  if (explicit) return explicit;
  const isAiStudio = Boolean(
    process.env["APPLET_ID"] || process.env["DEFAULT_APP_PORT"],
  );
  if (process.env["NODE_ENV"] === "production" && !isAiStudio) {
    return null;
  }
  return process.env["SESSION_SECRET"]?.trim() || "bitebend-dev-chat-handoff-hmac-secret";
}

function buildS2SHmacHeaders(
  method: "GET" | "POST",
  endpointPath: string,
  bodyCanonical: string,
): Record<string, string> | null {
  const secret = getInternalHmacSecret();
  if (!secret) return null;
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(24).toString("hex");
  const signingInput = `${method}\n${endpointPath}\n${ts}\n${nonce}\n${sha256Hex(bodyCanonical)}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");

  return {
    ...(bodyCanonical ? { "Content-Type": "application/json" } : {}),
    "x-bitebend-ts": ts,
    "x-bitebend-nonce": nonce,
    "x-bitebend-sig": sig,
  };
}

export interface DispatchOtpResult {
  deliveryStatus: "delivered" | "failed" | "cancelled" | "uncertain";
  failureCode?: string | null;
  conversationId?: string;
  messageId?: string;
  committedAt?: string;
}

/**
 * Re-reads the challenge row immediately before S2S dispatch to recalculate fresh
 * remaining_ttl_seconds from main DB clock_timestamp(). Never dispatches expired,
 * invalidated, or consumed challenges. Updates main DB delivery state monotonically.
 */
export async function dispatchOtpWithFreshMainDbTtl(params: {
  challengeId: string;
  restaurantId: number;
  restaurantName: string;
  ownerPhoneNorm: string;
  otp: string;
  issuedAt: Date;
}): Promise<DispatchOtpResult> {
  // 1. Fresh main DB read right before calling chat-api
  const freshRes = await db.execute<{
    id: string;
    expires_at: Date | string;
    remaining_ttl_seconds: number;
  }>(sql`
    SELECT
      id,
      expires_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::int AS remaining_ttl_seconds
    FROM profile_pin_otp_challenges
    WHERE id = ${params.challengeId}::uuid
      AND invalidated_at IS NULL
      AND consumed_at IS NULL
      AND delivery_status IN ('pending', 'uncertain')
      AND expires_at > clock_timestamp()
    LIMIT 1
  `);

  const fresh = freshRes.rows[0];
  if (!fresh || Number(fresh.remaining_ttl_seconds) <= 0) {
    await db.execute(sql`
      UPDATE profile_pin_otp_challenges
      SET
        delivery_status = 'failed',
        failure_code = COALESCE(failure_code, 'OTP_EXPIRED_BEFORE_DISPATCH'),
        updated_at = clock_timestamp()
      WHERE id = ${params.challengeId}::uuid
        AND delivery_status IN ('pending', 'uncertain')
    `);
    return { deliveryStatus: "failed", failureCode: "OTP_EXPIRED_BEFORE_DISPATCH" };
  }

  const expiresAtDate = new Date(fresh.expires_at);
  const remainingTtlSeconds = Number(fresh.remaining_ttl_seconds);
  const deliveryDeadlineAt = new Date(
    Math.min(Date.now() + DEFAULT_DELIVERY_DEADLINE_MS, expiresAtDate.getTime()),
  );

  const endpointPath = "/api/internal/security/send-otp";
  const bodyObj = {
    challengeId: params.challengeId,
    phoneHmac: hmacChatPhoneDigest(params.ownerPhoneNorm),
    restaurantId: params.restaurantId,
    restaurantName: params.restaurantName,
    otp: params.otp,
    issuedAt: params.issuedAt.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
    deliveryDeadlineAt: deliveryDeadlineAt.toISOString(),
    remainingTtlSeconds,
  };
  const bodyCanonical = JSON.stringify(bodyObj);
  const headers = buildS2SHmacHeaders("POST", endpointPath, bodyCanonical);
  if (!headers) {
    await db.execute(sql`
      UPDATE profile_pin_otp_challenges
      SET
        delivery_status = 'failed',
        failure_code = 'HMAC_NOT_CONFIGURED',
        invalidated_at = COALESCE(invalidated_at, clock_timestamp()),
        invalidation_reason = COALESCE(invalidation_reason, 'delivery_failed'),
        updated_at = clock_timestamp()
      WHERE id = ${params.challengeId}::uuid
        AND delivery_status IN ('pending', 'uncertain')
    `);
    return { deliveryStatus: "failed", failureCode: "HMAC_NOT_CONFIGURED" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), S2S_HTTP_TIMEOUT_MS);

  try {
    const resp = await fetch(`${getChatApiInternalUrl()}${endpointPath}`, {
      method: "POST",
      headers,
      body: bodyCanonical,
      signal: controller.signal,
    });
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      deliveryStatus?: string;
      failureCode?: string;
      code?: string;
      conversationId?: string;
      messageId?: string;
      committedAt?: string;
    };

    if (resp.ok && data.deliveryStatus === "delivered") {
      const chatCommittedAt = data.committedAt ? new Date(data.committedAt) : null;
      await db.execute(sql`
        UPDATE profile_pin_otp_challenges
        SET
          delivery_status = 'delivered',
          delivered_at = COALESCE(delivered_at, clock_timestamp()),
          chat_committed_at = COALESCE(chat_committed_at, ${chatCommittedAt}),
          failure_code = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${params.challengeId}::uuid
          AND delivery_status IN ('pending', 'uncertain')
      `);
      return {
        deliveryStatus: "delivered",
        conversationId: data.conversationId,
        messageId: data.messageId,
        committedAt: data.committedAt,
      };
    }

    if (resp.status === 409 || data.deliveryStatus === "cancelled") {
      await db.execute(sql`
        UPDATE profile_pin_otp_challenges
        SET
          delivery_status = 'cancelled',
          invalidated_at = COALESCE(invalidated_at, clock_timestamp()),
          invalidation_reason = COALESCE(invalidation_reason, 'cancelled_in_chat_api'),
          cancel_sync_status = CASE
            WHEN cancel_sync_status = 'pending' THEN 'confirmed_cancelled'
            ELSE cancel_sync_status
          END,
          updated_at = clock_timestamp()
        WHERE id = ${params.challengeId}::uuid
          AND delivery_status IN ('pending', 'uncertain')
      `);
      return { deliveryStatus: "cancelled", failureCode: data.code ?? "CHALLENGE_CANCELLED" };
    }

    if (resp.status === 404 || resp.status === 422 || resp.status === 400 || data.deliveryStatus === "failed") {
      const failCode = data.failureCode ?? data.code ?? `HTTP_${resp.status}`;
      await db.execute(sql`
        UPDATE profile_pin_otp_challenges
        SET
          delivery_status = 'failed',
          failure_code = ${failCode},
          invalidated_at = COALESCE(invalidated_at, clock_timestamp()),
          invalidation_reason = COALESCE(invalidation_reason, 'delivery_failed'),
          updated_at = clock_timestamp()
        WHERE id = ${params.challengeId}::uuid
          AND delivery_status IN ('pending', 'uncertain')
      `);
      return { deliveryStatus: "failed", failureCode: failCode };
    }

    // 5xx or ambiguous upstream error -> mark uncertain for background reconciliation
    await db.execute(sql`
      UPDATE profile_pin_otp_challenges
      SET
        delivery_status = CASE WHEN delivery_status = 'pending' THEN 'uncertain' ELSE delivery_status END,
        failure_code = ${`HTTP_${resp.status}`},
        updated_at = clock_timestamp()
      WHERE id = ${params.challengeId}::uuid
        AND delivery_status = 'pending'
    `);
    return { deliveryStatus: "uncertain", failureCode: `HTTP_${resp.status}` };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, challengeId: params.challengeId },
      "Chat API S2S OTP send failed or timed out; marking delivery uncertain",
    );
    await db.execute(sql`
      UPDATE profile_pin_otp_challenges
      SET
        delivery_status = CASE WHEN delivery_status = 'pending' THEN 'uncertain' ELSE delivery_status END,
        failure_code = 'CHAT_API_UNREACHABLE',
        updated_at = clock_timestamp()
      WHERE id = ${params.challengeId}::uuid
        AND delivery_status = 'pending'
    `);
    return { deliveryStatus: "uncertain", failureCode: "CHAT_API_UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeChatChallengeStatus(challengeId: string): Promise<{
  reachable: boolean;
  deliveryStatus?: string;
  failureCode?: string | null;
  committedAt?: string | null;
}> {
  const endpointPath = `/api/internal/security/challenges/${encodeURIComponent(challengeId)}`;
  const headers = buildS2SHmacHeaders("GET", endpointPath, "");
  if (!headers) return { reachable: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${getChatApiInternalUrl()}${endpointPath}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const data = (await resp.json().catch(() => ({}))) as {
      deliveryStatus?: string;
      failureCode?: string | null;
      committedAt?: string | null;
    };
    if (!resp.ok && resp.status !== 404) {
      return { reachable: false };
    }
    return {
      reachable: true,
      deliveryStatus: data.deliveryStatus ?? (resp.status === 404 ? "not_found" : "pending"),
      failureCode: data.failureCode ?? null,
      committedAt: data.committedAt ?? null,
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelChatChallenge(challengeId: string): Promise<{
  reachable: boolean;
  status?: "cancelled" | "delivered" | "failed";
  alreadyDelivered?: boolean;
  committedAt?: string | null;
  failureCode?: string | null;
}> {
  const endpointPath = `/api/internal/security/challenges/${encodeURIComponent(challengeId)}/cancel`;
  const headers = buildS2SHmacHeaders("POST", endpointPath, "");
  if (!headers) return { reachable: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${getChatApiInternalUrl()}${endpointPath}`, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { reachable: false };
    }
    const data = (await resp.json().catch(() => ({}))) as {
      status?: "cancelled" | "delivered" | "failed";
      alreadyDelivered?: boolean;
      committedAt?: string | null;
      failureCode?: string | null;
    };

    await withBoundedSecurityTx(async (tx) => {
      const [row] = await tx
        .select({
          id: profilePinOtpChallenges.id,
          deliveryStatus: profilePinOtpChallenges.deliveryStatus,
        })
        .from(profilePinOtpChallenges)
        .where(eq(profilePinOtpChallenges.id, challengeId))
        .for("update");

      if (!row) return;

      if (data.status === "delivered") {
        const chatCommittedAt = data.committedAt ? new Date(data.committedAt) : null;
        await tx.execute(sql`
          UPDATE profile_pin_otp_challenges
          SET
            delivery_status = CASE
              WHEN delivery_status IN ('pending', 'uncertain') THEN 'delivered'
              ELSE delivery_status
            END,
            delivered_at = CASE
              WHEN delivery_status IN ('pending', 'uncertain') THEN COALESCE(delivered_at, clock_timestamp())
              ELSE delivered_at
            END,
            chat_committed_at = COALESCE(chat_committed_at, ${chatCommittedAt}),
            cancel_sync_status = 'confirmed_already_delivered',
            updated_at = clock_timestamp()
          WHERE id = ${challengeId}::uuid
        `);
      } else if (data.status === "cancelled") {
        await tx.execute(sql`
          UPDATE profile_pin_otp_challenges
          SET
            delivery_status = CASE
              WHEN delivery_status IN ('pending', 'uncertain') THEN 'cancelled'
              ELSE delivery_status
            END,
            cancel_sync_status = 'confirmed_cancelled',
            updated_at = clock_timestamp()
          WHERE id = ${challengeId}::uuid
        `);
      } else if (data.status === "failed") {
        await tx.execute(sql`
          UPDATE profile_pin_otp_challenges
          SET
            delivery_status = CASE
              WHEN delivery_status IN ('pending', 'uncertain') THEN 'failed'
              ELSE delivery_status
            END,
            failure_code = COALESCE(failure_code, ${data.failureCode ?? "DELIVERY_FAILED"}),
            cancel_sync_status = 'confirmed_failed',
            updated_at = clock_timestamp()
          WHERE id = ${challengeId}::uuid
        `);
      }
    });

    return {
      reachable: true,
      status: data.status,
      alreadyDelivered: data.alreadyDelivered,
      committedAt: data.committedAt,
      failureCode: data.failureCode,
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Periodic reconciliation sweep (F-13):
 * 1. In bounded batches of <= 100 rows (ORDER BY id ASC LIMIT 100 FOR UPDATE SKIP LOCKED),
 *    atomically selects and invalidates expired active OTP challenges inside a transaction.
 * 2. In bounded batches of <= 100 rows (ORDER BY id ASC LIMIT 100 FOR UPDATE SKIP LOCKED),
 *    identifies pending cancel syncs and reconciles each outside locks before committing monotonic updates.
 * 3. In bounded batches of <= 100 rows (ORDER BY id ASC LIMIT 100 FOR UPDATE SKIP LOCKED),
 *    identifies 'uncertain' deliveries, probes chat-api outside locks, then commits monotonic updates under row lock.
 */
export async function runSecurityOtpReconciliationSweep(): Promise<void> {
  try {
    // Step 1: Atomically lock (ORDER BY id ASC LIMIT 100 FOR UPDATE SKIP LOCKED) & expire stale challenges in tx
    await withBoundedSecurityTx(async (tx) => {
      const lockedExpired = await tx
        .select({ id: profilePinOtpChallenges.id })
        .from(profilePinOtpChallenges)
        .where(
          and(
            isNull(profilePinOtpChallenges.invalidatedAt),
            isNull(profilePinOtpChallenges.consumedAt),
            sql`${profilePinOtpChallenges.expiresAt} <= clock_timestamp()`,
          ),
        )
        .orderBy(asc(profilePinOtpChallenges.id))
        .limit(100)
        .for("update", { skipLocked: true });

      if (lockedExpired.length === 0) return;

      const ids = lockedExpired.map((r) => r.id);
      await tx
        .update(profilePinOtpChallenges)
        .set({
          invalidatedAt: sql`clock_timestamp()`,
          invalidationReason: "expired",
          cancelSyncStatus: sql`CASE WHEN ${profilePinOtpChallenges.deliveryStatus} IN ('pending', 'uncertain') THEN 'pending' ELSE ${profilePinOtpChallenges.cancelSyncStatus} END`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            inArray(profilePinOtpChallenges.id, ids),
            isNull(profilePinOtpChallenges.invalidatedAt),
            isNull(profilePinOtpChallenges.consumedAt),
            sql`${profilePinOtpChallenges.expiresAt} <= clock_timestamp()`,
          ),
        );
    });

    // Step 2: Select <= 100 uncontended pending cancel sync IDs under SKIP LOCKED, then reconcile outside lock
    const pendingCancelIds = await withBoundedSecurityTx(async (tx) => {
      const rows = await tx
        .select({ id: profilePinOtpChallenges.id })
        .from(profilePinOtpChallenges)
        .where(eq(profilePinOtpChallenges.cancelSyncStatus, "pending"))
        .orderBy(asc(profilePinOtpChallenges.id))
        .limit(100)
        .for("update", { skipLocked: true });
      return rows.map((r) => r.id);
    });

    for (const id of pendingCancelIds) {
      await cancelChatChallenge(id);
    }

    // Step 3: Select <= 100 uncontended 'uncertain' IDs under SKIP LOCKED, probe over HTTP, commit monotonically under tx lock
    const uncertainIds = await withBoundedSecurityTx(async (tx) => {
      const rows = await tx
        .select({ id: profilePinOtpChallenges.id })
        .from(profilePinOtpChallenges)
        .where(eq(profilePinOtpChallenges.deliveryStatus, "uncertain"))
        .orderBy(asc(profilePinOtpChallenges.id))
        .limit(100)
        .for("update", { skipLocked: true });
      return rows.map((r) => r.id);
    });

    for (const id of uncertainIds) {
      const statusRes = await probeChatChallengeStatus(id);
      if (!statusRes.reachable) continue;
      if (
        statusRes.deliveryStatus !== "delivered" &&
        statusRes.deliveryStatus !== "cancelled" &&
        statusRes.deliveryStatus !== "failed"
      ) {
        continue;
      }

      await withBoundedSecurityTx(async (tx) => {
        const [locked] = await tx
          .select({
            id: profilePinOtpChallenges.id,
            deliveryStatus: profilePinOtpChallenges.deliveryStatus,
          })
          .from(profilePinOtpChallenges)
          .where(eq(profilePinOtpChallenges.id, id))
          .for("update");

        if (
          !locked ||
          (locked.deliveryStatus !== "pending" && locked.deliveryStatus !== "uncertain")
        ) {
          return;
        }

        if (statusRes.deliveryStatus === "delivered") {
          const chatCommittedAt = statusRes.committedAt ? new Date(statusRes.committedAt) : null;
          await tx.execute(sql`
            UPDATE profile_pin_otp_challenges
            SET
              delivery_status = 'delivered',
              delivered_at = COALESCE(delivered_at, clock_timestamp()),
              chat_committed_at = COALESCE(chat_committed_at, ${chatCommittedAt}),
              failure_code = NULL,
              updated_at = clock_timestamp()
            WHERE id = ${id}::uuid
              AND delivery_status IN ('pending', 'uncertain')
          `);
        } else if (statusRes.deliveryStatus === "cancelled") {
          await tx.execute(sql`
            UPDATE profile_pin_otp_challenges
            SET
              delivery_status = 'cancelled',
              updated_at = clock_timestamp()
            WHERE id = ${id}::uuid
              AND delivery_status IN ('pending', 'uncertain')
          `);
        } else if (statusRes.deliveryStatus === "failed") {
          await tx.execute(sql`
            UPDATE profile_pin_otp_challenges
            SET
              delivery_status = 'failed',
              failure_code = COALESCE(failure_code, ${statusRes.failureCode ?? "DELIVERY_FAILED"}),
              updated_at = clock_timestamp()
            WHERE id = ${id}::uuid
              AND delivery_status IN ('pending', 'uncertain')
          `);
        }
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "OTP reconciliation sweep skipped");
  }
}
