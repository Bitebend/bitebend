import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";

// Isolate DB strictly to in-memory PGlite BEFORE static ESM imports evaluate db/index.ts
vi.hoisted(() => {
  process.env["CHAT_PGLITE_DIR"] = ":memory:";
  process.env["CHAT_INTERNAL_HMAC_SECRET"] = "test-chat-secret-hmac-key-0123456789";
  process.env["CHAT_PHONE_PEPPER"] = "test-phone-pepper";
  process.env["CHAT_ADMIN_SECRET"] = "test-admin-secret-999";
  delete process.env["DATABASE_URL"];
  delete process.env["CHAT_DATABASE_URL"];
});

import { createChatApp } from "../app";
import { chatDb, chatPool, ensureChatDbReady, messagingAccounts, messagingContactClaims, messagingDevices } from "../db";
import { buildAutoUsernameBase, buildLoginChallengePayload, hmacPhoneDigest } from "../lib/crypto";

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
    if (!val || header.toLowerCase().includes("max-age=0") || header.toLowerCase().includes("expires=thu, 01 jan 1970")) {
      map.delete(name);
    } else {
      map.set(name, val);
    }
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function makeRealEd25519DevicePayload(matrixDeviceId: string, otpkCount = 3) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const ed25519B64 = spki.subarray(spki.length - 32).toString("base64").replace(/=+$/, "");
  const oneTimeKeys: Record<string, unknown> = {};
  for (let i = 0; i < otpkCount; i++) {
    oneTimeKeys[`signed_curve25519:AA${i}`] = { key: `otpk_${matrixDeviceId}_${i}` };
  }
  const payload = {
    deviceLabel: "Vitest Browser",
    matrixDeviceId,
    deviceKeysJson: {
      keys: {
        [`ed25519:${matrixDeviceId}`]: ed25519B64,
        [`curve25519:${matrixDeviceId}`]: `curve_${matrixDeviceId}`,
      },
    },
    oneTimeKeys,
    fallbackKey: {
      "signed_curve25519:FB1": { key: `fb_${matrixDeviceId}` },
    },
  };
  const signEndorsement = (accountId: string, targetMatrixDeviceId: string, targetEd25519: string) => {
    const msg = JSON.stringify({
      accountId: accountId.toLowerCase(),
      matrixDeviceId: targetMatrixDeviceId,
      ed25519: targetEd25519,
    });
    const sigB64 = crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64").replace(/=+$/, "");
    return JSON.stringify({
      [`@${accountId.toLowerCase()}:chat.bitebend.in`]: {
        [`ed25519:${matrixDeviceId}`]: sigB64,
      },
    });
  };
  const signLoginChallenge = (params: {
    challengeId: string;
    accountId: string;
    matrixDeviceId: string;
    nonce: string;
  }) => {
    const msg = buildLoginChallengePayload(params);
    const sigB64 = crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64").replace(/=+$/, "");
    return JSON.stringify({
      [`@${params.accountId.toLowerCase()}:chat.bitebend.in`]: {
        [`ed25519:${matrixDeviceId}`]: sigB64,
      },
    });
  };
  return { payload, ed25519B64, signEndorsement, signLoginChallenge };
}

function makeFakeDevicePayload(matrixDeviceId: string, otpkCount = 3) {
  return makeRealEd25519DevicePayload(matrixDeviceId, otpkCount).payload;
}

