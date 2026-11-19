import { Router, type Request, type Response } from "express";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatDb,
  messagingDeviceListChanges,
  messagingDevices,
  messagingFallbackKeys,
  messagingOneTimePrekeys,
  messagingToDeviceEvents,
} from "../db";
import { fromMatrixUserId, toMatrixUserId, verifyDeviceEndorsementEnvelope } from "../lib/crypto";
import { type AuthedChatRequest, requireChatAuth } from "../middlewares/chatAuth";
import { notifyDevice } from "../ws";

const router = Router();
const MAX_OTPK_PER_DEVICE = 200;

const uploadKeysSchema = z.object({
  device_keys: z.record(z.unknown()).optional(),
  one_time_keys: z.record(z.unknown()).optional(),
  fallback_keys: z.record(z.unknown()).optional(),
});

const queryKeysSchema = z.object({
  device_keys: z.record(z.array(z.string())).default({}),
});

const claimKeysSchema = z.object({
  one_time_keys: z.record(z.record(z.string())),
});

const sendToDeviceSchema = z.object({
  messages: z.record(z.record(z.record(z.unknown()))),
});

async function countOtpks(deviceId: string): Promise<number> {
  const [row] = await chatDb
    .select({ cnt: sql<number>`count(*)::int` })
    .from(messagingOneTimePrekeys)
    .where(eq(messagingOneTimePrekeys.deviceId, deviceId));
  return row?.cnt ?? 0;
}

router.post("/keys/upload", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const parsed = uploadKeysSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid key upload payload" });
    return;
  }

  const myMatrixUserId = toMatrixUserId(chatAuth.accountId);

  if (parsed.data.device_keys) {
    const dk: Record<string, unknown> = {
      ...parsed.data.device_keys,
      user_id: myMatrixUserId,
      device_id: chatAuth.matrixDeviceId,
    };
    const keysRec = dk["keys"] as Record<string, unknown> | undefined;
    const ed = keysRec?.[`ed25519:${chatAuth.matrixDeviceId}`];
    const curve = keysRec?.[`curve25519:${chatAuth.matrixDeviceId}`];
    if (typeof ed === "string" && typeof curve === "string") {
      await chatDb
        .update(messagingDevices)
        .set({
          deviceKeysJson: dk,
          identityKeyEd25519: ed,
          identityKeyCurve25519: curve,
          lastSeenAt: new Date(),
        })
        .where(eq(messagingDevices.id, chatAuth.deviceId));
    }
  }

  if (parsed.data.one_time_keys) {
    const existingCount = await countOtpks(chatAuth.deviceId);
    const room = Math.max(0, MAX_OTPK_PER_DEVICE - existingCount);
    const entries = Object.entries(parsed.data.one_time_keys).slice(0, room);
    if (entries.length > 0) {
      await chatDb
        .insert(messagingOneTimePrekeys)
        .values(
          entries.map(([fullKeyId, pub]) => {
            const idx = fullKeyId.indexOf(":");
            const algorithm = idx > 0 ? fullKeyId.slice(0, idx) : "signed_curve25519";
            const keyId = idx > 0 ? fullKeyId.slice(idx + 1) : fullKeyId;
            return {
              accountId: chatAuth.accountId,
              deviceId: chatAuth.deviceId,
              keyId,
              algorithm,
              publicKeyJson: pub,
            };
          }),
        )
        .onConflictDoNothing();
    }
  }

  if (parsed.data.fallback_keys) {
    const first = Object.entries(parsed.data.fallback_keys)[0];
    if (first) {
      const [fullKeyId, pub] = first;
      const idx = fullKeyId.indexOf(":");
      const algorithm = idx > 0 ? fullKeyId.slice(0, idx) : "signed_curve25519";
      const keyId = idx > 0 ? fullKeyId.slice(idx + 1) : fullKeyId;
      await chatDb
        .insert(messagingFallbackKeys)
        .values({
          deviceId: chatAuth.deviceId,
          keyId,
          algorithm,
          publicKeyJson: pub,
          used: false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: messagingFallbackKeys.deviceId,
          set: {
            keyId,
            algorithm,
            publicKeyJson: pub,
            used: false,
            updatedAt: new Date(),
          },
        });
    }
  }

  const otpkCount = await countOtpks(chatAuth.deviceId);
  res.json({
    one_time_key_counts: {
      signed_curve25519: otpkCount,
    },
  });
});

