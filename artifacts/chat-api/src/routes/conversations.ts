import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatDb,
  messagingAccounts,
  messagingConversationMembers,
  messagingConversations,
  messagingDeviceListChanges,
  messagingDevices,
  messagingMessages,
} from "../db";
import { toMatrixUserId } from "../lib/crypto";
import { type AuthedChatRequest, requireChatAuth } from "../middlewares/chatAuth";
import { notifyAccount } from "../ws";

const router = Router();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createDirectSchema = z.object({
  kind: z.literal("direct"),
  targetUsername: z.string().trim().min(3).max(32),
});

const createGroupSchema = z.object({
  kind: z.literal("group"),
  title: z.string().trim().min(1).max(80),
  memberUsernames: z.array(z.string().trim().min(3).max(32)).max(50).default([]),
});

const createConversationSchema = z.discriminatedUnion("kind", [createDirectSchema, createGroupSchema]);

const addMemberSchema = z.object({
  username: z.string().trim().min(3).max(32),
});

const sendMessageSchema = z.object({
  clientMsgId: z.string().uuid(),
  eventType: z.enum(["m.room.encrypted"]).default("m.room.encrypted"),
  keyEpoch: z.number().int().positive().default(1),
  payload: z.record(z.unknown()),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});

const ackSchema = z.object({
  lastReadSeq: z.number().int().min(0),
});

async function requireMembership(conversationId: string, accountId: string) {
  const [member] = await chatDb
    .select()
    .from(messagingConversationMembers)
    .where(
      and(
        eq(messagingConversationMembers.conversationId, conversationId),
        eq(messagingConversationMembers.accountId, accountId),
      ),
    )
    .limit(1);
  return member ?? null;
}

router.get("/conversations", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;

  const myMemberships = await chatDb
    .select({
      conversationId: messagingConversationMembers.conversationId,
      role: messagingConversationMembers.role,
      lastReadSeq: messagingConversationMembers.lastReadSeq,
    })
    .from(messagingConversationMembers)
    .where(eq(messagingConversationMembers.accountId, chatAuth.accountId));

  if (myMemberships.length === 0) {
    res.json({ conversations: [] });
    return;
  }

  const convIds = myMemberships.map((m) => m.conversationId);
  const convRows = await chatDb
    .select()
    .from(messagingConversations)
    .where(inArray(messagingConversations.id, convIds));

  const allMembers = await chatDb
    .select({
      conversationId: messagingConversationMembers.conversationId,
      accountId: messagingConversationMembers.accountId,
      role: messagingConversationMembers.role,
      username: messagingAccounts.username,
      displayName: messagingAccounts.displayName,
    })
    .from(messagingConversationMembers)
    .innerJoin(messagingAccounts, eq(messagingAccounts.id, messagingConversationMembers.accountId))
    .where(inArray(messagingConversationMembers.conversationId, convIds));

  const lastMessageMap = new Map<string, typeof messagingMessages.$inferSelect>();
  for (const cid of convIds) {
    const [latest] = await chatDb
      .select()
      .from(messagingMessages)
      .where(eq(messagingMessages.conversationId, cid))
      .orderBy(desc(messagingMessages.serverSeq))
      .limit(1);
    if (latest) lastMessageMap.set(cid, latest);
  }

  const membersByConv = new Map<string, Array<{
    accountId: string;
    matrixUserId: string;
    username: string;
    displayName: string;
    role: string;
  }>>();

  for (const row of allMembers) {
    const list = membersByConv.get(row.conversationId) ?? [];
    list.push({
      accountId: row.accountId,
      matrixUserId: toMatrixUserId(row.accountId),
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    });
    membersByConv.set(row.conversationId, list);
  }

  const membershipByConv = new Map(myMemberships.map((m) => [m.conversationId, m]));

  const conversations = convRows
    .map((conv) => {
      const m = membershipByConv.get(conv.id);
      const last = lastMessageMap.get(conv.id);
      return {
        id: conv.id,
        kind: conv.kind,
        title: conv.title,
        keyEpoch: conv.keyEpoch,
        nextSeq: conv.nextSeq,
        lastReadSeq: m?.lastReadSeq ?? 0,
        unreadCount: Math.max(0, conv.nextSeq - (m?.lastReadSeq ?? 0)),
        myRole: m?.role ?? "member",
        members: membersByConv.get(conv.id) ?? [],
        lastMessage: last
          ? {
              id: last.id,
              senderAccountId: last.senderAccountId,
              senderMatrixUserId: toMatrixUserId(last.senderAccountId),
              serverSeq: last.serverSeq,
              eventType: last.eventType,
              keyEpoch: last.keyEpoch,
              payloadJson: last.payloadJson,
              createdAt: last.createdAt.toISOString(),
            }
          : null,
        createdAt: conv.createdAt.toISOString(),
      };
    })
    .sort((a, b) => {
      const ta = a.lastMessage?.createdAt ?? a.createdAt;
      const tb = b.lastMessage?.createdAt ?? b.createdAt;
      return tb.localeCompare(ta);
    });

  res.json({ conversations });
});

