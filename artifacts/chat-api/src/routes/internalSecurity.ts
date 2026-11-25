import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatDb,
  messagingAccounts,
  messagingConversationMembers,
  messagingConversations,
  messagingMessages,
  messagingSecurityOtpDeliveries,
} from "../db";
import {
  SYSTEM_SECURITY_ACCOUNT_ID,
  SYSTEM_SECURITY_DEVICE_ID,
  SYSTEM_SECURITY_DISPLAY_NAME,
  SYSTEM_SECURITY_EVENT_TYPE,
} from "../lib/securityConfig";
import { ensureSystemSecurityIdentity, signSecurityOtpPayload } from "../lib/securityOtpSigner";
import { requireInternalS2SHmac } from "../middlewares/internalAuth";
import { notifyAccount } from "../ws";

const router = Router();
router.use(requireInternalS2SHmac);

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256HexRe = /^[0-9a-f]{64}$/i;

const sendOtpSchema = z.object({
  challengeId: z.string().uuid(),
  phoneHmac: z.string().regex(sha256HexRe),
  restaurantId: z.number().int().positive(),
  restaurantName: z.string().trim().min(1).max(160),
  otp: z.string().regex(/^\d{6}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  deliveryDeadlineAt: z.string().datetime(),
  remainingTtlSeconds: z.number().int().positive(),
});

const CHAT_PG_CONTENTION_CODES = new Set([
  "55P03", // lock_not_available
  "57014", // query_canceled / statement_timeout
  "25P03", // idle_in_transaction_session_timeout
  "40P01", // deadlock_detected
  "40001", // serialization_failure
]);

function isPgLockTimeoutOrContention(err: unknown): boolean {
  const messages: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const rec = cur as { code?: unknown; message?: unknown; cause?: unknown; originalError?: unknown };
    if (typeof rec.code === "string" && CHAT_PG_CONTENTION_CODES.has(rec.code)) {
      return true;
    }
    if (typeof rec.message === "string") {
      messages.push(rec.message.toLowerCase());
    }
    cur = rec.cause ?? rec.originalError;
  }
  const msg = messages.join(" ");
  return (
    msg.includes("lock timeout") ||
    msg.includes("statement timeout") ||
    msg.includes("idle-in-transaction") ||
    msg.includes("could not obtain lock") ||
    msg.includes("deadlock detected")
  );
}

function getSystemConversationKey(recipientAccountId: string): string {
  return `system_security_otp:${recipientAccountId.toLowerCase()}`;
}

/**
 * POST /api/internal/security/send-otp
 * Guarantees database-enforced idempotency via messaging_security_otp_deliveries (PK = challenge_id)
 * and partial unique index uq_messages_system_security_otp_challenge (client_msg_id WHERE event_type = 'bb.system.security_otp').
 */