router.post("/keys/query", requireChatAuth, async (req: Request, res: Response) => {
  const parsed = queryKeysSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid keys query payload" });
    return;
  }

  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  const endorsementsOut: Record<
    string,
    Record<
      string,
      {
        isRoot: boolean;
        ed25519: string;
        endorsedByMatrixDeviceId: string | null;
        endorsedByEd25519: string | null;
        endorsementSig: string | null;
        createdAt: string;
      }
    >
  > = {};
  const ancestorsOut: Record<
    string,
    Record<
      string,
      {
        isRoot: boolean;
        ed25519: string;
        endorsedByMatrixDeviceId: string | null;
        endorsedByEd25519: string | null;
        endorsementSig: string | null;
        status: string;
      }
    >
  > = {};

  const requestedUsers = Object.keys(parsed.data.device_keys);
  const accountIds = requestedUsers
    .map((uid) => ({ uid, accountId: fromMatrixUserId(uid) }))
    .filter((x): x is { uid: string; accountId: string } => x.accountId !== null);

  if (accountIds.length > 0) {
    const allRows = await chatDb
      .select({
        id: messagingDevices.id,
        accountId: messagingDevices.accountId,
        matrixDeviceId: messagingDevices.matrixDeviceId,
        identityKeyEd25519: messagingDevices.identityKeyEd25519,
        deviceKeysJson: messagingDevices.deviceKeysJson,
        endorsedByDeviceId: messagingDevices.endorsedByDeviceId,
        endorsementSig: messagingDevices.endorsementSig,
        status: messagingDevices.status,
        revokedAt: messagingDevices.revokedAt,
        createdAt: messagingDevices.createdAt,
      })
      .from(messagingDevices)
      .where(
        inArray(
          messagingDevices.accountId,
          accountIds.map((x) => x.accountId),
        ),
      )
      .orderBy(asc(messagingDevices.createdAt), asc(messagingDevices.id));

    for (const reqItem of accountIds) {
      out[reqItem.uid] = {};
      endorsementsOut[reqItem.uid] = {};
      ancestorsOut[reqItem.uid] = {};

      const filterList = parsed.data.device_keys[reqItem.uid] ?? [];
      const userDevices = allRows.filter((d) => d.accountId === reqItem.accountId);
      const byId = new Map(userDevices.map((d) => [d.id, d]));

      // Identify the single earliest unendorsed root device for this account
      const rootDevice = userDevices.find((d) => d.endorsedByDeviceId === null) ?? null;

      // Verify full endorsement chain back to the root device (cycle-safe)
      const verifiedDeviceIds = new Set<string>();
      const verifyNode = (dev: typeof userDevices[number], visited = new Set<string>()): boolean => {
        if (verifiedDeviceIds.has(dev.id)) return true;
        if (visited.has(dev.id)) return false;
        visited.add(dev.id);

        if (dev.endorsedByDeviceId === null) {
          if (rootDevice && dev.id === rootDevice.id) {
            verifiedDeviceIds.add(dev.id);
            return true;
          }
          return false;
        }

        if (!dev.endorsementSig) return false;
        const parent = byId.get(dev.endorsedByDeviceId);
        if (!parent || parent.accountId !== dev.accountId) return false;

        const sigOk = verifyDeviceEndorsementEnvelope({
          accountId: dev.accountId,
          targetMatrixDeviceId: dev.matrixDeviceId,
          targetEd25519: dev.identityKeyEd25519,
          signerMatrixDeviceId: parent.matrixDeviceId,
          signerEd25519: parent.identityKeyEd25519,
          endorsementSigJson: dev.endorsementSig,
        });
        if (!sigOk) return false;
        if (!verifyNode(parent, visited)) return false;
        verifiedDeviceIds.add(dev.id);
        return true;
      };

      for (const dev of userDevices) {
        if (dev.status !== "active" || dev.revokedAt !== null) continue;
        if (filterList.length > 0 && !filterList.includes(dev.matrixDeviceId)) continue;
        if (!verifyNode(dev)) continue;

        const parent = dev.endorsedByDeviceId ? byId.get(dev.endorsedByDeviceId) ?? null : null;
        out[reqItem.uid][dev.matrixDeviceId] = dev.deviceKeysJson;
        endorsementsOut[reqItem.uid][dev.matrixDeviceId] = {
          isRoot: dev.endorsedByDeviceId === null,
          ed25519: dev.identityKeyEd25519,
          endorsedByMatrixDeviceId: parent ? parent.matrixDeviceId : null,
          endorsedByEd25519: parent ? parent.identityKeyEd25519 : null,
          endorsementSig: dev.endorsementSig ?? null,
          createdAt: dev.createdAt.toISOString(),
        };

        // Include any verified revoked ancestors needed to anchor the chain on peers
        let curParent = parent;
        const seenAncestors = new Set<string>();
        while (curParent && !seenAncestors.has(curParent.id)) {
          seenAncestors.add(curParent.id);
          if (curParent.status !== "active" || curParent.revokedAt !== null) {
            const grand = curParent.endorsedByDeviceId ? byId.get(curParent.endorsedByDeviceId) ?? null : null;
            ancestorsOut[reqItem.uid][curParent.matrixDeviceId] = {
              isRoot: curParent.endorsedByDeviceId === null,
              ed25519: curParent.identityKeyEd25519,
              endorsedByMatrixDeviceId: grand ? grand.matrixDeviceId : null,
              endorsedByEd25519: grand ? grand.identityKeyEd25519 : null,
              endorsementSig: curParent.endorsementSig ?? null,
              status: curParent.status,
            };
          }
          curParent = curParent.endorsedByDeviceId ? byId.get(curParent.endorsedByDeviceId) ?? null : null;
        }
      }
    }
  }

  res.json({
    device_keys: out,
    failures: {},
    endorsements: endorsementsOut,
    endorsement_ancestors: ancestorsOut,
  });
});

