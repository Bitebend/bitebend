import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatDb,
  chatPool,
  messagingAccounts,
  messagingConversationMembers,
  messagingConversations,
  messagingDeviceLinkTokens,
  messagingDeviceListChanges,
  messagingDevices,
  messagingFallbackKeys,
  messagingOneTimePrekeys,
  messagingSessions,
} from "../db";
import {
  generateOpaqueToken,
  generateShortCode,
  safeEqualHex,
  sha256Hex,
  toMatrixUserId,
  verifyDeviceEndorsementEnvelope,
} from "../lib/crypto";
import {
  COOKIE_NAMES,
  clearHostCookie,
  parseRawCookies,
  pickCookieValue,
  setHostCookie,
} from "../lib/cookies";
import { createChatRateLimiter, recordAuditEvent } from "../lib/rateLimiter";
import { type AuthedChatRequest, requireChatAuth, resolveSessionFromCookieHeader } from "../middlewares/chatAuth";
import { disconnectDeviceSockets, notifyAccount, notifyDevice } from "../ws";

const router = Router();

const LINK_TOKEN_TTL_MS = 5 * 60 * 1000;
const SHORT_CODE_TTL_MS = 3 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINK_FAILED_ATTEMPTS = 5;
const SHORT_CODE_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const linkRateLimiter = createChatRateLimiter({
  maxRequests: 30,
  windowMs: 10 * 60 * 1000,
  label: "device-link",
});

async function bumpTokenFailedAttempt(linkId: string): Promise<{ failedAttempts: number; status: string }> {
  const [updated] = await chatDb
    .update(messagingDeviceLinkTokens)
    .set({
      failedAttempts: sql`${messagingDeviceLinkTokens.failedAttempts} + 1`,
      status: sql`CASE WHEN ${messagingDeviceLinkTokens.failedAttempts} + 1 >= ${MAX_LINK_FAILED_ATTEMPTS} THEN 'rejected' ELSE ${messagingDeviceLinkTokens.status} END`,
    })
    .where(eq(messagingDeviceLinkTokens.id, linkId))
    .returning({
      failedAttempts: messagingDeviceLinkTokens.failedAttempts,
      status: messagingDeviceLinkTokens.status,
    });
  return updated ?? { failedAttempts: MAX_LINK_FAILED_ATTEMPTS, status: "rejected" };
}

function shortCodeFailBucketKey(accountId: string): { key: string; expiresAt: Date } {
  const bucketStart = Math.floor(Date.now() / SHORT_CODE_FAILURE_WINDOW_MS) * SHORT_CODE_FAILURE_WINDOW_MS;
  return {
    key: `chat:short-code-fail:${accountId}:${bucketStart}`,
    expiresAt: new Date(bucketStart + SHORT_CODE_FAILURE_WINDOW_MS),
  };
}

async function isShortCodeLookupLocked(accountId: string): Promise<boolean> {
  const { key } = shortCodeFailBucketKey(accountId);
  try {
    const res = await chatPool.query<{ count: number }>(
      "SELECT count FROM rate_limit_windows WHERE key = $1 AND expires_at > NOW()",
      [key],
    );
    return (res.rows[0]?.count ?? 0) >= MAX_LINK_FAILED_ATTEMPTS;
  } catch {
    return false;
  }
}

async function recordShortCodeLookupFailure(accountId: string): Promise<number> {
  const { key, expiresAt } = shortCodeFailBucketKey(accountId);
  try {
    const res = await chatPool.query<{ count: number }>(
      `INSERT INTO rate_limit_windows (key, expires_at, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE
         SET count = rate_limit_windows.count + 1
       RETURNING count`,
      [key, expiresAt],
    );
    return res.rows[0]?.count ?? 1;
  } catch {
    return 1;
  }
}

const linkIntentSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(60).default("Linked Browser"),
  matrixDeviceId: z.string().trim().min(4).max(64),
  device2EciesPub: z.string().trim().min(20).max(512),
});

