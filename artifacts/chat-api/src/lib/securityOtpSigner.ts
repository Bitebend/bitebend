import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { chatDb, messagingAccounts, messagingDevices } from "../db";
import {
  getSecuritySigningMaterial,
  parseConfiguredPublicKeysMap,
  SYSTEM_SECURITY_ACCOUNT_ID,
  SYSTEM_SECURITY_DEVICE_ID,
  SYSTEM_SECURITY_DISPLAY_NAME,
  SYSTEM_SECURITY_EVENT_TYPE,
  SYSTEM_SECURITY_MATRIX_DEVICE_ID,
  SYSTEM_SECURITY_PURPOSE,
  SYSTEM_SECURITY_USERNAME,
} from "./securityConfig";

export interface CanonicalOtpFields {
  keyId: string;
  challengeId: string;
  recipientAccountId: string;
  conversationId: string;
  restaurantId: number;
  restaurantName: string;
  otp: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedSecurityOtpPayload extends CanonicalOtpFields {
  version: 1;
  type: typeof SYSTEM_SECURITY_EVENT_TYPE;
  purpose: typeof SYSTEM_SECURITY_PURPOSE;
  signature: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Exact 13-element JSON array canonical serialization.
 * Element ordering MUST match client-side verification identically.
 */
export function buildCanonicalOtpSigningString(fields: CanonicalOtpFields): string {
  return JSON.stringify([
    "bb-security-otp-v1",
    1,
    SYSTEM_SECURITY_EVENT_TYPE,
    SYSTEM_SECURITY_PURPOSE,
    fields.keyId,
    fields.challengeId.toLowerCase(),
    fields.recipientAccountId.toLowerCase(),
    fields.conversationId.toLowerCase(),
    fields.restaurantId,
    fields.restaurantName,
    fields.otp,
    fields.issuedAt,
    fields.expiresAt,
  ]);
}

export function signSecurityOtpPayload(
  fields: Omit<CanonicalOtpFields, "keyId">,
): { payload: SignedSecurityOtpPayload; keyId: string } {
  const mat = getSecuritySigningMaterial();
  const normalizedFields: CanonicalOtpFields = {
    keyId: mat.keyId,
    challengeId: fields.challengeId.toLowerCase(),
    recipientAccountId: fields.recipientAccountId.toLowerCase(),
    conversationId: fields.conversationId.toLowerCase(),
    restaurantId: fields.restaurantId,
    restaurantName: fields.restaurantName,
    otp: fields.otp,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
  };

  const canonical = buildCanonicalOtpSigningString(normalizedFields);
  const sigBytes = crypto.sign(null, Buffer.from(canonical, "utf8"), mat.privateKey);
  const signature = sigBytes.toString("base64url");

  return {
    keyId: mat.keyId,
    payload: {
      version: 1,
      type: SYSTEM_SECURITY_EVENT_TYPE,
      purpose: SYSTEM_SECURITY_PURPOSE,
      ...normalizedFields,
      signature,
    },
  };
}

export function verifySignedSecurityOtpPayload(
  payload: SignedSecurityOtpPayload,
  pinnedPublicKeyRaw?: Buffer,
): boolean {
  if (
    payload.version !== 1 ||
    payload.type !== SYSTEM_SECURITY_EVENT_TYPE ||
    payload.purpose !== SYSTEM_SECURITY_PURPOSE ||
    typeof payload.keyId !== "string" ||
    typeof payload.signature !== "string"
  ) {
    return false;
  }

  let keyRaw = pinnedPublicKeyRaw;
  if (!keyRaw) {
    const map = parseConfiguredPublicKeysMap();
    keyRaw = map[payload.keyId];
    if (!keyRaw) {
      const mat = getSecuritySigningMaterial();
      if (mat.keyId === payload.keyId) {
        keyRaw = mat.publicKeyRaw;
      }
    }
  }
  if (!keyRaw || keyRaw.length !== 32) return false;

  const normSig = payload.signature.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (normSig.length % 4)) % 4;
  const sigBuf = Buffer.from(normSig + "=".repeat(pad), "base64");
  if (sigBuf.length !== 64) return false;

  try {
    const canonical = buildCanonicalOtpSigningString(payload);
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, keyRaw]);
    const pubObj = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(canonical, "utf8"), pubObj, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Ensures the deterministic system security identity exists and has not collided
 * with any non-system user record. Fails closed on invariant violation.
 */
export async function ensureSystemSecurityIdentity(): Promise<void> {
  const [byId] = await chatDb
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, SYSTEM_SECURITY_ACCOUNT_ID))
    .limit(1);

  if (byId) {
    if (
      byId.usernameLower !== SYSTEM_SECURITY_USERNAME ||
      byId.accountType !== "system_security"
    ) {
      throw new Error(
        `FATAL: System security account UUID ${SYSTEM_SECURITY_ACCOUNT_ID} corrupted (username_lower=${byId.usernameLower}, account_type=${byId.accountType})`,
      );
    }
  }

  const [byUsername] = await chatDb
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.usernameLower, SYSTEM_SECURITY_USERNAME))
    .limit(1);

  if (byUsername) {
    if (
      byUsername.id.toLowerCase() !== SYSTEM_SECURITY_ACCOUNT_ID ||
      byUsername.accountType !== "system_security"
    ) {
      throw new Error(
        `FATAL: System security username ${SYSTEM_SECURITY_USERNAME} corrupted (id=${byUsername.id}, account_type=${byUsername.accountType})`,
      );
    }
  }

  if (!byId) {
    await chatDb
      .insert(messagingAccounts)
      .values({
        id: SYSTEM_SECURITY_ACCOUNT_ID,
        username: SYSTEM_SECURITY_USERNAME,
        usernameLower: SYSTEM_SECURITY_USERNAME,
        displayName: SYSTEM_SECURITY_DISPLAY_NAME,
        loginPhoneHmac: null,
        identityStatus: "active",
        accountType: "system_security",
      })
      .onConflictDoNothing();
  }

  const [devById] = await chatDb
    .select()
    .from(messagingDevices)
    .where(eq(messagingDevices.id, SYSTEM_SECURITY_DEVICE_ID))
    .limit(1);

  if (devById) {
    if (
      devById.accountId.toLowerCase() !== SYSTEM_SECURITY_ACCOUNT_ID ||
      devById.matrixDeviceId !== SYSTEM_SECURITY_MATRIX_DEVICE_ID
    ) {
      throw new Error(
        `FATAL: System security device UUID ${SYSTEM_SECURITY_DEVICE_ID} belongs to wrong account/device`,
      );
    }
  } else {
    await chatDb
      .insert(messagingDevices)
      .values({
        id: SYSTEM_SECURITY_DEVICE_ID,
        accountId: SYSTEM_SECURITY_ACCOUNT_ID,
        deviceLabel: "Bitebend Security Signer",
        matrixDeviceId: SYSTEM_SECURITY_MATRIX_DEVICE_ID,
        identityKeyEd25519: "system_security_ed25519_signer",
        identityKeyCurve25519: "system_security_no_e2ee",
        deviceKeysJson: { system: true, purpose: SYSTEM_SECURITY_PURPOSE },
        status: "active",
      })
      .onConflictDoNothing();
  }
}
