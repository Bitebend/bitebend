import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { chatDb, chatInternalRequestNonces } from "../db";
import { sha256Hex } from "../lib/crypto";
import { getChatInternalHmacSecret } from "../lib/securityConfig";

const MAX_CLOCK_SKEW_MS = 60 * 1000; // +-60s
const NONCE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

export interface RawBodyRequest extends Request {
  rawBody?: string;
}

export async function requireInternalS2SHmac(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = getChatInternalHmacSecret();
  if (!secret) {
    res.status(503).json({
      error: "Internal HMAC secret is not configured",
      code: "HMAC_NOT_CONFIGURED",
    });
    return;
  }

  const tsHeader = String(req.headers["x-bitebend-ts"] ?? "");
  const nonceHeader = String(req.headers["x-bitebend-nonce"] ?? "");
  const sigHeader = String(req.headers["x-bitebend-sig"] ?? "");

  const tsMs = Number(tsHeader);
  if (!tsHeader || !Number.isFinite(tsMs) || !nonceHeader || nonceHeader.length < 16 || !sigHeader) {
    res.status(401).json({ error: "Missing S2S authentication headers", code: "UNAUTHORIZED" });
    return;
  }

  if (Math.abs(Date.now() - tsMs) > MAX_CLOCK_SKEW_MS) {
    res.status(401).json({ error: "Request timestamp outside allowed clock skew", code: "STALE_TIMESTAMP" });
    return;
  }

  const method = req.method.toUpperCase();
  const fullPath = `${req.baseUrl}${req.path}`;
  let bodyCanonical = "";
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    const rawBody = (req as RawBodyRequest).rawBody;
    if (typeof rawBody === "string") {
      bodyCanonical = rawBody;
    } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      bodyCanonical = JSON.stringify(req.body);
    }
  }

  const signingInput = `${method}\n${fullPath}\n${tsHeader}\n${nonceHeader}\n${sha256Hex(bodyCanonical)}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("hex");

  const sigBuf = Buffer.from(sigHeader, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    res.status(401).json({ error: "Invalid HMAC signature", code: "INVALID_SIGNATURE" });
    return;
  }

  // Atomic replay check backed by chat_internal_request_nonces
  const nonceHash = sha256Hex(nonceHeader);
  const nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);
  const inserted = await chatDb
    .insert(chatInternalRequestNonces)
    .values({ nonceHash, expiresAt: nonceExpiresAt })
    .onConflictDoNothing({ target: chatInternalRequestNonces.nonceHash })
    .returning({ nonceHash: chatInternalRequestNonces.nonceHash });

  if (inserted.length === 0) {
    res.status(409).json({ error: "Replay nonce rejected", code: "REPLAY_DETECTED" });
    return;
  }

  next();
}
