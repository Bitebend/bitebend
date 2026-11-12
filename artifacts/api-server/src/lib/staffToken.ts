import crypto from "node:crypto";
import { getSessionSecret } from "./token";

export interface StaffTokenPayload {
  staffId: number;
  restaurantId: number;
  role: "waiter" | "chef";
  tokenVersion: number;
  tokenType: "staff";
  ts?: number;
}

/**
 * Computes an HMAC-SHA256 hex digest of the 6-digit connection PIN.
 * Storing only the digest ensures the plaintext PIN is never saved in the database
 * while allowing instant, indexing-friendly exact equality lookups across all restaurants.
 */
export function hashPinDigest(pin: string): string {
  const secret = getSessionSecret();
  return crypto.createHmac("sha256", secret).update(pin.trim()).digest("hex");
}

/**
 * Issues a cryptographically signed staff session token.
 * Payload includes staffId, restaurantId, role, tokenVersion, and tokenType: 'staff'.
 * Crucially, it does NOT include a userId, guaranteeing role isolation from owner routes.
 */
export function generateStaffToken(payload: {
  staffId: number;
  restaurantId: number;
  role: "waiter" | "chef";
  tokenVersion: number;
}): string {
  const secret = getSessionSecret();
  const dataObj: StaffTokenPayload = {
    ...payload,
    tokenType: "staff",
    ts: Date.now(),
  };
  const data = Buffer.from(JSON.stringify(dataObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Verifies a signed staff token.
 * Validates HMAC signature, tokenType === 'staff', and expiration (30 days).
 */
export function verifyStaffToken(token: string): StaffTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("base64url");

  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as StaffTokenPayload;
    if (payload.tokenType !== "staff") return null;
    // 30-day token lifetime
    if (payload.ts && Date.now() - payload.ts > 30 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