router.post("/keys/claim", requireChatAuth, async (req: Request, res: Response) => {
  const parsed = claimKeysSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid key claim payload" });
    return;
  }

  const claimed: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const [matrixUserId, deviceAlgoMap] of Object.entries(parsed.data.one_time_keys)) {
    const accountId = fromMatrixUserId(matrixUserId);
    if (!accountId) continue;

    for (const [matrixDeviceId, algorithm] of Object.entries(deviceAlgoMap)) {
      const [dev] = await chatDb
        .select({ id: messagingDevices.id })
        .from(messagingDevices)
        .where(
          and(
            eq(messagingDevices.accountId, accountId),
            eq(messagingDevices.matrixDeviceId, matrixDeviceId),
            eq(messagingDevices.status, "active"),
            isNull(messagingDevices.revokedAt),
          ),
        )
        .limit(1);

      if (!dev) continue;

      const poppedKey = await chatDb.transaction(async (tx) => {
        // Atomic concurrent claim using FOR UPDATE SKIP LOCKED
        const [selected] = await tx
          .select({
            id: messagingOneTimePrekeys.id,
            keyId: messagingOneTimePrekeys.keyId,
            algorithm: messagingOneTimePrekeys.algorithm,
            publicKeyJson: messagingOneTimePrekeys.publicKeyJson,
          })
          .from(messagingOneTimePrekeys)
          .where(
            and(
              eq(messagingOneTimePrekeys.deviceId, dev.id),
              eq(messagingOneTimePrekeys.algorithm, algorithm),
            ),
          )
          .orderBy(asc(messagingOneTimePrekeys.id))
          .limit(1)
          .for("update", { skipLocked: true });

        if (selected) {
          await tx
            .delete(messagingOneTimePrekeys)
            .where(eq(messagingOneTimePrekeys.id, selected.id));
          return {
            fullKeyId: `${selected.algorithm}:${selected.keyId}`,
            publicKeyJson: selected.publicKeyJson,
          };
        }

        // Fall back to registered fallback key when OTPKs are exhausted
        const [fb] = await tx
          .select()
          .from(messagingFallbackKeys)
          .where(and(eq(messagingFallbackKeys.deviceId, dev.id), eq(messagingFallbackKeys.algorithm, algorithm)))
          .limit(1);

        if (fb) {
          await tx
            .update(messagingFallbackKeys)
            .set({ used: true, updatedAt: new Date() })
            .where(eq(messagingFallbackKeys.deviceId, dev.id));
          return {
            fullKeyId: `${fb.algorithm}:${fb.keyId}`,
            publicKeyJson: fb.publicKeyJson,
          };
        }

        return null;
      });

      if (poppedKey) {
        if (!claimed[matrixUserId]) claimed[matrixUserId] = {};
        claimed[matrixUserId][matrixDeviceId] = {
          [poppedKey.fullKeyId]: poppedKey.publicKeyJson,
        };
      }
    }
  }

  res.json({
    one_time_keys: claimed,
    failures: {},
  });
});