router.post("/conversations", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const parsed = createConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid conversation payload" });
    return;
  }

  if (parsed.data.kind === "direct") {
    const targetUsername = parsed.data.targetUsername.replace(/^@/, "").toLowerCase();
    const [target] = await chatDb
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.usernameLower, targetUsername))
      .limit(1);

    if (!target) {
      res.status(404).json({ error: `User @${targetUsername} not found` });
      return;
    }
    if (target.accountType === "system_security") {
      res.status(403).json({ error: "Cannot start a conversation with Bitebend Security", code: "SYSTEM_ACCOUNT_FORBIDDEN" });
      return;
    }
    if (target.id === chatAuth.accountId) {
      res.status(400).json({ error: "Cannot start a direct chat with yourself" });
      return;
    }

    const pair = [chatAuth.accountId, target.id].sort();
    const directPairKey = `${pair[0]}:${pair[1]}`;

    const [existing] = await chatDb
      .select()
      .from(messagingConversations)
      .where(eq(messagingConversations.directPairKey, directPairKey))
      .limit(1);

    if (existing) {
      res.json({ conversationId: existing.id, existing: true });
      return;
    }

    const createdId = await chatDb.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messagingConversations)
        .values({
          kind: "direct",
          directPairKey,
          createdByAccountId: chatAuth.accountId,
        })
        .onConflictDoNothing({ target: messagingConversations.directPairKey })
        .returning({ id: messagingConversations.id });

      if (!inserted) {
        const [raceRow] = await tx
          .select({ id: messagingConversations.id })
          .from(messagingConversations)
          .where(eq(messagingConversations.directPairKey, directPairKey))
          .limit(1);
        return raceRow!.id;
      }

      await tx.insert(messagingConversationMembers).values([
        { conversationId: inserted.id, accountId: chatAuth.accountId, role: "owner" },
        { conversationId: inserted.id, accountId: target.id, role: "member" },
      ]);

      return inserted.id;
    });

    notifyAccount(target.id, { type: "sync_hint", conversationId: createdId });
    res.status(201).json({ conversationId: createdId, existing: false });
    return;
  }

  // Group conversation
  if (parsed.data.kind !== "group") return;
  const groupTitle = parsed.data.title;
  const cleanUsernames = Array.from(
    new Set(
      parsed.data.memberUsernames
        .map((u) => u.replace(/^@/, "").toLowerCase())
        .filter((u) => u && u !== chatAuth.username.toLowerCase()),
    ),
  );

  const memberAccounts = cleanUsernames.length > 0
    ? await chatDb
        .select({ id: messagingAccounts.id })
        .from(messagingAccounts)
        .where(
          and(
            inArray(messagingAccounts.usernameLower, cleanUsernames),
            eq(messagingAccounts.accountType, "user"),
          ),
        )
    : [];

  const conv = await chatDb.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messagingConversations)
      .values({
        kind: "group",
        title: groupTitle,
        createdByAccountId: chatAuth.accountId,
      })
      .returning();

    await tx.insert(messagingConversationMembers).values([
      { conversationId: inserted.id, accountId: chatAuth.accountId, role: "owner" },
      ...memberAccounts.map((m) => ({
        conversationId: inserted.id,
        accountId: m.id,
        role: "member",
      })),
    ]);

    return inserted;
  });

  for (const m of memberAccounts) {
    notifyAccount(m.id, { type: "sync_hint", conversationId: conv.id });
  }

  res.status(201).json({ conversationId: conv.id });
});

