import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { and, eq, gt, ilike, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatDb,
  messagingAccounts,
  messagingContactClaims,
  messagingDevices,
  messagingFallbackKeys,
  messagingHandoffDrafts,
  messagingLoginChallenges,
  messagingOneTimePrekeys,
  messagingSessions,
} from "../db";
import {
  buildAutoUsernameBase,
  buildAutoUsernameCandidates,
  buildLoginChallengePayload,
  extractMatrixEd25519Signature,
  generateOpaqueToken,
  hmacPhoneDigest,
  maskDisplayName,
  maskPhone,
  normalizePhone,
  sanitizeDisplayNameToSlug,
  sha256Hex,
  toMatrixUserId,
  validateUsername,
  verifyEd25519Signature,
} from "../lib/crypto";
import {
  COOKIE_NAMES,
  clearHandoffSourceCookie,
  clearHostCookie,
  hasDuplicateCookie,
  parseRawCookies,
  pickCookieValue,
  setHostCookie,
} from "../lib/cookies";
import { verifyAndConsumeHandoffToken } from "../lib/hmacClient";
import { createChatRateLimiter, recordAuditEvent } from "../lib/rateLimiter";
import {
  type AuthedChatRequest,
  requireChatAuth,
  resolveSessionFromCookieHeader,
} from "../middlewares/chatAuth";

const router = Router();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DRAFT_TTL_MS = 20 * 60 * 1000; // 20 minutes

const authLimiter = createChatRateLimiter({
  maxRequests: 25,
  windowMs: 10 * 60 * 1000,
  label: "chat-auth",
});

const deviceBundleSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(60).default("Web Browser"),
  matrixDeviceId: z.string().trim().min(4).max(64),
  deviceKeysJson: z.record(z.unknown()),
  oneTimeKeys: z.record(z.unknown()).optional().default({}),
  fallbackKey: z.record(z.unknown()).optional(),
});

const registerSchema = z.object({
  proposedAccountId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(60),
  mobileNumber: z.string().trim().min(6).max(24).optional(),
  contactPhone: z.string().trim().min(6).max(24).optional(),
  device: deviceBundleSchema,
});

const activateDraftSchema = z.object({
  proposedAccountId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  device: deviceBundleSchema,
});

const loginChallengeSchema = z.object({
  mobileNumber: z.string().trim().min(6).max(24),
  knownDevices: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        matrixDeviceId: z.string().trim().min(4).max(64),
      }),
    )
    .max(25)
    .optional()
    .default([]),
});

const loginVerifySchema = z.object({
  challengeId: z.string().uuid(),
  accountId: z.string().uuid(),
  matrixDeviceId: z.string().trim().min(4).max(64),
  signatureEnvelopeJson: z.string().min(16).max(4096),
});

const LOGIN_CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function extractKeysFromUpload(
  matrixDeviceId: string,
  deviceKeysJson: Record<string, unknown>,
): { ed25519: string; curve25519: string } | null {
  const keysObj = deviceKeysJson["keys"];
  if (!keysObj || typeof keysObj !== "object") return null;
  const record = keysObj as Record<string, unknown>;
  const ed = record[`ed25519:${matrixDeviceId}`];
  const curve = record[`curve25519:${matrixDeviceId}`];
  if (typeof ed !== "string" || typeof curve !== "string" || !ed || !curve) {
    return null;
  }
  return { ed25519: ed, curve25519: curve };
}