router.post("/sendToDevice/:eventType/:txnId", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const eventType = String(req.params["eventType"] ?? "");
  const txnId = String(req.params["txnId"] ?? "");
  if (!eventType || !txnId || txnId.length > 128) {
    res.status(400).json({ error: "Invalid sendToDevice parameters" });
    return;
  }

  const parsed = sendToDeviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sendToDevice body" });
    return;
  }

  const recipientDeviceIdsToNotify = new Set<string>();

  for (const [matrixUserId, devicesMap] of Object.entries(parsed.data.messages)) {
    const accountId = fromMatrixUserId(matrixUserId);
    if (!accountId) continue;

    for (const [targetMatrixDeviceId, contentJson] of Object.entries(devicesMap)) {
      const [targetDev] = await chatDb
        .select({ id: messagingDevices.id })
        .from(messagingDevices)
        .where(
          and(
            eq(messagingDevices.accountId, accountId),
            eq(messagingDevices.matrixDeviceId, targetMatrixDeviceId),
            eq(messagingDevices.status, "active"),
            isNull(messagingDevices.revokedAt),
          ),
        )
        .limit(1);

      if (!targetDev) continue;

      await chatDb
        .insert(messagingToDeviceEvents)
        .values({
          recipientAccountId: accountId,
          recipientDeviceId: targetDev.id,
          senderAccountId: chatAuth.accountId,
          senderDeviceId: chatAuth.deviceId,
          txnId,
          eventType,
          contentJson,
        })
        .onConflictDoNothing();

      recipientDeviceIdsToNotify.add(targetDev.id);
    }
  }

  for (const devId of recipientDeviceIdsToNotify) {
    notifyDevice(devId, { type: "sync_hint" });
  }

  res.json({});
});

router.get("/sync", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const sinceRaw = String(req.query["since"] ?? "").trim();

  if (sinceRaw) {
    // Expected format "td:<number>|dl:<number>"
    const tdMatch = /td:(\d+)/.exec(sinceRaw);
    const dlMatch = /dl:(\d+)/.exec(sinceRaw);
    const now = new Date();
    if (tdMatch) {
      const ackTd = Number(tdMatch[1]);
      if (ackTd > 0) {
        await chatDb
          .update(messagingToDeviceEvents)
          .set({ consumedAt: now })
          .where(
            and(
              eq(messagingToDeviceEvents.recipientDeviceId, chatAuth.deviceId),
              lte(messagingToDeviceEvents.id, ackTd),
              isNull(messagingToDeviceEvents.consumedAt),
            ),
          );
      }
    }
    if (dlMatch) {
      const ackDl = Number(dlMatch[1]);
      if (ackDl > 0) {
        await chatDb
          .update(messagingDeviceListChanges)
          .set({ consumedAt: now })
          .where(
            and(
              eq(messagingDeviceListChanges.observerAccountId, chatAuth.accountId),
              lte(messagingDeviceListChanges.id, ackDl),
              isNull(messagingDeviceListChanges.consumedAt),
            ),
          );
      }
    }
  }

  const pendingToDevice = await chatDb
    .select({
      id: messagingToDeviceEvents.id,
      senderAccountId: messagingToDeviceEvents.senderAccountId,
      eventType: messagingToDeviceEvents.eventType,
      contentJson: messagingToDeviceEvents.contentJson,
    })
    .from(messagingToDeviceEvents)
    .where(
      and(
        eq(messagingToDeviceEvents.recipientDeviceId, chatAuth.deviceId),
        isNull(messagingToDeviceEvents.consumedAt),
      ),
    )
    .orderBy(asc(messagingToDeviceEvents.id))
    .limit(200);

  const pendingDeviceChanges = await chatDb
    .select({
      id: messagingDeviceListChanges.id,
      subjectAccountId: messagingDeviceListChanges.subjectAccountId,
    })
    .from(messagingDeviceListChanges)
    .where(
      and(
        eq(messagingDeviceListChanges.observerAccountId, chatAuth.accountId),
        isNull(messagingDeviceListChanges.consumedAt),
      ),
    )
    .orderBy(asc(messagingDeviceListChanges.id))
    .limit(100);

  const maxTd = pendingToDevice.reduce((m, r) => Math.max(m, r.id), 0);
  const maxDl = pendingDeviceChanges.reduce((m, r) => Math.max(m, r.id), 0);
  const otpkCount = await countOtpks(chatAuth.deviceId);

  const [fb] = await chatDb
    .select({ algorithm: messagingFallbackKeys.algorithm, used: messagingFallbackKeys.used })
    .from(messagingFallbackKeys)
    .where(eq(messagingFallbackKeys.deviceId, chatAuth.deviceId))
    .limit(1);

  const changedMatrixUsers = Array.from(
    new Set(pendingDeviceChanges.map((d) => toMatrixUserId(d.subjectAccountId))),
  );

  res.json({
    next_batch: `td:${maxTd}|dl:${maxDl}`,
    to_device: {
      events: pendingToDevice.map((ev) => ({
        sender: toMatrixUserId(ev.senderAccountId),
        type: ev.eventType,
        content: ev.contentJson,
      })),
    },
    device_lists: {
      changed: changedMatrixUsers,
    },
    device_one_time_keys_count: {
      signed_curve25519: otpkCount,
    },
    device_unused_fallback_key_types: fb && !fb.used ? [fb.algorithm] : [],
  });
});

export default router;
