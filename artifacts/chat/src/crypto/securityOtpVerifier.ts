import * as ed25519 from "@noble/ed25519";
import type { ServerMessageItem } from "../lib/api";

export const SYSTEM_SECURITY_EVENT_TYPE = "bb.system.security_otp";
export const SYSTEM_SECURITY_PURPOSE = "profile_pin_reset";

export interface VerifiedSecurityOtpPayload {
  version: 1;
  type: typeof SYSTEM_SECURITY_EVENT_TYPE;
  purpose: typeof SYSTEM_SECURITY_PURPOSE;
  keyId: string;
  challengeId: string;
  recipientAccountId: string;
  conversationId: string;
  restaurantId: number;
  restaurantName: string;
  otp: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export type SecurityOtpVerificationResult =
  | { valid: true; payload: VerifiedSecurityOtpPayload }
  | { valid: false; reason: string };

export type OtpDisplayState = "active" | "expired" | "superseded" | "invalid";

function decodePublicKey32(raw: string): Uint8Array | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 64-char hex
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // base64 or base64url
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const bin = atob(normalized + "=".repeat(padLen));
    if (bin.length !== 32) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function decodeSignature64(sig: string): Uint8Array | null {
  if (typeof sig !== "string" || !sig.trim()) return null;
  const normalized = sig.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const bin = atob(normalized + "=".repeat(padLen));
    if (bin.length !== 64) return null;
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function getPinnedSecurityPublicKeys(options?: {
  rawJsonEnv?: string;
  isProd?: boolean;
  isDev?: boolean;
  mode?: string;
}): Record<string, Uint8Array> {
  const isProd = options?.isProd ?? Boolean(import.meta.env.PROD);
  const isDev = options?.isDev ?? Boolean(import.meta.env.DEV);
  const mode = options?.mode ?? import.meta.env.MODE;
  const rawJson =
    options?.rawJsonEnv !== undefined
      ? options.rawJsonEnv
      : (import.meta.env.VITE_CHAT_SECURITY_PUBLIC_KEYS ?? "");

  const keys: Record<string, Uint8Array> = {};
  if (typeof rawJson === "string" && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [keyId, val] of Object.entries(parsed)) {
          if (typeof val === "string") {
            const decoded = decodePublicKey32(val);
            if (decoded) {
              keys[keyId] = decoded;
            }
          }
        }
      }
    } catch {
      // Fail closed on malformed JSON: leave keys empty unless non-prod fallback applies
    }
  }

  // Strictly forbid dev fallback public keys in production builds and tree-shake them at build time
  if (!import.meta.env.PROD && Object.keys(keys).length === 0 && !isProd && (isDev || mode === "test")) {
    const devOnlyPublicKeys: Record<string, string> = {
      "bb-sec-dev-v1": "Sj8mKO3aME8Sxgu6uOdjgRC294OARY4z1LBHBj3fpoE",
    };
    for (const [keyId, val] of Object.entries(devOnlyPublicKeys)) {
      const decoded = decodePublicKey32(val);
      if (decoded) {
        keys[keyId] = decoded;
      }
    }
  }

  return keys;
}

