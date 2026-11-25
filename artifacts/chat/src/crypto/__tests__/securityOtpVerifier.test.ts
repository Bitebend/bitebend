import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  buildCanonicalSecurityOtpMessage,
  getOtpDisplayState,
  getPinnedSecurityPublicKeys,
  SYSTEM_SECURITY_EVENT_TYPE,
  SYSTEM_SECURITY_PURPOSE,
  verifySecurityOtpMessage,
} from "../securityOtpVerifier";
import { ChatCryptoSession } from "../e2eeClient";

const DEV_SEED_HEX = "5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function deriveDevKeyPair() {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(DEV_SEED_HEX, "hex")]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ format: "der", type: "spki" });
  const rawPub = spki.subarray(spki.length - 32);
  return {
    privateKey: priv,
    publicKeyBase64Url: rawPub.toString("base64url"),
    publicKeyBytes: new Uint8Array(rawPub),
  };
}

function makeSignedMessage(overrides: Partial<{
  keyId: string;
  challengeId: string;
  clientMsgId: string;
  recipientAccountId: string;
  accountId: string;
  conversationId: string;
  envelopeConversationId: string;
  restaurantId: number;
  restaurantName: string;
  otp: string;
  issuedAt: string;
  expiresAt: string;
  eventType: string;
  privateKey: crypto.KeyObject;
}> = {}) {
  const { privateKey: devPriv } = deriveDevKeyPair();
  const challengeId = overrides.challengeId ?? "11111111-1111-4111-8111-111111111111";
  const recipientAccountId = overrides.recipientAccountId ?? "22222222-2222-4222-8222-222222222222";
  const conversationId = overrides.conversationId ?? "33333333-3333-4333-8333-333333333333";
  const keyId = overrides.keyId ?? "bb-sec-dev-v1";
  const restaurantId = overrides.restaurantId ?? 42;
  const restaurantName = overrides.restaurantName ?? "Spice Garden";
  const otp = overrides.otp ?? "482910";
  const issuedAt = overrides.issuedAt ?? new Date(Date.now() - 5_000).toISOString();
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 9 * 60_000).toISOString();

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

  const sig = crypto
    .sign(null, Buffer.from(canonical, "utf8"), overrides.privateKey ?? devPriv)
    .toString("base64url");

  return {
    accountId: overrides.accountId ?? recipientAccountId,
    serverMessage: {
      conversationId: overrides.envelopeConversationId ?? conversationId,
      clientMsgId: overrides.clientMsgId ?? challengeId,
      eventType: overrides.eventType ?? SYSTEM_SECURITY_EVENT_TYPE,
      payloadJson: {
        version: 1,
        type: SYSTEM_SECURITY_EVENT_TYPE,
        purpose: SYSTEM_SECURITY_PURPOSE,
        keyId,
        challengeId,
        recipientAccountId,
        conversationId,
        restaurantId,
        restaurantName,
        otp,
        issuedAt,
        expiresAt,
        signature: sig,
      },
    },
  };
}

