import crypto from "node:crypto";
import { getPhonePepper } from "./crypto";

export const SYSTEM_SECURITY_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_SECURITY_USERNAME = "bitebend.security_otp";
export const SYSTEM_SECURITY_DISPLAY_NAME = "Bitebend Security";
export const SYSTEM_SECURITY_DEVICE_ID = "00000000-0000-4000-8000-000000000002";
export const SYSTEM_SECURITY_MATRIX_DEVICE_ID = "SYSTEM_SECURITY_V1";
export const SYSTEM_SECURITY_EVENT_TYPE = "bb.system.security_otp";
export const SYSTEM_SECURITY_PURPOSE = "profile_pin_reset";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Fixed non-production development seed ONLY (never accepted when NODE_ENV === "production")
const DEV_ONLY_SECURITY_ED25519_SEED_HEX =
  "5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const DEV_ONLY_KEY_ID = "bb-sec-dev-v1";

export interface SecuritySigningMaterial {
  keyId: string;
  privateKey: crypto.KeyObject;
  publicKeyRaw: Buffer;
  publicKeyBase64Url: string;
  isDevFallback: boolean;
}

function isExternalProduction(): boolean {
  const isAiStudio = Boolean(
    process.env["APPLET_ID"] || process.env["DEFAULT_APP_PORT"],
  );
  return process.env["NODE_ENV"] === "production" && !isAiStudio;
}

export function getChatInternalHmacSecret(): string | null {
  const explicit = process.env["CHAT_INTERNAL_HMAC_SECRET"]?.trim();
  if (explicit) return explicit;
  if (isExternalProduction()) {
    return null;
  }
  return process.env["SESSION_SECRET"]?.trim() || "bitebend-dev-chat-handoff-hmac-secret";
}

function parseRawKeyBytes(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]+$/.test(trimmed) && (trimmed.length === 64 || trimmed.length === 128)) {
    return Buffer.from(trimmed.slice(0, 64), "hex");
  }

  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    const padLen = (4 - (normalized.length % 4)) % 4;
    const buf = Buffer.from(normalized + "=".repeat(padLen), "base64");
    if (buf.length === 32 || buf.length === 64) {
      return buf.subarray(0, 32);
    }
    if (buf.length === 48 && buf.subarray(0, 16).equals(ED25519_PKCS8_PREFIX)) {
      return buf.subarray(16, 48);
    }
  }
  return null;
}

export function parsePublicKeyBytes(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      const pubObj = crypto.createPublicKey(trimmed);
      const spki = pubObj.export({ format: "der", type: "spki" });
      if (spki.length === 44 && spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
        return spki.subarray(12, 44);
      }
    } catch {
      return null;
    }
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    const padLen = (4 - (normalized.length % 4)) % 4;
    const buf = Buffer.from(normalized + "=".repeat(padLen), "base64");
    if (buf.length === 32) return buf;
    if (buf.length === 44 && buf.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
      return buf.subarray(12, 44);
    }
  }
  return null;
}

export function parseConfiguredPublicKeysMap(): Record<string, Buffer> {
  const raw = process.env["CHAT_SECURITY_PUBLIC_KEYS"]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CHAT_SECURITY_PUBLIC_KEYS must be valid JSON mapping keyId -> public key");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CHAT_SECURITY_PUBLIC_KEYS must be a JSON object");
  }
  const out: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`CHAT_SECURITY_PUBLIC_KEYS[${k}] must be a string`);
    }
    const bytes = parsePublicKeyBytes(v);
    if (!bytes) {
      throw new Error(`CHAT_SECURITY_PUBLIC_KEYS[${k}] is not a valid Ed25519 public key`);
    }
    out[k] = bytes;
  }
  return out;
}

export function getSecuritySigningMaterial(): SecuritySigningMaterial {
  const isProd = isExternalProduction();
  const envPriv = process.env["CHAT_SECURITY_SIGNING_PRIVATE_KEY"]?.trim();
  const envKeyId = process.env["CHAT_SECURITY_ACTIVE_KEY_ID"]?.trim();

  if (isProd) {
    if (!envPriv) {
      throw new Error("FATAL: CHAT_SECURITY_SIGNING_PRIVATE_KEY is required in production");
    }
    if (!envKeyId) {
      throw new Error("FATAL: CHAT_SECURITY_ACTIVE_KEY_ID is required in production");
    }
  }

  let privateKey: crypto.KeyObject;
  const keyId = envKeyId || DEV_ONLY_KEY_ID;
  const isDevFallback = !envPriv;

  if (envPriv) {
    if (envPriv.includes("BEGIN PRIVATE KEY")) {
      privateKey = crypto.createPrivateKey(envPriv.replace(/\\n/g, "\n"));
    } else {
      const seed32 = parseRawKeyBytes(envPriv);
      if (!seed32) {
        throw new Error("CHAT_SECURITY_SIGNING_PRIVATE_KEY is malformed (expected Ed25519 PEM or 32-byte seed in base64/hex)");
      }
      const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed32]);
      privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    }
  } else {
    const seed32 = Buffer.from(DEV_ONLY_SECURITY_ED25519_SEED_HEX, "hex");
    const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed32]);
    privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  }

  const pubObj = crypto.createPublicKey(privateKey);
  const spki = pubObj.export({ format: "der", type: "spki" });
  if (spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("CHAT_SECURITY_SIGNING_PRIVATE_KEY must be an Ed25519 private key");
  }
  const publicKeyRaw = Buffer.from(spki.subarray(12, 44));

  const configuredPubs = parseConfiguredPublicKeysMap();
  if (configuredPubs[keyId] && !configuredPubs[keyId].equals(publicKeyRaw)) {
    throw new Error(
      `FATAL: CHAT_SECURITY_PUBLIC_KEYS[${keyId}] does not match CHAT_SECURITY_SIGNING_PRIVATE_KEY`,
    );
  }

  return {
    keyId,
    privateKey,
    publicKeyRaw,
    publicKeyBase64Url: publicKeyRaw.toString("base64url"),
    isDevFallback,
  };
}

export function validateChatSecurityStartupConfig(): void {
  if (isExternalProduction()) {
    if (!getChatInternalHmacSecret()) {
      throw new Error("FATAL: CHAT_INTERNAL_HMAC_SECRET is required in production");
    }
    getPhonePepper();
    getSecuritySigningMaterial();
  } else {
    // Validate format if explicitly provided even in non-production
    if (process.env["CHAT_SECURITY_SIGNING_PRIVATE_KEY"]?.trim()) {
      getSecuritySigningMaterial();
    } else if (process.env["CHAT_SECURITY_PUBLIC_KEYS"]?.trim()) {
      parseConfiguredPublicKeysMap();
    }
  }
}