const linkLookupSchema = z.object({
  qrPayload: z.string().max(2048).optional(),
  shortCode: z.string().trim().min(6).max(16).optional(),
});

const linkRespondSchema = z.object({
  linkId: z.string().uuid(),
  device1EciesOutMsg: z.string().min(20).max(8192),
});

const linkSubmitKeysSchema = z.object({
  deviceKeysJson: z.record(z.unknown()),
  oneTimeKeys: z.record(z.unknown()).optional().default({}),
  fallbackKey: z.record(z.unknown()).optional(),
  device2KeyProofCiphertext: z.string().min(10).max(8192),
});

const linkApproveSchema = z.object({
  linkId: z.string().uuid(),
  device1EndorsementSig: z.string().min(16).max(2048),
});

async function bumpPeersAndKeyEpochs(accountId: string, reason: string): Promise<void> {
  const myConvs = await chatDb
    .select({ conversationId: messagingConversationMembers.conversationId })
    .from(messagingConversationMembers)
    .where(eq(messagingConversationMembers.accountId, accountId));

  const convIds = myConvs.map((c) => c.conversationId);
  const observerIds = new Set<string>([accountId]);

  if (convIds.length > 0) {
    await chatDb
      .update(messagingConversations)
      .set({ keyEpoch: sql`${messagingConversations.keyEpoch} + 1` })
      .where(inArray(messagingConversations.id, convIds));

    const peers = await chatDb
      .select({ accountId: messagingConversationMembers.accountId })
      .from(messagingConversationMembers)
      .where(inArray(messagingConversationMembers.conversationId, convIds));

    for (const p of peers) {
      observerIds.add(p.accountId);
    }
  }

  const values = Array.from(observerIds).map((observerAccountId) => ({
    observerAccountId,
    subjectAccountId: accountId,
    reason,
  }));

  if (values.length > 0) {
    await chatDb.insert(messagingDeviceListChanges).values(values);
  }

  for (const obs of observerIds) {
    notifyAccount(obs, { type: "sync_hint" });
  }
}

router.get("/devices", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const rows = await chatDb
    .select({
      id: messagingDevices.id,
      deviceLabel: messagingDevices.deviceLabel,
      matrixDeviceId: messagingDevices.matrixDeviceId,
      identityKeyEd25519: messagingDevices.identityKeyEd25519,
      status: messagingDevices.status,
      endorsedByDeviceId: messagingDevices.endorsedByDeviceId,
      lastSeenAt: messagingDevices.lastSeenAt,
      revokedAt: messagingDevices.revokedAt,
      createdAt: messagingDevices.createdAt,
    })
    .from(messagingDevices)
    .where(eq(messagingDevices.accountId, chatAuth.accountId))
    .orderBy(desc(messagingDevices.createdAt));

  res.json({
    devices: rows.map((d) => ({
      ...d,
      isCurrent: d.id === chatAuth.deviceId,
    })),
  });
});