async function createAccountAndInitialDevice(params: {
  proposedAccountId?: string;
  usernameCandidates: string[];
  displayName: string;
  loginPhoneHmac: string | null;
  avoidLoginPhoneCollision?: boolean;
  device: z.infer<typeof deviceBundleSchema>;
  claim?: {
    phoneHmac: string;
    phoneMasked: string;
    source: string;
  } | null;
  draftIdToActivate?: string | null;
}) {
  const extracted = extractKeysFromUpload(params.device.matrixDeviceId, params.device.deviceKeysJson);
  if (!extracted) {
    return { error: "Missing Ed25519/Curve25519 identity keys in device bundle", status: 400 as const };
  }

  const accountId = params.proposedAccountId?.toLowerCase() ?? crypto.randomUUID();
  const matrixUserId = toMatrixUserId(accountId);
  const rawSession = generateOpaqueToken(32);
  const sessionTokenHash = sha256Hex(rawSession);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const normalizedDeviceKeys: Record<string, unknown> = {
    ...params.device.deviceKeysJson,
    user_id: matrixUserId,
    device_id: params.device.matrixDeviceId,
  };

  try {
    const result = await chatDb.transaction(async (tx) => {
      if (params.draftIdToActivate) {
        const [draftCheck] = await tx
          .select({ id: messagingHandoffDrafts.id, status: messagingHandoffDrafts.status, expiresAt: messagingHandoffDrafts.expiresAt })
          .from(messagingHandoffDrafts)
          .where(eq(messagingHandoffDrafts.id, params.draftIdToActivate))
          .limit(1);

        if (!draftCheck || draftCheck.status !== "pending" || draftCheck.expiresAt <= new Date()) {
          throw Object.assign(new Error("DRAFT_EXPIRED_OR_CONSUMED"), { code: "DRAFT_EXPIRED_OR_CONSUMED" });
        }
      }

      let effectiveLoginPhoneHmac = params.loginPhoneHmac;
      if (effectiveLoginPhoneHmac) {
        const [existingPhoneOwner] = await tx
          .select({ id: messagingAccounts.id })
          .from(messagingAccounts)
          .where(eq(messagingAccounts.loginPhoneHmac, effectiveLoginPhoneHmac))
          .limit(1);
        if (existingPhoneOwner) {
          if (params.avoidLoginPhoneCollision) {
            effectiveLoginPhoneHmac = null;
          } else {
            throw Object.assign(new Error("EXISTING_ACCOUNT_FOUND"), { code: "EXISTING_ACCOUNT_FOUND" });
          }
        }
      }

      const validCandidates = params.usernameCandidates
        .map((c) => validateUsername(c))
        .filter((v): v is { ok: true; username: string; lower: string } => v.ok)
        .map((v) => v.lower);

      if (validCandidates.length === 0) {
        throw new Error("No valid auto-generated username candidates");
      }

      const takenRows = await tx
        .select({ usernameLower: messagingAccounts.usernameLower })
        .from(messagingAccounts)
        .where(inArray(messagingAccounts.usernameLower, validCandidates));
      const takenSet = new Set(takenRows.map((r) => r.usernameLower));

      const orderedCandidates = [
        ...validCandidates.filter((c) => !takenSet.has(c)),
        // Append extra random candidates in case all pre-built candidates collided simultaneously
        ...Array.from({ length: 6 }, () => {
          const rand = crypto.randomBytes(3).toString("hex");
          const stem = validCandidates[0]!.slice(0, 23).replace(/[._-]+$/g, "") || "user";
          return `${stem}.${rand}`;
        }),
      ];

      let account: typeof messagingAccounts.$inferSelect | null = null;
      for (const candidate of orderedCandidates) {
        await tx.execute(sql.raw("SAVEPOINT sp_account_insert"));
        try {
          const [insertedAccount] = await tx
            .insert(messagingAccounts)
            .values({
              id: accountId,
              username: candidate,
              usernameLower: candidate,
              displayName: params.displayName,
              loginPhoneHmac: effectiveLoginPhoneHmac,
              identityStatus: "active",
            })
            .returning();
          await tx.execute(sql.raw("RELEASE SAVEPOINT sp_account_insert"));
          account = insertedAccount;
          break;
        } catch (insertErr: unknown) {
          await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT sp_account_insert"));
          const ie = insertErr as { code?: string; message?: string; cause?: { code?: string; message?: string } };
          const icode = ie?.code ?? ie?.cause?.code;
          const imsg = `${ie?.message ?? ""} ${ie?.cause?.message ?? ""}`;
          if (imsg.includes("uq_messaging_accounts_login_phone_hmac")) {
            if (params.avoidLoginPhoneCollision) {
              effectiveLoginPhoneHmac = null;
              continue;
            }
            throw Object.assign(new Error("EXISTING_ACCOUNT_FOUND"), { code: "EXISTING_ACCOUNT_FOUND" });
          }
          if (icode === "23505" && (imsg.includes("uq_messaging_accounts_username_lower") || imsg.includes("username_lower"))) {
            continue;
          }
          throw insertErr;
        }
      }

      if (!account) {
        throw new Error("Unable to allocate unique auto-generated username");
      }

      const [device] = await tx
        .insert(messagingDevices)
        .values({
          accountId: account.id,
          deviceLabel: params.device.deviceLabel,
          matrixDeviceId: params.device.matrixDeviceId,
          identityKeyEd25519: extracted.ed25519,
          identityKeyCurve25519: extracted.curve25519,
          deviceKeysJson: normalizedDeviceKeys,
          status: "active",
          lastSeenAt: new Date(),
        })
        .returning();

      const otpkEntries = Object.entries(params.device.oneTimeKeys ?? {}).slice(0, 200);
      if (otpkEntries.length > 0) {
        await tx.insert(messagingOneTimePrekeys).values(
          otpkEntries.map(([fullKeyId, keyVal]) => {
            const colonIdx = fullKeyId.indexOf(":");
            const algorithm = colonIdx > 0 ? fullKeyId.slice(0, colonIdx) : "signed_curve25519";
            const keyId = colonIdx > 0 ? fullKeyId.slice(colonIdx + 1) : fullKeyId;
            return {
              accountId: account.id,
              deviceId: device.id,
              keyId,
              algorithm,
              publicKeyJson: keyVal,
            };
          }),
        );
      }

      if (params.device.fallbackKey && Object.keys(params.device.fallbackKey).length > 0) {
        const firstFallback = Object.entries(params.device.fallbackKey)[0];
        if (firstFallback) {
          const [fullKeyId, keyVal] = firstFallback;
          const colonIdx = fullKeyId.indexOf(":");
          const algorithm = colonIdx > 0 ? fullKeyId.slice(0, colonIdx) : "signed_curve25519";
          const keyId = colonIdx > 0 ? fullKeyId.slice(colonIdx + 1) : fullKeyId;
          await tx.insert(messagingFallbackKeys).values({
            deviceId: device.id,
            keyId,
            algorithm,
            publicKeyJson: keyVal,
            used: false,
          });
        }
      }

      if (params.claim) {
        await tx.insert(messagingContactClaims).values({
          accountId: account.id,
          phoneHmac: params.claim.phoneHmac,
          phoneMasked: params.claim.phoneMasked,
          source: params.claim.source,
          verificationStatus: "unverified",
        });
      }

      if (params.draftIdToActivate) {
        await tx
          .update(messagingHandoffDrafts)
          .set({ status: "activated", activatedAccountId: account.id })
          .where(eq(messagingHandoffDrafts.id, params.draftIdToActivate));
      }

      const [session] = await tx
        .insert(messagingSessions)
        .values({
          accountId: account.id,
          deviceId: device.id,
          tokenHash: sessionTokenHash,
          expiresAt: sessionExpiresAt,
        })
        .returning();

      return { account, device, session };
    });

    return {
      ok: true as const,
      rawSession,
      account: {
        id: result.account.id,
        username: result.account.username,
        displayName: result.account.displayName,
        matrixUserId,
      },
      device: {
        id: result.device.id,
        matrixDeviceId: result.device.matrixDeviceId,
        deviceLabel: result.device.deviceLabel,
        identityKeyEd25519: result.device.identityKeyEd25519,
      },
    };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e?.code ?? e?.cause?.code;
    const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
    if (code === "DRAFT_EXPIRED_OR_CONSUMED") {
      return { error: "Your restaurant handoff draft expired. Please create an account manually or scan a new QR.", status: 410 as const };
    }
    if (code === "EXISTING_ACCOUNT_FOUND" || msg.includes("uq_messaging_accounts_login_phone_hmac")) {
      return {
        error: "An account with this mobile number already exists. Please sign in instead.",
        code: "EXISTING_ACCOUNT_FOUND",
        status: 409 as const,
      };
    }
    if (code === "23505" || msg.includes("uq_messaging_accounts_username_lower") || msg.includes("unique constraint")) {
      return { error: "That @username is already taken. Please pick another.", status: 409 as const };
    }
    throw err;
  }
}