describe("Bitebend Chat API (isolated DB, mobile login, auto-username, handoff supersession, OTPK SKIP LOCKED, seq, revocation)", () => {
  let server: http.Server;
  let baseUrl: string;
  let mockHandoffServer: http.Server;
  const issuedHandoffs = new Map<string, { handoffId: string; restaurantId: number; customerName: string; customerPhone: string }>();

  beforeAll(async () => {
    // Mock internal api-server handoff verifier
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post("/api/internal/messaging/handoff/verify-consume", (req, res) => {
      const { rawToken } = req.body as { rawToken: string };
      const rec = issuedHandoffs.get(rawToken);
      if (!rec) {
        res.status(410).json({ valid: false, code: "HANDOFF_EXPIRED_OR_INVALID" });
        return;
      }
      issuedHandoffs.delete(rawToken);
      res.json({ valid: true, ...rec, issuedAt: new Date().toISOString() });
    });
    mockHandoffServer = http.createServer(mockApp);
    await new Promise<void>((r) => mockHandoffServer.listen(0, "127.0.0.1", r));
    const mockAddr = mockHandoffServer.address() as { port: number };
    process.env["API_SERVER_INTERNAL_URL"] = `http://127.0.0.1:${mockAddr.port}`;

    await ensureChatDbReady();
    server = http.createServer(createChatApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    mockHandoffServer.close();
    await chatPool.end();
  });

  it("auto-generates privacy-safe @usernames, enforces unique login mobile numbers, handles username collisions, and preserves legacy accounts", async () => {
    const aliceId = crypto.randomUUID();
    const res1 = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: aliceId,
        displayName: "Alice Banerjee",
        mobileNumber: "9876543210",
        device: makeFakeDevicePayload("ALICE_DEV1"),
      }),
    });
    expect(res1.status).toBe(201);
    const aliceJson = (await res1.json()) as {
      account: { id: string; username: string; displayName: string };
    };
    expect(aliceJson.account.username).toMatch(/^alice\.banerjee\.\d{4}$/);
    // Zero real phone digits exposed in handle
    expect(aliceJson.account.username).not.toContain("3210");
    expect(aliceJson.account.username).not.toContain("9876");

    // Duplicate registration with formatted variant of same mobile number rejected with 409 EXISTING_ACCOUNT_FOUND
    const resDupPhone = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "Different Name",
        mobileNumber: "+91 98765-43210",
        device: makeFakeDevicePayload("DUP_PHONE_DEV"),
      }),
    });
    expect(resDupPhone.status).toBe(409);
    const dupPhoneJson = (await resDupPhone.json()) as { code?: string };
    expect(dupPhoneJson.code).toBe("EXISTING_ACCOUNT_FOUND");

    // Forced username collision: pre-occupy expected base username for Bob -> registration still succeeds with unique suffix via SAVEPOINT retry
    const collisionPhone = "919800001122";
    const expectedBase = buildAutoUsernameBase("Bob", collisionPhone);
    const legacyId = crypto.randomUUID();
    await chatDb.insert(messagingAccounts).values({
      id: legacyId,
      username: expectedBase,
      usernameLower: expectedBase,
      displayName: "Legacy User",
      loginPhoneHmac: null, // legacy account has no loginPhoneHmac
      identityStatus: "active",
    });
    await chatDb.insert(messagingContactClaims).values({
      accountId: legacyId,
      phoneHmac: hmacPhoneDigest("919999999999"),
      phoneMasked: "••••••9999",
      source: "legacy_claim",
      verificationStatus: "unverified",
    });

    const resBob = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "Bob",
        mobileNumber: "9800001122",
        device: makeFakeDevicePayload("BOB_DEV1"),
      }),
    });
    expect(resBob.status).toBe(201);
    const bobJson = (await resBob.json()) as { account: { username: string } };
    expect(bobJson.account.username).not.toBe(expectedBase);
    expect(bobJson.account.username.startsWith(`${expectedBase}.`)).toBe(true);
  });

  it("supports passwordless Ed25519 challenge-response login on same browser and enforces LINK_REQUIRED on fresh browsers", async () => {
    const aliceId = crypto.randomUUID();
    const dev1 = makeRealEd25519DevicePayload("LOGIN_D1", 2);
    const reg = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: aliceId,
        displayName: "Priya Login",
        mobileNumber: "9811223344",
        device: dev1.payload,
      }),
    });
    expect(reg.status).toBe(201);
    const firstCookies = extractCookieJar("", reg.headers.getSetCookie());

    // Logout normally (revokes server session; device keys stay preserved on browser)
    const outRes = await fetch(`${baseUrl}/api/chat/logout`, {
      method: "POST",
      headers: { Cookie: firstCookies },
    });
    expect(outRes.status).toBe(200);

    // 1) Unknown number -> 404 ACCOUNT_NOT_FOUND
    const unknownRes = await fetch(`${baseUrl}/api/chat/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobileNumber: "9000000001", knownDevices: [] }),
    });
    expect(unknownRes.status).toBe(404);
    expect(((await unknownRes.json()) as { code?: string }).code).toBe("ACCOUNT_NOT_FOUND");

    // 2) Fresh browser (empty knownDevices) -> LINK_REQUIRED without leaking accountId/username
    const freshRes = await fetch(`${baseUrl}/api/chat/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobileNumber: "9811223344", knownDevices: [] }),
    });
    expect(freshRes.status).toBe(200);
    const freshJson = (await freshRes.json()) as Record<string, unknown>;
    expect(freshJson.status).toBe("LINK_REQUIRED");
    expect(freshJson.accountId).toBeUndefined();
    expect(freshJson.matrixDeviceId).toBeUndefined();
    expect(freshJson.username).toBeUndefined();

    // 3) Same browser with matching knownDevices -> CHALLENGE_ISSUED
    const chal1Res = await fetch(`${baseUrl}/api/chat/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mobileNumber: "+91 9811223344",
        knownDevices: [{ accountId: aliceId, matrixDeviceId: "LOGIN_D1" }],
      }),
    });
    expect(chal1Res.status).toBe(200);
    const chal1 = (await chal1Res.json()) as {
      status: string;
      challengeId: string;
      accountId: string;
      matrixDeviceId: string;
      nonce: string;
    };
    expect(chal1.status).toBe("CHALLENGE_ISSUED");
    expect(chal1.accountId).toBe(aliceId);
    expect(chal1.matrixDeviceId).toBe("LOGIN_D1");

    // 4) Bad Ed25519 signature rejected 401 and consumes single-use challenge
    const badVerify = await fetch(`${baseUrl}/api/chat/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: chal1.challengeId,
        accountId: aliceId,
        matrixDeviceId: "LOGIN_D1",
        signatureEnvelopeJson: JSON.stringify({
          [`@${aliceId}:chat.bitebend.in`]: {
            "ed25519:LOGIN_D1": Buffer.alloc(64, 5).toString("base64").replace(/=+$/, ""),
          },
        }),
      }),
    });
    expect(badVerify.status).toBe(401);

    const replayAfterBad = await fetch(`${baseUrl}/api/chat/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: chal1.challengeId,
        accountId: aliceId,
        matrixDeviceId: "LOGIN_D1",
        signatureEnvelopeJson: dev1.signLoginChallenge(chal1),
      }),
    });
    expect(replayAfterBad.status).toBe(401);

    // 5) Fresh challenge + valid Ed25519 signature mints working session cookie
    const chal2 = (await (
      await fetch(`${baseUrl}/api/chat/login/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobileNumber: "9811223344",
          knownDevices: [{ accountId: aliceId, matrixDeviceId: "LOGIN_D1" }],
        }),
      })
    ).json()) as { challengeId: string; accountId: string; matrixDeviceId: string; nonce: string };

    const okVerify = await fetch(`${baseUrl}/api/chat/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: chal2.challengeId,
        accountId: aliceId,
        matrixDeviceId: "LOGIN_D1",
        signatureEnvelopeJson: dev1.signLoginChallenge(chal2),
      }),
    });
    expect(okVerify.status).toBe(200);
    const reloggedCookies = extractCookieJar("", okVerify.headers.getSetCookie());
    const reloggedJson = (await okVerify.json()) as { account: { id: string; username: string } };
    expect(reloggedJson.account.id).toBe(aliceId);

    const convCheck = await fetch(`${baseUrl}/api/chat/conversations`, {
      headers: { Cookie: reloggedCookies },
    });
    expect(convCheck.status).toBe(200);

    // 6) Replaying single-use challenge again fails
    const replayOk = await fetch(`${baseUrl}/api/chat/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: chal2.challengeId,
        accountId: aliceId,
        matrixDeviceId: "LOGIN_D1",
        signatureEnvelopeJson: dev1.signLoginChallenge(chal2),
      }),
    });
    expect(replayOk.status).toBe(401);

    // 7) Revoked device cannot get login challenge -> returns LINK_REQUIRED
    await fetch(`${baseUrl}/api/chat/logout`, {
      method: "POST",
      headers: { Cookie: reloggedCookies },
    });
    await chatDb.update(messagingDevices).set({ status: "revoked", revokedAt: new Date() });
    const afterRevokeChallenge = await fetch(`${baseUrl}/api/chat/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mobileNumber: "9811223344",
        knownDevices: [{ accountId: aliceId, matrixDeviceId: "LOGIN_D1" }],
      }),
    });
    expect(afterRevokeChallenge.status).toBe(200);
    expect(((await afterRevokeChallenge.json()) as { status: string }).status).toBe("LINK_REQUIRED");
  });

  it("supersedes Draft A when Handoff B is exchanged, activates without manual username, and never overwrites active session", async () => {
    issuedHandoffs.set("tok_customer_A", {
      handoffId: crypto.randomUUID(),
      restaurantId: 10,
      customerName: "Customer Alpha",
      customerPhone: "919111111111",
    });
    issuedHandoffs.set("tok_customer_B", {
      handoffId: crypto.randomUUID(),
      restaurantId: 12,
      customerName: "Customer Beta",
      customerPhone: "919222222222",
    });

    // Browser starts with Customer A's handoff cookie
    let cookies = "bb_msg_handoff=tok_customer_A";
    const boot1 = await fetch(`${baseUrl}/api/chat/session/bootstrap`, { headers: { Cookie: cookies } });
    expect((await boot1.json() as { state: string }).state).toBe("HANDOFF_READY");

    const exA = await fetch(`${baseUrl}/api/chat/handoff/exchange`, {
      method: "POST",
      headers: { Cookie: cookies },
    });
    expect(exA.status).toBe(201);
    cookies = extractCookieJar(cookies, exA.headers.getSetCookie());
    const draftA = (await exA.json() as { draft: { id: string; maskedPhone: string } }).draft;
    expect(draftA.maskedPhone).toContain("1111");

    // Shared browser gets Customer B checkout handoff BEFORE Customer A activated
    cookies = `${cookies}; bb_msg_handoff=tok_customer_B`;
    const boot2 = await fetch(`${baseUrl}/api/chat/session/bootstrap`, { headers: { Cookie: cookies } });
    // Strict precedence: bb_msg_handoff overrides unactivated bb_chat_draft!
    expect((await boot2.json() as { state: string }).state).toBe("HANDOFF_READY");

    const exB = await fetch(`${baseUrl}/api/chat/handoff/exchange`, {
      method: "POST",
      headers: { Cookie: cookies },
    });
    expect(exB.status).toBe(201);
    const oldDraftCookieOnly = cookies.split(";").find((c) => c.trim().startsWith("bb_chat_draft="))!;
    cookies = extractCookieJar(cookies, exB.headers.getSetCookie());
    const draftB = (await exB.json() as { draft: { id: string; maskedPhone: string } }).draft;
    expect(draftB.maskedPhone).toContain("2222");

    // Customer A's stale draft cookie was marked superseded in DB -> falls back to NO_HANDOFF
    const staleCheck = await fetch(`${baseUrl}/api/chat/session/bootstrap`, {
      headers: { Cookie: oldDraftCookieOnly },
    });
    expect((await staleCheck.json() as { state: string }).state).toBe("NO_HANDOFF");

    // Customer B activates WITHOUT supplying manual username
    const actB = await fetch(`${baseUrl}/api/chat/activate-from-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        device: makeFakeDevicePayload("BETA_DEV1"),
      }),
    });
    expect(actB.status).toBe(201);
    const actBJson = (await actB.json()) as { account: { username: string } };
    expect(actBJson.account.username).toMatch(/^customer\.beta\.\d{4}$/);
    cookies = extractCookieJar(cookies, actB.headers.getSetCookie());

    // Subsequent QR handoff for the same phone in another browser still activates cleanly without login_phone_hmac conflict
    issuedHandoffs.set("tok_customer_B_second", {
      handoffId: crypto.randomUUID(),
      restaurantId: 12,
      customerName: "Customer Beta",
      customerPhone: "919222222222",
    });
    let cookiesB2 = "bb_msg_handoff=tok_customer_B_second";
    const exB2 = await fetch(`${baseUrl}/api/chat/handoff/exchange`, {
      method: "POST",
      headers: { Cookie: cookiesB2 },
    });
    expect(exB2.status).toBe(201);
    cookiesB2 = extractCookieJar(cookiesB2, exB2.headers.getSetCookie());
    const actB2 = await fetch(`${baseUrl}/api/chat/activate-from-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookiesB2 },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        device: makeFakeDevicePayload("BETA_DEV2"),
      }),
    });
    expect(actB2.status).toBe(201);

    // Now if Customer C leaves a handoff cookie on original browser, active session MUST be preserved!
    issuedHandoffs.set("tok_customer_C", {
      handoffId: crypto.randomUUID(),
      restaurantId: 14,
      customerName: "Customer Gamma",
      customerPhone: "919333333333",
    });
    const bootConflict = await fetch(`${baseUrl}/api/chat/session/bootstrap`, {
      headers: { Cookie: `${cookies}; bb_msg_handoff=tok_customer_C` },
    });
    expect((await bootConflict.json() as { state: string }).state).toBe("AUTHENTICATED_WITH_PENDING_HANDOFF");

    const exConflict = await fetch(`${baseUrl}/api/chat/handoff/exchange`, {
      method: "POST",
      headers: { Cookie: `${cookies}; bb_msg_handoff=tok_customer_C` },
    });
    expect(exConflict.status).toBe(409);
  });

  it("claims OTPKs atomically without double-claim, orders monotonic seq, enforces 15 MB cap & revocation", async () => {
    const user1Id = crypto.randomUUID();
    const r1 = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: user1Id,
        displayName: "Sender One",
        mobileNumber: "9810001001",
        device: makeFakeDevicePayload("DEV_S1", 2),
      }),
    });
    expect(r1.status).toBe(201);
    const cookie1 = extractCookieJar("", r1.headers.getSetCookie());

    const user2Id = crypto.randomUUID();
    const r2 = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: user2Id,
        displayName: "Receiver Two",
        mobileNumber: "9810001002",
        device: makeFakeDevicePayload("DEV_R2", 2),
      }),
    });
    expect(r2.status).toBe(201);
    const r2Json = (await r2.json()) as { account: { username: string } };
    const cookie2 = extractCookieJar("", r2.headers.getSetCookie());

    // Concurrent OTPK claims against receiver_two's 2 OTPKs (+1 fallback)
    const targetMatrix = `@${user2Id}:chat.bitebend.in`;
    const claimOnce = () =>
      fetch(`${baseUrl}/api/chat/keys/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie1 },
        body: JSON.stringify({ one_time_keys: { [targetMatrix]: { DEV_R2: "signed_curve25519" } } }),
      }).then((r) => r.json() as Promise<{ one_time_keys: Record<string, Record<string, Record<string, unknown>>> }>);

    const [c1, c2, c3] = await Promise.all([claimOnce(), claimOnce(), claimOnce()]);
    const claimedIds = [c1, c2, c3].map((c) => Object.keys(c.one_time_keys[targetMatrix].DEV_R2)[0]);
    expect(new Set(claimedIds).size).toBe(3); // AA0, AA1, FB1 — never duplicated!

    // Direct conversation + monotonic server_seq + clientMsgId idempotency
    const convRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie1 },
      body: JSON.stringify({ kind: "direct", targetUsername: r2Json.account.username }),
    });
    const { conversationId } = (await convRes.json()) as { conversationId: string };

    const msgId = crypto.randomUUID();
    const m1 = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie1 },
      body: JSON.stringify({
        clientMsgId: msgId,
        keyEpoch: 1,
        payload: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "cipher_1" },
        attachmentIds: [],
      }),
    }).then((r) => r.json() as Promise<{ duplicate: boolean; message: { serverSeq: number } }>);
    expect(m1.duplicate).toBe(false);
    expect(m1.message.serverSeq).toBe(1);

    // Retry same clientMsgId -> idempotent duplicate, seq remains 1
    const m1Dup = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie1 },
      body: JSON.stringify({
        clientMsgId: msgId,
        keyEpoch: 1,
        payload: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "cipher_1" },
        attachmentIds: [],
      }),
    }).then((r) => r.json() as Promise<{ duplicate: boolean; message: { serverSeq: number } }>);
    expect(m1Dup.duplicate).toBe(true);
    expect(m1Dup.message.serverSeq).toBe(1);

    // Oversized > 15 MB attachment rejected with 413
    const tooBig = Buffer.alloc(15 * 1024 * 1024 + 10, 7);
    const tooBigSha = crypto.createHash("sha256").update(tooBig).digest("hex");
    const upBig = await fetch(`${baseUrl}/api/chat/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Cookie: cookie1,
        "x-conversation-id": conversationId,
        "x-ciphertext-sha256": tooBigSha,
      },
      body: tooBig,
    });
    expect(upBig.status).toBe(413);

    // Metadata-only admin endpoint requires CHAT_ADMIN_SECRET and returns zero PII
    const unauthStats = await fetch(`${baseUrl}/api/chat/admin/stats`);
    expect(unauthStats.status).toBe(403);
    const okStats = await fetch(`${baseUrl}/api/chat/admin/stats`, {
      headers: { "x-chat-admin-secret": "test-admin-secret-999" },
    });
    expect(okStats.status).toBe(200);
    const statsJson = (await okStats.json()) as { stats: Record<string, number> };
    expect(statsJson.stats.accounts).toBeGreaterThanOrEqual(4);

    // Logout revokes session immediately
    const outRes = await fetch(`${baseUrl}/api/chat/logout`, {
      method: "POST",
      headers: { Cookie: cookie2 },
    });
    expect(outRes.status).toBe(200);
    const afterOut = await fetch(`${baseUrl}/api/chat/conversations`, { headers: { Cookie: cookie2 } });
    expect(afterOut.status).toBe(401);
  });

  it("links Device 2 via real Ed25519 endorsement, bumps keyEpoch, supports safe link-status recovery & revokes cleanly", async () => {
    const accId = crypto.randomUUID();
    const d1Dev = makeRealEd25519DevicePayload("PRIMARY_D1", 1);
    const r1 = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: accId,
        displayName: "Multi User",
        mobileNumber: "9810002001",
        device: d1Dev.payload,
      }),
    });
    expect(r1.status).toBe(201);
    const d1Cookies = extractCookieJar("", r1.headers.getSetCookie());

    // Create peer + conversation so we can observe keyEpoch bump
    const peerRes = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "Peer",
        mobileNumber: "9810002002",
        device: makeFakeDevicePayload("PEER_D1", 1),
      }),
    });
    expect(peerRes.status).toBe(201);
    const peerJson = (await peerRes.json()) as { account: { username: string } };

    const convRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ kind: "direct", targetUsername: peerJson.account.username }),
    });
    const { conversationId } = (await convRes.json()) as { conversationId: string };

    // Step 1: Device 2 creates link-intent (gets __Host/bb_link_claim cookie)
    const intentRes = await fetch(`${baseUrl}/api/chat/devices/link-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceLabel: "Second Tab",
        matrixDeviceId: "SECOND_D2",
        device2EciesPub: "ecies_pub_key_base64_valid_length_0123456789",
      }),
    });
    expect(intentRes.status).toBe(201);
    const claimCookieOnly = extractCookieJar("", intentRes.headers.getSetCookie());
    let d2Cookies = claimCookieOnly;
    const intentJson = (await intentRes.json()) as { linkId: string; shortCode: string };
    expect(intentJson.shortCode).toHaveLength(8);

    // Step 2a: Device 1 looks up via 8-char short code
    const lookupRes = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ shortCode: intentJson.shortCode }),
    });
    expect(lookupRes.status).toBe(200);
    const lookupJson = (await lookupRes.json()) as { accountId: string };
    expect(lookupJson.accountId).toBe(accId);

    // Step 2b: Device 1 responds with Ecies challenge
    const respondRes = await fetch(`${baseUrl}/api/chat/devices/link-respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        linkId: intentJson.linkId,
        device1EciesOutMsg: "ecies_outbound_challenge_payload_0123456789",
      }),
    });
    expect(respondRes.status).toBe(200);

    // Step 3a: Device 2 polls challenge using claim cookie
    const chalRes = await fetch(`${baseUrl}/api/chat/devices/link-challenge/${intentJson.linkId}`, {
      headers: { Cookie: d2Cookies },
    });
    expect(chalRes.status).toBe(200);
    const chalJson = (await chalRes.json()) as { status: string; accountId: string };
    expect(chalJson.status).toBe("challenge_issued");
    expect(chalJson.accountId).toBe(accId);

    // Step 3b: Device 2 submits OlmMachine keys + key proof
    const d2Dev = makeRealEd25519DevicePayload("SECOND_D2", 2);
    const subKeysRes = await fetch(`${baseUrl}/api/chat/devices/link-submit-keys/${intentJson.linkId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d2Cookies },
      body: JSON.stringify({
        deviceKeysJson: d2Dev.payload.deviceKeysJson,
        oneTimeKeys: d2Dev.payload.oneTimeKeys,
        fallbackKey: d2Dev.payload.fallbackKey,
        device2KeyProofCiphertext: "sealed_ed25519_proof_ciphertext",
      }),
    });
    expect(subKeysRes.status).toBe(200);

    // Forged Ed25519 endorsement must be rejected with 403
    const badApprove = await fetch(`${baseUrl}/api/chat/devices/link-approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        linkId: intentJson.linkId,
        device1EndorsementSig: JSON.stringify({
          [`@${accId}:chat.bitebend.in`]: {
            "ed25519:PRIMARY_D1": Buffer.alloc(64, 1).toString("base64").replace(/=+$/, ""),
          },
        }),
      }),
    });
    expect(badApprove.status).toBe(403);

    // Step 4: Device 1 approves SAS with real Ed25519 signature of Device 2
    const realEndorsementSig = d1Dev.signEndorsement(accId, "SECOND_D2", d2Dev.ed25519B64);
    const appRes = await fetch(`${baseUrl}/api/chat/devices/link-approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        linkId: intentJson.linkId,
        device1EndorsementSig: realEndorsementSig,
      }),
    });
    expect(appRes.status).toBe(200);
    const appJson = (await appRes.json()) as { device: { id: string; matrixDeviceId: string } };
    expect(appJson.device.matrixDeviceId).toBe("SECOND_D2");

    // Step 5 (Interrupted recovery): Device 2 calls link-status, suppose response drops before client stores bb_chat_sess
    const firstStatusRes = await fetch(`${baseUrl}/api/chat/devices/link-status/${intentJson.linkId}`, {
      headers: { Cookie: claimCookieOnly },
    });
    expect(firstStatusRes.status).toBe(200);
    const lostSessionCookie = extractCookieJar("", firstStatusRes.headers.getSetCookie());

    // Retry with only claimCookie recovers and rotates session, revoking lostSessionCookie!
    const retryStatusRes = await fetch(`${baseUrl}/api/chat/devices/link-status/${intentJson.linkId}`, {
      headers: { Cookie: claimCookieOnly },
    });
    expect(retryStatusRes.status).toBe(200);
    d2Cookies = extractCookieJar(d2Cookies, retryStatusRes.headers.getSetCookie());
    const statusJson = (await retryStatusRes.json()) as { approved: boolean };
    expect(statusJson.approved).toBe(true);

    // Discarded first session MUST be revoked immediately (no multiple sessions leaked!)
    const lostSessionCheck = await fetch(`${baseUrl}/api/chat/conversations`, { headers: { Cookie: lostSessionCookie } });
    expect(lostSessionCheck.status).toBe(401);

    // Polling again WITH the active d2Cookies session is idempotent
    const idemStatusRes = await fetch(`${baseUrl}/api/chat/devices/link-status/${intentJson.linkId}`, {
      headers: { Cookie: d2Cookies },
    });
    expect(idemStatusRes.status).toBe(200);
    expect(((await idemStatusRes.json()) as { approved: boolean }).approved).toBe(true);

    // Finalize with link-ack -> future replay using claimCookieOnly MUST NOT mint a new session
    const ackRes = await fetch(`${baseUrl}/api/chat/devices/link-ack/${intentJson.linkId}`, {
      method: "POST",
      headers: { Cookie: d2Cookies },
    });
    expect(ackRes.status).toBe(200);

    const replayAfterAck = await fetch(`${baseUrl}/api/chat/devices/link-status/${intentJson.linkId}`, {
      headers: { Cookie: claimCookieOnly },
    });
    expect(replayAfterAck.status).toBe(200);
    expect((await replayAfterAck.json()) as { status: string; approved: boolean }).toEqual({
      status: "claimed",
      approved: false,
    });

    // Verify /keys/query returns verified endorsements and filters out DB-tampered devices
    await chatDb.insert(messagingDevices).values({
      accountId: accId,
      deviceLabel: "DB Injected Rogue",
      matrixDeviceId: "TAMPERED_D3",
      identityKeyEd25519: Buffer.alloc(32, 8).toString("base64").replace(/=+$/, ""),
      identityKeyCurve25519: "curve_rogue",
      deviceKeysJson: { keys: {} },
      endorsedByDeviceId: appJson.device.id,
      endorsementSig: realEndorsementSig, // wrong target / invalid sig for TAMPERED_D3
      status: "active",
    });

    const queryRes = await fetch(`${baseUrl}/api/chat/keys/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ device_keys: { [`@${accId}:chat.bitebend.in`]: [] } }),
    });
    expect(queryRes.status).toBe(200);
    const qJson = (await queryRes.json()) as {
      device_keys: Record<string, Record<string, unknown>>;
      endorsements: Record<string, Record<string, { endorsementSig: string | null }>>;
    };
    const uid = `@${accId}:chat.bitebend.in`;
    expect(Object.keys(qJson.device_keys[uid] ?? {})).toContain("PRIMARY_D1");
    expect(Object.keys(qJson.device_keys[uid] ?? {})).toContain("SECOND_D2");
    expect(Object.keys(qJson.device_keys[uid] ?? {})).not.toContain("TAMPERED_D3");
    expect(qJson.endorsements[uid]?.SECOND_D2?.endorsementSig).toBe(realEndorsementSig);

    // Verify Device 2 can now list conversations & keyEpoch bumped from 1 -> 2
    const d2Convs = await fetch(`${baseUrl}/api/chat/conversations`, { headers: { Cookie: d2Cookies } });
    expect(d2Convs.status).toBe(200);
    const d2ConvsJson = (await d2Convs.json()) as { conversations: { id: string; keyEpoch: number }[] };
    expect(d2ConvsJson.conversations.find((c) => c.id === conversationId)?.keyEpoch).toBe(2);

    // Revoke Device 2 from Device 1 -> keyEpoch bumps to 3, Device 2 session immediately 401
    const revRes = await fetch(`${baseUrl}/api/chat/devices/${appJson.device.id}`, {
      method: "DELETE",
      headers: { Cookie: d1Cookies },
    });
    expect(revRes.status).toBe(200);

    const d2AfterRevoke = await fetch(`${baseUrl}/api/chat/conversations`, { headers: { Cookie: d2Cookies } });
    expect(d2AfterRevoke.status).toBe(401);

    const d1Convs = await fetch(`${baseUrl}/api/chat/conversations`, { headers: { Cookie: d1Cookies } });
    const d1ConvsJson = (await d1Convs.json()) as { conversations: { id: string; keyEpoch: number }[] };
    expect(d1ConvsJson.conversations.find((c) => c.id === conversationId)?.keyEpoch).toBe(3);
  });

  it("enforces failedAttempts lockout on wrong QR secret, wrong endorsement sig, and shortCode brute-force", async () => {
    const accId = crypto.randomUUID();
    const d1Dev = makeRealEd25519DevicePayload("LOCK_D1", 1);
    const reg = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: accId,
        displayName: "Lock Test",
        mobileNumber: "9810003001",
        device: d1Dev.payload,
      }),
    });
    expect(reg.status).toBe(201);
    const d1Cookies = extractCookieJar("", reg.headers.getSetCookie());

    // 1) Wrong QR secret 5 times -> locks token as rejected (429), subsequent valid QR secret returns 429
    const intentQr = await fetch(`${baseUrl}/api/chat/devices/link-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceLabel: "Lock QR Browser",
        matrixDeviceId: "LOCK_QR2",
        device2EciesPub: "ecies_pub_key_base64_valid_length_0123456789",
      }),
    }).then((r) => r.json() as Promise<{ linkId: string; qrPayload: string; shortCode: string }>);

    for (let i = 0; i < 4; i++) {
      const bad = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: d1Cookies },
        body: JSON.stringify({
          qrPayload: JSON.stringify({ v: 1, linkId: intentQr.linkId, secret: `wrong_${i}` }),
        }),
      });
      expect(bad.status).toBe(403);
    }
    const fifthBad = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        qrPayload: JSON.stringify({ v: 1, linkId: intentQr.linkId, secret: "wrong_4" }),
      }),
    });
    expect(fifthBad.status).toBe(429);

    // Even valid QR payload is now locked at 429
    const afterLock = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ qrPayload: intentQr.qrPayload }),
    });
    expect(afterLock.status).toBe(429);

    // 2) Wrong endorsement signature 5 times on link-approve -> locks link token (429)
    const intentEndorse = await fetch(`${baseUrl}/api/chat/devices/link-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceLabel: "Lock Endorse Browser",
        matrixDeviceId: "LOCK_ED2",
        device2EciesPub: "ecies_pub_key_base64_valid_length_0123456789",
      }),
    });
    const d2Claim = extractCookieJar("", intentEndorse.headers.getSetCookie());
    const intentEndorseJson = (await intentEndorse.json()) as { linkId: string; shortCode: string };

    await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ shortCode: intentEndorseJson.shortCode }),
    });
    await fetch(`${baseUrl}/api/chat/devices/link-respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        linkId: intentEndorseJson.linkId,
        device1EciesOutMsg: "ecies_outbound_challenge_payload_0123456789",
      }),
    });
    const d2Keys = makeRealEd25519DevicePayload("LOCK_ED2", 1);
    await fetch(`${baseUrl}/api/chat/devices/link-submit-keys/${intentEndorseJson.linkId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d2Claim },
      body: JSON.stringify({
        deviceKeysJson: d2Keys.payload.deviceKeysJson,
        oneTimeKeys: d2Keys.payload.oneTimeKeys,
        device2KeyProofCiphertext: "sealed_ed25519_proof",
      }),
    });

    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/api/chat/devices/link-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: d1Cookies },
        body: JSON.stringify({
          linkId: intentEndorseJson.linkId,
          device1EndorsementSig: `bad_endorsement_sig_attempt_${i}`,
        }),
      });
      expect(r.status).toBe(403);
    }
    const fifthEndorse = await fetch(`${baseUrl}/api/chat/devices/link-approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({
        linkId: intentEndorseJson.linkId,
        device1EndorsementSig: "bad_endorsement_sig_attempt_4",
      }),
    });
    expect(fifthEndorse.status).toBe(429);

    // 3) 5 failed shortCode guesses lock shortCode lookup at 429
    for (let i = 0; i < 4; i++) {
      const scMiss = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: d1Cookies },
        body: JSON.stringify({ shortCode: `BADCODE${i}` }),
      });
      expect(scMiss.status).toBe(404);
    }
    const fifthShortCode = await fetch(`${baseUrl}/api/chat/devices/link-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: d1Cookies },
      body: JSON.stringify({ shortCode: "BADCODE9" }),
    });
    expect(fifthShortCode.status).toBe(429);
  });
});