// Step 1 (Device 2 unauthenticated): Create link intent + set browser-locked claim cookie
router.post("/devices/link-intent", linkRateLimiter, async (req: Request, res: Response) => {
  const parsed = linkIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid link intent parameters" });
    return;
  }

  const linkId = crypto.randomUUID();
  const qrSecret = generateOpaqueToken(24);
  const shortCode = generateShortCode();
  const claimSecret = generateOpaqueToken(32);

  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  const shortCodeExpiresAt = new Date(Date.now() + SHORT_CODE_TTL_MS);

  await chatDb.insert(messagingDeviceLinkTokens).values({
    id: linkId,
    secretHash: sha256Hex(qrSecret),
    shortCode,
    shortCodeExpiresAt,
    claimCookieHash: sha256Hex(claimSecret),
    device2Label: parsed.data.deviceLabel,
    device2MatrixId: parsed.data.matrixDeviceId,
    device2Ed25519: "pending",
    device2Curve25519: "pending",
    device2KeysJson: {},
    device2OtpkJson: {},
    device2EciesPub: parsed.data.device2EciesPub,
    status: "pending_scan",
    expiresAt,
  });

  setHostCookie(req, res, COOKIE_NAMES.LINK_CLAIM_PROD, COOKIE_NAMES.LINK_CLAIM_DEV, claimSecret, LINK_TOKEN_TTL_MS);

  res.status(201).json({
    linkId,
    qrPayload: JSON.stringify({ v: 1, linkId, secret: qrSecret }),
    shortCode,
    shortCodeExpiresAt: shortCodeExpiresAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
});

// Step 2a (Device 1 authenticated): Verify QR payload or 8-char short code & bind approving device
router.post("/devices/link-lookup", requireChatAuth, linkRateLimiter, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const parsed = linkLookupSchema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.qrPayload && !parsed.data.shortCode)) {
    res.status(400).json({ error: "Provide a scanned QR payload or 8-character link code" });
    return;
  }

  const now = new Date();
  let tokenRow: typeof messagingDeviceLinkTokens.$inferSelect | undefined;

  if (parsed.data.qrPayload) {
    let qrData: { linkId?: string; secret?: string };
    try {
      qrData = JSON.parse(parsed.data.qrPayload);
    } catch {
      res.status(400).json({ error: "Malformed QR payload" });
      return;
    }
    if (!qrData.linkId || !qrData.secret) {
      res.status(400).json({ error: "Invalid QR code payload" });
      return;
    }

    const [found] = await chatDb
      .select()
      .from(messagingDeviceLinkTokens)
      .where(
        and(
          eq(messagingDeviceLinkTokens.id, qrData.linkId),
          gt(messagingDeviceLinkTokens.expiresAt, now),
        ),
      )
      .limit(1);

    if (!found) {
      res.status(404).json({ error: "Link request not found or expired" });
      return;
    }
    if (found.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || found.status === "rejected") {
      res.status(429).json({ error: "Link request locked after repeated failed attempts", code: "LINK_LOCKED" });
      return;
    }
    if (!safeEqualHex(found.secretHash, sha256Hex(qrData.secret))) {
      const bumped = await bumpTokenFailedAttempt(found.id);
      await recordAuditEvent("link_qr_secret_failed", chatAuth.accountId, chatAuth.deviceId, {
        linkId: found.id,
        failedAttempts: bumped.failedAttempts,
      });
      if (bumped.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || bumped.status === "rejected") {
        res.status(429).json({ error: "Link request locked after repeated failed attempts", code: "LINK_LOCKED" });
      } else {
        res.status(403).json({ error: "Invalid QR pairing secret", code: "INVALID_LINK_SECRET" });
      }
      return;
    }
    tokenRow = found;
  } else if (parsed.data.shortCode) {
    if (await isShortCodeLookupLocked(chatAuth.accountId)) {
      res.status(429).json({
        error: "Too many invalid pairing code attempts. Please wait before trying again.",
        code: "SHORT_CODE_LOCKED",
      });
      return;
    }

    const normalizedCode = parsed.data.shortCode.replace(/[\s-]/g, "").toUpperCase();
    const [found] = await chatDb
      .select()
      .from(messagingDeviceLinkTokens)
      .where(
        and(
          eq(messagingDeviceLinkTokens.shortCode, normalizedCode),
          gt(messagingDeviceLinkTokens.shortCodeExpiresAt, now),
          gt(messagingDeviceLinkTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(messagingDeviceLinkTokens.createdAt))
      .limit(1);

    if (!found) {
      const failCount = await recordShortCodeLookupFailure(chatAuth.accountId);
      if (failCount >= MAX_LINK_FAILED_ATTEMPTS) {
        res.status(429).json({
          error: "Too many invalid pairing code attempts. Please wait before trying again.",
          code: "SHORT_CODE_LOCKED",
        });
      } else {
        res.status(404).json({ error: "Invalid or expired 8-character code" });
      }
      return;
    }
    if (found.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || found.status === "rejected") {
      res.status(429).json({ error: "Link code locked after repeated attempts", code: "LINK_LOCKED" });
      return;
    }
    tokenRow = found;
  }

  if (!tokenRow || (tokenRow.status !== "pending_scan" && tokenRow.accountId !== chatAuth.accountId)) {
    res.status(409).json({ error: "Link code was already claimed or is unavailable" });
    return;
  }

  await chatDb
    .update(messagingDeviceLinkTokens)
    .set({
      accountId: chatAuth.accountId,
      approvingDeviceId: chatAuth.deviceId,
    })
    .where(eq(messagingDeviceLinkTokens.id, tokenRow.id));

  res.json({
    linkId: tokenRow.id,
    deviceLabel: tokenRow.device2Label,
    matrixDeviceId: tokenRow.device2MatrixId,
    device2EciesPub: tokenRow.device2EciesPub,
    accountId: chatAuth.accountId,
    matrixUserId: toMatrixUserId(chatAuth.accountId),
    username: chatAuth.username,
    displayName: chatAuth.displayName,
  });
});