/**
 * GET /api/chat/session/bootstrap
 * Enforces deterministic precedence:
 *   bb_chat_sess > bb_msg_handoff > bb_chat_draft > NO_HANDOFF
 */
router.get("/session/bootstrap", async (req: Request, res: Response) => {
  const { values, duplicates } = parseRawCookies(req.headers.cookie);

  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV])) {
    clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
    res.status(400).json({ state: "COOKIE_COLLISION", error: "Malformed duplicate session cookies cleared" });
    return;
  }

  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  const hasHandoffCookie =
    !hasDuplicateCookie(duplicates, [COOKIE_NAMES.HANDOFF_PROD, COOKIE_NAMES.HANDOFF_DEV]) &&
    Boolean(pickCookieValue(values, COOKIE_NAMES.HANDOFF_PROD, COOKIE_NAMES.HANDOFF_DEV));

  if (sessionState.status === "ok") {
    const auth = sessionState.auth;
    res.json({
      state: hasHandoffCookie ? "AUTHENTICATED_WITH_PENDING_HANDOFF" : "AUTHENTICATED",
      pendingHandoffDetected: hasHandoffCookie,
      account: {
        id: auth.accountId,
        username: auth.username,
        displayName: auth.displayName,
        matrixUserId: toMatrixUserId(auth.accountId),
      },
      currentDevice: {
        id: auth.deviceId,
        matrixDeviceId: auth.matrixDeviceId,
      },
    });
    return;
  }

  if (sessionState.status === "invalid_or_revoked") {
    clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
  }

  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.HANDOFF_PROD, COOKIE_NAMES.HANDOFF_DEV])) {
    clearHandoffSourceCookie(req, res);
    res.json({ state: "NO_HANDOFF", notice: "Duplicate handoff cookies cleared" });
    return;
  }

  if (hasHandoffCookie) {
    res.json({ state: "HANDOFF_READY" });
    return;
  }

  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV])) {
    clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
    res.json({ state: "NO_HANDOFF" });
    return;
  }

  const rawDraft = pickCookieValue(values, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  if (rawDraft) {
    const [draft] = await chatDb
      .select({
        id: messagingHandoffDrafts.id,
        restaurantId: messagingHandoffDrafts.restaurantId,
        maskedName: messagingHandoffDrafts.maskedName,
        maskedPhone: messagingHandoffDrafts.maskedPhone,
        expiresAt: messagingHandoffDrafts.expiresAt,
      })
      .from(messagingHandoffDrafts)
      .where(
        and(
          eq(messagingHandoffDrafts.draftTokenHash, sha256Hex(rawDraft)),
          eq(messagingHandoffDrafts.status, "pending"),
          gt(messagingHandoffDrafts.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (draft) {
      res.json({
        state: "DRAFT_PENDING",
        draft: {
          id: draft.id,
          restaurantId: draft.restaurantId,
          maskedName: draft.maskedName,
          maskedPhone: draft.maskedPhone,
          expiresAt: draft.expiresAt.toISOString(),
        },
      });
      return;
    }
    clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  }

  res.json({ state: "NO_HANDOFF" });
});

/**
 * POST /api/chat/handoff/exchange
 * Exchanges single-use bb_msg_handoff cookie via S2S HMAC call to api-server.
 * Always supersedes any pre-existing unactivated bb_chat_draft cookie.
 * Refuses to replace an active authenticated session (bb_chat_sess).
 */
router.post("/handoff/exchange", authLimiter, async (req: Request, res: Response) => {
  const { values, duplicates } = parseRawCookies(req.headers.cookie);

  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.HANDOFF_PROD, COOKIE_NAMES.HANDOFF_DEV])) {
    clearHandoffSourceCookie(req, res);
    res.status(400).json({ error: "Duplicate handoff cookies rejected", code: "DUPLICATE_COOKIE" });
    return;
  }

  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (sessionState.status === "ok") {
    res.status(409).json({
      error: "An active messaging account is already signed in on this browser",
      code: "AUTHENTICATED_WITH_PENDING_HANDOFF",
    });
    return;
  }

  const rawHandoff = pickCookieValue(values, COOKIE_NAMES.HANDOFF_PROD, COOKIE_NAMES.HANDOFF_DEV);
  if (!rawHandoff) {
    res.status(400).json({ error: "No pending restaurant order handoff found", code: "MISSING_HANDOFF" });
    return;
  }

  const verification = await verifyAndConsumeHandoffToken(rawHandoff);
  // Clear source handoff cookie regardless of verify result (single-use boundary)
  clearHandoffSourceCookie(req, res);

  if (!verification.valid || !verification.handoffId || !verification.customerPhone) {
    res.status(410).json({
      error: "Your order handoff link expired or was already used. You can create a new account directly.",
      code: verification.code ?? "HANDOFF_INVALID",
    });
    return;
  }

  const oldRawDraft = pickCookieValue(values, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  const newRawDraft = generateOpaqueToken(32);
  const newDraftHash = sha256Hex(newRawDraft);
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);

  const rawCustomerName = verification.customerName ?? "Guest";
  const normalizedPhone = normalizePhone(verification.customerPhone) ?? verification.customerPhone;
  const maskedName = maskDisplayName(rawCustomerName);
  const maskedPhone = maskPhone(normalizedPhone);
  const phoneHmac = hmacPhoneDigest(normalizedPhone);
  const suggestedUsernameBase = buildAutoUsernameBase(rawCustomerName, normalizedPhone);

  const createdDraft = await chatDb.transaction(async (tx) => {
    if (oldRawDraft) {
      await tx
        .update(messagingHandoffDrafts)
        .set({ status: "superseded" })
        .where(
          and(
            eq(messagingHandoffDrafts.draftTokenHash, sha256Hex(oldRawDraft)),
            eq(messagingHandoffDrafts.status, "pending"),
          ),
        );
    }

    const [inserted] = await tx
      .insert(messagingHandoffDrafts)
      .values({
        draftTokenHash: newDraftHash,
        sourceHandoffId: verification.handoffId!,
        restaurantId: verification.restaurantId ?? 0,
        maskedName,
        maskedPhone,
        phoneHmac,
        suggestedUsernameBase,
        status: "pending",
        expiresAt,
      })
      .returning({
        id: messagingHandoffDrafts.id,
        restaurantId: messagingHandoffDrafts.restaurantId,
        maskedName: messagingHandoffDrafts.maskedName,
        maskedPhone: messagingHandoffDrafts.maskedPhone,
        expiresAt: messagingHandoffDrafts.expiresAt,
      });

    return inserted;
  });

  setHostCookie(req, res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV, newRawDraft, DRAFT_TTL_MS);
  await recordAuditEvent("handoff_draft_created", null, null, {
    draftId: createdDraft.id,
    supersededPrior: Boolean(oldRawDraft),
  });

  res.status(201).json({
    state: "DRAFT_PENDING",
    draft: {
      id: createdDraft.id,
      restaurantId: createdDraft.restaurantId,
      maskedName: createdDraft.maskedName,
      maskedPhone: createdDraft.maskedPhone,
      expiresAt: createdDraft.expiresAt.toISOString(),
    },
  });
});

