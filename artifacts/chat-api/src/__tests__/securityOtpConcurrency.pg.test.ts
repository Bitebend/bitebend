import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { verifyConnectedChatTestDbIdentity } from "../lib/testDbSafetyGuard";

const {
  originalEnvSnapshot,
  testChatPgUrl,
  testChatIdentity,
} = await vi.hoisted(async () => {
  const { assertSafeChatTestDatabase } = await import("../lib/testDbSafetyGuard");
  const snapshot: NodeJS.ProcessEnv = { ...process.env };
  const safe = assertSafeChatTestDatabase(snapshot);

  process.env["CHAT_DATABASE_URL"] = safe.testChatUrl;
  delete process.env["USE_LOCAL_DB"];
  process.env["CHAT_INTERNAL_HMAC_SECRET"] =
    process.env["CHAT_INTERNAL_HMAC_SECRET"] || "test-chat-pg-secret-hmac-key-0123456789";
  process.env["CHAT_PHONE_PEPPER"] = process.env["CHAT_PHONE_PEPPER"] || "test-phone-pepper";

  return {
    originalEnvSnapshot: snapshot,
    testChatPgUrl: safe.testChatUrl,
    testChatIdentity: safe.identity,
  };
});

import { createChatApp } from "../app";
import {
  chatDb,
  chatPool,
  ensureChatDbReady,
  messagingAccounts,
  messagingMessages,
  messagingSecurityOtpDeliveries,
} from "../db";
import { hmacPhoneDigest } from "../lib/crypto";
import { SYSTEM_SECURITY_EVENT_TYPE } from "../lib/securityConfig";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function signS2SHeaders(method: "GET" | "POST", endpointPath: string, bodyCanonical: string) {
  const secret = process.env["CHAT_INTERNAL_HMAC_SECRET"]!;
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(24).toString("hex");
  const signingInput = `${method}\n${endpointPath}\n${ts}\n${nonce}\n${sha256Hex(bodyCanonical)}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");
  return {
    ...(bodyCanonical ? { "Content-Type": "application/json" } : {}),
    "x-bitebend-ts": ts,
    "x-bitebend-nonce": nonce,
    "x-bitebend-sig": sig,
  };
}

describe("Stage 2 External PostgreSQL Multi-Connection Concurrency Suite (Chat API)", () => {
  let controlPool: pg.Pool;
  let server: http.Server;
  let baseUrl = "";
  let alicePhoneNorm = "";
  let aliceAccountId = "";

  beforeAll(async () => {
    controlPool = new pg.Pool({ connectionString: testChatPgUrl, max: 5 });
    const client = await controlPool.connect();
    try {
      // Mandatory live DB identity verification BEFORE running migrations or writing test data
      await verifyConnectedChatTestDbIdentity(client, testChatIdentity, originalEnvSnapshot);
    } finally {
      client.release();
    }

    await ensureChatDbReady();
    server = http.createServer(createChatApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Register isolated active messaging user
    const phoneDigits = String(9000000000 + Math.floor(Math.random() * 900000000));
    alicePhoneNorm = `91${phoneDigits}`;
    const deviceId = `PG_DEV_${crypto.randomBytes(4).toString("hex")}`;

    const regRes = await fetch(`${baseUrl}/api/chat/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedAccountId: crypto.randomUUID(),
        displayName: "PG Chat Owner",
        mobileNumber: phoneDigits,
        device: {
          deviceLabel: "PG Test Device",
          matrixDeviceId: deviceId,
          deviceKeysJson: {
            keys: {
              [`ed25519:${deviceId}`]: `ed_${deviceId}`,
              [`curve25519:${deviceId}`]: `curve_${deviceId}`,
            },
          },
          oneTimeKeys: {
            "signed_curve25519:AA0": { key: `otpk_${deviceId}_0` },
          },
          fallbackKey: {
            "signed_curve25519:FB1": { key: `fb_${deviceId}` },
          },
        },
      }),
    });
    expect(regRes.status).toBe(201);
    const regJson = (await regRes.json()) as { account: { id: string } };
    aliceAccountId = regJson.account.id;
  });

  afterAll(async () => {
    if (aliceAccountId) {
      await chatDb.delete(messagingAccounts).where(eq(messagingAccounts.id, aliceAccountId)).catch(() => {});
    }
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await controlPool.end();
    await chatPool.end();
  });

  it("serializes concurrent S2S send-otp retries idempotently into strictly one message", async () => {
    const challengeId = crypto.randomUUID();
    const endpoint = "/api/internal/security/send-otp";
    const body = JSON.stringify({
      challengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 505,
      restaurantName: "PG Chat Cafe",
      otp: "654321",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 15_000).toISOString(),
      remainingTtlSeconds: 600,
    });

    const responses = await Promise.all([
      fetch(`${baseUrl}${endpoint}`, { method: "POST", headers: signS2SHeaders("POST", endpoint, body), body }),
      fetch(`${baseUrl}${endpoint}`, { method: "POST", headers: signS2SHeaders("POST", endpoint, body), body }),
      fetch(`${baseUrl}${endpoint}`, { method: "POST", headers: signS2SHeaders("POST", endpoint, body), body }),
    ]);

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 201]);

    const msgs = await chatDb
      .select()
      .from(messagingMessages)
      .where(
        and(
          eq(messagingMessages.clientMsgId, challengeId),
          eq(messagingMessages.eventType, SYSTEM_SECURITY_EVENT_TYPE),
        ),
      );
    expect(msgs.length).toBe(1);
  });

  it("F-14 positive control: proves distinct pg_backend_pid() sessions and exact pg_blocking_pids() observation on controlPool", async () => {
    const challengeId = crypto.randomUUID();
    await chatDb
      .insert(messagingSecurityOtpDeliveries)
      .values({
        challengeId,
        status: "pending",
        recipientAccountId: aliceAccountId,
        deliveryDeadlineAt: new Date(Date.now() + 20_000),
        expiresAt: new Date(Date.now() + 600_000),
      })
      .onConflictDoNothing({ target: messagingSecurityOtpDeliveries.challengeId });

    const blockerClient = await controlPool.connect();
    const waiterClient = await controlPool.connect();
    const observerClient = await controlPool.connect();

    let waiterQueryPromise: Promise<unknown> | null = null;
    try {
      const [{ rows: bRows }, { rows: wRows }, { rows: oRows }] = await Promise.all([
        blockerClient.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`),
        waiterClient.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`),
        observerClient.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`),
      ]);
      const blockerPid = Number(bRows[0]?.pid ?? 0);
      const waiterPid = Number(wRows[0]?.pid ?? 0);
      const observerPid = Number(oRows[0]?.pid ?? 0);
      expect(new Set([blockerPid, waiterPid, observerPid]).size).toBe(3);

      await blockerClient.query("BEGIN");
      await blockerClient.query(
        `SELECT challenge_id FROM messaging_security_otp_deliveries WHERE challenge_id = $1 FOR UPDATE`,
        [challengeId],
      );

      await waiterClient.query("BEGIN");
      waiterQueryPromise = waiterClient.query(
        `SELECT challenge_id FROM messaging_security_otp_deliveries WHERE challenge_id = $1 FOR UPDATE`,
        [challengeId],
      );

      let blockers: number[] = [];
      for (let i = 0; i < 30; i++) {
        const res = await observerClient.query<{ blockers: number[] }>(
          `SELECT pg_blocking_pids($1)::int[] AS blockers`,
          [waiterPid],
        );
        blockers = (res.rows[0]?.blockers ?? []).map(Number);
        if (blockers.includes(blockerPid)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(blockers).toContain(blockerPid);

      await blockerClient.query("ROLLBACK");
      await waiterQueryPromise;
      await waiterClient.query("ROLLBACK");

      const cleared = await observerClient.query<{ blockers: number[] }>(
        `SELECT pg_blocking_pids($1)::int[] AS blockers`,
        [waiterPid],
      );
      expect((cleared.rows[0]?.blockers ?? []).map(Number)).toEqual([]);
    } finally {
      await blockerClient.query("ROLLBACK").catch(() => {});
      await waiterQueryPromise?.catch(() => {});
      await waiterClient.query("ROLLBACK").catch(() => {});
      blockerClient.release();
      waiterClient.release();
      observerClient.release();
    }
  });

  it("returns bounded 55P03 contention responses on GET/cancel/send-otp under real PostgreSQL row locks verified via pg_blocking_pids()", async () => {
    const challengeId = crypto.randomUUID();
    const sendEndpoint = "/api/internal/security/send-otp";
    const sendBody = JSON.stringify({
      challengeId,
      phoneHmac: hmacPhoneDigest(alicePhoneNorm),
      restaurantId: 506,
      restaurantName: "PG Lock Diner",
      otp: "777888",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deliveryDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
      remainingTtlSeconds: 600,
    });

    // Seed pending delivery row cleanly
    await chatDb
      .insert(messagingSecurityOtpDeliveries)
      .values({
        challengeId,
        status: "pending",
        recipientAccountId: aliceAccountId,
        deliveryDeadlineAt: new Date(Date.now() + 20_000),
        expiresAt: new Date(Date.now() + 600_000),
      })
      .onConflictDoNothing({ target: messagingSecurityOtpDeliveries.challengeId });

    const lockClient = await controlPool.connect();
    const observerClient = await controlPool.connect();
    try {
      const [{ rows: lRows }, { rows: oRows }] = await Promise.all([
        lockClient.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`),
        observerClient.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`),
      ]);
      const lockPid = Number(lRows[0]?.pid ?? 0);
      const observerPid = Number(oRows[0]?.pid ?? 0);
      expect(lockPid).toBeGreaterThan(0);
      expect(lockPid).not.toBe(observerPid);

      await lockClient.query("BEGIN");
      await lockClient.query(
        `SELECT challenge_id FROM messaging_security_otp_deliveries WHERE challenge_id = $1 FOR UPDATE`,
        [challengeId],
      );

      // 1) GET status probe uses 1000ms lock_timeout -> observe HTTP connection blocked by lockPid via pg_blocking_pids()
      const getPath = `/api/internal/security/challenges/${challengeId}`;
      const getPromise = fetch(`${baseUrl}${getPath}`, {
        method: "GET",
        headers: signS2SHeaders("GET", getPath, ""),
      });

      let httpWaiterPid = 0;
      for (let i = 0; i < 30; i++) {
        const res = await observerClient.query<{ pid: number }>(
          `SELECT pid::int AS pid
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND state = 'active'
             AND wait_event_type = 'Lock'
             AND $1 = ANY(pg_blocking_pids(pid))`,
          [lockPid],
        );
        if (res.rows[0]?.pid) {
          httpWaiterPid = Number(res.rows[0].pid);
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(httpWaiterPid).toBeGreaterThan(0);
      expect(httpWaiterPid).not.toBe(lockPid);

      const getRes = await getPromise;
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({
        found: true,
        deliveryStatus: "pending",
        delivered: false,
        lockContention: true,
      });

      // 2) Cancel uses 2000ms lock_timeout -> returns HTTP 503 DB_LOCK_CONTENTION
      const cancelPath = `/api/internal/security/challenges/${challengeId}/cancel`;
      const cancelRes = await fetch(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: signS2SHeaders("POST", cancelPath, ""),
      });
      expect(cancelRes.status).toBe(503);
      expect(cancelRes.headers.get("retry-after")).toBe("2");
      expect(((await cancelRes.json()) as { code: string }).code).toBe("DB_LOCK_CONTENTION");

      // 3) Send-otp uses 3000ms lock_timeout -> returns HTTP 503 uncertain / DB_LOCK_CONTENTION
      const sendContendedRes = await fetch(`${baseUrl}${sendEndpoint}`, {
        method: "POST",
        headers: signS2SHeaders("POST", sendEndpoint, sendBody),
        body: sendBody,
      });
      expect(sendContendedRes.status).toBe(503);
      expect(sendContendedRes.headers.get("retry-after")).toBe("2");
      const sendJson = (await sendContendedRes.json()) as { deliveryStatus: string; code: string };
      expect(sendJson.deliveryStatus).toBe("uncertain");
      expect(sendJson.code).toBe("DB_LOCK_CONTENTION");
    } finally {
      await lockClient.query("ROLLBACK").catch(() => {});
      lockClient.release();
      observerClient.release();
    }
  });
});