router.post("/send-otp", async (req: Request, res: Response) => {
  const parsed = sendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid OTP delivery payload", details: parsed.error.flatten() });
    return;
  }

  const input = parsed.data;
  const challengeId = input.challengeId.toLowerCase();
  const expiresAt = new Date(input.expiresAt);
  const deliveryDeadlineAt = new Date(input.deliveryDeadlineAt);

  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(deliveryDeadlineAt.getTime())) {
    res.status(400).json({ error: "Invalid OTP timestamp metadata" });
    return;
  }

  if (input.remainingTtlSeconds <= 0 || expiresAt.getTime() <= Date.now()) {
    res.status(422).json({
      ok: false,
      deliveryStatus: "failed",
      failureCode: "OTP_EXPIRED_BEFORE_DISPATCH",
      error: "Challenge expired before delivery",
    });
    return;
  }

  // Verify system identity integrity before dispatching any OTP
  await ensureSystemSecurityIdentity();

  // Strictly match ONLY verified active Messaging user login_phone_hmac (never unverified contact claims)
  const [recipient] = await chatDb
    .select({
      id: messagingAccounts.id,
      identityStatus: messagingAccounts.identityStatus,
      accountType: messagingAccounts.accountType,
    })
    .from(messagingAccounts)
    .where(
      and(
        eq(messagingAccounts.loginPhoneHmac, input.phoneHmac.toLowerCase()),
        eq(messagingAccounts.accountType, "user"),
        eq(messagingAccounts.identityStatus, "active"),
      ),
    )
    .limit(1);

  if (!recipient) {
    res.status(404).json({
      ok: false,
      deliveryStatus: "failed",
      failureCode: "RECIPIENT_NOT_FOUND",
      error: "No active Bitebend Messaging account matches the verified owner mobile number",
    });
    return;
  }

  // Tx0: Commit 'pending' row immediately so concurrent GET /challenges/:id sees active work
  await chatDb
    .insert(messagingSecurityOtpDeliveries)
    .values({
      challengeId,
      status: "pending",
      recipientAccountId: recipient.id,
      deliveryDeadlineAt,
      expiresAt,
    })
    .onConflictDoNothing({ target: messagingSecurityOtpDeliveries.challengeId });

  type Tx1Result =
    | {
        kind: "delivered";
        idempotent: boolean;
        conversationId: string;
        messageId: string;
        serverSeq: number;
        committedAt: string;
        notifyRecipientId?: string;
      }
    | { kind: "cancelled"; cancelledAt: string | null }
    | { kind: "failed"; failureCode: string };

  let result: Tx1Result;

  try {
    result = await chatDb.transaction(async (tx): Promise<Tx1Result> => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '3000ms'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5000ms'"));
      await tx.execute(sql.raw("SET LOCAL idle_in_transaction_session_timeout = '5000ms'"));

      const [locked] = await tx
        .select()
        .from(messagingSecurityOtpDeliveries)
        .where(eq(messagingSecurityOtpDeliveries.challengeId, challengeId))
        .for("update");

      if (!locked) {
        return { kind: "failed", failureCode: "DELIVERY_ROW_MISSING" };
      }

      if (locked.status === "delivered") {
        return {
          kind: "delivered",
          idempotent: true,
          conversationId: locked.conversationId!,
          messageId: locked.messageId!,
          serverSeq: locked.serverSeq!,
          committedAt: (locked.deliveredAt ?? locked.updatedAt).toISOString(),
        };
      }

      if (locked.status === "cancelled") {
        return {
          kind: "cancelled",
          cancelledAt: locked.cancelledAt?.toISOString() ?? null,
        };
      }

      if (locked.status === "failed") {
        return {
          kind: "failed",
          failureCode: locked.failureCode ?? "DELIVERY_FAILED",
        };
      }

      const timeCheckRows = await tx.execute<{ now_ts: Date | string }>(
        sql`SELECT clock_timestamp() AS now_ts`,
      );
      const nowDb = new Date(timeCheckRows.rows[0]?.now_ts ?? Date.now());

      if (nowDb.getTime() >= locked.deliveryDeadlineAt.getTime()) {
        await tx
          .update(messagingSecurityOtpDeliveries)
          .set({
            status: "failed",
            failureCode: "DELIVERY_DEADLINE_EXCEEDED",
            failedAt: nowDb,
            updatedAt: nowDb,
          })
          .where(
            and(
              eq(messagingSecurityOtpDeliveries.challengeId, challengeId),
              eq(messagingSecurityOtpDeliveries.status, "pending"),
            ),
          );
        return { kind: "failed", failureCode: "DELIVERY_DEADLINE_EXCEEDED" };
      }

      if (nowDb.getTime() >= locked.expiresAt.getTime()) {
        await tx
          .update(messagingSecurityOtpDeliveries)
          .set({
            status: "failed",
            failureCode: "OTP_EXPIRED",
            failedAt: nowDb,
            updatedAt: nowDb,
          })
          .where(
            and(
              eq(messagingSecurityOtpDeliveries.challengeId, challengeId),
              eq(messagingSecurityOtpDeliveries.status, "pending"),
            ),
          );
        return { kind: "failed", failureCode: "OTP_EXPIRED" };
      }

      // Ensure read-only system security conversation exists for this recipient
      const pairKey = getSystemConversationKey(recipient.id);
      await tx
        .insert(messagingConversations)
        .values({
          kind: "system_readonly",
          title: SYSTEM_SECURITY_DISPLAY_NAME,
          directPairKey: pairKey,
          keyEpoch: 1,
          nextSeq: 0,
          createdByAccountId: SYSTEM_SECURITY_ACCOUNT_ID,
        })
        .onConflictDoNothing({ target: messagingConversations.directPairKey });

      const [conv] = await tx
        .select()
        .from(messagingConversations)
        .where(eq(messagingConversations.directPairKey, pairKey))
        .for("update");

      if (!conv) {
        throw new Error("Failed to acquire system_readonly conversation");
      }

      await tx
        .insert(messagingConversationMembers)
        .values([
          {
            conversationId: conv.id,
            accountId: recipient.id,
            role: "member",
          },
          {
            conversationId: conv.id,
            accountId: SYSTEM_SECURITY_ACCOUNT_ID,
            role: "owner",
          },
        ])
        .onConflictDoNothing();

      // Double-check partial unique message table before allocating nextSeq
      const [existingMsg] = await tx
        .select()
        .from(messagingMessages)
        .where(
          and(
            eq(messagingMessages.clientMsgId, challengeId),
            eq(messagingMessages.eventType, SYSTEM_SECURITY_EVENT_TYPE),
          ),
        )
        .limit(1);

      let savedMessage = existingMsg;
      let usedKeyId = locked.signingKeyId ?? "";

      if (!savedMessage) {
        const nextSeq = conv.nextSeq + 1;
        await tx
          .update(messagingConversations)
          .set({ nextSeq })
          .where(eq(messagingConversations.id, conv.id));

        const signed = signSecurityOtpPayload({
          challengeId,
          recipientAccountId: recipient.id,
          conversationId: conv.id,
          restaurantId: input.restaurantId,
          restaurantName: input.restaurantName,
          otp: input.otp,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
        });
        usedKeyId = signed.keyId;

        const insertedRows = await tx
          .insert(messagingMessages)
          .values({
            conversationId: conv.id,
            senderAccountId: SYSTEM_SECURITY_ACCOUNT_ID,
            senderDeviceId: SYSTEM_SECURITY_DEVICE_ID,
            clientMsgId: challengeId,
            serverSeq: nextSeq,
            eventType: SYSTEM_SECURITY_EVENT_TYPE,
            keyEpoch: 1,
            payloadJson: signed.payload as unknown as Record<string, unknown>,
            attachmentIdsJson: [],
          })
          .onConflictDoNothing()
          .returning();

        if (insertedRows[0]) {
          savedMessage = insertedRows[0];
        } else {
          const [dup] = await tx
            .select()
            .from(messagingMessages)
            .where(
              and(
                eq(messagingMessages.clientMsgId, challengeId),
                eq(messagingMessages.eventType, SYSTEM_SECURITY_EVENT_TYPE),
              ),
            )
            .limit(1);
          savedMessage = dup;
        }
      }

      if (!savedMessage) {
        throw new Error("Failed to persist signed security OTP message");
      }

      // Final pre-commit deadline check with DB clock_timestamp()
      const postClock = await tx.execute<{ now_ts: Date | string }>(
        sql`SELECT clock_timestamp() AS now_ts`,
      );
      const commitCheckNow = new Date(postClock.rows[0]?.now_ts ?? Date.now());
      if (
        commitCheckNow.getTime() >= locked.deliveryDeadlineAt.getTime() ||
        commitCheckNow.getTime() >= locked.expiresAt.getTime()
      ) {
        throw Object.assign(new Error("DELIVERY_DEADLINE_ABORT"), {
          code: "DELIVERY_DEADLINE_ABORT",
          reason:
            commitCheckNow.getTime() >= locked.expiresAt.getTime()
              ? "OTP_EXPIRED"
              : "DELIVERY_DEADLINE_EXCEEDED",
        });
      }

      const [updatedDelivery] = await tx
        .update(messagingSecurityOtpDeliveries)
        .set({
          status: "delivered",
          conversationId: conv.id,
          messageId: savedMessage.id,
          serverSeq: savedMessage.serverSeq,
          signingKeyId: usedKeyId || ((savedMessage.payloadJson?.["keyId"] as string) ?? null),
          deliveredAt: commitCheckNow,
          updatedAt: commitCheckNow,
        })
        .where(
          and(
            eq(messagingSecurityOtpDeliveries.challengeId, challengeId),
            eq(messagingSecurityOtpDeliveries.status, "pending"),
          ),
        )
        .returning();

      if (!updatedDelivery) {
        throw Object.assign(new Error("DELIVERY_STATE_RACE"), {
          code: "DELIVERY_DEADLINE_ABORT",
          reason: "DELIVERY_STATE_CONFLICT",
        });
      }

      return {
        kind: "delivered",
        idempotent: false,
        conversationId: conv.id,
        messageId: savedMessage.id,
        serverSeq: savedMessage.serverSeq,
        committedAt: (updatedDelivery.deliveredAt ?? commitCheckNow).toISOString(),
        notifyRecipientId: recipient.id,
      };
    });
  } catch (err: unknown) {
    const e = err as { code?: string; reason?: string };
    if (e?.code === "DELIVERY_DEADLINE_ABORT") {
      const failureCode = e.reason ?? "DELIVERY_DEADLINE_EXCEEDED";
      await chatDb
        .update(messagingSecurityOtpDeliveries)
        .set({
          status: "failed",
          failureCode,
          failedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(messagingSecurityOtpDeliveries.challengeId, challengeId),
            eq(messagingSecurityOtpDeliveries.status, "pending"),
          ),
        );
      res.status(422).json({
        ok: false,
        deliveryStatus: "failed",
        failureCode,
        error: "Delivery deadline exceeded; message rolled back cleanly",
      });
      return;
    }
    if (isPgLockTimeoutOrContention(err)) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        ok: false,
        deliveryStatus: "uncertain",
        code: "DB_LOCK_CONTENTION",
        error: "Messaging database temporarily busy; delivery status uncertain",
      });
      return;
    }
    throw err;
  }

  if (result.kind === "delivered") {
    if (!result.idempotent && result.notifyRecipientId) {
      notifyAccount(result.notifyRecipientId, {
        type: "sync_hint",
        conversationId: result.conversationId,
        serverSeq: result.serverSeq,
      });
    }
    res.status(result.idempotent ? 200 : 201).json({
      ok: true,
      idempotent: result.idempotent,
      deliveryStatus: "delivered",
      conversationId: result.conversationId,
      messageId: result.messageId,
      serverSeq: result.serverSeq,
      committedAt: result.committedAt,
    });
    return;
  }

  if (result.kind === "cancelled") {
    res.status(409).json({
      ok: false,
      deliveryStatus: "cancelled",
      code: "CHALLENGE_CANCELLED",
      cancelledAt: result.cancelledAt,
    });
    return;
  }

  res.status(422).json({
    ok: false,
    deliveryStatus: "failed",
    failureCode: result.failureCode,
  });
});