/**
 * DELETE /api/chat/handoff/pending
 * Dismisses a pending handoff or unactivated draft without disturbing any active session.
 */
router.delete("/handoff/pending", async (req: Request, res: Response) => {
  const { values } = parseRawCookies(req.headers.cookie);
  const rawDraft = pickCookieValue(values, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  if (rawDraft) {
    await chatDb
      .update(messagingHandoffDrafts)
      .set({ status: "superseded" })
      .where(
        and(
          eq(messagingHandoffDrafts.draftTokenHash, sha256Hex(rawDraft)),
          eq(messagingHandoffDrafts.status, "pending"),
        ),
      );
  }
  clearHandoffSourceCookie(req, res);
  clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  res.json({ ok: true });
});

router.get("/username/check", async (req: Request, res: Response) => {
  const raw = String(req.query["username"] ?? "");
  const v = validateUsername(raw);
  if (!v.ok) {
    res.json({ available: false, valid: false, error: v.error });
    return;
  }
  const [existing] = await chatDb
    .select({ id: messagingAccounts.id })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.usernameLower, v.lower))
    .limit(1);

  res.json({
    available: !existing,
    valid: true,
    normalized: v.username,
    error: existing ? "Username is already taken" : undefined,
  });
});

router.post("/register", authLimiter, async (req: Request, res: Response) => {
  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (sessionState.status === "ok") {
    res.status(409).json({ error: "Already signed in on this browser", code: "ALREADY_AUTHENTICATED" });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration payload", details: parsed.error.flatten() });
    return;
  }

  const rawPhone = (parsed.data.mobileNumber ?? parsed.data.contactPhone ?? "").trim();
  const normPhone = normalizePhone(rawPhone);
  if (!normPhone) {
    res.status(400).json({ error: "Please enter a valid mobile number (10+ digits)." });
    return;
  }

  const phoneHmac = hmacPhoneDigest(normPhone);
  const phoneMasked = maskPhone(normPhone);
  const usernameCandidates = buildAutoUsernameCandidates(parsed.data.displayName, normPhone);

  const created = await createAccountAndInitialDevice({
    proposedAccountId: parsed.data.proposedAccountId,
    usernameCandidates,
    displayName: parsed.data.displayName,
    loginPhoneHmac: phoneHmac,
    device: parsed.data.device,
    claim: {
      phoneHmac,
      phoneMasked,
      source: "mobile_registration",
    },
  });

  if (!created.ok) {
    res.status(created.status).json({ error: created.error, code: (created as { code?: string }).code });
    return;
  }

  setHostCookie(req, res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV, created.rawSession, SESSION_TTL_MS);
  clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  clearHandoffSourceCookie(req, res);

  await recordAuditEvent("account_registered", created.account.id, created.device.id);
  res.status(201).json({
    account: created.account,
    device: created.device,
  });
});

