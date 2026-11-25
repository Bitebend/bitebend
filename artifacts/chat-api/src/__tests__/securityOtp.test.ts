import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";

// Isolate DB strictly to in-memory PGlite BEFORE static ESM imports evaluate db/index.ts
vi.hoisted(() => {
  process.env["CHAT_PGLITE_DIR"] = ":memory:";
  process.env["CHAT_INTERNAL_HMAC_SECRET"] = "test-chat-secret-hmac-key-0123456789";
  process.env["CHAT_PHONE_PEPPER"] = "test-phone-pepper";
  delete process.env["DATABASE_URL"];
  delete process.env["CHAT_DATABASE_URL"];
  delete process.env["CHAT_SECURITY_SIGNING_PRIVATE_KEY"];
  delete process.env["CHAT_SECURITY_ACTIVE_KEY_ID"];
});

import { createChatApp } from "../app";
import {
  chatDb,
  chatPool,
  ensureChatDbReady,
  messagingAccounts,
  messagingConversations,
  messagingMessages,
  messagingSecurityOtpDeliveries,
} from "../db";
import { hmacPhoneDigest } from "../lib/crypto";
import {
  getSecuritySigningMaterial,
  SYSTEM_SECURITY_ACCOUNT_ID,
  SYSTEM_SECURITY_EVENT_TYPE,
  SYSTEM_SECURITY_USERNAME,
  validateChatSecurityStartupConfig,
} from "../lib/securityConfig";
import {
  ensureSystemSecurityIdentity,
  verifySignedSecurityOtpPayload,
  type SignedSecurityOtpPayload,
} from "../lib/securityOtpSigner";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function signS2SHeaders(
  method: "GET" | "POST",
  endpointPath: string,
  bodyCanonical: string,
  overrides: Partial<{ secret: string; ts: string; nonce: string; sig: string }> = {},
) {
  const secret = overrides.secret ?? process.env["CHAT_INTERNAL_HMAC_SECRET"]!;
  const ts = overrides.ts ?? String(Date.now());
  const nonce = overrides.nonce ?? crypto.randomBytes(24).toString("hex");
  const signingInput = `${method}\n${endpointPath}\n${ts}\n${nonce}\n${sha256Hex(bodyCanonical)}`;
  const sig = overrides.sig ?? crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");
  return {
    ...(bodyCanonical ? { "Content-Type": "application/json" } : {}),
    "x-bitebend-ts": ts,
    "x-bitebend-nonce": nonce,
    "x-bitebend-sig": sig,
  };
}

function makeDevice(matrixDeviceId: string) {
  return {
    deviceLabel: "Vitest Device",
    matrixDeviceId,
    deviceKeysJson: {
      keys: {
        [`ed25519:${matrixDeviceId}`]: `ed_${matrixDeviceId}`,
        [`curve25519:${matrixDeviceId}`]: `curve_${matrixDeviceId}`,
      },
    },
    oneTimeKeys: {
      "signed_curve25519:AA0": { key: `otpk_${matrixDeviceId}_0` },
    },
    fallbackKey: {
      "signed_curve25519:FB1": { key: `fb_${matrixDeviceId}` },
    },
  };
}

