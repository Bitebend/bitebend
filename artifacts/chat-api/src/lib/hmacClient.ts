import crypto from "node:crypto";
import { sha256Hex } from "./crypto";
import { logger } from "./logger";

export interface HandoffVerificationResult {
  valid: boolean;
  code?: string;
  handoffId?: string;
  restaurantId?: number;
  customerName?: string;
  customerPhone?: string;
  issuedAt?: string;
}

function getHmacSecret(): string | null {
  const explicit = process.env["CHAT_INTERNAL_HMAC_SECRET"]?.trim();
  if (explicit) return explicit;
  if (process.env["NODE_ENV"] === "production") return null;
  return process.env["SESSION_SECRET"]?.trim() || "bitebend-dev-chat-handoff-hmac-secret";
}

function getApiServerUrl(): string {
  return (
    process.env["API_SERVER_INTERNAL_URL"]?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export async function verifyAndConsumeHandoffToken(
  rawToken: string,
): Promise<HandoffVerificationResult> {
  const secret = getHmacSecret();
  if (!secret) {
    logger.error("CHAT_INTERNAL_HMAC_SECRET missing in production");
    return { valid: false, code: "HMAC_NOT_CONFIGURED" };
  }

  const endpointPath = "/api/internal/messaging/handoff/verify-consume";
  const bodyCanonical = JSON.stringify({ rawToken });
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(24).toString("hex");
  const signingInput = `POST\n${endpointPath}\n${ts}\n${nonce}\n${sha256Hex(bodyCanonical)}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${getApiServerUrl()}${endpointPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bitebend-ts": ts,
        "x-bitebend-nonce": nonce,
        "x-bitebend-sig": sig,
      },
      body: bodyCanonical,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as HandoffVerificationResult;
    if (!res.ok || !data.valid) {
      return { valid: false, code: data.code ?? `HTTP_${res.status}` };
    }
    return data;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Failed to reach api-server for handoff verify-consume");
    return { valid: false, code: "HANDOFF_VERIFIER_UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}