router.post("/activate-from-draft", authLimiter, async (req: Request, res: Response) => {
  const { values, duplicates } = parseRawCookies(req.headers.cookie);
  if (hasDuplicateCookie(duplicates, [COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV])) {
    clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
    res.status(400).json({ error: "Duplicate draft cookie rejected" });
    return;
  }

  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (sessionState.status === "ok") {
    res.status(409).json({ error: "An active account is already signed in", code: "ALREADY_AUTHENTICATED" });
    return;
  }

  const rawDraft = pickCookieValue(values, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  if (!rawDraft) {
    res.status(400).json({ error: "No pending activation draft found", code: "MISSING_DRAFT" });
    return;
  }

  const parsed = activateDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid activation payload" });
    return;
  }

  const [draft] = await chatDb
    .select()
    .from(messagingHandoffDrafts)
    .where(
      and(
        eq(messagingHandoffDrafts.draftTokenHash, sha256Hex(rawDraft)),
        eq(messagingHandoffDrafts.status, "pending"),
        gt(messagingHandoffDrafts.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!draft) {
    clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
    res.status(410).json({ error: "Activation draft expired. Please create a new account directly.", code: "DRAFT_EXPIRED" });
    return;
  }

  const fallbackTag = String((parseInt(draft.phoneHmac.slice(0, 8), 16) % 9000) + 1000);
  const draftTagMatch = /\.(\d{4})$/.exec(draft.suggestedUsernameBase ?? "");
  const tag = draftTagMatch ? draftTagMatch[1]! : fallbackTag;
  const baseHandle = parsed.data.displayName?.trim()
    ? `${sanitizeDisplayNameToSlug(parsed.data.displayName)}.${tag}`
    : (draft.suggestedUsernameBase ?? `guest.${tag}`);

  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const usernameCandidates = [
    baseHandle,
    ...Array.from({ length: 10 }, (_, idx) => {
      const len = idx < 4 ? 2 : 4;
      const bytes = crypto.randomBytes(len);
      let r = "";
      for (let j = 0; j < len; j++) r += alphabet[bytes[j]! % alphabet.length];
      const stem = baseHandle.slice(0, 30 - 1 - r.length).replace(/[._-]+$/g, "") || "guest";
      return `${stem}.${r}`;
    }),
  ];

  const created = await createAccountAndInitialDevice({
    proposedAccountId: parsed.data.proposedAccountId,
    usernameCandidates,
    displayName: parsed.data.displayName?.trim() || draft.maskedName,
    loginPhoneHmac: draft.phoneHmac,
    avoidLoginPhoneCollision: true,
    device: parsed.data.device,
    claim: {
      phoneHmac: draft.phoneHmac,
      phoneMasked: draft.maskedPhone,
      source: "qr_order_handoff",
    },
    draftIdToActivate: draft.id,
  });

  if (!created.ok) {
    res.status(created.status).json({ error: created.error, code: (created as { code?: string }).code });
    return;
  }

  setHostCookie(req, res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV, created.rawSession, SESSION_TTL_MS);
  clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  clearHandoffSourceCookie(req, res);

  await recordAuditEvent("account_activated_from_draft", created.account.id, created.device.id, {
    draftId: draft.id,
  });

  res.status(201).json({
    account: created.account,
    device: created.device,
  });
});

/**
 * POST /api/chat/login/challenge
 * Passwordless existing-account reconnection:
 * - Same browser with active local OlmMachine keypair -> issues single-use Ed25519 challenge nonce.
 * - Fresh browser / missing keys -> returns LINK_REQUIRED without leaking account PII or bypassing E2EE.
 */
router.post("/login/challenge", authLimiter, async (req: Request, res: Response) => {
  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (sessionState.status === "ok") {
    res.status(409).json({ error: "Already signed in on this browser", code: "ALREADY_AUTHENTICATED" });
    return;
  }

  const parsed = loginChallengeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a valid mobile number." });
    return;
  }

  const normPhone = normalizePhone(parsed.data.mobileNumber);
  if (!normPhone) {
    res.status(400).json({ error: "Please enter a valid mobile number (10+ digits)." });
    return;
  }

  const phoneHmac = hmacPhoneDigest(normPhone);
  const [account] = await chatDb
    .select({
      id: messagingAccounts.id,
      identityStatus: messagingAccounts.identityStatus,
    })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.loginPhoneHmac, phoneHmac))
    .limit(1);

  if (!account || account.identityStatus !== "active") {
    res.status(404).json({
      status: "NOT_FOUND",
      code: "ACCOUNT_NOT_FOUND",
      error: "No account is registered with that mobile number.",
    });
    return;
  }

  const matchingHints = parsed.data.knownDevices.filter(
    (kd) => kd.accountId.toLowerCase() === account.id.toLowerCase(),
  );

  let matchedDevice: { id: string; matrixDeviceId: string } | null = null;
  if (matchingHints.length > 0) {
    const candidateMatrixIds = Array.from(new Set(matchingHints.map((h) => h.matrixDeviceId)));
    const [foundDevice] = await chatDb
      .select({
        id: messagingDevices.id,
        matrixDeviceId: messagingDevices.matrixDeviceId,
      })
      .from(messagingDevices)
      .where(
        and(
          eq(messagingDevices.accountId, account.id),
          inArray(messagingDevices.matrixDeviceId, candidateMatrixIds),
          eq(messagingDevices.status, "active"),
          isNull(messagingDevices.revokedAt),
        ),
      )
      .limit(1);
    matchedDevice = foundDevice ?? null;
  }

  if (!matchedDevice) {
    res.json({
      status: "LINK_REQUIRED",
      message:
        "This browser does not hold your local encryption keys. Approve this browser from an already signed-in device using Link Existing.",
    });
    return;
  }

  const nonce = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS);
  const [challenge] = await chatDb
    .insert(messagingLoginChallenges)
    .values({
      accountId: account.id,
      deviceId: matchedDevice.id,
      matrixDeviceId: matchedDevice.matrixDeviceId,
      nonce,
      expiresAt,
    })
    .returning();

  res.json({
    status: "CHALLENGE_ISSUED",
    challengeId: challenge.id,
    accountId: account.id,
    matrixDeviceId: matchedDevice.matrixDeviceId,
    nonce: challenge.nonce,
  });
});

