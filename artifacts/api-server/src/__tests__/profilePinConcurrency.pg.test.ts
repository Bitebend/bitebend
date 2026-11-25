import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { eq } from "drizzle-orm";
import { verifyConnectedMainTestDbIdentity } from "../lib/testDbSafetyGuard";

const {
  originalEnvSnapshot,
  testPgUrl,
  testPgIdentity,
} = await vi.hoisted(async () => {
  const { assertSafeMainTestDatabase } = await import("../lib/testDbSafetyGuard");
  const snapshot: NodeJS.ProcessEnv = { ...process.env };
  const safe = assertSafeMainTestDatabase(snapshot);

  process.env["DATABASE_URL"] = safe.testUrl;
  delete process.env["USE_LOCAL_DB"];
  process.env["CHAT_INTERNAL_HMAC_SECRET"] =
    process.env["CHAT_INTERNAL_HMAC_SECRET"] || "test-stage2-pg-s2s-secret-0123456789";
  process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v1";
  process.env["PROFILE_PIN_PEPPER_VERSION"] = "1";
  process.env["PROFILE_PIN_OTP_PEPPER"] = "test-otp-pepper-v1";
  process.env["PROFILE_PIN_OTP_PEPPER_VERSION"] = "1";
  process.env["CHAT_PHONE_PEPPER"] = "test-chat-phone-pepper";
  process.env["PROFILE_PIN_TOKEN_SECRET"] = "test-profile-pin-token-secret";

  return {
    originalEnvSnapshot: snapshot,
    testPgUrl: safe.testUrl,
    testPgIdentity: safe.identity,
  };
});

import app from "../app";
import { db, pool, restaurants, restaurantProfilePins, profilePinOtpChallenges, users } from "@workspace/db";
import { generateToken } from "../lib/token";
import { clearSecurityTestHooks, registerSecurityTestHooks } from "../lib/securityTx";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function reqJson(
  baseUrl: string,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers; setCookies: string[] }> {
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-proto": "https",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-json response
  }
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, body: parsed, headers: res.headers, setCookies };
}

