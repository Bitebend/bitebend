import crypto from "node:crypto";

export function getSessionSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!envSecret) {
      throw new Error(
        "[CONFIG_ERROR] Missing required environment variable in production: SESSION_SECRET must be configured with a secure, non-empty secret.",
      );
    }
    return envSecret;
  }
  return envSecret || "bitebend-secure-session-secret-key-2026";
}

const SECRET = getSessionSecret();

export interface TokenPayload {
  userId: number;
  role?: string;
  email?: string;
  ts?: number;
}

export function generateToken(payload: { userId: number; role?: string; email?: string }): string {
  const dataObj: TokenPayload = { ...payload, ts: Date.now() };
  const data = Buffer.from(JSON.stringify(dataObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as TokenPayload;
    // Token valid for 30 days
    if (payload.ts && Date.now() - payload.ts > 30 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
