import express, { Router, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { chatDb, messagingAttachments, messagingConversationMembers, messagingConversations } from "../db";
import { sha256Hex } from "../lib/crypto";
import { type AuthedChatRequest, requireChatAuth } from "../middlewares/chatAuth";

const router = Router();

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB ciphertext limit
export const ACCOUNT_QUOTA_BYTES = 250 * 1024 * 1024; // 250 MB per-account quota

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Re = /^[0-9a-f]{64}$/i;

router.post(
  "/",
  requireChatAuth,
  express.raw({ type: "application/octet-stream", limit: "16mb" }),
  async (req: Request, res: Response) => {
    const { chatAuth } = req as AuthedChatRequest;
    const conversationId = String(req.headers["x-conversation-id"] ?? "").trim();
    const declaredSha256 = String(req.headers["x-ciphertext-sha256"] ?? "").trim().toLowerCase();

    if (!uuidRe.test(conversationId) || !sha256Re.test(declaredSha256)) {
      res.status(400).json({ error: "Invalid attachment metadata headers" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Encrypted attachment bytes required" });
      return;
    }

    if (req.body.length > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({
        error: "Encrypted file exceeds 15 MB limit.",
        code: "ATTACHMENT_TOO_LARGE",
      });
      return;
    }

    const actualSha256 = sha256Hex(req.body);
    if (actualSha256 !== declaredSha256) {
      res.status(400).json({ error: "Ciphertext SHA-256 checksum mismatch" });
      return;
    }

    const [membership] = await chatDb
      .select({ accountId: messagingConversationMembers.accountId })
      .from(messagingConversationMembers)
      .where(
        and(
          eq(messagingConversationMembers.conversationId, conversationId),
          eq(messagingConversationMembers.accountId, chatAuth.accountId),
        ),
      )
      .limit(1);

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
        error: "Attachments cannot be uploaded to a read-only system conversation",
        code: "SYSTEM_CONVERSATION_READONLY",
      });
      return;
    }

    const [usageRow] = await chatDb
      .select({ totalBytes: sql<number>`coalesce(sum(byte_size), 0)::bigint` })
      .from(messagingAttachments)
      .where(eq(messagingAttachments.uploaderAccountId, chatAuth.accountId));

    const currentBytes = Number(usageRow?.totalBytes ?? 0);
    if (currentBytes + req.body.length > ACCOUNT_QUOTA_BYTES) {
      res.status(413).json({ error: "Account attachment storage quota exceeded", code: "QUOTA_EXCEEDED" });
      return;
    }

    const [saved] = await chatDb
      .insert(messagingAttachments)
      .values({
        uploaderAccountId: chatAuth.accountId,
        conversationId,
        ciphertextSha256: actualSha256,
        byteSize: req.body.length,
        blobBase64: req.body.toString("base64"),
      })
      .returning({
        id: messagingAttachments.id,
        byteSize: messagingAttachments.byteSize,
        ciphertextSha256: messagingAttachments.ciphertextSha256,
      });

    res.status(201).json({
      attachmentId: saved.id,
      byteSize: saved.byteSize,
      ciphertextSha256: saved.ciphertextSha256,
    });
  },
);

router.get("/:id", requireChatAuth, async (req: Request, res: Response) => {
  const { chatAuth } = req as AuthedChatRequest;
  const attachmentId = String(req.params["id"] ?? "");
  if (!uuidRe.test(attachmentId)) {
    res.status(400).json({ error: "Invalid attachment id" });
    return;
  }

  const [row] = await chatDb
    .select()
    .from(messagingAttachments)
    .where(eq(messagingAttachments.id, attachmentId))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  const [membership] = await chatDb
    .select({ accountId: messagingConversationMembers.accountId })
    .from(messagingConversationMembers)
    .where(
      and(
        eq(messagingConversationMembers.conversationId, row.conversationId),
        eq(messagingConversationMembers.accountId, chatAuth.accountId),
      ),
    )
    .limit(1);

  if (!membership) {
    res.status(403).json({ error: "Not authorized to download this attachment" });
    return;
  }

  const rawBytes = Buffer.from(row.blobBase64, "base64");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(rawBytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Ciphertext-Sha256", row.ciphertextSha256);
  res.send(rawBytes);
});

export default router;
