import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const PROFILE_PIN_UNLOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const BCRYPT_PIN_COST = 12;

const PIN_RE = /^\d{4}$/;
const OTP_RE = /^\d{6}$/;

const DEV_PIN_PEPPER = "bitebend-dev-profile-pin-pepper-v1";
const DEV_OTP_PEPPER = "bitebend-dev-profile-otp-pepper-v1";
const DEV_PHONE_PEPPER = "bitebend-dev-chat-phone-pepper";
const DEV_TOKEN_SECRET = "bitebend-dev-profile-pin-token-secret";

function isExternalProduction(): boolean {
  const isAiStudio = Boolean(
    process.env["APPLET_ID"] || process.env["DEFAULT_APP_PORT"],
  );
  return process.env["NODE_ENV"] === "production" && !isAiStudio;
}

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_RE.test(pin);
}

export function isValidOtpFormat(otp: unknown): otp is string {
  return typeof otp === "string" && OTP_RE.test(otp);
}

export function normalizePhone(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "••••";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  return `••••••${digits.slice(-4)}`;
}

interface VersionedPepperConfig {
  currentVersion: number;
  peppers: Record<number, string>;
}

function loadVersionedPeppers(
  envVar: string,
  versionVar: string,
  prevVar: string,
  devFallback: string,
): VersionedPepperConfig {
  const isProd = isExternalProduction();
  const currentSecret = process.env[envVar]?.trim();
  if (!currentSecret && isProd) {
    throw new Error(`FATAL: ${envVar} is required in production`);
  }

  const parsedVersion = Number(process.env[versionVar] ?? "1");
  const currentVersion =
    Number.isInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;

  const peppers: Record<number, string> = {};
  const prevRaw = process.env[prevVar]?.trim();
  if (prevRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(prevRaw);
    } catch {
      throw new Error(`${prevVar} must be valid JSON mapping version -> secret`);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const vNum = Number(k);
        if (Number.isInteger(vNum) && vNum > 0 && typeof v === "string" && v.trim()) {
          peppers[vNum] = v.trim();
        }
      }
    }
  }

  peppers[currentVersion] = currentSecret || devFallback;
  return { currentVersion, peppers };
}

export function getPinPepperConfig(): VersionedPepperConfig {
  return loadVersionedPeppers(
    "PROFILE_PIN_PEPPER",
    "PROFILE_PIN_PEPPER_VERSION",
    "PROFILE_PIN_PREVIOUS_PEPPERS_JSON",
    DEV_PIN_PEPPER,
  );
}

export function getOtpPepperConfig(): VersionedPepperConfig {
  return loadVersionedPeppers(
    "PROFILE_PIN_OTP_PEPPER",
    "PROFILE_PIN_OTP_PEPPER_VERSION",
    "PROFILE_PIN_OTP_PREVIOUS_PEPPERS_JSON",
    DEV_OTP_PEPPER,
  );
}

export function getChatPhonePepper(): string {
  const configured = process.env["CHAT_PHONE_PEPPER"]?.trim();
  if (configured) return configured;
  if (isExternalProduction()) {
    throw new Error("FATAL: CHAT_PHONE_PEPPER is required in production");
  }
  return DEV_PHONE_PEPPER;
}

export function hmacChatPhoneDigest(normalizedPhone: string): string {
  return crypto
    .createHmac("sha256", getChatPhonePepper())
    .update(normalizedPhone, "utf8")
    .digest("hex");
}

/**
 * Computes domain-separated keyed HMAC-SHA256 digest of a 4-digit PIN
 * bound to (ownerUserId, restaurantId) before bcrypt cost 12.
 * Never passes raw PIN to bcrypt.
 */
export function computeKeyedPinPreimage(params: {
  ownerUserId: number;
  restaurantId: number;
  pin: string;
  pepper: string;
}): string {
  const domainInput = `BB-PROFILE-PIN-V1|owner:${params.ownerUserId}|restaurant:${params.restaurantId}|pin:${params.pin}`;
  return crypto
    .createHmac("sha256", params.pepper)
    .update(domainInput, "utf8")
    .digest("base64url");
}

export async function hashProfilePin(params: {
  ownerUserId: number;
  restaurantId: number;
  pin: string;
}): Promise<{ pinHash: string; pepperVersion: number }> {
  const cfg = getPinPepperConfig();
  const currentPepper = cfg.peppers[cfg.currentVersion]!;
  const preimage = computeKeyedPinPreimage({
    ownerUserId: params.ownerUserId,
    restaurantId: params.restaurantId,
    pin: params.pin,
    pepper: currentPepper,
  });
  const pinHash = await bcrypt.hash(preimage, BCRYPT_PIN_COST);
  return { pinHash, pepperVersion: cfg.currentVersion };
}