/**
 * POST /api/chat/login/verify
 * Verifies single-use Ed25519 challenge signature from an intact local OlmMachine
 * and re-mints a session cookie for that exact device without altering E2EE trust.
 */
router.post("/login/verify", authLimiter, async (req: Request, res: Response) => {
  const sessionState = await resolveSessionFromCookieHeader(req.headers.cookie);
  if (sessionState.status === "ok") {
    res.status(409).json({ error: "Already signed in on this browser", code: "ALREADY_AUTHENTICATED" });
    return;
  }

  const parsed = loginVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login verification payload" });
    return;
  }

  const normAccountId = parsed.data.accountId.toLowerCase();
  const now = new Date();
  const rawSession = generateOpaqueToken(32);
  const sessionTokenHash = sha256Hex(rawSession);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const verified = await chatDb.transaction(async (tx) => {
    const [consumed] = await tx
      .update(messagingLoginChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(messagingLoginChallenges.id, parsed.data.challengeId),
          eq(messagingLoginChallenges.accountId, normAccountId),
          eq(messagingLoginChallenges.matrixDeviceId, parsed.data.matrixDeviceId),
          isNull(messagingLoginChallenges.consumedAt),
          gt(messagingLoginChallenges.expiresAt, now),
        ),
      )
      .returning();

    if (!consumed) {
      return { ok: false as const, status: 401 as const, error: "Login challenge expired or already used", code: "CHALLENGE_INVALID" };
    }

    const [device] = await tx
      .select()
      .from(messagingDevices)
      .where(
        and(
          eq(messagingDevices.id, consumed.deviceId),
          eq(messagingDevices.accountId, consumed.accountId),
          eq(messagingDevices.status, "active"),
          isNull(messagingDevices.revokedAt),
        ),
      )
      .limit(1);

    if (!device) {
      return { ok: false as const, status: 401 as const, error: "Device is no longer active", code: "DEVICE_REVOKED" };
    }

    const [account] = await tx
      .select()
      .from(messagingAccounts)
      .where(
        and(
          eq(messagingAccounts.id, consumed.accountId),
          eq(messagingAccounts.identityStatus, "active"),
        ),
      )
      .limit(1);

    if (!account) {
      return { ok: false as const, status: 401 as const, error: "Account not active", code: "ACCOUNT_INACTIVE" };
    }

    const matrixUserId = toMatrixUserId(account.id);
    const sigBytes = extractMatrixEd25519Signature(
      parsed.data.signatureEnvelopeJson,
      matrixUserId,
      device.matrixDeviceId,
    );
    if (!sigBytes) {
      return { ok: false as const, status: 401 as const, error: "Malformed device signature", code: "INVALID_DEVICE_PROOF" };
    }

    const expectedPayload = buildLoginChallengePayload({
      challengeId: consumed.id,
      accountId: account.id,
      matrixDeviceId: device.matrixDeviceId,
      nonce: consumed.nonce,
    });

    const sigOk = verifyEd25519Signature({
      payload: expectedPayload,
      signatureBytes: sigBytes,
      signerEd25519Base64: device.identityKeyEd25519,
    });
    if (!sigOk) {
      return { ok: false as const, status: 401 as const, error: "Device cryptographic proof failed", code: "INVALID_DEVICE_PROOF" };
    }

    await tx
      .update(messagingDevices)
      .set({ lastSeenAt: now })
      .where(eq(messagingDevices.id, device.id));

    await tx.insert(messagingSessions).values({
      accountId: account.id,
      deviceId: device.id,
      tokenHash: sessionTokenHash,
      expiresAt: sessionExpiresAt,
    });

    return {
      ok: true as const,
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        matrixUserId,
      },
      device: {
        id: device.id,
        matrixDeviceId: device.matrixDeviceId,
        deviceLabel: device.deviceLabel,
        identityKeyEd25519: device.identityKeyEd25519,
      },
    };
  });

  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error, code: verified.code });
    return;
  }

  setHostCookie(req, res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV, rawSession, SESSION_TTL_MS);
  clearHostCookie(res, COOKIE_NAMES.DRAFT_PROD, COOKIE_NAMES.DRAFT_DEV);
  clearHandoffSourceCookie(req, res);

  await recordAuditEvent("session_login_device_challenge", verified.account.id, verified.device.id);
  res.json({
    account: verified.account,
    device: verified.device,
  });
});