describe("Stage 2 External PostgreSQL Multi-Connection Concurrency Suite (Main API)", () => {
  let controlPool: pg.Pool;
  let server: http.Server;
  let baseUrl = "";
  let mockChatServer: http.Server;
  let lastSentOtp = "";
  let onSendOtpS2SHook: ((payload: { restaurantId: number; challengeId: string }) => Promise<void>) | null = null;

  let adminId = 0;
  let adminToken = "";
  let adminCookie = "";

  const createdRestaurantIds: number[] = [];
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    controlPool = new pg.Pool({ connectionString: testPgUrl, max: 8 });
    const client = await controlPool.connect();
    try {
      // Mandatory live DB identity verification BEFORE any migrations or writes
      await verifyConnectedMainTestDbIdentity(client, testPgIdentity, originalEnvSnapshot);
      await client.query(`
        CREATE TABLE IF NOT EXISTS "sessions" (
          "sid" varchar NOT NULL COLLATE "default",
          "sess" json NOT NULL,
          "expire" timestamp(6) NOT NULL,
          CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
        );
        CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" ("expire");
      `);
    } finally {
      client.release();
    }

    const migrationsFolder = path.resolve(__dirname, "../../../../lib/db/drizzle");
    await migrate(db as any, { migrationsFolder });

    // Mock S2S Chat Server
    const chatApp = express();
    chatApp.use(express.json());
    chatApp.post("/api/internal/security/send-otp", async (req, res) => {
      lastSentOtp = String(req.body?.otp ?? "");
      if (onSendOtpS2SHook) {
        await onSendOtpS2SHook({
          restaurantId: Number(req.body?.restaurantId ?? 0),
          challengeId: String(req.body?.challengeId ?? ""),
        });
      }
      res.status(201).json({
        ok: true,
        deliveryStatus: "delivered",
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        committedAt: new Date().toISOString(),
      });
    });
    chatApp.get("/api/internal/security/challenges/:id", (_req, res) => {
      res.json({ found: true, deliveryStatus: "delivered", delivered: true });
    });
    chatApp.post("/api/internal/security/challenges/:id/cancel", (_req, res) => {
      res.json({ ok: true, status: "cancelled", alreadyDelivered: false });
    });
    mockChatServer = http.createServer(chatApp);
    await new Promise<void>((r) => mockChatServer.listen(0, "127.0.0.1", r));
    const chatAddr = mockChatServer.address() as { port: number };
    process.env["CHAT_API_INTERNAL_URL"] = `http://127.0.0.1:${chatAddr.port}`;

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Seed isolated SuperAdmin + unlock SensitiveAuth
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const [admin] = await db
      .insert(users)
      .values({
        name: "PG Suite Admin",
        email: `pg-admin-${uniqueSuffix}@test.local`,
        passwordHash: await bcrypt.hash("AdminPass!123", 10),
        role: "super_admin",
      })
      .returning();
    adminId = admin.id;
    createdUserIds.push(adminId);
    adminToken = generateToken({ userId: adminId, role: "super_admin" });

    const setupSens = await reqJson(
      baseUrl,
      "POST",
      "/api/admin/sensitive-auth/setup",
      { password: "PgSensitivePass!1" },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(setupSens.status).toBe(200);
    adminCookie = setupSens.setCookies.map((c) => c.split(";")[0]).join("; ");
  });

  afterAll(async () => {
    clearSecurityTestHooks();
    for (const rid of createdRestaurantIds) {
      await db.delete(profilePinOtpChallenges).where(eq(profilePinOtpChallenges.restaurantId, rid)).catch(() => {});
      await db.delete(restaurantProfilePins).where(eq(restaurantProfilePins.restaurantId, rid)).catch(() => {});
      await db.delete(restaurants).where(eq(restaurants.id, rid)).catch(() => {});
    }
    for (const uid of createdUserIds) {
      await db.delete(users).where(eq(users.id, uid)).catch(() => {});
    }
    server.closeAllConnections?.();
    mockChatServer.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => mockChatServer.close(() => r()));
    await controlPool.end();
    await pool.end();
  });

  beforeEach(() => {
    clearSecurityTestHooks();
    onSendOtpS2SHook = null;
    process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v1";
    process.env["PROFILE_PIN_PEPPER_VERSION"] = "1";
    delete process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"];
  });

  async function seedOwnerAndRestaurant(label: string) {
    const uniq = `${label}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const [rest] = await db
      .insert(restaurants)
      .values({
        name: `PG ${label}`,
        slug: `pg-${uniq}`,
        cuisineType: "multi_cuisine",
        address: "100 Test St",
        locality: "Test",
        city: "Bengaluru",
        state: "Karnataka",
        phone: "9811122233",
        email: `${uniq}@test.local`,
        approvalStatus: "approved",
        subscriptionStatus: "active",
        isActive: true,
      })
      .returning();
    createdRestaurantIds.push(rest.id);

    const [owner] = await db
      .insert(users)
      .values({
        name: `Owner ${label}`,
        email: `${uniq}@test.local`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: rest.id,
        registrationPhone: "9811122233",
        registrationPhoneNorm: "919811122233",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    createdUserIds.push(owner.id);

    await db.update(restaurants).set({ ownerId: owner.id }).where(eq(restaurants.id, rest.id));
    const token = generateToken({ userId: owner.id, email: owner.email, role: "owner" });
    return { owner, rest, auth: { Authorization: `Bearer ${token}` } };
  }

  it("F-14 positive control: proves distinct pg_backend_pid() sessions and exact pg_blocking_pids() observation across controlPool connections", async () => {
    const { rest } = await seedOwnerAndRestaurant("posctrl");
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
      await blockerClient.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE`, [rest.id]);

      await waiterClient.query("BEGIN");
      waiterQueryPromise = waiterClient.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE`, [rest.id]);

      let observedBlockers: number[] = [];
      for (let i = 0; i < 30; i++) {
        const res = await observerClient.query<{ blockers: number[] }>(
          `SELECT pg_blocking_pids($1)::int[] AS blockers`,
          [waiterPid],
        );
        observedBlockers = (res.rows[0]?.blockers ?? []).map(Number);
        if (observedBlockers.includes(blockerPid)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(observedBlockers).toContain(blockerPid);

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

  it("C-02, F-12 & F-14: blocks concurrent verify connections behind real PostgreSQL FOR UPDATE lock with distinct pg_backend_pid() / pg_blocking_pids() and skips bcrypt after 5th failure", async () => {
    const { rest, auth } = await seedOwnerAndRestaurant("c02");
    const setupRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "7391", confirmPin: "7391" }, auth);
    expect(setupRes.status).toBe(201);

    // Fail 4 times first
    for (let i = 0; i < 4; i++) {
      const r = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, auth);
      expect(r.status).toBe(401);
    }

    const req5InLock = createDeferred();
    const releaseReq5 = createDeferred();
    let hookArmed = true;
    let holderPid = 0;

    registerSecurityTestHooks({
      onVerifyLockAcquired: async ({ restaurantId, readBackendPid }) => {
        if (restaurantId === rest.id && hookArmed) {
          hookArmed = false;
          holderPid = (await readBackendPid?.()) ?? 0;
          req5InLock.resolve();
          await releaseReq5.promise;
        }
      },
    });

    const compareSpy = vi.spyOn(bcrypt, "compare");
    compareSpy.mockClear();

    try {
      // Launch #5 (wrong PIN) and hold its PostgreSQL FOR UPDATE row lock
      const p5 = reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, auth);
      let p6!: ReturnType<typeof reqJson>;
      let p7!: ReturnType<typeof reqJson>;
      let blockedRows: Array<{ pid: number; blockers: number[] }> = [];

      try {
        await req5InLock.promise;
        expect(holderPid).toBeGreaterThan(0);

        // Now launch #6 (wrong PIN) and #7 (CORRECT PIN!) concurrently while #5 holds the PG row lock
        p6 = reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, auth);
        p7 = reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "7391" }, auth);

        // Observe real PostgreSQL row-lock blocking via pg_blocking_pids() & distinct backend PIDs
        // Note: PostgreSQL LockTuple queues multiple concurrent FOR UPDATE waiters sequentially
        // (waiter2 -> waiter1 -> holderPid), so traverse the live pg_blocking_pids() chain.
        for (let i = 0; i < 40; i++) {
          const waitCheck = await controlPool.query<{ pid: number; blockers: number[] }>(
            `WITH RECURSIVE lock_chain AS (
               SELECT pid::int AS pid, pg_blocking_pids(pid)::int[] AS blockers
               FROM pg_stat_activity
               WHERE datname = current_database()
                 AND pid <> pg_backend_pid()
                 AND state = 'active'
                 AND wait_event_type = 'Lock'
                 AND $1 = ANY(pg_blocking_pids(pid))
               UNION
               SELECT a.pid::int AS pid, pg_blocking_pids(a.pid)::int[] AS blockers
               FROM pg_stat_activity a
               JOIN lock_chain lc ON lc.pid = ANY(pg_blocking_pids(a.pid))
               WHERE a.datname = current_database()
                 AND a.pid <> pg_backend_pid()
                 AND a.state = 'active'
                 AND a.wait_event_type = 'Lock'
             )
             SELECT pid, blockers FROM lock_chain`,
            [holderPid],
          );
          blockedRows = waitCheck.rows;
          if (blockedRows.length >= 2) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(blockedRows.length).toBeGreaterThanOrEqual(2);
        expect(blockedRows.some((r) => r.blockers.map(Number).includes(holderPid))).toBe(true);
        expect(new Set([holderPid, ...blockedRows.map((r) => Number(r.pid))]).size).toBeGreaterThanOrEqual(3);
      } finally {
        // Always release #5 so it commits or finishes before idle_in_transaction_session_timeout
        releaseReq5.resolve();
      }

      const [r5, r6, r7] = await Promise.all([p5, p6, p7]);

      expect(r5.status).toBe(429);
      expect(r5.body.code).toBe("PIN_LOCKED");
      expect(r6.status).toBe(429);
      expect(r6.body.code).toBe("PIN_LOCKED");
      expect(r7.status).toBe(429);
      expect(r7.body.code).toBe("PIN_LOCKED");
      // Only #5 ran bcrypt; #6 and #7 saw lockedUntil > clock_timestamp() under lock and exited cleanly
      expect(compareSpy).toHaveBeenCalledTimes(1);
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("F-06 & F-11: serializes missing-PIN-row reset-with-otp vs admin reset behind (0) restaurants FOR UPDATE anchor, leaves clean tombstone, and increments pin_version on setup", async () => {
    const { rest, auth } = await seedOwnerAndRestaurant("f06");
    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "1122", confirmPin: "1122" }, auth);
    const verifyBeforeReset = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "1122" }, auth);
    expect(verifyBeforeReset.status).toBe(200);
    const preResetUnlockToken = verifyBeforeReset.body.unlockToken as string;

    const otpReq = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, auth);
    expect(otpReq.status).toBe(201);
    const challengeId = otpReq.body.challengeId as string;
    const otp = lastSentOtp;

    // Delete PIN row so restaurant_profile_pins row does NOT exist
    await db.delete(restaurantProfilePins).where(eq(restaurantProfilePins.restaurantId, rest.id));

    const resetOtpHeld = createDeferred();
    const releaseResetOtp = createDeferred();
    const executionSequence: string[] = [];
    const anchorPids: number[] = [];

    registerSecurityTestHooks({
      onResetWithOtpAnchorAcquired: async ({ restaurantId, readBackendPid }) => {
        if (restaurantId === rest.id) {
          executionSequence.push("reset_with_otp_acquired");
          const pid = (await readBackendPid?.()) ?? 0;
          if (pid > 0) anchorPids.push(pid);
          resetOtpHeld.resolve();
          await releaseResetOtp.promise;
        }
      },
      onAdminResetAnchorAcquired: async ({ restaurantId, readBackendPid }) => {
        if (restaurantId === rest.id) {
          executionSequence.push("admin_reset_acquired");
          const pid = (await readBackendPid?.()) ?? 0;
          if (pid > 0) anchorPids.push(pid);
        }
      },
    });

    const resetWithOtpPromise = reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId, otp, newPin: "4455", confirmPin: "4455" },
      auth,
    );
    await resetOtpHeld.promise;

    // Launch concurrent admin reset while reset-with-otp holds restaurants anchor on missing child PIN row
    const adminResetPromise = reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${rest.id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );

    await new Promise((r) => setTimeout(r, 150));
    // Admin reset MUST still be blocked waiting for (0) restaurants FOR UPDATE
    expect(executionSequence).toEqual(["reset_with_otp_acquired"]);

    releaseResetOtp.resolve();
    const [otpResetRes, adminResetRes] = await Promise.all([resetWithOtpPromise, adminResetPromise]);
    clearSecurityTestHooks();
    expect(otpResetRes.status).toBe(200);
    expect(adminResetRes.status).toBe(200);
    expect(adminResetRes.body.hadPin).toBe(true);
    expect(executionSequence).toEqual(["reset_with_otp_acquired", "admin_reset_acquired"]);
    expect(anchorPids.length).toBe(2);

    // Final DB state MUST hold clean F-11 tombstone with pinVersion incremented to 2
    const [tombstonePin] = await db
      .select()
      .from(restaurantProfilePins)
      .where(eq(restaurantProfilePins.restaurantId, rest.id))
      .limit(1);
    expect(tombstonePin).toBeDefined();
    expect(tombstonePin.pinHash).toBeNull();
    expect(tombstonePin.pinSetAt).toBeNull();
    expect(tombstonePin.pinVersion).toBe(2);
    expect(tombstonePin.failedAttempts).toBe(0);
    expect(tombstonePin.lockoutLevel).toBe(0);
    expect(tombstonePin.lockedUntil).toBeNull();
    expect(tombstonePin.lastFailedAt).toBeNull();

    // Subsequent setup on tombstone increments pinVersion -> 3 and pre-reset token remains invalid
    const reSetupRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "6677", confirmPin: "6677" }, auth);
    expect(reSetupRes.status).toBe(201);
    expect(reSetupRes.body.pinVersion).toBe(3);

    const staleAttempt = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...auth,
      "X-Profile-Pin-Token": preResetUnlockToken,
    });
    expect(staleAttempt.status).toBe(403);
    expect(staleAttempt.body.code).toBe("PIN_REQUIRED");
  });

  it("executes change vs reset-with-otp concurrently without PostgreSQL 40P01 deadlocks and maps 55P03 lock_timeout to 503", async () => {
    const { rest, auth } = await seedOwnerAndRestaurant("deadlock");
    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "1234", confirmPin: "1234" }, auth);
    const otpReq = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, auth);
    expect(otpReq.status).toBe(201);

    const [changeRes, resetRes] = await Promise.all([
      reqJson(baseUrl, "POST", "/api/owner/profile/pin/change", { currentPin: "1234", newPin: "5678", confirmPin: "5678" }, auth),
      reqJson(
        baseUrl,
        "POST",
        "/api/owner/profile/pin/reset-with-otp",
        { challengeId: otpReq.body.challengeId, otp: lastSentOtp, newPin: "9012", confirmPin: "9012" },
        auth,
      ),
    ]);
    // Neither transaction may 500 or deadlock (40P01)
    expect([200, 400, 401, 503]).toContain(changeRes.status);
    expect([200, 400, 503]).toContain(resetRes.status);

    // Real PostgreSQL 55P03 lock_timeout test: external session holds FOR UPDATE on restaurants > 2200ms
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE`, [rest.id]);

      const contendedRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/lock", {}, auth);
      expect(contendedRes.status).toBe(503);
      expect(contendedRes.headers.get("retry-after")).toBe("2");
      expect(contendedRes.body.code).toBe("DB_CONTENTION_RETRY");
    } finally {
      await lockClient.query("ROLLBACK").catch(() => {});
      lockClient.release();
    }
  });

  it("enforces partial unique index 23505, C-01 post-lock clock_timestamp(), and G-01 pepper rehash race safety", async () => {
    const { owner, rest, auth } = await seedOwnerAndRestaurant("g01pg");
    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "2468", confirmPin: "2468" }, auth);

    // C-01: Forgot-OTP Tx2 timestamps reflect post-lock clock_timestamp()
    let postDelayClockMs = 0;
    registerSecurityTestHooks({
      onForgotOtpTx2AfterLock: async ({ restaurantId, readTxClock }) => {
        if (restaurantId === rest.id) {
          await new Promise((r) => setTimeout(r, 40));
          const c = await readTxClock();
          postDelayClockMs = c.getTime();
        }
      },
    });
    const otpReq = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, auth);
    clearSecurityTestHooks();
    expect(otpReq.status).toBe(201);

    const [challengeRow] = await db
      .select()
      .from(profilePinOtpChallenges)
      .where(eq(profilePinOtpChallenges.id, otpReq.body.challengeId))
      .limit(1);
    expect(challengeRow.createdAt.getTime()).toBeGreaterThanOrEqual(postDelayClockMs);
    expect(challengeRow.updatedAt.getTime()).toBeGreaterThanOrEqual(challengeRow.createdAt.getTime());

    // Partial unique index 23505 prevents second active challenge
    await expect(
      pool.query(
        `INSERT INTO profile_pin_otp_challenges (id, restaurant_id, owner_user_id, otp_hmac, expires_at)
         VALUES ($1::uuid, $2, $3, $4, clock_timestamp() + interval '10 minutes')`,
        [crypto.randomUUID(), rest.id, owner.id, "aa".repeat(32)],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // G-01: Pepper rotation + concurrent /pin/change race -> stale rehash skips cleanly
    process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v2";
    process.env["PROFILE_PIN_PEPPER_VERSION"] = "2";
    process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = JSON.stringify({ 1: "test-pin-pepper-v1" });

    let injected = false;
    registerSecurityTestHooks({
      onVerifyBeforeRehashTx: async ({ restaurantId }) => {
        if (restaurantId === rest.id && !injected) {
          injected = true;
          const ch = await reqJson(
            baseUrl,
            "POST",
            "/api/owner/profile/pin/change",
            { currentPin: "2468", newPin: "8642", confirmPin: "8642" },
            auth,
          );
          expect(ch.status).toBe(200);
        }
      },
    });

    const vRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "2468" }, auth);
    clearSecurityTestHooks();
    expect(vRes.status).toBe(200);
    expect(injected).toBe(true);

    // Ensure new PIN 8642 remained intact
    const okNew = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "8642" }, auth);
    expect(okNew.status).toBe(200);
  });

  it("F-14 no-lock windows: holds zero PostgreSQL row locks across setup/rehash bcrypt.hash and external Chat HTTP S2S calls", async () => {
    const { owner, rest, auth } = await seedOwnerAndRestaurant("nolock");

    // 1) No DB lock held while POST /owner/profile/pin/setup runs bcrypt.hash
    let setupNowaitOk = false;
    const origHash = bcrypt.hash.bind(bcrypt);
    const hashSpy = vi.spyOn(bcrypt, "hash").mockImplementation(async (s: string, saltOrRounds: string | number) => {
      const c = await controlPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE NOWAIT`, [rest.id]);
        await c.query("ROLLBACK");
        setupNowaitOk = true;
      } finally {
        c.release();
      }
      return origHash(s, saltOrRounds as any);
    });

    const setupRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "3141", confirmPin: "3141" }, auth);
    hashSpy.mockRestore();
    expect(setupRes.status).toBe(201);
    expect(setupNowaitOk).toBe(true);

    // 2) No DB lock held during G-01 verify pepper rehash bcrypt.hash window
    process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v2";
    process.env["PROFILE_PIN_PEPPER_VERSION"] = "2";
    process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = JSON.stringify({ 1: "test-pin-pepper-v1" });

    let rehashNowaitOk = false;
    const rehashSpy = vi.spyOn(bcrypt, "hash").mockImplementation(async (s: string, saltOrRounds: string | number) => {
      const c = await controlPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE NOWAIT`, [rest.id]);
        await c.query(`SELECT id FROM restaurant_profile_pins WHERE restaurant_id = $1 FOR UPDATE NOWAIT`, [rest.id]);
        await c.query("ROLLBACK");
        rehashNowaitOk = true;
      } finally {
        c.release();
      }
      return origHash(s, saltOrRounds as any);
    });

    const verifyRehashRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "3141" }, auth);
    rehashSpy.mockRestore();
    expect(verifyRehashRes.status).toBe(200);
    expect(rehashNowaitOk).toBe(true);

    // 3) No DB lock held across external Chat HTTP S2S /send-otp call during forgot-otp
    let s2sNowaitOk = false;
    onSendOtpS2SHook = async ({ restaurantId, challengeId }) => {
      if (restaurantId === rest.id) {
        const c = await controlPool.connect();
        try {
          await c.query("BEGIN");
          await c.query(`SELECT id FROM restaurants WHERE id = $1 FOR UPDATE NOWAIT`, [rest.id]);
          await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT`, [owner.id]);
          await c.query(`SELECT id FROM restaurant_profile_pins WHERE restaurant_id = $1 FOR UPDATE NOWAIT`, [rest.id]);
          await c.query(`SELECT id FROM profile_pin_otp_challenges WHERE id = $1::uuid FOR UPDATE NOWAIT`, [challengeId]);
          await c.query("ROLLBACK");
          s2sNowaitOk = true;
        } finally {
          c.release();
        }
      }
    };

    const otpRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, auth);
    onSendOtpS2SHook = null;
    expect(otpRes.status).toBe(201);
    expect(s2sNowaitOk).toBe(true);
  });
});