/**
 * GET /api/internal/security/challenges/:challengeId
 * Probes chat-api delivery state safely under a short lock_timeout (1000ms).
 * Any 55P03 lock contention rolls back cleanly and returns { deliveryStatus: 'pending', delivered: false }.
 */
router.get("/challenges/:challengeId", async (req: Request, res: Response) => {
  const challengeId = String(req.params["challengeId"] ?? "").toLowerCase();
  if (!uuidRe.test(challengeId)) {
    res.status(400).json({ error: "Invalid challengeId" });
    return;
  }

  try {
    const row = await chatDb.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '1000ms'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '3000ms'"));
      await tx.execute(sql.raw("SET LOCAL idle_in_transaction_session_timeout = '3000ms'"));
      const [found] = await tx
        .select()
        .from(messagingSecurityOtpDeliveries)
        .where(eq(messagingSecurityOtpDeliveries.challengeId, challengeId))
        .for("update");
      return found ?? null;
    });

    if (!row) {
      res.status(404).json({
        found: false,
        deliveryStatus: "not_found",
        delivered: false,
      });
      return;
    }

    res.json({
      found: true,
      deliveryStatus: row.status,
      delivered: row.status === "delivered",
      failureCode: row.failureCode,
      conversationId: row.conversationId,
      messageId: row.messageId,
      serverSeq: row.serverSeq,
      committedAt: row.deliveredAt?.toISOString() ?? null,
    });
  } catch (err) {
    if (isPgLockTimeoutOrContention(err)) {
      res.json({
        found: true,
        deliveryStatus: "pending",
        delivered: false,
        lockContention: true,
      });
      return;
    }
    throw err;
  }
});