// Step 2b (Device 1 authenticated): Submit Ecies outbound channel establishment message
router.post("/devices/link-respond", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const parsed = linkRespondSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid link respond payload" });
    return;
  }

  const [updated] = await chatDb
    .update(messagingDeviceLinkTokens)
    .set({
      device1EciesOutMsg: parsed.data.device1EciesOutMsg,
      status: "challenge_issued",
    })
    .where(
      and(
        eq(messagingDeviceLinkTokens.id, parsed.data.linkId),
        eq(messagingDeviceLinkTokens.accountId, chatAuth.accountId),
        eq(messagingDeviceLinkTokens.approvingDeviceId, chatAuth.deviceId),
        eq(messagingDeviceLinkTokens.status, "pending_scan"),
        lt(messagingDeviceLinkTokens.failedAttempts, MAX_LINK_FAILED_ATTEMPTS),
        gt(messagingDeviceLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning({ id: messagingDeviceLinkTokens.id });

  if (!updated) {
    res.status(409).json({ error: "Link request expired or state changed" });
    return;
  }

  res.json({ ok: true, linkId: updated.id });
});

function validateLinkClaimCookie(req: Request, row: typeof messagingDeviceLinkTokens.$inferSelect): boolean {
  const { values } = parseRawCookies(req.headers.cookie);
  const claim = pickCookieValue(values, COOKIE_NAMES.LINK_CLAIM_PROD, COOKIE_NAMES.LINK_CLAIM_DEV);
  if (!claim) return false;
  return safeEqualHex(row.claimCookieHash, sha256Hex(claim));
}

// Step 3a (Device 2 unauthenticated, protected by __Host-bb_link_claim): Poll for Device 1's Ecies challenge
router.get("/devices/link-challenge/:linkId", async (req: Request, res: Response) => {
  const linkId = String(req.params["linkId"] ?? "");
  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(eq(messagingDeviceLinkTokens.id, linkId))
    .limit(1);

  if (!row || !validateLinkClaimCookie(req, row)) {
    res.status(404).json({ error: "Link session not found" });
    return;
  }

  if (row.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || row.status === "rejected") {
    res.status(429).json({ status: "rejected", error: "Link request locked after repeated failed attempts" });
    return;
  }

  if (row.expiresAt <= new Date()) {
    res.status(410).json({ status: "expired", error: "Link request expired" });
    return;
  }

  if (row.status === "pending_scan" || !row.accountId) {
    res.json({ status: "pending_scan" });
    return;
  }

  const [acc] = await chatDb
    .select({ username: messagingAccounts.username, displayName: messagingAccounts.displayName })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, row.accountId))
    .limit(1);

  res.json({
    status: row.status,
    accountId: row.accountId,
    matrixUserId: toMatrixUserId(row.accountId),
    username: acc?.username ?? "",
    displayName: acc?.displayName ?? "",
    device1EciesOutMsg: row.device1EciesOutMsg,
  });
});

