import crypto from "node:crypto";

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,28}[a-zA-Z0-9]$/;
const MATRIX_DOMAIN = "chat.bitebend.in";

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function generateShortCode(): string {
  // Unambiguous uppercase alphanumeric 8-char verification/link code
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function getPhonePepper(): string {
  const configured = process.env["CHAT_PHONE_PEPPER"]?.trim();
  if (configured) return configured;
  const isAiStudio = Boolean(
    process.env["APPLET_ID"] || process.env["DEFAULT_APP_PORT"],
  );
  if (process.env["NODE_ENV"] === "production" && !isAiStudio) {
    throw new Error("CHAT_PHONE_PEPPER is required in production");
  }
  return "bitebend-dev-chat-phone-pepper";
}

export function hmacPhoneDigest(normalizedPhone: string): string {
  return crypto
    .createHmac("sha256", getPhonePepper())
    .update(normalizedPhone, "utf8")
    .digest("hex");
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  const tail = digits.slice(-4);
  return `••••••${tail}`;
}

export function maskDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Guest";
  const parts = trimmed.split(/\s+/);
  return parts
    .map((p) => (p.length <= 1 ? p : `${p[0]}${"•".repeat(Math.min(p.length - 1, 3))}`))
    .join(" ");
}

export function validateUsername(raw: string): { ok: true; username: string; lower: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/^@/, "");
  if (trimmed.length < 3 || trimmed.length > 30) {
    return { ok: false, error: "Username must be between 3 and 30 characters." };
  }
  if (!USERNAME_RE.test(trimmed)) {
    return {
      ok: false,
      error: "Username may only contain letters, numbers, dots, underscores, or hyphens, starting and ending with a letter or number.",
    };
  }
  if (trimmed.includes("..")) {
    return { ok: false, error: "Username cannot contain consecutive dots." };
  }
  return { ok: true, username: trimmed, lower: trimmed.toLowerCase() };
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function toMatrixUserId(accountId: string): string {
  return `@${accountId.toLowerCase()}:${MATRIX_DOMAIN}`;
}

export function fromMatrixUserId(matrixUserId: string): string | null {
  const m = /^@([0-9a-f-]{36}):chat\.bitebend\.in$/i.exec(matrixUserId.trim());
  return m ? m[1].toLowerCase() : null;
}

export function toMatrixRoomId(conversationId: string): string {
  return `!${conversationId.toLowerCase()}:${MATRIX_DOMAIN}`;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function buildDeviceEndorsementPayload(params: {
  accountId: string;
  matrixDeviceId: string;
  ed25519: string;
}): string {
  return JSON.stringify({
    accountId: params.accountId.toLowerCase(),
    matrixDeviceId: params.matrixDeviceId,
    ed25519: params.ed25519,
  });
}

export function decodeBase64Fixed(input: string, expectedBytes: number): Buffer | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const trimmed = input.trim();
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  const padLen = (4 - (normalized.length % 4)) % 4;
  const buf = Buffer.from(normalized + "=".repeat(padLen), "base64");
  return buf.length === expectedBytes ? buf : null;
}

export function extractMatrixEd25519Signature(
  sigEnvelopeJson: string,
  signerMatrixUserId: string,
  signerMatrixDeviceId: string,
): Buffer | null {
  try {
    const parsed = JSON.parse(sigEnvelopeJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const userEntry =
      parsed[signerMatrixUserId] ??
      Object.entries(parsed).find(([k]) => k.toLowerCase() === signerMatrixUserId.toLowerCase())?.[1];
    if (!userEntry || typeof userEntry !== "object") return null;
    const sigB64 = (userEntry as Record<string, unknown>)[`ed25519:${signerMatrixDeviceId}`];
    if (typeof sigB64 !== "string") return null;
    return decodeBase64Fixed(sigB64, 64);
  } catch {
    return null;
  }
}

export function verifyEd25519Signature(params: {
  payload: string;
  signatureBytes: Buffer;
  signerEd25519Base64: string;
}): boolean {
  const pubRaw = decodeBase64Fixed(params.signerEd25519Base64, 32);
  if (!pubRaw || params.signatureBytes.length !== 64) return false;
  try {
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(params.payload, "utf8"), keyObj, params.signatureBytes);
  } catch {
    return false;
  }
}

export function verifyDeviceEndorsementEnvelope(params: {
  accountId: string;
  targetMatrixDeviceId: string;
  targetEd25519: string;
  signerMatrixDeviceId: string;
  signerEd25519: string;
  endorsementSigJson: string;
}): boolean {
  const sigBytes = extractMatrixEd25519Signature(
    params.endorsementSigJson,
    toMatrixUserId(params.accountId),
    params.signerMatrixDeviceId,
  );
  if (!sigBytes) return false;
  const payload = buildDeviceEndorsementPayload({
    accountId: params.accountId,
    matrixDeviceId: params.targetMatrixDeviceId,
    ed25519: params.targetEd25519,
  });
  return verifyEd25519Signature({
    payload,
    signatureBytes: sigBytes,
    signerEd25519Base64: params.signerEd25519,
  });
}

export function sanitizeDisplayNameToSlug(displayName: string): string {
  const normalized = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "");

  if (normalized.length < 2) {
    return "user";
  }
  const clipped = normalized.slice(0, 18).replace(/[._-]+$/g, "");
  return clipped.length >= 2 ? clipped : "user";
}

/**
 * Derives a non-reversible 4-digit privacy-safe suffix from HMAC(phone) so
 * publicly searchable @usernames never expose any digits of a user's mobile number.
 */
export function buildPrivacySafePhoneTag(normalizedPhone: string): string {
  const digest = hmacPhoneDigest(normalizedPhone);
  const num = (parseInt(digest.slice(0, 8), 16) % 9000) + 1000;
  return String(num);
}

export function buildAutoUsernameBase(displayName: string, normalizedPhone: string): string {
  const slug = sanitizeDisplayNameToSlug(displayName);
  const tag = buildPrivacySafePhoneTag(normalizedPhone);
  const base = `${slug}.${tag}`;
  const checked = validateUsername(base);
  return checked.ok ? checked.lower : `user.${tag}`;
}

export function buildAutoUsernameCandidates(displayName: string, normalizedPhone: string, count = 12): string[] {
  const base = buildAutoUsernameBase(displayName, normalizedPhone);
  const candidates: string[] = [base];
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";

  // Deterministic short numeric/alnum extensions + random collision suffixes within 30-char max
  for (let i = 1; i < count; i++) {
    const suffixLen = i <= 4 ? 2 : 4;
    const bytes = crypto.randomBytes(suffixLen);
    let rand = "";
    for (let j = 0; j < suffixLen; j++) {
      rand += alphabet[bytes[j]! % alphabet.length];
    }
    const maxBaseLen = 30 - 1 - rand.length;
    const trimmedBase = base.slice(0, maxBaseLen).replace(/[._-]+$/g, "") || "user";
    const cand = `${trimmedBase}.${rand}`;
    const v = validateUsername(cand);
    if (v.ok && !candidates.includes(v.lower)) {
      candidates.push(v.lower);
    }
  }
  return candidates;
}

export function buildLoginChallengePayload(params: {
  challengeId: string;
  accountId: string;
  matrixDeviceId: string;
  nonce: string;
}): string {
  return JSON.stringify({
    type: "bitebend_device_login_v1",
    challengeId: params.challengeId,
    accountId: params.accountId.toLowerCase(),
    matrixDeviceId: params.matrixDeviceId,
    nonce: params.nonce,
  });
}