router.post("/conversations/:id/members", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const conversationId = String(req.params["id"] ?? "");
  if (!uuidRe.test(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const membership = await requireMembership(conversationId, chatAuth.accountId);
  if (!membership || membership.role !== "owner") {
    res.status(403).json({ error: "Only group owners can add members" });
    return;
  }

  const [conv] = await chatDb
    .select()
    .from(messagingConversations)
    .where(eq(messagingConversations.id, conversationId))
    .limit(1);

  if (!conv || conv.kind !== "group") {
    res.status(400).json({ error: "Members can only be added to group conversations" });
    return;
  }

  const parsed = addMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }

  const targetLower = parsed.data.username.replace(/^@/, "").toLowerCase();
  const [target] = await chatDb
    .select({ id: messagingAccounts.id, accountType: messagingAccounts.accountType })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.usernameLower, targetLower))
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (target.accountType === "system_security") {
    res.status(403).json({ error: "System security identity cannot be added to conversations", code: "SYSTEM_ACCOUNT_FORBIDDEN" });
    return;
  }

  await chatDb.transaction(async (tx) => {
    await tx
      .insert(messagingConversationMembers)
      .values({ conversationId, accountId: target.id, role: "member" })
      .onConflictDoNothing();

    await tx
      .update(messagingConversations)
      .set({ keyEpoch: sql`${messagingConversations.keyEpoch} + 1` })
      .where(eq(messagingConversations.id, conversationId));
  });

  const allMembers = await chatDb
    .select({ accountId: messagingConversationMembers.accountId })
    .from(messagingConversationMembers)
    .where(eq(messagingConversationMembers.conversationId, conversationId));

  for (const m of allMembers) {
    notifyAccount(m.accountId, { type: "sync_hint", conversationId });
  }

  res.json({ ok: true });
});

router.delete("/conversations/:id/members/:accountId", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const conversationId = String(req.params["id"] ?? "");
  const targetAccountId = String(req.params["accountId"] ?? "");
  if (!uuidRe.test(conversationId) || !uuidRe.test(targetAccountId)) {
    res.status(400).json({ error: "Invalid identifier" });
    return;
  }

  const [convCheck] = await chatDb
    .select({ kind: messagingConversations.kind })
    .from(messagingConversations)
    .where(eq(messagingConversations.id, conversationId))
    .limit(1);
  if (!convCheck || convCheck.kind === "system_readonly") {
    res.status(403).json({ error: "Cannot modify members of a read-only system conversation", code: "SYSTEM_CONVERSATION_READONLY" });
    return;
  }

  const callerMember = await requireMembership(conversationId, chatAuth.accountId);
  if (!callerMember) {
    res.status(403).json({ error: "Not a member" });
    return;
  }

  if (targetAccountId !== chatAuth.accountId && callerMember.role !== "owner") {
    res.status(403).json({ error: "Only owners can remove other members" });
    return;
  }

  await chatDb.transaction(async (tx) => {
    await tx
      .delete(messagingConversationMembers)
      .where(
        and(
          eq(messagingConversationMembers.conversationId, conversationId),
          eq(messagingConversationMembers.accountId, targetAccountId),
        ),
      );

    await tx
      .update(messagingConversations)
      .set({ keyEpoch: sql`${messagingConversations.keyEpoch} + 1` })
      .where(eq(messagingConversations.id, conversationId));
  });

  const remaining = await chatDb
    .select({ accountId: messagingConversationMembers.accountId })
    .from(messagingConversationMembers)
    .where(eq(messagingConversationMembers.conversationId, conversationId));

  if (remaining.length > 0) {
    await chatDb.insert(messagingDeviceListChanges).values(
      remaining.map((r) => ({
        observerAccountId: r.accountId,
        subjectAccountId: targetAccountId,
        reason: "member_removed",
      })),
    );
    for (const r of remaining) {
      notifyAccount(r.accountId, { type: "sync_hint", conversationId });
    }
  }

  res.json({ ok: true });
});