// Step 3b (Device 2 unauthenticated, protected by __Host-bb_link_claim): Submit real OlmMachine keys & Ecies key proof
router.post("/devices/link-submit-keys/:linkId", async (req: Request, res: Response) => {
  const linkId = String(req.params["linkId"] ?? "");
  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(eq(messagingDeviceLinkTokens.id, linkId))
    .limit(1);

  if (!row || !validateLinkClaimCookie(req, row)) {
    res.status(404).json({ error: "Link session not found" });
    return;
  }
  if (row.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || row.status === "rejected") {
    res.status(429).json({ error: "Link request locked after repeated failed attempts", code: "LINK_LOCKED" });
    return;
  }
  if (row.status !== "challenge_issued" || row.expiresAt <= new Date() || !row.accountId) {
    res.status(409).json({ error: "Link request not ready for keys" });
    return;
  }

  const parsed = linkSubmitKeysSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid device key submission" });
    return;
  }

  const keysObj = parsed.data.deviceKeysJson["keys"] as Record<string, unknown> | undefined;
  const ed = keysObj?.[`ed25519:${row.device2MatrixId}`];
  const curve = keysObj?.[`curve25519:${row.device2MatrixId}`];
  if (typeof ed !== "string" || typeof curve !== "string" || !ed || !curve) {
    res.status(400).json({ error: "Missing Ed25519/Curve25519 keys in device keys bundle" });
    return;
  }

  const normalizedKeys = {
    ...parsed.data.deviceKeysJson,
    user_id: toMatrixUserId(row.accountId),
    device_id: row.device2MatrixId,
  };

  await chatDb
    .update(messagingDeviceLinkTokens)
    .set({
      device2Ed25519: ed,
      device2Curve25519: curve,
      device2KeysJson: normalizedKeys,
      device2OtpkJson: {
        oneTimeKeys: parsed.data.oneTimeKeys,
        fallbackKey: parsed.data.fallbackKey ?? null,
        keyProofCiphertext: parsed.data.device2KeyProofCiphertext,
      },
      status: "awaiting_approval",
    })
    .where(eq(messagingDeviceLinkTokens.id, row.id));

  if (row.approvingDeviceId) {
    notifyDevice(row.approvingDeviceId, { type: "link_update", linkId: row.id });
  }

  res.json({ ok: true, status: "awaiting_approval" });
});

// Step 4a (Device 1 authenticated): Check key proof & status before user clicks Approve SAS
router.get("/devices/link-pending/:linkId", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const linkId = String(req.params["linkId"] ?? "");
  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(and(eq(messagingDeviceLinkTokens.id, linkId), eq(messagingDeviceLinkTokens.accountId, chatAuth.accountId)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Link session not found" });
    return;
  }

  const otpkBundle = row.device2OtpkJson as { keyProofCiphertext?: string } | null;
  res.json({
    linkId: row.id,
    status: row.status,
    deviceLabel: row.device2Label,
    matrixDeviceId: row.device2MatrixId,
    device2Ed25519: row.device2Ed25519,
    device2KeyProofCiphertext: otpkBundle?.keyProofCiphertext ?? null,
  });
});