export function buildCanonicalSecurityOtpMessage(payload: {
  keyId: string;
  challengeId: string;
  recipientAccountId: string;
  conversationId: string;
  restaurantId: number;
  restaurantName: string;
  otp: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return JSON.stringify([
    "bb-security-otp-v1",
    1,
    SYSTEM_SECURITY_EVENT_TYPE,
    SYSTEM_SECURITY_PURPOSE,
    payload.keyId,
    payload.challengeId.toLowerCase(),
    payload.recipientAccountId.toLowerCase(),
    payload.conversationId.toLowerCase(),
    payload.restaurantId,
    payload.restaurantName,
    payload.otp,
    payload.issuedAt,
    payload.expiresAt,
  ]);
}

export async function verifySecurityOtpMessage(params: {
  serverMessage: Pick<
    ServerMessageItem,
    "conversationId" | "clientMsgId" | "eventType" | "payloadJson"
  >;
  accountId: string;
  pinnedKeysOverride?: Record<string, Uint8Array>;
}): Promise<SecurityOtpVerificationResult> {
  const { serverMessage, accountId } = params;

  if (serverMessage.eventType !== SYSTEM_SECURITY_EVENT_TYPE) {
    return { valid: false, reason: "Unexpected security event type" };
  }

  const p = serverMessage.payloadJson;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    return { valid: false, reason: "Malformed security message payload" };
  }

  if (
    p["version"] !== 1 ||
    p["type"] !== SYSTEM_SECURITY_EVENT_TYPE ||
    p["purpose"] !== SYSTEM_SECURITY_PURPOSE
  ) {
    return { valid: false, reason: "Unsupported security OTP envelope version or purpose" };
  }

  const keyId = p["keyId"];
  const challengeId = p["challengeId"];
  const recipientAccountId = p["recipientAccountId"];
  const conversationId = p["conversationId"];
  const restaurantId = p["restaurantId"];
  const restaurantName = p["restaurantName"];
  const otp = p["otp"];
  const issuedAt = p["issuedAt"];
  const expiresAt = p["expiresAt"];
  const signature = p["signature"];

  if (
    typeof keyId !== "string" ||
    !keyId ||
    typeof challengeId !== "string" ||
    typeof recipientAccountId !== "string" ||
    typeof conversationId !== "string" ||
    typeof restaurantId !== "number" ||
    !Number.isInteger(restaurantId) ||
    restaurantId <= 0 ||
    typeof restaurantName !== "string" ||
    typeof otp !== "string" ||
    !/^\d{6}$/.test(otp) ||
    typeof issuedAt !== "string" ||
    typeof expiresAt !== "string" ||
    Number.isNaN(Date.parse(issuedAt)) ||
    Number.isNaN(Date.parse(expiresAt)) ||
    typeof signature !== "string"
  ) {
    return { valid: false, reason: "Missing or invalid security OTP fields" };
  }

  // Bind signed context strictly to the server message envelope and logged-in account
  if (challengeId.toLowerCase() !== serverMessage.clientMsgId.toLowerCase()) {
    return { valid: false, reason: "Challenge binding mismatch" };
  }
  if (recipientAccountId.toLowerCase() !== accountId.toLowerCase()) {
    return { valid: false, reason: "Recipient account mismatch" };
  }
  if (conversationId.toLowerCase() !== serverMessage.conversationId.toLowerCase()) {
    return { valid: false, reason: "Conversation binding mismatch" };
  }

  const pinnedKeys = params.pinnedKeysOverride ?? getPinnedSecurityPublicKeys();
  const publicKeyBytes = pinnedKeys[keyId];
  if (!publicKeyBytes || publicKeyBytes.length !== 32) {
    return { valid: false, reason: "Unrecognized Bitebend security signing key" };
  }

  const sigBytes = decodeSignature64(signature);
  if (!sigBytes) {
    return { valid: false, reason: "Malformed Ed25519 signature" };
  }

  const canonical = buildCanonicalSecurityOtpMessage({
    keyId,
    challengeId,
    recipientAccountId,
    conversationId,
    restaurantId,
    restaurantName,
    otp,
    issuedAt,
    expiresAt,
  });

  try {
    const messageBytes = new TextEncoder().encode(canonical);
    const verified = await ed25519.verifyAsync(sigBytes, messageBytes, publicKeyBytes);
    if (!verified) {
      return { valid: false, reason: "Invalid Ed25519 signature" };
    }
  } catch {
    return { valid: false, reason: "Signature verification error" };
  }

  return {
    valid: true,
    payload: {
      version: 1,
      type: SYSTEM_SECURITY_EVENT_TYPE,
      purpose: SYSTEM_SECURITY_PURPOSE,
      keyId,
      challengeId: challengeId.toLowerCase(),
      recipientAccountId: recipientAccountId.toLowerCase(),
      conversationId: conversationId.toLowerCase(),
      restaurantId,
      restaurantName,
      otp,
      issuedAt,
      expiresAt,
      signature,
    },
  };
}

export function getOtpDisplayState(params: {
  valid: boolean;
  payload?: Pick<VerifiedSecurityOtpPayload, "expiresAt"> | null;
  highestValidSeq: number;
  serverSeq: number;
  nowMs?: number;
}): OtpDisplayState {
  if (!params.valid || !params.payload) {
    return "invalid";
  }
  if (params.serverSeq < params.highestValidSeq) {
    return "superseded";
  }
  const now = params.nowMs ?? Date.now();
  const exp = Date.parse(params.payload.expiresAt);
  if (Number.isNaN(exp) || exp <= now) {
    return "expired";
  }
  return "active";
}