router.get("/conversations/:id/messages", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const conversationId = String(req.params["id"] ?? "");
  if (!uuidRe.test(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const membership = await requireMembership(conversationId, chatAuth.accountId);
  if (!membership) {
    res.status(403).json({ error: "Not a member of this conversation" });
    return;
  }

  const afterSeq = Math.max(0, Number(req.query["afterSeq"] ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 100) || 100));

  const rows = await chatDb
    .select({
      id: messagingMessages.id,
      conversationId: messagingMessages.conversationId,
      senderAccountId: messagingMessages.senderAccountId,
      senderDeviceId: messagingMessages.senderDeviceId,
      clientMsgId: messagingMessages.clientMsgId,
      serverSeq: messagingMessages.serverSeq,
      eventType: messagingMessages.eventType,
      keyEpoch: messagingMessages.keyEpoch,
      payloadJson: messagingMessages.payloadJson,
      attachmentIdsJson: messagingMessages.attachmentIdsJson,
      createdAt: messagingMessages.createdAt,
      senderMatrixDeviceId: messagingDevices.matrixDeviceId,
    })
    .from(messagingMessages)
    .leftJoin(messagingDevices, eq(messagingDevices.id, messagingMessages.senderDeviceId))
    .where(
      and(
        eq(messagingMessages.conversationId, conversationId),
        gt(messagingMessages.serverSeq, afterSeq),
      ),
    )
    .orderBy(asc(messagingMessages.serverSeq))
    .limit(limit);

  res.json({
    messages: rows.map((r) => ({
      ...r,
      senderMatrixUserId: toMatrixUserId(r.senderAccountId),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post("/conversations/:id/messages", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const conversationId = String(req.params["id"] ?? "");
  if (!uuidRe.test(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const membership = await requireMembership(conversationId, chatAuth.accountId);
  if (!membership) {
    res.status(403).json({ error: "Not a member of this conversation" });
    return;
  }

  const [convMeta] = await chatDb
    .select({ kind: messagingConversations.kind })
    .from(messagingConversations)
    .where(eq(messagingConversations.id, conversationId))
    .limit(1);

  if (!convMeta || convMeta.kind === "system_readonly") {
    res.status(403).json({
      error: "This Bitebend Security channel is read-only",
      code: "SYSTEM_CONVERSATION_READONLY",
    });
    return;
  }

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid encrypted message envelope" });
    return;
  }

  const { payload, clientMsgId, eventType, keyEpoch, attachmentIds } = parsed.data;
  if (typeof payload["ciphertext"] !== "string" || typeof payload["algorithm"] !== "string") {
    res.status(400).json({ error: "Messages must contain encrypted ciphertext and algorithm metadata" });
    return;
  }

  // Idempotent duplicate check before bumping serverSeq
  const [duplicate] = await chatDb
    .select()
    .from(messagingMessages)
    .where(
      and(
        eq(messagingMessages.conversationId, conversationId),
        eq(messagingMessages.senderDeviceId, chatAuth.deviceId),
        eq(messagingMessages.clientMsgId, clientMsgId),
      ),
    )
    .limit(1);

  if (duplicate) {
    res.json({
      duplicate: true,
      message: {
        ...duplicate,
        senderMatrixUserId: toMatrixUserId(duplicate.senderAccountId),
        senderMatrixDeviceId: chatAuth.matrixDeviceId,
        createdAt: duplicate.createdAt.toISOString(),
      },
    });
    return;
  }

  const saved = await chatDb.transaction(async (tx) => {
    const [conv] = await tx
      .update(messagingConversations)
      .set({ nextSeq: sql`${messagingConversations.nextSeq} + 1` })
      .where(eq(messagingConversations.id, conversationId))
      .returning({ nextSeq: messagingConversations.nextSeq, keyEpoch: messagingConversations.keyEpoch });

    const [inserted] = await tx
      .insert(messagingMessages)
      .values({
        conversationId,
        senderAccountId: chatAuth.accountId,
        senderDeviceId: chatAuth.deviceId,
        clientMsgId,
        serverSeq: conv.nextSeq,
        eventType,
        keyEpoch: Math.max(conv.keyEpoch, keyEpoch),
        payloadJson: payload,
        attachmentIdsJson: attachmentIds,
      })
      .returning();

    return inserted;
  });

  const members = await chatDb
    .select({ accountId: messagingConversationMembers.accountId })
    .from(messagingConversationMembers)
    .where(eq(messagingConversationMembers.conversationId, conversationId));

  for (const m of members) {
    notifyAccount(m.accountId, {
      type: "sync_hint",
      conversationId,
      serverSeq: saved.serverSeq,
    });
  }

  res.status(201).json({
    duplicate: false,
    message: {
      ...saved,
      senderMatrixUserId: toMatrixUserId(saved.senderAccountId),
      senderMatrixDeviceId: chatAuth.matrixDeviceId,
      createdAt: saved.createdAt.toISOString(),
    },
  });
});

router.post("/conversations/:id/ack", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const conversationId = String(req.params["id"] ?? "");
  if (!uuidRe.test(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ack payload" });
    return;
  }

  await chatDb
    .update(messagingConversationMembers)
    .set({
      lastReadSeq: sql`GREATEST(${messagingConversationMembers.lastReadSeq}, ${parsed.data.lastReadSeq})`,
    })
    .where(
      and(
        eq(messagingConversationMembers.conversationId, conversationId),
        eq(messagingConversationMembers.accountId, chatAuth.accountId),
      ),
    );

  res.json({ ok: true });
});

export default router;