// Step 4b (Device 1 authenticated): Approve SAS match + verify & store Ed25519 endorsement of Device 2's identity key
router.post("/devices/link-approve", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const parsed = linkApproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid link approval payload" });
    return;
  }

  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(
      and(
        eq(messagingDeviceLinkTokens.id, parsed.data.linkId),
        eq(messagingDeviceLinkTokens.accountId, chatAuth.accountId),
        eq(messagingDeviceLinkTokens.approvingDeviceId, chatAuth.deviceId),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Device link session not found" });
    return;
  }
  if (row.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || row.status === "rejected") {
    res.status(429).json({ error: "Link request locked after repeated failed attempts", code: "LINK_LOCKED" });
    return;
  }
  if (row.status !== "awaiting_approval" || row.expiresAt <= new Date()) {
    res.status(409).json({ error: "Device link is not awaiting approval or expired" });
    return;
  }

  const [approvingDevice] = await chatDb
    .select({
      id: messagingDevices.id,
      matrixDeviceId: messagingDevices.matrixDeviceId,
      identityKeyEd25519: messagingDevices.identityKeyEd25519,
    })
    .from(messagingDevices)
    .where(
      and(
        eq(messagingDevices.id, chatAuth.deviceId),
        eq(messagingDevices.accountId, chatAuth.accountId),
        eq(messagingDevices.status, "active"),
        isNull(messagingDevices.revokedAt),
      ),
    )
    .limit(1);

  if (!approvingDevice) {
    res.status(403).json({ error: "Approving device is inactive" });
    return;
  }

  const sigValid = verifyDeviceEndorsementEnvelope({
    accountId: chatAuth.accountId,
    targetMatrixDeviceId: row.device2MatrixId,
    targetEd25519: row.device2Ed25519,
    signerMatrixDeviceId: approvingDevice.matrixDeviceId,
    signerEd25519: approvingDevice.identityKeyEd25519,
    endorsementSigJson: parsed.data.device1EndorsementSig,
  });

  if (!sigValid) {
    const bumped = await bumpTokenFailedAttempt(row.id);
    await recordAuditEvent("device_endorsement_failed", chatAuth.accountId, chatAuth.deviceId, {
      linkId: row.id,
      failedAttempts: bumped.failedAttempts,
    });
    if (bumped.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || bumped.status === "rejected") {
      res.status(429).json({
        error: "Link request locked after repeated invalid endorsement signatures",
        code: "LINK_LOCKED",
      });
    } else {
      res.status(403).json({
        error: "Invalid Ed25519 device endorsement signature",
        code: "INVALID_ENDORSEMENT_SIG",
      });
    }
    return;
  }

  const otpkBundle = row.device2OtpkJson as {
    oneTimeKeys?: Record<string, unknown>;
    fallbackKey?: Record<string, unknown> | null;
  };

  const createdDevice = await chatDb.transaction(async (tx) => {
    const [dev] = await tx
      .insert(messagingDevices)
      .values({
        accountId: chatAuth.accountId,
        deviceLabel: row.device2Label,
        matrixDeviceId: row.device2MatrixId,
        identityKeyEd25519: row.device2Ed25519,
        identityKeyCurve25519: row.device2Curve25519,
        deviceKeysJson: row.device2KeysJson,
        endorsedByDeviceId: chatAuth.deviceId,
        endorsementSig: parsed.data.device1EndorsementSig,
        status: "active",
        lastSeenAt: new Date(),
      })
      .returning();

    const otpkEntries = Object.entries(otpkBundle?.oneTimeKeys ?? {}).slice(0, 200);
    if (otpkEntries.length > 0) {
      await tx.insert(messagingOneTimePrekeys).values(
        otpkEntries.map(([fullKeyId, pub]) => {
          const idx = fullKeyId.indexOf(":");
          return {
            accountId: chatAuth.accountId,
            deviceId: dev.id,
            keyId: idx > 0 ? fullKeyId.slice(idx + 1) : fullKeyId,
            algorithm: idx > 0 ? fullKeyId.slice(0, idx) : "signed_curve25519",
            publicKeyJson: pub,
          };
        }),
      );
    }

    if (otpkBundle?.fallbackKey && Object.keys(otpkBundle.fallbackKey).length > 0) {
      const first = Object.entries(otpkBundle.fallbackKey)[0];
      if (first) {
        const [fullKeyId, pub] = first;
        const idx = fullKeyId.indexOf(":");
        await tx.insert(messagingFallbackKeys).values({
          deviceId: dev.id,
          keyId: idx > 0 ? fullKeyId.slice(idx + 1) : fullKeyId,
          algorithm: idx > 0 ? fullKeyId.slice(0, idx) : "signed_curve25519",
          publicKeyJson: pub,
          used: false,
        });
      }
    }

    await tx
      .update(messagingDeviceLinkTokens)
      .set({
        device1EndorsementSig: parsed.data.device1EndorsementSig,
        device2DeviceId: dev.id,
        sasConfirmedAt: new Date(),
        status: "approved",
      })
      .where(eq(messagingDeviceLinkTokens.id, row.id));

    return dev;
  });

  await bumpPeersAndKeyEpochs(chatAuth.accountId, "device_added");
  await recordAuditEvent("device_linked", chatAuth.accountId, createdDevice.id, {
    endorsedBy: chatAuth.deviceId,
  });

  res.json({
    ok: true,
    device: {
      id: createdDevice.id,
      deviceLabel: createdDevice.deviceLabel,
      matrixDeviceId: createdDevice.matrixDeviceId,
    },
  });
});