function extractCookieJar(prevCookie: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();
  if (prevCookie) {
    for (const part of prevCookie.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }
  for (const header of setCookieHeaders) {
    const kv = header.split(";")[0];
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const name = kv.slice(0, eq).trim();
    const val = kv.slice(eq + 1).trim();
    if (!val || header.toLowerCase().includes("max-age=0")) {
      map.delete(name);
    } else {
      map.set(name, val);
    }
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

describe("Stage 2 Chat-API: System Security Identity, Read-Only Isolation, S2S HMAC, Ed25519 Signing & Concurrency", () => {
  let server: http.Server;
  let baseUrl = "";
  let aliceAccountId = "";
  let aliceCookie = "";
  let bobCookie = "";
  const alicePhoneNorm = "919876543210";

  beforeAll(async () => {
    await ensureChatDbReady();
    server = http.createServer(createChatApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Register Alice (with normalized phone) & Bob
    const aliceReg = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "Alice Owner",
        mobileNumber: "9876543210",
        device: makeDevice("ALICE_SEC_DEV1"),
      }),
    });
    expect(aliceReg.status).toBe(201);
    aliceCookie = extractCookieJar("", aliceReg.headers.getSetCookie());
    const aliceJson = (await aliceReg.json()) as {
      account: { id: string };
    };
    aliceAccountId = aliceJson.account.id;

    const bobReg = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "Bob Attacker",
        mobileNumber: "9876500000",
        device: makeDevice("BOB_SEC_DEV1"),
      }),
    });
    expect(bobReg.status).toBe(201);
    bobCookie = extractCookieJar("", bobReg.headers.getSetCookie());
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await chatPool.end();
  });

  it("provisions deterministic system security identity idempotently and fails closed on startup misconfiguration or identity corruption", async () => {
    await expect(ensureChatDbReady()).resolves.toBeUndefined();
    await expect(ensureSystemSecurityIdentity()).resolves.toBeUndefined();

    const [sysAcc] = await chatDb
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.id, SYSTEM_SECURITY_ACCOUNT_ID))
      .limit(1);
    expect(sysAcc?.usernameLower).toBe(SYSTEM_SECURITY_USERNAME);
    expect(sysAcc?.accountType).toBe("system_security");

    // External production without Ed25519 private key fails closed
    const prevNodeEnv = process.env["NODE_ENV"];
    const prevApplet = process.env["APPLET_ID"];
    const prevPort = process.env["DEFAULT_APP_PORT"];
    try {
      process.env["NODE_ENV"] = "production";
      delete process.env["APPLET_ID"];
      delete process.env["DEFAULT_APP_PORT"];
      expect(() => validateChatSecurityStartupConfig()).toThrow(/CHAT_SECURITY_SIGNING_PRIVATE_KEY/);
    } finally {
      process.env["NODE_ENV"] = prevNodeEnv;
      if (prevApplet !== undefined) process.env["APPLET_ID"] = prevApplet;
      if (prevPort !== undefined) process.env["DEFAULT_APP_PORT"] = prevPort;
    }

    // Corrupt account_type temporarily -> ensureSystemSecurityIdentity fails closed
    await chatDb
      .update(messagingAccounts)
      .set({ accountType: "user" })
      .where(eq(messagingAccounts.id, SYSTEM_SECURITY_ACCOUNT_ID));
    try {
      await expect(ensureSystemSecurityIdentity()).rejects.toThrow(/FATAL: System security account UUID/);
    } finally {
      await chatDb
        .update(messagingAccounts)
        .set({ accountType: "system_security" })
        .where(eq(messagingAccounts.id, SYSTEM_SECURITY_ACCOUNT_ID));
    }
  });

  it("enforces S2S HMAC authentication, timestamp skew window, and nonce replay rejection", async () => {
    const challengeId = crypto.randomUUID();
    const endpoint = "/api/internal/security/send-otp";
    const body = JSON.stringify({
      challengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "123456",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });

    // Missing headers
    const noAuth = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(noAuth.status).toBe(401);

    // Invalid signature
    const badSig = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, body, { sig: "deadbeef".repeat(8) }),
      body,
    });
    expect(badSig.status).toBe(401);

    // Stale timestamp (>60s)
    const staleTs = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, body, { ts: String(Date.now() - 120_000) }),
      body,
    });
    expect(staleTs.status).toBe(401);

    // Replay nonce rejection (using a GET status check with reused nonce)
    const statusPath = `/api/internal/security/challenges/${challengeId}`;
    const fixedNonce = "reused_nonce_0123456789abcdef";
    const h1 = signS2SHeaders("GET", statusPath, "", { nonce: fixedNonce });
    const firstGet = await fetch(`${baseUrl}${statusPath}`, { method: "GET", headers: h1 });
    expect(firstGet.status).toBe(404);

    const h2 = signS2SHeaders("GET", statusPath, "", { nonce: fixedNonce });
    const replayGet = await fetch(`${baseUrl}${statusPath}`, { method: "GET", headers: h2 });
    expect(replayGet.status).toBe(409);
  });

  it("delivers signed OTP into system_readonly channel, verifies Ed25519 signature, and enforces full client isolation", async () => {
    // System account must be invisible in user search/lookup & registration
    const searchRes = await fetch(`${baseUrl}/api/chat/users/lookup?q=bitebend`, {
      headers: { Cookie: bobCookie },
    });
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { users: Array<{ username: string }> };
    expect(searchJson.users.some((u) => u.username.toLowerCase().includes("security_otp"))).toBe(false);

    const exactLookup = await fetch(
      `${baseUrl}/api/chat/users/lookup?username=${SYSTEM_SECURITY_USERNAME}`,
      { headers: { Cookie: bobCookie } },
    );
    expect(exactLookup.status).toBe(404);

    // Client cannot start a DM with @bitebend.security_otp
    const dmRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: bobCookie },
      body: JSON.stringify({ kind: "direct", targetUsername: SYSTEM_SECURITY_USERNAME }),
    });
    expect(dmRes.status).toBe(403);

    // Reject expired pre-dispatch & unmatched phone
    const endpoint = "/api/internal/security/send-otp";
    const unmatchedBody = JSON.stringify({
      challengeId: crypto.randomUUID(),
      phoneHmac: hmacPhoneDigest("919999999999"),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "123456",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });
    const unmatchedRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, unmatchedBody),
      body: unmatchedBody,
    });
    expect(unmatchedRes.status).toBe(404);
    expect(((await unmatchedRes.json()) as { failureCode: string }).failureCode).toBe("RECIPIENT_NOT_FOUND");

    // Valid OTP dispatch to Alice
    const challengeId = crypto.randomUUID();
    const validBody = JSON.stringify({
      challengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "654321",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });
    const sendRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, validBody),
      body: validBody,
    });
    expect(sendRes.status).toBe(201);
    const sendJson = (await sendRes.json()) as {
      ok: boolean;
      deliveryStatus: string;
      conversationId: string;
      messageId: string;
      serverSeq: number;
    };
    expect(sendJson.ok).toBe(true);
    expect(sendJson.deliveryStatus).toBe("delivered");
    expect(sendJson.serverSeq).toBe(1);

    // Verify signed payload cryptographically
    const [msgRow] = await chatDb
      .select()
      .from(messagingMessages)
      .where(eq(messagingMessages.id, sendJson.messageId))
      .limit(1);
    expect(msgRow?.eventType).toBe(SYSTEM_SECURITY_EVENT_TYPE);
    const mat = getSecuritySigningMaterial();
    expect(
      verifySignedSecurityOtpPayload(
        msgRow!.payloadJson as unknown as SignedSecurityOtpPayload,
        mat.publicKeyRaw,
      ),
    ).toBe(true);

    // Client cannot send replies, upload attachments, or alter membership of system_readonly
    const sendReplyRes = await fetch(
      `${baseUrl}/api/chat/conversations/${sendJson.conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({
          clientMsgId: crypto.randomUUID(),
          eventType: "m.room.encrypted",
          keyEpoch: 1,
          payload: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "fake" },
        }),
      },
    );
    expect(sendReplyRes.status).toBe(403);

    const blob = Buffer.from("encrypted-bytes");
    const uploadRes = await fetch(`${baseUrl}/api/chat/attachments`, {
      method: "POST",
      headers: {
        Cookie: aliceCookie,
        "Content-Type": "application/octet-stream",
        "x-conversation-id": sendJson.conversationId,
        "x-ciphertext-sha256": crypto.createHash("sha256").update(blob).digest("hex"),
      },
      body: blob,
    });
    expect(uploadRes.status).toBe(403);

    const addMemberRes = await fetch(
      `${baseUrl}/api/chat/conversations/${sendJson.conversationId}/members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({ username: "bob" }),
      },
    );
    expect(addMemberRes.status).toBe(403);

    // Read-receipt ack on system_readonly remains allowed for unread badge clearing
    const ackRes = await fetch(
      `${baseUrl}/api/chat/conversations/${sendJson.conversationId}/ack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({ lastReadSeq: 1 }),
      },
    );
    expect(ackRes.status).toBe(200);
  });

  it("enforces concurrent idempotency (Promise.all), deadline-overrun atomic rollback, pre-dispatch cancellation, and safe GET status probing", async () => {
    const endpoint = "/api/internal/security/send-otp";
    const sharedChallengeId = crypto.randomUUID();
    const convPairKey = `system_security_otp:${aliceAccountId.toLowerCase()}`;
    const [convBefore] = await chatDb
      .select({ nextSeq: messagingConversations.nextSeq })
      .from(messagingConversations)
      .where(eq(messagingConversations.directPairKey, convPairKey))
      .limit(1);

    const reqBody = JSON.stringify({
      challengeId: sharedChallengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "777888",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });

    const concurrent = await Promise.all(
      [1, 2, 3].map(() =>
        fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: signS2SHeaders("POST", endpoint, reqBody),
          body: reqBody,
        }),
      ),
    );
    const statuses = concurrent.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 201]);

    const committedMsgs = await chatDb
      .select()
      .from(messagingMessages)
      .where(
        and(
          eq(messagingMessages.clientMsgId, sharedChallengeId),
          eq(messagingMessages.eventType, SYSTEM_SECURITY_EVENT_TYPE),
        ),
      );
    expect(committedMsgs.length).toBe(1);

    const [convAfterConcurrent] = await chatDb
      .select({ nextSeq: messagingConversations.nextSeq })
      .from(messagingConversations)
      .where(eq(messagingConversations.directPairKey, convPairKey))
      .limit(1);
    expect(convAfterConcurrent!.nextSeq).toBe((convBefore?.nextSeq ?? 0) + 1);

    // Deadline already past -> atomic rollback / failed with zero message created & seq unchanged
    const overdueChallengeId = crypto.randomUUID();
    const overdueBody = JSON.stringify({
      challengeId: overdueChallengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "222333",
      issuedAt: new Date(Date.now() - 20_000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
      remainingTtlSeconds: 580,
    });
    const overdueRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, overdueBody),
      body: overdueBody,
    });
    expect(overdueRes.status).toBe(422);
    const overdueJson = (await overdueRes.json()) as { deliveryStatus: string; failureCode: string };
    expect(overdueJson.deliveryStatus).toBe("failed");
    expect(overdueJson.failureCode).toBe("DELIVERY_DEADLINE_EXCEEDED");

    const overdueMsgs = await chatDb
      .select()
      .from(messagingMessages)
      .where(eq(messagingMessages.clientMsgId, overdueChallengeId));
    expect(overdueMsgs.length).toBe(0);

    const [convAfterOverdue] = await chatDb
      .select({ nextSeq: messagingConversations.nextSeq })
      .from(messagingConversations)
      .where(eq(messagingConversations.directPairKey, convPairKey))
      .limit(1);
    expect(convAfterOverdue!.nextSeq).toBe(convAfterConcurrent!.nextSeq);

    // Pre-dispatch cancel tombstone blocks subsequent send-otp with 409
    const cancelChallengeId = crypto.randomUUID();
    const cancelPath = `/api/internal/security/challenges/${cancelChallengeId}/cancel`;
    const cancelRes = await fetch(`${baseUrl}${cancelPath}`, {
      method: "POST",
      headers: signS2SHeaders("POST", cancelPath, ""),
    });
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as { status: string }).status).toBe("cancelled");

    const blockedSendBody = JSON.stringify({
      challengeId: cancelChallengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "999000",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });
    const blockedSendRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: signS2SHeaders("POST", endpoint, blockedSendBody),
      body: blockedSendBody,
    });
    expect(blockedSendRes.status).toBe(409);

    // Cancelling an already-delivered challenge does NOT overwrite delivered
    const cancelDeliveredPath = `/api/internal/security/challenges/${sharedChallengeId}/cancel`;
    const cancelDeliveredRes = await fetch(`${baseUrl}${cancelDeliveredPath}`, {
      method: "POST",
      headers: signS2SHeaders("POST", cancelDeliveredPath, ""),
    });
    expect(cancelDeliveredRes.status).toBe(200);
    const cancelDeliveredJson = (await cancelDeliveredRes.json()) as {
      status: string;
      alreadyDelivered: boolean;
    };
    expect(cancelDeliveredJson.status).toBe("delivered");
    expect(cancelDeliveredJson.alreadyDelivered).toBe(true);

    // GET /challenges/:challengeId returns authoritative terminal state
    const getPath = `/api/internal/security/challenges/${sharedChallengeId}`;
    const getStatusRes = await fetch(`${baseUrl}${getPath}`, {
      method: "GET",
      headers: signS2SHeaders("GET", getPath, ""),
    });
    expect(getStatusRes.status).toBe(200);
    const getStatusJson = (await getStatusRes.json()) as {
      found: boolean;
      deliveryStatus: string;
      delivered: boolean;
    };
    expect(getStatusJson.found).toBe(true);
    expect(getStatusJson.deliveryStatus).toBe("delivered");
    expect(getStatusJson.delivered).toBe(true);

    // Verify 55P03 lock contention fallback behavior on GET /challenges/:id via controlled transaction error mock
    const spy = vi.spyOn(chatDb, "transaction").mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    );
    try {
      const contendedRes = await fetch(`${baseUrl}${getPath}`, {
        method: "GET",
        headers: signS2SHeaders("GET", getPath, ""),
      });
      expect(contendedRes.status).toBe(200);
      expect(await contendedRes.json()).toEqual({
        found: true,
        deliveryStatus: "pending",
        delivered: false,
        lockContention: true,
      });
    } finally {
      spy.mockRestore();
    }

    const [delRow] = await chatDb
      .select()
      .from(messagingSecurityOtpDeliveries)
      .where(eq(messagingSecurityOtpDeliveries.challengeId, sharedChallengeId))
      .limit(1);
    expect(delRow?.status).toBe("delivered");
  });

  it("maps lock/statement contention to HTTP 503 DB_LOCK_CONTENTION on send-otp/cancel and enforces Mandatory Chat Test DB Safety Guard", async () => {
    const { assertSafeChatTestDatabase, verifyConnectedChatTestDbIdentity } = await import(
      "../lib/testDbSafetyGuard"
    );

    // 1. send-otp 55P03 contention -> 503 uncertain (so reconciliation handles safely)
    const cid = crypto.randomUUID();
    const sendEndpoint = "/api/internal/security/send-otp";
    const sendBody = JSON.stringify({
      challengeId: cid,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 101,
      restaurantName: "Demo Diner",
      otp: "111222",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      remainingTtlSeconds: 600,
    });
    const txSpy1 = vi.spyOn(chatDb, "transaction").mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    );
    try {
      const res = await fetch(`${baseUrl}${sendEndpoint}`, {
        method: "POST",
        headers: signS2SHeaders("POST", sendEndpoint, sendBody),
        body: sendBody,
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      const json = (await res.json()) as { deliveryStatus: string; code: string };
      expect(json.deliveryStatus).toBe("uncertain");
      expect(json.code).toBe("DB_LOCK_CONTENTION");
    } finally {
      txSpy1.mockRestore();
    }

    // 2. cancel 55P03 contention -> 503 DB_LOCK_CONTENTION
    const cancelPath = `/api/internal/security/challenges/${cid}/cancel`;
    const txSpy2 = vi.spyOn(chatDb, "transaction").mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    );
    try {
      const res = await fetch(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: signS2SHeaders("POST", cancelPath, ""),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      const json = (await res.json()) as { ok: boolean; code: string };
      expect(json.ok).toBe(false);
      expect(json.code).toBe("DB_LOCK_CONTENTION");
    } finally {
      txSpy2.mockRestore();
    }

    // 3. Mandatory Chat Test Database Safety Guard
    expect(() =>
      assertSafeChatTestDatabase({
        NODE_ENV: "test",
        CHAT_DATABASE_URL: "postgres://u:p@localhost:5432/prod_chat",
      }),
    ).toThrow(/TEST_CHAT_PG_URL is not configured/);

    expect(() =>
      assertSafeChatTestDatabase({
        NODE_ENV: "test",
        CHAT_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/chat_prod",
        TEST_CHAT_PG_URL: "postgres://u:p@localhost/chat_prod",
      }),
    ).toThrow(/TEST_CHAT_DB_SAFETY_ABORT/);

    expect(() =>
      assertSafeChatTestDatabase({
        NODE_ENV: "development",
        CHAT_DATABASE_URL: "postgres://u:p@prod.host:5432/chat_prod",
        TEST_PG_URL: "postgres://u:p@localhost:5432/shared_test",
        TEST_CHAT_PG_URL: "postgres://u:p@127.0.0.1:5432/shared_test",
      }),
    ).toThrow(/must be independent|matches TEST_PG_URL/);

    const safeChat = assertSafeChatTestDatabase({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://u:p@prod.host:5432/main_prod",
      CHAT_DATABASE_URL: "postgres://u:p@prod.host:5432/chat_prod",
      TEST_PG_URL: "postgres://u:p@localhost:5432/main_test",
      TEST_CHAT_PG_URL: "postgres://u:p@localhost:5432/chat_test?schema=chat_test_schema",
    });
    expect(safeChat.identity.database).toBe("chat_test");
    expect(safeChat.identity.searchPath).toBe("chat_test_schema");

    await expect(
      verifyConnectedChatTestDbIdentity(
        {
          query: async () => ({ rows: [{ current_db: "chat_test", current_schema: "public" }] }) as any,
        },
        safeChat.identity,
        { CHAT_DATABASE_URL: "postgres://u:p@prod.host:5432/chat_prod" },
      ),
    ).rejects.toThrow(/TEST_CHAT_DB_SAFETY_ABORT.*does not match expected TEST_CHAT_PG_URL search_path\/schema/);

    await expect(
      verifyConnectedChatTestDbIdentity(
        {
          query: async () => ({ rows: [{ current_db: "chat_test", current_schema: "chat_test_schema" }] }) as any,
        },
        safeChat.identity,
        { CHAT_DATABASE_URL: "postgres://u:p@prod.host:5432/chat_prod" },
      ),
    ).resolves.toEqual({ currentDatabase: "chat_test", currentSchema: "chat_test_schema" });
  });
});