router.post("/logout", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  await chatDb
    .update(messagingSessions)
    .set({ revokedAt: new Date() })
    .where(eq(messagingSessions.id, chatAuth.sessionId));
  clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
  await recordAuditEvent("session_logout", chatAuth.accountId, chatAuth.deviceId);
  res.json({ ok: true });
});

router.post("/logout-all", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  await chatDb
    .update(messagingSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(messagingSessions.accountId, chatAuth.accountId), isNull(messagingSessions.revokedAt)));
  clearHostCookie(res, COOKIE_NAMES.SESSION_PROD, COOKIE_NAMES.SESSION_DEV);
  await recordAuditEvent("session_logout_all", chatAuth.accountId, chatAuth.deviceId);
  res.json({ ok: true });
});

router.get("/users/lookup", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const raw = String(req.query["username"] ?? "").trim().replace(/^@/, "");
  const q = String(req.query["q"] ?? "").trim().replace(/^@/, "");

  if (q && q.length >= 2) {
    const escaped = q.toLowerCase().replace(/[%_\\]/g, "\\$&");
    const rows = await chatDb
      .select({
        accountId: messagingAccounts.id,
        username: messagingAccounts.username,
        displayName: messagingAccounts.displayName,
      })
      .from(messagingAccounts)
      .where(and(ilike(messagingAccounts.usernameLower, `${escaped}%`), ne(messagingAccounts.id, chatAuth.accountId)))
      .limit(10);

    res.json({
      users: rows.map((r) => ({
        ...r,
        matrixUserId: toMatrixUserId(r.accountId),
      })),
    });
    return;
  }

  if (!raw) {
    res.status(400).json({ error: "username or q parameter is required" });
    return;
  }

  const [found] = await chatDb
    .select({
      accountId: messagingAccounts.id,
      username: messagingAccounts.username,
      displayName: messagingAccounts.displayName,
    })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.usernameLower, raw.toLowerCase()))
    .limit(1);

  if (!found) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    user: {
      ...found,
      matrixUserId: toMatrixUserId(found.accountId),
    },
  });
});

export default router;