// Step 5 (Device 2 unauthenticated, protected by __Host-bb_link_claim):
// Issues session cookie cleanly with safe retry/recovery if HTTP response dropped before client ack.
// Prior unacknowledged session for device2DeviceId is revoked on retry so at most 1 active session exists;
// once client calls POST /devices/link-ack/:linkId, status flips to "claimed" and bb_link_claim cannot replay.
router.get("/devices/link-status/:linkId", async (req: Request, res: Response) => {
  const linkId = String(req.params["linkId"] ?? "");
  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(eq(messagingDeviceLinkTokens.id, linkId))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Link session not found" });
    return;
  }

  // Idempotent recovery: if client already possesses a valid session for this exact linked device, confirm cleanly
  const existingSession = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (
    existingSession.status === "ok" &&
    row.accountId &&
    row.device2DeviceId &&
    existingSession.auth.deviceId === row.device2DeviceId &&
    (row.status === "approved" || row.status === "claimed")
  ) {
    res.json({
      status: "approved",
      approved: true,
      account: {
        id: existingSession.auth.accountId,
        username: existingSession.auth.username,
        displayName: existingSession.auth.displayName,
        matrixUserId: toMatrixUserId(existingSession.auth.accountId),
      },
      device: {
        id: row.device2DeviceId,
        matrixDeviceId: row.device2MatrixId,
        deviceLabel: row.device2Label,
      },
    });
    return;
  }

  if (!validateLinkClaimCookie(req, row)) {
    res.status(404).json({ error: "Link session not found" });
    return;
  }

  if (row.failedAttempts >= MAX_LINK_FAILED_ATTEMPTS || row.status === "rejected") {
    res.status(429).json({ status: "rejected", approved: false, error: "Link request locked" });
    return;
  }

  if (row.expiresAt <= new Date()) {
    res.status(410).json({ status: "expired", approved: false, error: "Link request expired" });
    return;
  }

  if (row.status === "claimed") {
    res.json({ status: "claimed", approved: false });
    return;
  }

  if (row.status !== "approved" || !row.accountId || !row.device2DeviceId) {
    res.json({ status: row.status, approved: false });
    return;
  }

  const rawSession = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const issued = await chatDb.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(messagingDeviceLinkTokens)
      .where(eq(messagingDeviceLinkTokens.id, row.id))
      .for("update");

    if (!locked || locked.status !== "approved" || locked.expiresAt <= new Date() || !locked.device2DeviceId) {
      return { ok: false as const, status: locked?.status ?? "expired" };
    }

    // Revoke any prior unacknowledged session minted during an interrupted response so at most 1 session exists
    await tx
      .update(messagingSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(messagingSessions.deviceId, locked.device2DeviceId), isNull(messagingSessions.revokedAt)));

    await tx.insert(messagingSessions).values({
      accountId: locked.accountId!,
      deviceId: locked.device2DeviceId,
      tokenHash: sha256Hex(rawSession),
      expiresAt,
    });

    return { ok: true as const };
  });

  if (!issued.ok) {
    res.json({ status: issued.status, approved: false });
    return;
  }

  const [acc] = await chatDb
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, row.accountId))
    .limit(1);

  setHostCookie(req, res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV, rawSession, SESSION_TTL_MS);

  res.json({
    status: "approved",
    approved: true,
    account: {
      id: acc.id,
      username: acc.username,
      displayName: acc.displayName,
      matrixUserId: toMatrixUserId(acc.id),
    },
    device: {
      id: row.device2DeviceId,
      matrixDeviceId: row.device2MatrixId,
      deviceLabel: row.device2Label,
    },
  });
});