export async function verifyProfilePin(params: {
  ownerUserId: number;
  restaurantId: number;
  pin: string;
  storedHash: string;
  storedPepperVersion: number;
}): Promise<{ valid: boolean; needsRehash: boolean }> {
  const cfg = getPinPepperConfig();
  const pepper = cfg.peppers[params.storedPepperVersion];
  if (!pepper) {
    // Unknown pepper version — run dummy compare to normalize timing
    const dummy = computeKeyedPinPreimage({
      ownerUserId: params.ownerUserId,
      restaurantId: params.restaurantId,
      pin: params.pin,
      pepper: cfg.peppers[cfg.currentVersion]!,
    });
    await bcrypt.compare(dummy, params.storedHash).catch(() => false);
    return { valid: false, needsRehash: false };
  }

  const preimage = computeKeyedPinPreimage({
    ownerUserId: params.ownerUserId,
    restaurantId: params.restaurantId,
    pin: params.pin,
    pepper,
  });
  const valid = await bcrypt.compare(preimage, params.storedHash);
  return {
    valid,
    needsRehash: valid && params.storedPepperVersion !== cfg.currentVersion,
  };
}

export function generateNumericOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function computeOtpHmac(params: {
  challengeId: string;
  ownerUserId: number;
  restaurantId: number;
  otp: string;
  pepperVersion?: number;
}): { otpHmac: string; otpPepperVersion: number } {
  const cfg = getOtpPepperConfig();
  const version = params.pepperVersion ?? cfg.currentVersion;
  const pepper = cfg.peppers[version];
  if (!pepper) {
    throw new Error(`Unknown OTP pepper version: ${version}`);
  }
  const input = `BB-PROFILE-OTP-V1|challenge:${params.challengeId.toLowerCase()}|owner:${params.ownerUserId}|restaurant:${params.restaurantId}|otp:${params.otp}`;
  const otpHmac = crypto.createHmac("sha256", pepper).update(input, "utf8").digest("hex");
  return { otpHmac, otpPepperVersion: version };
}

export function verifyOtpHmac(params: {
  challengeId: string;
  ownerUserId: number;
  restaurantId: number;
  otp: string;
  storedOtpHmac: string;
  storedOtpPepperVersion: number;
}): boolean {
  const cfg = getOtpPepperConfig();
  const pepper = cfg.peppers[params.storedOtpPepperVersion];
  if (!pepper) return false;
  const { otpHmac } = computeOtpHmac({
    challengeId: params.challengeId,
    ownerUserId: params.ownerUserId,
    restaurantId: params.restaurantId,
    otp: params.otp,
    pepperVersion: params.storedOtpPepperVersion,
  });
  const a = Buffer.from(otpHmac, "utf8");
  const b = Buffer.from(params.storedOtpHmac, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getProfilePinTokenSigningKey(): Buffer {
  const isProd = isExternalProduction();
  const baseSecret =
    process.env["PROFILE_PIN_TOKEN_SECRET"]?.trim() ||
    process.env["SESSION_SECRET"]?.trim();

  if (!baseSecret && isProd) {
    throw new Error("FATAL: PROFILE_PIN_TOKEN_SECRET or SESSION_SECRET is required in production");
  }
  const root = baseSecret || DEV_TOKEN_SECRET;
  return crypto.createHmac("sha256", root).update("BB-PROFILE-PIN-TOKEN-KEY-V1", "utf8").digest();
}

export interface ProfilePinUnlockClaims {
  typ: "profile_pin_unlock";
  uid: number;
  rid: number;
  pv: number;
  iat: number;
  exp: number;
}

export function signProfilePinUnlockToken(params: {
  ownerUserId: number;
  restaurantId: number;
  pinVersion: number;
  ttlMs?: number;
  nowMs?: number;
}): { token: string; expiresAt: number } {
  const now = params.nowMs ?? Date.now();
  const expiresAt = now + (params.ttlMs ?? PROFILE_PIN_UNLOCK_TTL_MS);
  const claims: ProfilePinUnlockClaims = {
    typ: "profile_pin_unlock",
    uid: params.ownerUserId,
    rid: params.restaurantId,
    pv: params.pinVersion,
    iat: now,
    exp: expiresAt,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", getProfilePinTokenSigningKey())
    .update(payloadB64, "utf8")
    .digest("base64url");
  return { token: `${payloadB64}.${sig}`, expiresAt };
}

export function verifyProfilePinUnlockToken(token: string): ProfilePinUnlockClaims | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadB64, sigB64] = parts;

  const expectedSig = crypto
    .createHmac("sha256", getProfilePinTokenSigningKey())
    .update(payloadB64, "utf8")
    .digest("base64url");

  const a = Buffer.from(sigB64, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      decoded["typ"] !== "profile_pin_unlock" ||
      !Number.isInteger(decoded["uid"]) ||
      !Number.isInteger(decoded["rid"]) ||
      !Number.isInteger(decoded["pv"]) ||
      typeof decoded["exp"] !== "number"
    ) {
      return null;
    }
    return decoded as unknown as ProfilePinUnlockClaims;
  } catch {
    return null;
  }
}

export function validateMainApiSecurityStartupConfig(): void {
  if (isExternalProduction()) {
    getPinPepperConfig();
    getOtpPepperConfig();
    getChatPhonePepper();
    getProfilePinTokenSigningKey();
    if (!process.env["CHAT_INTERNAL_HMAC_SECRET"]?.trim()) {
      throw new Error("FATAL: CHAT_INTERNAL_HMAC_SECRET is required in production");
    }
  }
}