/**
 * POST /api/internal/security/challenges/:challengeId/cancel
 * Inserts a cancelled tombstone if not yet created, or transitions pending -> cancelled.
 * Never overwrites an already 'delivered' or 'failed' challenge.
 */
router.post("/challenges/:challengeId/cancel", async (req: Request, res: Response) => {
  const challengeId = String(req.params["challengeId"] ?? "").toLowerCase();
  if (!uuidRe.test(challengeId)) {
    res.status(400).json({ error: "Invalid challengeId" });
    return;
  }

  try {
    const outcome = await chatDb.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2000ms'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '4000ms'"));
      await tx.execute(sql.raw("SET LOCAL idle_in_transaction_session_timeout = '4000ms'"));

      const zeroUuid = "00000000-0000-0000-0000-000000000000";
      const clockRows = await tx.execute<{ now_ts: Date | string }>(
        sql`SELECT clock_timestamp() AS now_ts`,
      );
      const nowDb = new Date(clockRows.rows[0]?.now_ts ?? Date.now());

      await tx
        .insert(messagingSecurityOtpDeliveries)
        .values({
          challengeId,
          status: "cancelled",
          recipientAccountId: zeroUuid,
          deliveryDeadlineAt: nowDb,
          expiresAt: nowDb,
          cancelledAt: nowDb,
          createdAt: nowDb,
          updatedAt: nowDb,
        })
        .onConflictDoNothing({ target: messagingSecurityOtpDeliveries.challengeId });

      const [locked] = await tx
        .select()
        .from(messagingSecurityOtpDeliveries)
        .where(eq(messagingSecurityOtpDeliveries.challengeId, challengeId))
        .for("update");

      if (!locked) {
        return { status: "cancelled" as const, alreadyDelivered: false, committedAt: null, failureCode: null };
      }

      if (locked.status === "delivered") {
        return {
          status: "delivered" as const,
          alreadyDelivered: true,
          committedAt: locked.deliveredAt?.toISOString() ?? null,
          failureCode: null,
        };
      }

      if (locked.status === "failed") {
        return {
          status: "failed" as const,
          alreadyDelivered: false,
          committedAt: null,
          failureCode: locked.failureCode ?? "DELIVERY_FAILED",
        };
      }

      if (locked.status !== "cancelled") {
        await tx
          .update(messagingSecurityOtpDeliveries)
          .set({
            status: "cancelled",
            cancelledAt: locked.cancelledAt ?? nowDb,
            updatedAt: nowDb,
          })
          .where(
            and(
              eq(messagingSecurityOtpDeliveries.challengeId, challengeId),
              eq(messagingSecurityOtpDeliveries.status, "pending"),
            ),
          );
      }

      return {
        status: "cancelled" as const,
        alreadyDelivered: false,
        committedAt: null,
        failureCode: null,
      };
    });

    res.json({ ok: true, ...outcome });
  } catch (err) {
    if (isPgLockTimeoutOrContention(err)) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        ok: false,
        code: "DB_LOCK_CONTENTION",
        error: "Challenge cancellation temporarily contended",
      });
      return;
    }
    throw err;
  }
});

export default router;