// Step 5b (Device 2 authenticated via received bb_chat_sess): Finalize link & invalidate bb_link_claim replay
router.post("/devices/link-ack/:linkId", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const linkId = String(req.params["linkId"] ?? "");

  const [row] = await chatDb
    .select()
    .from(messagingDeviceLinkTokens)
    .where(
      and(
        eq(messagingDeviceLinkTokens.id, linkId),
        eq(messagingDeviceLinkTokens.accountId, chatAuth.accountId),
        eq(messagingDeviceLinkTokens.device2DeviceId, chatAuth.deviceId),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Link session not found for this device" });
    return;
  }

  if (row.status === "approved") {
    await chatDb
      .update(messagingDeviceLinkTokens)
      .set({ status: "claimed" })
      .where(and(eq(messagingDeviceLinkTokens.id, row.id), eq(messagingDeviceLinkTokens.status, "approved")));
  }

  clearHostCookie(res, COOKIE_NAMES.LINK_CLAIM_PROD, COOKIE_NAMES.LINK_CLAIM_DEV);
  res.json({ ok: true, status: "claimed" });
});

// Revoke a device, revoke all its sessions, purge OTPKs, and rotate conversation Megolm keyEpoch
router.delete("/devices/:deviceId", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const targetDeviceId = String(req.params["deviceId"] ?? "");

  const [target] = await chatDb
    .select()
    .from(messagingDevices)
    .where(and(eq(messagingDevices.id, targetDeviceId), eq(messagingDevices.accountId, chatAuth.accountId)))
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "Device not found" });
    return;
  }

  if (target.status === "revoked") {
    res.json({ ok: true, alreadyRevoked: true });
    return;
  }

  // Require at least one remaining active device OR treat self-revoke gracefully
  const activeOthers = await chatDb
    .select({ id: messagingDevices.id })
    .from(messagingDevices)
    .where(
      and(
        eq(messagingDevices.accountId, chatAuth.accountId),
        eq(messagingDevices.status, "active"),
        ne(messagingDevices.id, targetDeviceId),
      ),
    );

  if (targetDeviceId === chatAuth.deviceId && activeOthers.length === 0) {
    res.status(400).json({ error: "Cannot revoke your only active device. Use Logout instead." });
    return;
  }

  const now = new Date();
  await chatDb.transaction(async (tx) => {
    await tx
      .update(messagingDevices)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(messagingDevices.id, targetDeviceId));

    await tx
      .update(messagingSessions)
      .set({ revokedAt: now })
      .where(and(eq(messagingSessions.deviceId, targetDeviceId), isNull(messagingSessions.revokedAt)));

    await tx
      .delete(messagingOneTimePrekeys)
      .where(eq(messagingOneTimePrekeys.deviceId, targetDeviceId));

    await tx
      .delete(messagingFallbackKeys)
      .where(eq(messagingFallbackKeys.deviceId, targetDeviceId));
  });

  disconnectDeviceSockets(targetDeviceId);
  await bumpPeersAndKeyEpochs(chatAuth.accountId, "device_revoked");
  await recordAuditEvent("device_revoked", chatAuth.accountId, targetDeviceId, {
    revokedByDeviceId: chatAuth.deviceId,
  });

  res.json({ ok: true });
});

export default router;