describe("Stage 2 Client Security OTP Ed25519 Verifier & Megolm Bypass", () => {
  it("verifies a valid canonical Ed25519-signed bb.system.security_otp payload against the dev key", async () => {
    const devKeys = deriveDevKeyPair();
    expect(devKeys.publicKeyBase64Url).toBe("Sj8mKO3aME8Sxgu6uOdjgRC294OARY4z1LBHBj3fpoE");

    const { accountId, serverMessage } = makeSignedMessage();
    const res = await verifySecurityOtpMessage({ serverMessage, accountId });
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.payload.otp).toBe("482910");
      expect(res.payload.restaurantId).toBe(42);
      expect(res.payload.restaurantName).toBe("Spice Garden");
    }
  });

  it("rejects any tampered field, bound context mismatch, unknown keyId, or wrong signature (fail-closed)", async () => {
    const base = makeSignedMessage();

    // Tampered OTP
    const tamperedOtp = structuredClone(base.serverMessage);
    (tamperedOtp.payloadJson as Record<string, unknown>)["otp"] = "999999";
    expect((await verifySecurityOtpMessage({ serverMessage: tamperedOtp, accountId: base.accountId })).valid).toBe(false);

    // Tampered restaurantName
    const tamperedName = structuredClone(base.serverMessage);
    (tamperedName.payloadJson as Record<string, unknown>)["restaurantName"] = "Evil Bistro";
    expect((await verifySecurityOtpMessage({ serverMessage: tamperedName, accountId: base.accountId })).valid).toBe(false);

    // Tampered expiresAt
    const tamperedExp = structuredClone(base.serverMessage);
    (tamperedExp.payloadJson as Record<string, unknown>)["expiresAt"] = new Date(Date.now() + 3600_000).toISOString();
    expect((await verifySecurityOtpMessage({ serverMessage: tamperedExp, accountId: base.accountId })).valid).toBe(false);

    // Challenge ID !== clientMsgId
    const mismatchChallenge = makeSignedMessage({
      challengeId: "11111111-1111-4111-8111-111111111111",
      clientMsgId: "99999999-9999-4999-8999-999999999999",
    });
    expect((await verifySecurityOtpMessage(mismatchChallenge)).valid).toBe(false);

    // Recipient account mismatch (replayed OTP from another owner's thread)
    const wrongRecipient = makeSignedMessage({
      recipientAccountId: "22222222-2222-4222-8222-222222222222",
      accountId: "77777777-7777-4777-8777-777777777777",
    });
    expect((await verifySecurityOtpMessage(wrongRecipient)).valid).toBe(false);

    // Envelope conversationId mismatch
    const wrongConv = makeSignedMessage({
      conversationId: "33333333-3333-4333-8333-333333333333",
      envelopeConversationId: "88888888-8888-4888-8888-888888888888",
    });
    expect((await verifySecurityOtpMessage(wrongConv)).valid).toBe(false);

    // Unknown keyId
    const unknownKey = makeSignedMessage({ keyId: "bb-sec-unknown-v9" });
    expect((await verifySecurityOtpMessage(unknownKey)).valid).toBe(false);

    // Wrong private key signature
    const rogue = crypto.generateKeyPairSync("ed25519");
    const forgedSig = makeSignedMessage({ privateKey: rogue.privateKey });
    expect((await verifySecurityOtpMessage(forgedSig)).valid).toBe(false);

    // Wrong eventType
    const wrongType = makeSignedMessage({ eventType: "m.room.encrypted" });
    expect((await verifySecurityOtpMessage(wrongType)).valid).toBe(false);
  });

  it("forbids dev fallback public key in production builds and requires pinned production keys", () => {
    const prodEmpty = getPinnedSecurityPublicKeys({
      isProd: true,
      isDev: false,
      mode: "production",
      rawJsonEnv: "",
    });
    expect(Object.keys(prodEmpty)).toEqual([]);

    const prodMalformed = getPinnedSecurityPublicKeys({
      isProd: true,
      isDev: false,
      mode: "production",
      rawJsonEnv: "{not-json",
    });
    expect(Object.keys(prodMalformed)).toEqual([]);

    const { publicKeySync } = (() => {
      const kp = crypto.generateKeyPairSync("ed25519");
      const spki = kp.publicKey.export({ format: "der", type: "spki" });
      if (!spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
        throw new Error("unexpected spki");
      }
      return { publicKeySync: spki.subarray(12, 44).toString("base64url") };
    })();

    const prodPinned = getPinnedSecurityPublicKeys({
      isProd: true,
      isDev: false,
      mode: "production",
      rawJsonEnv: JSON.stringify({ "bb-prod-2026": publicKeySync }),
    });
    expect(Object.keys(prodPinned)).toEqual(["bb-prod-2026"]);
    expect(prodPinned["bb-sec-dev-v1"]).toBeUndefined();
  });

  it("computes active, superseded, expired, and invalid OTP display states accurately", () => {
    const now = 1_700_000_000_000;
    const future = new Date(now + 120_000).toISOString();
    const past = new Date(now - 5_000).toISOString();

    expect(
      getOtpDisplayState({
        valid: true,
        payload: { expiresAt: future },
        highestValidSeq: 5,
        serverSeq: 5,
        nowMs: now,
      }),
    ).toBe("active");

    expect(
      getOtpDisplayState({
        valid: true,
        payload: { expiresAt: future },
        highestValidSeq: 5,
        serverSeq: 4,
        nowMs: now,
      }),
    ).toBe("superseded");

    expect(
      getOtpDisplayState({
        valid: true,
        payload: { expiresAt: past },
        highestValidSeq: 5,
        serverSeq: 5,
        nowMs: now,
      }),
    ).toBe("expired");

    expect(
      getOtpDisplayState({
        valid: false,
        payload: null,
        highestValidSeq: 5,
        serverSeq: 5,
        nowMs: now,
      }),
    ).toBe("invalid");
  });

  it("bypasses Megolm WASM decryption cleanly for bb.system.security_otp events", async () => {
    const fakeMachine = {
      decryptRoomEvent: async () => {
        throw new Error("Megolm decryptRoomEvent should NEVER be invoked for bb.system.security_otp");
      },
    };
    const fakeSession = Object.create(ChatCryptoSession.prototype) as ChatCryptoSession;
    Reflect.set(fakeSession, "machine", fakeMachine);
    Reflect.set(fakeSession, "storeName", "test-memory");

    const result = await fakeSession.decryptRoomEvent("33333333-3333-4333-8333-333333333333", {
      id: "44444444-4444-4444-8444-444444444444",
      senderMatrixUserId: "@00000000-0000-4000-8000-000000000001:chat.bitebend.in",
      createdAt: new Date().toISOString(),
      eventType: SYSTEM_SECURITY_EVENT_TYPE,
      payloadJson: { otp: "123456" },
    });

    expect(result).toEqual({
      decrypted: true,
      msgtype: SYSTEM_SECURITY_EVENT_TYPE,
      body: "",
    });
  });
});
