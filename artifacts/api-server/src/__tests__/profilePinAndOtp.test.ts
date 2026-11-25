import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import type { PGlite as PGliteType } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../../../lib/db/src/schema";
import { vi } from "vitest";

const { memClient, memPool } = await vi.hoisted(async () => {
  process.env["CHAT_INTERNAL_HMAC_SECRET"] = "test-stage2-s2s-secret-0123456789abcdef";
  process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v1";
  process.env["PROFILE_PIN_PEPPER_VERSION"] = "1";
  process.env["PROFILE_PIN_OTP_PEPPER"] = "test-otp-pepper-v1";
  process.env["PROFILE_PIN_OTP_PEPPER_VERSION"] = "1";
  process.env["CHAT_PHONE_PEPPER"] = "test-chat-phone-pepper";
  process.env["PROFILE_PIN_TOKEN_SECRET"] = "test-profile-pin-token-secret";

  const { PGlite } = await import("@electric-sql/pglite");
  const client: PGliteType = new PGlite();
  const poolAdapter = {
    async query(textOrConfig: any, paramsOrCallback?: any, callback?: any): Promise<any> {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text;
      const params = Array.isArray(paramsOrCallback) ? paramsOrCallback : textOrConfig?.values || [];
      const cb = typeof paramsOrCallback === "function" ? paramsOrCallback : callback;
      try {
        const res = await client.query(text, params);
        const result = { rows: res.rows, rowCount: res.rows.length, command: "", fields: res.fields || [] };
        if (cb) cb(null, result);
        return result;
      } catch (err) {
        if (cb) {
          cb(err);
          return { rows: [], rowCount: 0, command: "", fields: [] };
        }
        throw err;
      }
    },
    on: () => {},
    connect: async () => ({ query: (...args: any[]) => poolAdapter.query(args[0], args[1], args[2]), release: () => {} }),
    end: async () => {},
  };
  return { memClient: client, memPool: poolAdapter };
});

vi.mock("@workspace/db", async () => {
  const realSchema = await import("../../../../lib/db/src/schema");
  const { drizzle: dPglite } = await import("drizzle-orm/pglite");
  const dbInst = dPglite(memClient, { schema: realSchema });
  return {
    ...realSchema,
    db: dbInst,
    pool: memPool,
    pgliteInstance: memClient,
    ensureDbReady: async () => {},
  };
});

vi.mock("@workspace/db/schema", async () => {
  return await import("../../../../lib/db/src/schema");
});

import app from "../app";
import { generateToken } from "../lib/token";
import { runSecurityOtpReconciliationSweep } from "../lib/chatSecurityClient";

async function reqJson(
  baseUrl: string,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; setCookies: string[] }> {
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
  return { status: res.status, body: parsed, setCookies };
}

describe("Stage 2 API-Server: Profile PIN Gate, Pepper Rotation, Progressive Lockout, Messaging OTP & Race Safety", () => {
  let server: http.Server;
  let baseUrl = "";
  let db: ReturnType<typeof drizzle<typeof schema>>;

  // Mock S2S Chat API server
  let mockChatServer: http.Server;
  let s2sMode: "delivered" | "recipient_not_found" | "http_500" | "cancelled" = "delivered";
  let s2sStatusProbeResult: { deliveryStatus: string; committedAt?: string; failureCode?: string } = {
    deliveryStatus: "delivered",
    committedAt: new Date().toISOString(),
  };
  let s2sSendCalls: Array<{
    challengeId: string;
    phoneHmac: string;
    otp: string;
    remainingTtlSeconds: number;
    hasValidHmac: boolean;
  }> = [];
  let s2sCancelCalls: string[] = [];
  let onChatCancelHook: ((challengeId: string) => Promise<void>) | null = null;

  let verifiedOwnerId = 0;
  let verifiedRestaurantId = 0;
  let verifiedOwnerToken = "";

  let legacyOwnerId = 0;
  let legacyRestaurantId = 0;
  let legacyOwnerToken = "";

  let adminId = 0;
  let adminToken = "";

  beforeAll(async () => {
    await memClient.waitReady;
    await memClient.exec(`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" ("expire");
    `);

    const migrationsDir = path.resolve(__dirname, "../../../../lib/db/drizzle");
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const statements = sqlContent.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        if (
          file === "0041_profile_pin_and_otp.sql" ||
          file === "0042_profile_pin_concurrency_and_otp_unique.sql"
        ) {
          await memClient.exec(stmt);
        } else {
          try {
            await memClient.exec(stmt);
          } catch {
            // Ignore already-applied baseline DDL
          }
        }
      }
    }

    // Re-run 0041 and 0042 explicitly to verify migration idempotency
    for (const migrationFile of [
      "0041_profile_pin_and_otp.sql",
      "0042_profile_pin_concurrency_and_otp_unique.sql",
    ]) {
      const migrationSql = fs.readFileSync(path.join(migrationsDir, migrationFile), "utf-8");
      for (const stmt of migrationSql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await memClient.exec(stmt);
      }
    }

    db = drizzle(memClient, { schema });

    // Start mock chat-api S2S server
    const chatApp = express();
    chatApp.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );

    const verifyHmac = (req: any, endpointPath: string, bodyCanonical: string) => {
      const ts = String(req.headers["x-bitebend-ts"] ?? "");
      const nonce = String(req.headers["x-bitebend-nonce"] ?? "");
      const sig = String(req.headers["x-bitebend-sig"] ?? "");
      const bodyHash = crypto.createHash("sha256").update(bodyCanonical, "utf8").digest("hex");
      const signingInput = `${req.method.toUpperCase()}\n${endpointPath}\n${ts}\n${nonce}\n${bodyHash}`;
      const expected = crypto
        .createHmac("sha256", process.env["CHAT_INTERNAL_HMAC_SECRET"]!)
        .update(signingInput, "utf8")
        .digest("hex");
      return sig === expected;
    };

    chatApp.post("/api/internal/security/send-otp", (req: any, res) => {
      const rawBody = req.rawBody ?? JSON.stringify(req.body);
      const hasValidHmac = verifyHmac(req, "/api/internal/security/send-otp", rawBody);
      s2sSendCalls.push({
        challengeId: req.body.challengeId,
        phoneHmac: req.body.phoneHmac,
        otp: req.body.otp,
        remainingTtlSeconds: req.body.remainingTtlSeconds,
        hasValidHmac,
      });

      if (!hasValidHmac) {
        res.status(401).json({ error: "Bad HMAC" });
        return;
      }
      if (s2sMode === "recipient_not_found") {
        res.status(404).json({ ok: false, deliveryStatus: "failed", failureCode: "RECIPIENT_NOT_FOUND" });
        return;
      }
      if (s2sMode === "http_500") {
        res.status(500).json({ error: "Upstream chat error" });
        return;
      }
      if (s2sMode === "cancelled") {
        res.status(409).json({ ok: false, deliveryStatus: "cancelled", code: "CHALLENGE_CANCELLED" });
        return;
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
      res.json({
        found: true,
        deliveryStatus: s2sStatusProbeResult.deliveryStatus,
        delivered: s2sStatusProbeResult.deliveryStatus === "delivered",
        committedAt: s2sStatusProbeResult.committedAt ?? null,
        failureCode: s2sStatusProbeResult.failureCode ?? null,
      });
    });

    chatApp.post("/api/internal/security/challenges/:id/cancel", async (req, res) => {
      const id = String(req.params.id);
      s2sCancelCalls.push(id);
      if (onChatCancelHook) {
        await onChatCancelHook(id);
      }
      res.json({ ok: true, status: "cancelled", alreadyDelivered: false });
    });

    mockChatServer = http.createServer(chatApp);
    await new Promise<void>((r) => mockChatServer.listen(0, "127.0.0.1", r));
    const chatAddr = mockChatServer.address() as { port: number };
    process.env["CHAT_API_INTERNAL_URL"] = `http://127.0.0.1:${chatAddr.port}`;

    // Seed verified owner + restaurant
    const passwordHash = await bcrypt.hash("ownerpass123", 10);
    const [rest1] = await db
      .insert(schema.restaurants)
      .values({
        name: "Verified Grill",
        slug: "verified-grill",
        cuisineType: "multi_cuisine",
        address: "100 Indiranagar",
        locality: "Indiranagar",
        city: "Bengaluru",
        state: "Karnataka",
        phone: "9876543210",
        email: "verified@stage2.local",
        approvalStatus: "approved",
        subscriptionStatus: "active",
        isActive: true,
      })
      .returning();
    verifiedRestaurantId = rest1.id;

    const [owner1] = await db
      .insert(schema.users)
      .values({
        name: "Verified Owner",
        email: "verified@stage2.local",
        passwordHash,
        role: "owner",
        restaurantId: verifiedRestaurantId,
        registrationPhone: "9876543210",
        registrationPhoneNorm: "919876543210",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    verifiedOwnerId = owner1.id;
    await db
      .update(schema.restaurants)
      .set({ ownerId: verifiedOwnerId })
      .where(eq(schema.restaurants.id, verifiedRestaurantId));
    verifiedOwnerToken = generateToken({ userId: verifiedOwnerId, role: "owner" });

    // Seed legacy owner WITHOUT verified phone -> legacy_restaurant_phone backfill behavior
    const [rest2] = await db
      .insert(schema.restaurants)
      .values({
        name: "Legacy Cafe",
        slug: "legacy-cafe",
        cuisineType: "cafe",
        address: "50 Church St",
        locality: "CBD",
        city: "Bengaluru",
        state: "Karnataka",
        phone: "9888877777",
        email: "legacy@stage2.local",
        approvalStatus: "approved",
        subscriptionStatus: "active",
        isActive: true,
      })
      .returning();
    legacyRestaurantId = rest2.id;

    const [owner2] = await db
      .insert(schema.users)
      .values({
        name: "Legacy Owner",
        email: "legacy@stage2.local",
        passwordHash,
        role: "owner",
        restaurantId: legacyRestaurantId,
        registrationPhone: "9888877777",
        registrationPhoneNorm: "919888877777",
        registrationPhoneSource: "legacy_restaurant_phone",
        registrationPhoneVerified: false,
      })
      .returning();
    legacyOwnerId = owner2.id;
    await db
      .update(schema.restaurants)
      .set({ ownerId: legacyOwnerId })
      .where(eq(schema.restaurants.id, legacyRestaurantId));
    legacyOwnerToken = generateToken({ userId: legacyOwnerId, role: "owner" });

    const [admin] = await db
      .insert(schema.users)
      .values({
        name: "Stage2 SuperAdmin",
        email: "admin@stage2.local",
        passwordHash,
        role: "super_admin",
      })
      .returning();
    adminId = admin.id;
    adminToken = generateToken({ userId: adminId, role: "super_admin" });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    mockChatServer.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => mockChatServer.close(() => r()));
  });

  beforeEach(() => {
    s2sMode = "delivered";
    s2sSendCalls = [];
    s2sCancelCalls = [];
    onChatCancelHook = null;
    process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v1";
    process.env["PROFILE_PIN_PEPPER_VERSION"] = "1";
    delete process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"];
  });

  it("enforces DB monotonic delivery trigger and append-only audit log trigger from 0041 migration", async () => {
    const cid = crypto.randomUUID();
    const cid2 = crypto.randomUUID();
    await db.insert(schema.profilePinOtpChallenges).values({
      id: cid,
      restaurantId: verifiedRestaurantId,
      ownerUserId: verifiedOwnerId,
      otpHmac: "deadbeef".repeat(8),
      otpPepperVersion: 1,
      deliveryStatus: "delivered",
      deliveredAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });

    try {
      // Cannot downgrade delivered -> pending / uncertain / failed / cancelled
      await expect(
        memClient.query(`UPDATE profile_pin_otp_challenges SET delivery_status = 'uncertain' WHERE id = $1::uuid`, [cid]),
      ).rejects.toThrow(/terminal delivery_status/);

      await expect(
        memClient.query(`UPDATE profile_pin_otp_challenges SET delivery_status = 'failed' WHERE id = $1::uuid`, [cid]),
      ).rejects.toThrow(/terminal delivery_status/);

      // Once invalidated_at is set, it cannot be cleared
      await db.insert(schema.profilePinOtpChallenges).values({
        id: cid2,
        restaurantId: verifiedRestaurantId,
        ownerUserId: verifiedOwnerId,
        otpHmac: "beefdead".repeat(8),
        otpPepperVersion: 1,
        deliveryStatus: "pending",
        invalidatedAt: new Date(),
        invalidationReason: "superseded_by_resend",
        expiresAt: new Date(Date.now() + 600_000),
      });
      await expect(
        memClient.query(`UPDATE profile_pin_otp_challenges SET invalidated_at = NULL WHERE id = $1::uuid`, [cid2]),
      ).rejects.toThrow(/invalidated_at is immutable/);

      // Append-only audit logs reject UPDATE, DELETE
      const [logRow] = await db
        .insert(schema.ownerSecurityAuditLogs)
        .values({
          restaurantIdSnapshot: verifiedRestaurantId,
          ownerUserIdSnapshot: verifiedOwnerId,
          actorUserIdSnapshot: verifiedOwnerId,
          actorRole: "owner",
          eventType: "test_immutable_audit",
        })
        .returning();
      await expect(
        memClient.query(`UPDATE owner_security_audit_logs SET event_type = 'tampered' WHERE id = $1`, [logRow.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        memClient.query(`DELETE FROM owner_security_audit_logs WHERE id = $1`, [logRow.id]),
      ).rejects.toThrow(/append-only/);
    } finally {
      await db.delete(schema.profilePinOtpChallenges).where(eq(schema.profilePinOtpChallenges.id, cid));
      await db.delete(schema.profilePinOtpChallenges).where(eq(schema.profilePinOtpChallenges.id, cid2));
    }
  });

  it("gates ONLY GET/PUT /api/owner/profile while Tables, Orders, Subscription, Summary, Stats, and Account stay un-gated", async () => {
    const authHeader = { Authorization: `Bearer ${verifiedOwnerToken}` };

    // Before PIN setup: Profile returns 403 PIN_SETUP_REQUIRED
    const profBefore = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, authHeader);
    expect(profBefore.status).toBe(403);
    expect(profBefore.body.code).toBe("PIN_SETUP_REQUIRED");

    const putBefore = await reqJson(baseUrl, "PUT", "/api/owner/profile", { name: "Blocked" }, authHeader);
    expect(putBefore.status).toBe(403);
    expect(putBefore.body.code).toBe("PIN_SETUP_REQUIRED");

    // Non-profile owner endpoints continue working normally without Profile PIN
    expect((await reqJson(baseUrl, "GET", "/api/owner/restaurant/summary", undefined, authHeader)).status).toBe(200);
    expect((await reqJson(baseUrl, "GET", "/api/owner/tables", undefined, authHeader)).status).toBe(200);
    expect((await reqJson(baseUrl, "GET", "/api/owner/orders", undefined, authHeader)).status).toBe(200);
    expect((await reqJson(baseUrl, "GET", "/api/owner/stats", undefined, authHeader)).status).toBe(200);
    expect((await reqJson(baseUrl, "GET", "/api/subscription/plans", undefined, authHeader)).status).toBe(200);
    expect(
      (await reqJson(baseUrl, "PATCH", "/api/owner/tables/seating-mode", { seatingLabel: "Table" }, authHeader)).status,
    ).toBe(200);
  });

  it(
    "supports PIN setup, duplicate 409 guard, unlock token verification, global /pin/lock revocation, /pin/change revocation, and pepper rotation",
    async () => {
    const authHeader = { Authorization: `Bearer ${verifiedOwnerToken}` };

    const setupRes = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "2580", confirmPin: "2580" },
      authHeader,
    );
    expect(setupRes.status).toBe(201);
    const tokenV1 = setupRes.body.unlockToken as string;
    expect(setupRes.body.pinVersion).toBe(1);

    // Duplicate setup blocked
    const dupSetup = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "1111", confirmPin: "1111" },
      authHeader,
    );
    expect(dupSetup.status).toBe(409);

    // Access with token works
    const okGet = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": tokenV1,
    });
    expect(okGet.status).toBe(200);
    expect(okGet.body.name).toBe("Verified Grill");

    // Global Lock increments pinVersion and immediately revokes tokenV1
    const lockRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/lock", {}, authHeader);
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.pinVersion).toBe(2);

    const revokedGet = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": tokenV1,
    });
    expect(revokedGet.status).toBe(403);
    expect(revokedGet.body.code).toBe("PIN_REQUIRED");

    // Rotate pepper v1 -> v2 while verifying old PIN ("2580") -> transparent rehash to v2
    process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v2";
    process.env["PROFILE_PIN_PEPPER_VERSION"] = "2";
    process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = JSON.stringify({ "1": "test-pin-pepper-v1" });

    const verifyRotated = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/verify",
      { pin: "2580" },
      authHeader,
    );
    expect(verifyRotated.status).toBe(200);
    const tokenV2 = verifyRotated.body.unlockToken as string;

    const [pinDbAfterRotation] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, verifiedRestaurantId))
      .limit(1);
    expect(pinDbAfterRotation.pepperVersion).toBe(2);

    // Change PIN ("2580" -> "1937") increments pinVersion to 3 and revokes tokenV2
    const changeRes = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/change",
      { currentPin: "2580", newPin: "1937", confirmPin: "1937" },
      authHeader,
    );
    expect(changeRes.status).toBe(200);
    expect(changeRes.body.pinVersion).toBe(3);
    const tokenV3 = changeRes.body.unlockToken as string;

    const staleV2 = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": tokenV2,
    });
    expect(staleV2.status).toBe(403);

    const okV3 = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": tokenV3,
    });
      expect(okV3.status).toBe(200);
    },
    15_000,
  );

  it(
    "enforces progressive 5-attempt (15m) and 10-attempt (60m) lockouts across verify",
    async () => {
      const authHeader = { Authorization: `Bearer ${verifiedOwnerToken}` };

      for (let i = 1; i <= 4; i++) {
        const r = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, authHeader);
        expect(r.status).toBe(401);
        expect(r.body.remainingAttemptsBeforeLockout).toBe(5 - i);
      }

      // 5th wrong attempt triggers Level 1 lockout (15m)
      const lock1 = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, authHeader);
      expect(lock1.status).toBe(429);
      expect(lock1.body.code).toBe("PIN_LOCKED");
      expect(lock1.body.lockoutLevel).toBe(1);

      // Even valid PIN is blocked while locked
      const blockedValid = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "1937" }, authHeader);
      expect(blockedValid.status).toBe(429);
      expect(blockedValid.body.code).toBe("PIN_LOCKED");

      // Simulate Level 1 cooldown expiration by backdating locked_until -> do 5 more wrong attempts -> Level 2 lockout (60m)
      await db
        .update(schema.restaurantProfilePins)
        .set({ lockedUntil: new Date(Date.now() - 1000) })
        .where(eq(schema.restaurantProfilePins.restaurantId, verifiedRestaurantId));

      for (let i = 1; i <= 4; i++) {
        const r = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, authHeader);
        expect(r.status).toBe(401);
      }

      const lock2 = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, authHeader);
      expect(lock2.status).toBe(429);
      expect(lock2.body.code).toBe("PIN_LOCKED");
      expect(lock2.body.lockoutLevel).toBe(2);

      const [pinRow] = await db
        .select()
        .from(schema.restaurantProfilePins)
        .where(eq(schema.restaurantProfilePins.restaurantId, verifiedRestaurantId))
        .limit(1);
      expect(pinRow.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(50 * 60 * 1000);
    },
    15_000,
  );

  it(
    "blocks legacy unverified owners from OTP recovery, delivers verified OTP with fresh TTL & rate limits, enforces OTP max attempts, replay rejection, and pre-dispatch race invariant",
    async () => {
    // Legacy owner setup + forgot-otp blocked with PHONE_NOT_VERIFIED_FOR_OTP
    await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "3333", confirmPin: "3333" },
      { Authorization: `Bearer ${legacyOwnerToken}` },
    );
    const legacyOtpReq = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/forgot-otp",
      {},
      { Authorization: `Bearer ${legacyOwnerToken}` },
    );
    expect(legacyOtpReq.status).toBe(403);
    expect(legacyOtpReq.body.code).toBe("PHONE_NOT_VERIFIED_FOR_OTP");

    // Verified owner requests OTP (even while PIN is locked)
    const authHeader = { Authorization: `Bearer ${verifiedOwnerToken}` };
    const otp1Res = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, authHeader);
    expect(otp1Res.status).toBe(201);
    expect(otp1Res.body.deliveryStatus).toBe("delivered");
    expect(s2sSendCalls.length).toBe(1);
    expect(s2sSendCalls[0].hasValidHmac).toBe(true);
    expect(s2sSendCalls[0].remainingTtlSeconds).toBeGreaterThan(590);
    expect(s2sSendCalls[0].remainingTtlSeconds).toBeLessThanOrEqual(600);
    const challenge1Id = otp1Res.body.challengeId as string;
    const otp1Code = s2sSendCalls[0].otp;

    // 60s cooldown blocks immediate resend
    const cooldownRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, authHeader);
    expect(cooldownRes.status).toBe(429);
    expect(cooldownRes.body.code).toBe("OTP_COOLDOWN");

    // Wrong OTP attempts x5 invalidate challenge1 with OTP_MAX_ATTEMPTS
    for (let i = 1; i <= 4; i++) {
      const wrong = await reqJson(
        baseUrl,
        "POST",
        "/api/owner/profile/pin/reset-with-otp",
        { challengeId: challenge1Id, otp: otp1Code === "000000" ? "111111" : "000000", newPin: "4444", confirmPin: "4444" },
        authHeader,
      );
      expect(wrong.status).toBe(401);
      expect(wrong.body.remainingAttempts).toBe(5 - i);
    }
    const maxAtt = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId: challenge1Id, otp: otp1Code === "000000" ? "111111" : "000000", newPin: "4444", confirmPin: "4444" },
      authHeader,
    );
    expect(maxAtt.status).toBe(429);
    expect(maxAtt.body.code).toBe("OTP_MAX_ATTEMPTS");

    // Backdate challenge1 createdAt > 65s ago so resend succeeds
    await db
      .update(schema.profilePinOtpChallenges)
      .set({ createdAt: new Date(Date.now() - 70_000) })
      .where(eq(schema.profilePinOtpChallenges.id, challenge1Id));

    // Dispatch with upstream 500 -> marks delivery 'uncertain'
    s2sMode = "http_500";
    const otpUncertainRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, authHeader);
    expect(otpUncertainRes.status).toBe(201);
    expect(otpUncertainRes.body.deliveryStatus).toBe("uncertain");
    const uncertainChallengeId = otpUncertainRes.body.challengeId as string;
    const uncertainOtpCode = s2sSendCalls[1].otp;

    // Reconciliation resolves 'uncertain' -> 'delivered' cleanly
    s2sStatusProbeResult = { deliveryStatus: "delivered", committedAt: new Date().toISOString() };
    await runSecurityOtpReconciliationSweep();
    const [reconciledRow] = await db
      .select()
      .from(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.id, uncertainChallengeId))
      .limit(1);
    expect(reconciledRow.deliveryStatus).toBe("delivered");

    // PRE-DISPATCH RACE INVARIANT:
    // Resend supersedes prior challenge (even if it became delivered late); reset-with-otp MUST reject prior OTP
    await db
      .update(schema.profilePinOtpChallenges)
      .set({ createdAt: new Date(Date.now() - 70_000) })
      .where(eq(schema.profilePinOtpChallenges.id, uncertainChallengeId));
    s2sMode = "delivered";
    const otp3Res = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, authHeader);
    expect(otp3Res.status).toBe(201);
    const challenge3Id = otp3Res.body.challengeId as string;
    const otp3Code = s2sSendCalls[2].otp;

    // Superseded uncertainChallengeId (even though 'delivered') MUST be rejected!
    const trySuperseded = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId: uncertainChallengeId, otp: uncertainOtpCode, newPin: "5555", confirmPin: "5555" },
      authHeader,
    );
    expect(trySuperseded.status).toBe(400);
    expect(trySuperseded.body.code).toBe("OTP_INVALIDATED");

    // Rate limit 3 requests per 15 minutes blocks 4th request even if cooldown passed
    await db
      .update(schema.profilePinOtpChallenges)
      .set({ createdAt: new Date(Date.now() - 70_000) })
      .where(eq(schema.profilePinOtpChallenges.id, challenge3Id));
    const rateLimited15m = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, authHeader);
    expect(rateLimited15m.status).toBe(429);
    expect(rateLimited15m.body.code).toBe("OTP_RATE_LIMIT_15M");

    // Valid OTP resets PIN ("6789"), clears Level 2 lockout, unlocks profile
    const validReset = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId: challenge3Id, otp: otp3Code, newPin: "6789", confirmPin: "6789" },
      authHeader,
    );
    expect(validReset.status).toBe(200);
    expect(validReset.body.ok).toBe(true);
    const unlockAfterReset = validReset.body.unlockToken as string;

    // Profile is immediately accessible
    const profUnlocked = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": unlockAfterReset,
    });
    expect(profUnlocked.status).toBe(200);

    // Replay of already-consumed OTP fails cleanly
    const replayReset = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId: challenge3Id, otp: otp3Code, newPin: "8888", confirmPin: "8888" },
      authHeader,
    );
    expect(replayReset.status).toBe(400);
      expect(replayReset.body.code).toBe("OTP_ALREADY_USED");
    },
    15_000,
  );

  it("enforces SensitiveAuthDialog on Admin Profile PIN reset & Owner Phone Rebind and verifies audit events", async () => {
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    // Without SensitiveAuth unlock -> 403 SENSITIVE_AUTH_REQUIRED
    const blockedReset = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${legacyRestaurantId}/profile-pin/reset`,
      {},
      adminAuth,
    );
    expect(blockedReset.status).toBe(403);
    expect(blockedReset.body.code).toBe("SENSITIVE_AUTH_REQUIRED");

    const blockedRebind = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${legacyRestaurantId}/owner-phone/rebind`,
      { phone: "9811122233" },
      adminAuth,
    );
    expect(blockedRebind.status).toBe(403);
    expect(blockedRebind.body.code).toBe("SENSITIVE_AUTH_REQUIRED");

    // Setup & establish SensitiveAuth session cookie
    const sensitiveSetup = await reqJson(
      baseUrl,
      "POST",
      "/api/admin/sensitive-auth/setup",
      { password: "AdminSensitivePass!1" },
      adminAuth,
    );
    expect(sensitiveSetup.status).toBe(200);
    const adminCookie = sensitiveSetup.setCookies.map((c) => c.split(";")[0]).join("; ");

    // Admin Profile PIN reset clears legacy owner's PIN
    const adminResetRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${legacyRestaurantId}/profile-pin/reset`,
      {},
      { ...adminAuth, Cookie: adminCookie },
    );
    expect(adminResetRes.status).toBe(200);
    expect(adminResetRes.body.ok).toBe(true);
    expect(adminResetRes.body.hadPin).toBe(true);

    const legacyProfAfterReset = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      Authorization: `Bearer ${legacyOwnerToken}`,
    });
    expect(legacyProfAfterReset.status).toBe(403);
    expect(legacyProfAfterReset.body.code).toBe("PIN_SETUP_REQUIRED");

    // Admin Rebind marks owner's recovery phone verified (admin_rebind) enabling OTP recovery
    const rebindRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${legacyRestaurantId}/owner-phone/rebind`,
      { phone: "9811122233" },
      { ...adminAuth, Cookie: adminCookie },
    );
    expect(rebindRes.status).toBe(200);
    expect(rebindRes.body.ok).toBe(true);

    // Legacy owner sets a new PIN and can now request OTP recovery cleanly
    await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "9090", confirmPin: "9090" },
      { Authorization: `Bearer ${legacyOwnerToken}` },
    );
    s2sMode = "delivered";
    const legacyOtpAfterRebind = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/forgot-otp",
      {},
      { Authorization: `Bearer ${legacyOwnerToken}` },
    );
    expect(legacyOtpAfterRebind.status).toBe(201);
    expect(legacyOtpAfterRebind.body.deliveryStatus).toBe("delivered");
  });

  it("F-01: enforces Transaction 2 FOR UPDATE cooldown, 15m/24h limits, and open-challenge re-invalidation under simultaneous requests and inter-tx races", async () => {
    const passwordHash = await bcrypt.hash("ownerpass123", 10);
    const [raceRest] = await db
      .insert(schema.restaurants)
      .values({
        name: "Concurrency Bistro",
        slug: "concurrency-bistro",
        cuisineType: "cafe",
        address: "10 Race Lane",
        locality: "Koramangala",
        city: "Bengaluru",
        state: "Karnataka",
        phone: "9900112233",
        email: "race@stage2.local",
        approvalStatus: "approved",
        subscriptionStatus: "active",
        isActive: true,
      })
      .returning();

    const [raceOwner] = await db
      .insert(schema.users)
      .values({
        name: "Race Owner",
        email: "race@stage2.local",
        passwordHash,
        role: "owner",
        restaurantId: raceRest.id,
        registrationPhone: "9900112233",
        registrationPhoneNorm: "919900112233",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();

    await db.update(schema.restaurants).set({ ownerId: raceOwner.id }).where(eq(schema.restaurants.id, raceRest.id));
    const raceToken = generateToken({ userId: raceOwner.id, role: "owner" });
    const raceAuth = { Authorization: `Bearer ${raceToken}` };

    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "4242", confirmPin: "4242" }, raceAuth);

    // 1. Simultaneous requests -> only 1 succeeds (201), concurrent peers fail with 429 OTP_COOLDOWN, max 1 active challenge in DB
    const burst = await Promise.all([
      reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth),
      reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth),
      reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth),
    ]);
    const burst201 = burst.filter((r) => r.status === 201);
    const burst429 = burst.filter((r) => r.status === 429 && r.body.code === "OTP_COOLDOWN");
    expect(burst201.length).toBe(1);
    expect(burst429.length).toBe(2);

    const activeAfterBurst = await memClient.query<{ id: string }>(
      `SELECT id FROM profile_pin_otp_challenges WHERE owner_user_id = $1 AND invalidated_at IS NULL AND consumed_at IS NULL`,
      [raceOwner.id],
    );
    expect(activeAfterBurst.rows.length).toBe(1);

    // Clear challenges for clean inter-tx race tests
    await db.delete(schema.profilePinOtpChallenges).where(eq(schema.profilePinOtpChallenges.ownerUserId, raceOwner.id));

    // 2. Inter-transaction challenge invalidation race:
    // Prior pending challenge C_old (>70s old) gets cancelled between Tx1 and Tx2;
    // during that S2S cancel window, a concurrent 'uncertain' challenge C_concurrent slips in.
    // Tx2 MUST re-invalidate C_concurrent, synchronously cancel it, and leave <= 1 active challenge.
    const cOldId = crypto.randomUUID();
    const cConcurrentId = crypto.randomUUID();
    await db.insert(schema.profilePinOtpChallenges).values({
      id: cOldId,
      restaurantId: raceRest.id,
      ownerUserId: raceOwner.id,
      otpHmac: "aa".repeat(32),
      otpPepperVersion: 1,
      deliveryStatus: "pending",
      createdAt: new Date(Date.now() - 80_000),
      expiresAt: new Date(Date.now() + 500_000),
    });

    let injectedConcurrent = false;
    onChatCancelHook = async (cancelledId) => {
      if (cancelledId === cOldId && !injectedConcurrent) {
        injectedConcurrent = true;
        await db.insert(schema.profilePinOtpChallenges).values({
          id: cConcurrentId,
          restaurantId: raceRest.id,
          ownerUserId: raceOwner.id,
          otpHmac: "bb".repeat(32),
          otpPepperVersion: 1,
          deliveryStatus: "uncertain",
          createdAt: new Date(Date.now() - 75_000),
          expiresAt: new Date(Date.now() + 500_000),
        });
      }
    };

    const raceInvalidationRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth);
    expect(raceInvalidationRes.status).toBe(201);
    expect(s2sCancelCalls).toContain(cOldId);
    expect(s2sCancelCalls).toContain(cConcurrentId);

    const [cConcurrentRow] = await db
      .select()
      .from(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.id, cConcurrentId))
      .limit(1);
    expect(cConcurrentRow.invalidatedAt).not.toBeNull();
    expect(cConcurrentRow.invalidationReason).toBe("superseded_by_resend");

    const activeAfterInvalidationRace = await memClient.query<{ id: string }>(
      `SELECT id FROM profile_pin_otp_challenges WHERE owner_user_id = $1 AND invalidated_at IS NULL AND consumed_at IS NULL`,
      [raceOwner.id],
    );
    expect(activeAfterInvalidationRace.rows.length).toBe(1);
    expect(activeAfterInvalidationRace.rows[0].id).toBe(raceInvalidationRes.body.challengeId);

    // 3. Inter-transaction 15-minute limit race (3 per 15m):
    // Start with 2 challenges in last 15m (Tx1 passes < 3). During S2S cancel between Tx1 and Tx2, inject a 3rd challenge inside 15m.
    // Tx2 MUST re-check 15m limit under FOR UPDATE and reject with 429 OTP_RATE_LIMIT_15M without inserting.
    await db.delete(schema.profilePinOtpChallenges).where(eq(schema.profilePinOtpChallenges.ownerUserId, raceOwner.id));
    s2sCancelCalls = [];
    const c15Old = crypto.randomUUID();
    const c15Prior = crypto.randomUUID();
    const c15Injected = crypto.randomUUID();
    await db.insert(schema.profilePinOtpChallenges).values([
      {
        id: c15Old,
        restaurantId: raceRest.id,
        ownerUserId: raceOwner.id,
        otpHmac: "cc".repeat(32),
        otpPepperVersion: 1,
        deliveryStatus: "delivered",
        invalidatedAt: new Date(Date.now() - 120_000),
        invalidationReason: "superseded_by_resend",
        createdAt: new Date(Date.now() - 240_000),
        expiresAt: new Date(Date.now() + 300_000),
      },
      {
        id: c15Prior,
        restaurantId: raceRest.id,
        ownerUserId: raceOwner.id,
        otpHmac: "dd".repeat(32),
        otpPepperVersion: 1,
        deliveryStatus: "pending",
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() + 480_000),
      },
    ]);

    let injected15m = false;
    onChatCancelHook = async (cancelledId) => {
      if (cancelledId === c15Prior && !injected15m) {
        injected15m = true;
        await db.insert(schema.profilePinOtpChallenges).values({
          id: c15Injected,
          restaurantId: raceRest.id,
          ownerUserId: raceOwner.id,
          otpHmac: "ee".repeat(32),
          otpPepperVersion: 1,
          deliveryStatus: "delivered",
          createdAt: new Date(Date.now() - 75_000),
          expiresAt: new Date(Date.now() + 500_000),
        });
      }
    };

    const race15mRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth);
    expect(race15mRes.status).toBe(429);
    expect(race15mRes.body.code).toBe("OTP_RATE_LIMIT_15M");
    const countAfter15mRace = await memClient.query<{ id: string }>(
      `SELECT id FROM profile_pin_otp_challenges WHERE owner_user_id = $1`,
      [raceOwner.id],
    );
    expect(countAfter15mRace.rows.length).toBe(3);

    // 4. Inter-transaction 24-hour daily limit race (10 per 24h):
    // Seed 9 challenges over last 24h (>15m ago except 1 aged 10m pending). Tx1 passes (<10).
    // During cancel hook, inject a 10th challenge in last 24h (>60s ago). Tx2 MUST reject with 429 OTP_RATE_LIMIT_24H.
    await db.delete(schema.profilePinOtpChallenges).where(eq(schema.profilePinOtpChallenges.ownerUserId, raceOwner.id));
    const dailySeed: Array<typeof schema.profilePinOtpChallenges.$inferInsert> = [];
    for (let i = 0; i < 8; i++) {
      dailySeed.push({
        id: crypto.randomUUID(),
        restaurantId: raceRest.id,
        ownerUserId: raceOwner.id,
        otpHmac: String(i).repeat(64),
        otpPepperVersion: 1,
        deliveryStatus: "delivered",
        invalidatedAt: new Date(Date.now() - (i + 2) * 3_600_000),
        invalidationReason: "expired",
        createdAt: new Date(Date.now() - (i + 2) * 3_600_000),
        expiresAt: new Date(Date.now() - (i + 1) * 3_600_000),
      });
    }
    const c24Pending = crypto.randomUUID();
    dailySeed.push({
      id: c24Pending,
      restaurantId: raceRest.id,
      ownerUserId: raceOwner.id,
      otpHmac: "9".repeat(64),
      otpPepperVersion: 1,
      deliveryStatus: "pending",
      createdAt: new Date(Date.now() - 200_000),
      expiresAt: new Date(Date.now() + 400_000),
    });
    await db.insert(schema.profilePinOtpChallenges).values(dailySeed);

    let injected24h = false;
    onChatCancelHook = async (cancelledId) => {
      if (cancelledId === c24Pending && !injected24h) {
        injected24h = true;
        await db.insert(schema.profilePinOtpChallenges).values({
          id: crypto.randomUUID(),
          restaurantId: raceRest.id,
          ownerUserId: raceOwner.id,
          otpHmac: "f".repeat(64),
          otpPepperVersion: 1,
          deliveryStatus: "delivered",
          createdAt: new Date(Date.now() - 75_000),
          expiresAt: new Date(Date.now() + 500_000),
        });
      }
    };

    const race24hRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, raceAuth);
    expect(race24hRes.status).toBe(429);
    expect(race24hRes.body.code).toBe("OTP_RATE_LIMIT_24H");
    const countAfter24hRace = await memClient.query<{ id: string }>(
      `SELECT id FROM profile_pin_otp_challenges WHERE owner_user_id = $1`,
      [raceOwner.id],
    );
    expect(countAfter24hRace.rows.length).toBe(10);
  });

  it("F-02: STARTUP_REQUIRED_TABLES includes all Stage 2 tables and startup check fails clearly when any Stage 2 table is missing", async () => {
    const indexSrc = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf-8");
    const stage2Tables = [
      "restaurant_profile_pins",
      "profile_pin_otp_challenges",
      "owner_security_audit_logs",
    ] as const;

    for (const tbl of stage2Tables) {
      expect(indexSrc).toContain(`"${tbl}"`);
    }

    const { validateStartupRequiredTables } = await import("../lib/startupSchemaCheck");

    // Passes when all required Stage 2 tables are present
    const existingRes = await memClient.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const allTables = existingRes.rows.map((r) => r.table_name);
    const errorsOk: string[] = [];
    const passCheck = await validateStartupRequiredTables({
      fetchExistingTableNames: async () => allTables,
      requiredTables: stage2Tables,
      isProduction: true,
      onMissingTable: (m) => errorsOk.push(m),
      onFailureMessage: (m) => errorsOk.push(m),
    });
    expect(passCheck.ok).toBe(true);
    expect(passCheck.missingTables).toEqual([]);
    expect(errorsOk).toEqual([]);

    // Fails clearly in production when each Stage 2 table is absent
    for (const missingTbl of stage2Tables) {
      const errorsMissing: string[] = [];
      const failCheck = await validateStartupRequiredTables({
        fetchExistingTableNames: async () => allTables.filter((t) => t !== missingTbl),
        requiredTables: stage2Tables,
        isProduction: true,
        onMissingTable: (m) => errorsMissing.push(m),
        onFailureMessage: (m) => errorsMissing.push(m),
      });
      expect(failCheck.ok).toBe(false);
      expect(failCheck.missingTables).toEqual([missingTbl]);
      expect(errorsMissing).toContain(`[MIGRATION_ERROR] missing table: ${missingTbl}`);
    }
  });

  it("F-03 & F-05: uses PostgreSQL clock_timestamp() for lockout/expiry checks and enforces production security env configuration", async () => {
    const { signProfilePinUnlockToken, validateMainApiSecurityStartupConfig } = await import(
      "../lib/profilePinCrypto"
    );
    const authHeader = { Authorization: `Bearer ${verifiedOwnerToken}` };

    const statusRes = await reqJson(baseUrl, "GET", "/api/owner/profile/pin/status", undefined, authHeader);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.locked).toBe(false);

    // Expired unlock token according to DB clock_timestamp() -> 403 PIN_EXPIRED
    const [pinRow] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, verifiedRestaurantId))
      .limit(1);
    const expiredToken = signProfilePinUnlockToken({
      ownerUserId: verifiedOwnerId,
      restaurantId: verifiedRestaurantId,
      pinVersion: pinRow.pinVersion,
      ttlMs: -5_000,
      nowMs: Date.now(),
    });
    const expiredRes = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...authHeader,
      "X-Profile-Pin-Token": expiredToken.token,
    });
    expect(expiredRes.status).toBe(403);
    expect(expiredRes.body.code).toBe("PIN_EXPIRED");

    // F-05: Verify production startup fails closed if required Stage 2 secrets are missing
    const prevNodeEnv = process.env["NODE_ENV"];
    const prevAppletId = process.env["APPLET_ID"];
    const prevDefaultPort = process.env["DEFAULT_APP_PORT"];
    const prevPinPepper = process.env["PROFILE_PIN_PEPPER"];
    const prevOtpPepper = process.env["PROFILE_PIN_OTP_PEPPER"];
    const prevPhonePepper = process.env["CHAT_PHONE_PEPPER"];
    const prevTokenSecret = process.env["PROFILE_PIN_TOKEN_SECRET"];
    const prevHmac = process.env["CHAT_INTERNAL_HMAC_SECRET"];

    try {
      process.env["NODE_ENV"] = "production";
      delete process.env["APPLET_ID"];
      delete process.env["DEFAULT_APP_PORT"];

      // Succeeds when all required secrets are configured
      expect(() => validateMainApiSecurityStartupConfig()).not.toThrow();

      // Missing PROFILE_PIN_PEPPER throws FATAL
      delete process.env["PROFILE_PIN_PEPPER"];
      expect(() => validateMainApiSecurityStartupConfig()).toThrow(/FATAL: PROFILE_PIN_PEPPER is required in production/);
      process.env["PROFILE_PIN_PEPPER"] = prevPinPepper;

      // Missing PROFILE_PIN_OTP_PEPPER throws FATAL
      delete process.env["PROFILE_PIN_OTP_PEPPER"];
      expect(() => validateMainApiSecurityStartupConfig()).toThrow(/FATAL: PROFILE_PIN_OTP_PEPPER is required in production/);
      process.env["PROFILE_PIN_OTP_PEPPER"] = prevOtpPepper;

      // Missing CHAT_INTERNAL_HMAC_SECRET throws FATAL
      delete process.env["CHAT_INTERNAL_HMAC_SECRET"];
      expect(() => validateMainApiSecurityStartupConfig()).toThrow(/FATAL: CHAT_INTERNAL_HMAC_SECRET is required in production/);
    } finally {
      if (prevNodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prevNodeEnv;
      if (prevAppletId !== undefined) process.env["APPLET_ID"] = prevAppletId;
      if (prevDefaultPort !== undefined) process.env["DEFAULT_APP_PORT"] = prevDefaultPort;
      if (prevPinPepper !== undefined) process.env["PROFILE_PIN_PEPPER"] = prevPinPepper;
      if (prevOtpPepper !== undefined) process.env["PROFILE_PIN_OTP_PEPPER"] = prevOtpPepper;
      if (prevPhonePepper !== undefined) process.env["CHAT_PHONE_PEPPER"] = prevPhonePepper;
      if (prevTokenSecret !== undefined) process.env["PROFILE_PIN_TOKEN_SECRET"] = prevTokenSecret;
      if (prevHmac !== undefined) process.env["CHAT_INTERNAL_HMAC_SECRET"] = prevHmac;
    }
  });

  it("0042 Partial Unique Index: enforces <= 1 active OTP challenge per owner+restaurant while permitting historical invalidated/consumed rows", async () => {
    const idxCheck = await memClient.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_otp_challenges_one_active_per_owner_rest'`,
    );
    expect(idxCheck.rows.length).toBe(1);

    const active1 = crypto.randomUUID();
    const active2 = crypto.randomUUID();
    const hist1 = crypto.randomUUID();
    const hist2 = crypto.randomUUID();

    await db
      .delete(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.ownerUserId, verifiedOwnerId));

    await memClient.query(
      `INSERT INTO profile_pin_otp_challenges (id, restaurant_id, owner_user_id, otp_hmac, expires_at)
       VALUES ($1::uuid, $2, $3, $4, clock_timestamp() + interval '10 minutes')`,
      [active1, verifiedRestaurantId, verifiedOwnerId, "11".repeat(32)],
    );

    // Direct SQL attempt to insert a second active challenge must fail with SQLSTATE 23505
    await expect(
      memClient.query(
        `INSERT INTO profile_pin_otp_challenges (id, restaurant_id, owner_user_id, otp_hmac, expires_at)
         VALUES ($1::uuid, $2, $3, $4, clock_timestamp() + interval '10 minutes')`,
        [active2, verifiedRestaurantId, verifiedOwnerId, "22".repeat(32)],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // Historical invalidated/consumed rows remain permitted without unique violation
    await memClient.query(
      `INSERT INTO profile_pin_otp_challenges (id, restaurant_id, owner_user_id, otp_hmac, invalidated_at, invalidation_reason, expires_at)
       VALUES
         ($1::uuid, $3, $4, $5, clock_timestamp(), 'expired', clock_timestamp() - interval '1 minute'),
         ($2::uuid, $3, $4, $6, clock_timestamp(), 'superseded_by_resend', clock_timestamp() + interval '5 minutes')`,
      [hist1, hist2, verifiedRestaurantId, verifiedOwnerId, "33".repeat(32), "44".repeat(32)],
    );
  });

  it("F-12 & C-02: serializes PIN comparisons under row lock and skips bcrypt on queued requests after 5th failure commits PIN_LOCKED", async () => {
    const { registerSecurityTestHooks, clearSecurityTestHooks } = await import("../lib/securityTx");

    const cUser = await db
      .insert(schema.users)
      .values({
        name: "C02 Owner",
        email: `c02-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: null,
        registrationPhone: "9811100022",
        registrationPhoneNorm: "919811100022",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    const cRest = await db
      .insert(schema.restaurants)
      .values({
        name: "C02 Diner",
        slug: `c02-diner-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9811100022",
        email: `c02-${Date.now()}@test.com`,
        ownerId: cUser[0].id,
      })
      .returning();
    await db
      .update(schema.users)
      .set({ restaurantId: cRest[0].id })
      .where(eq(schema.users.id, cUser[0].id));

    const cToken = generateToken({
      userId: cUser[0].id,
      email: cUser[0].email,
      role: "owner",
    });
    const cAuth = { Authorization: `Bearer ${cToken}` };

    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "7391", confirmPin: "7391" }, cAuth);

    // Correct PIN on unlocked row succeeds and keeps failedAttempts=0
    const unlockedOk = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "7391" }, cAuth);
    expect(unlockedOk.status).toBe(200);

    const compareSpy = vi.spyOn(bcrypt, "compare");
    const lockOrderLog: string[] = [];
    try {
      compareSpy.mockClear();
      registerSecurityTestHooks({
        onVerifyLockAcquired: ({ failedAttempts, lockedUntil }) => {
          lockOrderLog.push(`fa=${failedAttempts},locked=${Boolean(lockedUntil)}`);
        },
      });

      // Attempts 1..4 fail -> failedAttempts increments to 4
      for (let i = 1; i <= 4; i++) {
        const failRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, cAuth);
        expect(failRes.status).toBe(401);
        expect(failRes.body.code).toBe("PIN_INVALID");
      }
      expect(compareSpy).toHaveBeenCalledTimes(4);

      // Concurrent barrier-ordered arrival: #5 (wrong), #6 (wrong), #7 (CORRECT PIN!)
      const req5 = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, cAuth);
      expect(req5.status).toBe(429);
      expect(req5.body.code).toBe("PIN_LOCKED");

      const [req6, req7ValidPin] = await Promise.all([
        reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "0000" }, cAuth),
        reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "7391" }, cAuth),
      ]);
      expect(req6.status).toBe(429);
      expect(req6.body.code).toBe("PIN_LOCKED");
      expect(req7ValidPin.status).toBe(429);
      expect(req7ValidPin.body.code).toBe("PIN_LOCKED");

      // Critically: bcrypt.compare executed ONLY 5 times total — NEVER on #6 or #7 after lockout committed
      expect(compareSpy).toHaveBeenCalledTimes(5);
      expect(lockOrderLog.length).toBe(7);
      expect(lockOrderLog[4]).toContain("fa=4");
      expect(lockOrderLog[5]).toContain("locked=true");
      expect(lockOrderLog[6]).toContain("locked=true");
    } finally {
      clearSecurityTestHooks();
      compareSpy.mockRestore();
    }
  }, 15_000);

  it("G-01: pepper rehash updates ONLY pin_hash/pepper_version/updated_at without mutating pin_version/pin_set_at and never overwrites concurrent change or admin reset", async () => {
    const { registerSecurityTestHooks, clearSecurityTestHooks } = await import("../lib/securityTx");

    const gOwner = await db
      .insert(schema.users)
      .values({
        name: "G01 Owner",
        email: `g01-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: null,
        registrationPhone: "9822200033",
        registrationPhoneNorm: "919822200033",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    const gRest = await db
      .insert(schema.restaurants)
      .values({
        name: "G01 Bistro",
        slug: `g01-bistro-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9822200033",
        email: `g01-${Date.now()}@test.com`,
        ownerId: gOwner[0].id,
      })
      .returning();
    await db
      .update(schema.users)
      .set({ restaurantId: gRest[0].id })
      .where(eq(schema.users.id, gOwner[0].id));

    const gToken = generateToken({
      userId: gOwner[0].id,
      email: gOwner[0].email,
      role: "owner",
    });
    const gAuth = { Authorization: `Bearer ${gToken}` };

    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "2468", confirmPin: "2468" }, gAuth);

    const [beforeRehash] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, gRest[0].id))
      .limit(1);
    expect(beforeRehash.pepperVersion).toBe(1);
    expect(beforeRehash.pinVersion).toBe(1);

    const prevV1 = process.env["PROFILE_PIN_PEPPER"]!;
    const prevVer = process.env["PROFILE_PIN_PEPPER_VERSION"]!;
    const prevJson = process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"];

    try {
      // Rotate active pepper to v2 while retaining v1 in PREVIOUS_PEPPERS_JSON
      process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v2";
      process.env["PROFILE_PIN_PEPPER_VERSION"] = "2";
      process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = JSON.stringify({ 1: prevV1 });

      // 1) Normal verify: Tx1 verifies v1 digest, Tx2 rehashes to v2 preserving pin_version & pin_set_at
      const verifyOk = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "2468" }, gAuth);
      expect(verifyOk.status).toBe(200);

      const [afterRehash] = await db
        .select()
        .from(schema.restaurantProfilePins)
        .where(eq(schema.restaurantProfilePins.restaurantId, gRest[0].id))
        .limit(1);
      expect(afterRehash.pepperVersion).toBe(2);
      expect(afterRehash.pinHash).not.toBe(beforeRehash.pinHash);
      expect(afterRehash.pinVersion).toBe(beforeRehash.pinVersion); // MUST NOT increment pin_version
      expect(beforeRehash.pinSetAt).not.toBeNull();
      expect(afterRehash.pinSetAt).not.toBeNull();
      expect(afterRehash.pinSetAt?.getTime()).toBe(beforeRehash.pinSetAt?.getTime()); // MUST NOT modify pin_set_at

      // 2) Concurrent PIN change between Tx1 and Tx2: rotate v2 -> v3, verify with v2 PIN while hook injects /pin/change
      process.env["PROFILE_PIN_PEPPER"] = "test-pin-pepper-v3";
      process.env["PROFILE_PIN_PEPPER_VERSION"] = "3";
      process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = JSON.stringify({ 1: prevV1, 2: "test-pin-pepper-v2" });

      let raceChangeTriggered = false;
      registerSecurityTestHooks({
        onVerifyBeforeRehashTx: async ({ restaurantId }) => {
          if (restaurantId === gRest[0].id && !raceChangeTriggered) {
            raceChangeTriggered = true;
            const chRes = await reqJson(
              baseUrl,
              "POST",
              "/api/owner/profile/pin/change",
              { currentPin: "2468", newPin: "9753", confirmPin: "9753" },
              gAuth,
            );
            expect(chRes.status).toBe(200);
          }
        },
      });

      const verifyRaceRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "2468" }, gAuth);
      expect(verifyRaceRes.status).toBe(200);
      expect(raceChangeTriggered).toBe(true);
      clearSecurityTestHooks();

      // The newer PIN "9753" set by /change MUST NOT have been overwritten by the stale "2468" rehash Tx2
      const oldPinCheck = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "2468" }, gAuth);
      expect(oldPinCheck.status).toBe(401);
      const newPinCheck = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "9753" }, gAuth);
      expect(newPinCheck.status).toBe(200);

      // Reset verified row back cleanly
      const [rowAfterChange] = await db
        .select()
        .from(schema.restaurantProfilePins)
        .where(eq(schema.restaurantProfilePins.restaurantId, gRest[0].id))
        .limit(1);
      expect(rowAfterChange.pinVersion).toBe(2);
    } finally {
      clearSecurityTestHooks();
      process.env["PROFILE_PIN_PEPPER"] = prevV1;
      process.env["PROFILE_PIN_PEPPER_VERSION"] = prevVer;
      if (prevJson === undefined) delete process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"];
      else process.env["PROFILE_PIN_PREVIOUS_PEPPERS_JSON"] = prevJson;
    }
  }, 15_000);

  it("F-06 & C-01: serializes missing-PIN-row reset-with-otp vs admin reset via (0) restaurants lock and assigns post-lock clock_timestamp() in forgot-otp Tx2", async () => {
    const { registerSecurityTestHooks, clearSecurityTestHooks } = await import("../lib/securityTx");

    const fOwner = await db
      .insert(schema.users)
      .values({
        name: "F06 Owner",
        email: `f06-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: null,
        registrationPhone: "9833300044",
        registrationPhoneNorm: "919833300044",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    const fRest = await db
      .insert(schema.restaurants)
      .values({
        name: "F06 Cafe",
        slug: `f06-cafe-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9833300044",
        email: `f06-${Date.now()}@test.com`,
        ownerId: fOwner[0].id,
      })
      .returning();
    await db
      .update(schema.users)
      .set({ restaurantId: fRest[0].id })
      .where(eq(schema.users.id, fOwner[0].id));

    const fAuth = {
      Authorization: `Bearer ${generateToken({ userId: fOwner[0].id, email: fOwner[0].email, role: "owner" })}`,
    };

    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "1122", confirmPin: "1122" }, fAuth);

    // C-01: Request OTP while injecting delay after lock inside Tx2 -> created_at == updated_at == post-lock clock_timestamp()
    s2sSendCalls = [];
    let preInsertClockMs = 0;
    registerSecurityTestHooks({
      onForgotOtpTx2AfterLock: async ({ restaurantId, readTxClock }) => {
        if (restaurantId === fRest[0].id) {
          await new Promise((r) => setTimeout(r, 40));
          const c = await readTxClock();
          preInsertClockMs = c.getTime();
        }
      },
    });

    const otpRes = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, fAuth);
    clearSecurityTestHooks();
    expect(otpRes.status).toBe(201);
    const challengeId = otpRes.body.challengeId as string;
    const otpCode = s2sSendCalls[0].otp;

    const [challengeRow] = await db
      .select()
      .from(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.id, challengeId))
      .limit(1);
    expect(challengeRow.createdAt.getTime()).toBeGreaterThanOrEqual(preInsertClockMs);
    expect(challengeRow.updatedAt.getTime()).toBeGreaterThanOrEqual(challengeRow.createdAt.getTime());
    expect(challengeRow.expiresAt.getTime() - challengeRow.createdAt.getTime()).toBe(600_000);

    // F-06: Delete PIN row directly so PIN row is missing, then verify both reset-with-otp and admin reset
    // acquire (0) restaurants FOR UPDATE anchor before touching restaurant_profile_pins
    await db.delete(schema.restaurantProfilePins).where(eq(schema.restaurantProfilePins.restaurantId, fRest[0].id));

    const acquiredAnchors: string[] = [];
    registerSecurityTestHooks({
      onResetWithOtpAnchorAcquired: ({ restaurantId }) => {
        if (restaurantId === fRest[0].id) acquiredAnchors.push("reset_with_otp");
      },
      onAdminResetAnchorAcquired: ({ restaurantId }) => {
        if (restaurantId === fRest[0].id) acquiredAnchors.push("admin_reset");
      },
    });

    const resetRes = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/reset-with-otp",
      { challengeId, otp: otpCode, newPin: "5566", confirmPin: "5566" },
      fAuth,
    );
    expect(resetRes.status).toBe(200);

    const verifySensitive = await reqJson(
      baseUrl,
      "POST",
      "/api/admin/sensitive-auth/verify",
      { password: "AdminSensitivePass!1" },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(verifySensitive.status).toBe(200);
    const adminCookie = verifySensitive.setCookies.map((c) => c.split(";")[0]).join("; ");

    const adminRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${fRest[0].id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );
    expect(adminRes.status).toBe(200);
    expect(acquiredAnchors).toEqual(["reset_with_otp", "admin_reset"]);

    const [afterAdminClear] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, fRest[0].id))
      .limit(1);
    expect(afterAdminClear).toBeDefined();
    expect(afterAdminClear.pinHash).toBeNull();
    expect(afterAdminClear.pinSetAt).toBeNull();
    expect(afterAdminClear.pinVersion).toBe(2);
    expect(afterAdminClear.failedAttempts).toBe(0);
    expect(afterAdminClear.lockoutLevel).toBe(0);
    expect(afterAdminClear.lockedUntil).toBeNull();
    expect(afterAdminClear.lastFailedAt).toBeNull();
    clearSecurityTestHooks();
  }, 15_000);

  it("maps PG contention errors (55P03/57014/25P03/40P01) cleanly to HTTP 503 DB_CONTENTION_RETRY and enforces Mandatory Test DB Safety Guard", async () => {
    const { isPgContentionError, respondSecurityContention, SecurityContentionError } = await import(
      "../lib/securityTx"
    );
    const { assertSafeMainTestDatabase, verifyConnectedMainTestDbIdentity } = await import(
      "../lib/testDbSafetyGuard"
    );

    expect(isPgContentionError({ code: "55P03", message: "lock timeout" })).toBe(true);
    expect(isPgContentionError({ cause: { code: "57014", message: "statement timeout" } })).toBe(true);
    expect(isPgContentionError({ cause: { code: "25P03", message: "idle in transaction" } })).toBe(true);
    expect(isPgContentionError({ code: "40P01", message: "deadlock detected" })).toBe(true);
    expect(isPgContentionError({ code: "23505", message: "unique violation" })).toBe(false);

    // Express response mapping returns 503 with Retry-After
    const headers: Record<string, string> = {};
    let statusSent = 0;
    let bodySent: unknown = null;
    const mockRes = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
      status(code: number) {
        statusSent = code;
        return this;
      },
      json(payload: unknown) {
        bodySent = payload;
        return this;
      },
    } as any;
    const handled = respondSecurityContention(mockRes, new SecurityContentionError("busy", "55P03"));
    expect(handled).toBe(true);
    expect(statusSent).toBe(503);
    expect(headers["Retry-After"]).toBe("2");
    expect((bodySent as any).code).toBe("DB_CONTENTION_RETRY");

    // Mandatory Test Database Safety Guard enforcement
    expect(() =>
      assertSafeMainTestDatabase({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://u:p@localhost:5432/prod_db",
      }),
    ).toThrow(/TEST_PG_URL is not configured/);

    expect(() =>
      assertSafeMainTestDatabase({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/app_db",
        TEST_PG_URL: "postgres://u:p@localhost/app_db",
      }),
    ).toThrow(/TEST_DB_SAFETY_ABORT/);

    expect(() =>
      assertSafeMainTestDatabase({
        NODE_ENV: "development",
        DATABASE_URL: "postgres://u:p@db.prod.internal:5432/bitebend",
        TEST_PG_URL: "postgres://u:p@localhost:5432/bitebend_test",
        TEST_CHAT_PG_URL: "postgres://u:p@127.0.0.1:5432/bitebend_test",
      }),
    ).toThrow(/must remain independent|matches TEST_CHAT_PG_URL/);

    const safe = assertSafeMainTestDatabase({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://u:p@prod.db.example:5432/bitebend_prod",
      CHAT_DATABASE_URL: "postgres://u:p@prod.db.example:5432/bitebend_chat_prod",
      TEST_PG_URL: "postgres://u:p@localhost:5432/bitebend_main_test?schema=test_stage2",
      TEST_CHAT_PG_URL: "postgres://u:p@localhost:5432/bitebend_chat_test",
    });
    expect(safe.identity.database).toBe("bitebend_main_test");
    expect(safe.identity.searchPath).toBe("test_stage2");

    // Live connected schema mismatch MUST abort with [TEST_DB_SAFETY_ABORT]
    await expect(
      verifyConnectedMainTestDbIdentity(
        {
          query: async () => ({ rows: [{ current_db: "bitebend_main_test", current_schema: "public" }] as any }),
        },
        safe.identity,
        { DATABASE_URL: "postgres://u:p@prod.db.example:5432/bitebend_prod" },
      ),
    ).rejects.toThrow(/TEST_DB_SAFETY_ABORT.*does not match expected TEST_PG_URL search_path\/schema/);

    await expect(
      verifyConnectedMainTestDbIdentity(
        {
          query: async () => ({ rows: [{ current_db: "bitebend_main_test", current_schema: "test_stage2" }] as any }),
        },
        safe.identity,
        { DATABASE_URL: "postgres://u:p@prod.db.example:5432/bitebend_prod" },
      ),
    ).resolves.toEqual({ currentDatabase: "bitebend_main_test", currentSchema: "test_stage2" });
  });

  it("F-11: preserves Admin PIN reset tombstones, monotonically increments pin_version on setup, handles missing/orphaned rows, and never resurrects stale unlocks", async () => {
    const f11Owner = await db
      .insert(schema.users)
      .values({
        name: "F11 Owner",
        email: `f11-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: null,
        registrationPhone: "9844400011",
        registrationPhoneNorm: "919844400011",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    const f11Rest = await db
      .insert(schema.restaurants)
      .values({
        name: "F11 Tombstone Bistro",
        slug: `f11-bistro-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9844400011",
        email: `f11-${Date.now()}@test.com`,
        ownerId: f11Owner[0].id,
      })
      .returning();
    await db.update(schema.users).set({ restaurantId: f11Rest[0].id }).where(eq(schema.users.id, f11Owner[0].id));

    const f11Auth = {
      Authorization: `Bearer ${generateToken({ userId: f11Owner[0].id, email: f11Owner[0].email, role: "owner" })}`,
    };

    // Setup PIN v1 and verify to mint both bearer unlockTokenV1 and session unlock cookie
    const setupV1 = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "1234", confirmPin: "1234" }, f11Auth);
    expect(setupV1.status).toBe(201);
    expect(setupV1.body.pinVersion).toBe(1);

    const verifyV1 = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "1234" }, f11Auth);
    expect(verifyV1.status).toBe(200);
    const tokenV1 = verifyV1.body.unlockToken as string;
    const preResetSessionCookie = verifyV1.setCookies.map((c) => c.split(";")[0]).join("; ");

    // Also fail once so failedAttempts > 0 before admin reset, plus seed an active OTP challenge
    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/verify", { pin: "9999" }, f11Auth);
    s2sMode = "delivered";
    const otpBeforeReset = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, f11Auth);
    expect(otpBeforeReset.status).toBe(201);
    const openChallengeId = otpBeforeReset.body.challengeId as string;

    // Confirm tokenV1 and preResetSessionCookie currently unlock /api/owner/profile
    const okTokenBefore = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...f11Auth,
      "X-Profile-Pin-Token": tokenV1,
    });
    expect(okTokenBefore.status).toBe(200);

    // Admin SensitiveAuth + Reset
    const sensRes = await reqJson(
      baseUrl,
      "POST",
      "/api/admin/sensitive-auth/verify",
      { password: "AdminSensitivePass!1" },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(sensRes.status).toBe(200);
    const adminCookie = sensRes.setCookies.map((c) => c.split(";")[0]).join("; ");

    const reset1 = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${f11Rest[0].id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );
    expect(reset1.status).toBe(200);
    expect(reset1.body).toEqual({ ok: true, hadPin: true });

    // Row MUST remain as a clean tombstone with pinVersion incremented to 2 and lockout cleared
    const [tombstone] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, f11Rest[0].id))
      .limit(1);
    expect(tombstone).toBeDefined();
    expect(tombstone.pinHash).toBeNull();
    expect(tombstone.pinSetAt).toBeNull();
    expect(tombstone.pinVersion).toBe(2);
    expect(tombstone.failedAttempts).toBe(0);
    expect(tombstone.lockoutLevel).toBe(0);
    expect(tombstone.lockedUntil).toBeNull();
    expect(tombstone.lastFailedAt).toBeNull();

    // Open OTP challenge invalidated
    const [otpAfterReset] = await db
      .select()
      .from(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.id, openChallengeId))
      .limit(1);
    expect(otpAfterReset.invalidationReason).toBe("admin_pin_reset");

    // Status & gated routes treat tombstone as unconfigured
    const statusAfterReset = await reqJson(baseUrl, "GET", "/api/owner/profile/pin/status", undefined, f11Auth);
    expect(statusAfterReset.status).toBe(200);
    expect(statusAfterReset.body.configured).toBe(false);
    expect(statusAfterReset.body.locked).toBe(false);
    expect(statusAfterReset.body.unlocked).toBe(false);

    const gatedAfterReset = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...f11Auth,
      "X-Profile-Pin-Token": tokenV1,
      Cookie: preResetSessionCookie,
    });
    expect(gatedAfterReset.status).toBe(403);
    expect(gatedAfterReset.body.code).toBe("PIN_SETUP_REQUIRED");

    // Repeated reset on tombstone increments pinVersion again (2 -> 3) and reports hadPin: false
    const resetRepeat = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${f11Rest[0].id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );
    expect(resetRepeat.status).toBe(200);
    expect(resetRepeat.body).toEqual({ ok: true, hadPin: false });

    // Owner runs /setup on tombstone -> increments pinVersion to 4 (NEVER resets to 1!)
    const setupOnTombstone = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "5678", confirmPin: "5678" },
      f11Auth,
    );
    expect(setupOnTombstone.status).toBe(201);
    expect(setupOnTombstone.body.pinVersion).toBe(4);
    const tokenV4 = setupOnTombstone.body.unlockToken as string;

    // Pre-reset tokenV1 and preResetSessionCookie MUST remain invalid (403 PIN_REQUIRED), never resurrect!
    const staleBearerAttempt = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...f11Auth,
      "X-Profile-Pin-Token": tokenV1,
    });
    expect(staleBearerAttempt.status).toBe(403);
    expect(staleBearerAttempt.body.code).toBe("PIN_REQUIRED");

    const staleSessionAttempt = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...f11Auth,
      Cookie: preResetSessionCookie,
    });
    expect(staleSessionAttempt.status).toBe(403);
    expect(staleSessionAttempt.body.code).toBe("PIN_REQUIRED");

    const validAfterRes = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      ...f11Auth,
      "X-Profile-Pin-Token": tokenV4,
    });
    expect(validAfterRes.status).toBe(200);

    // Missing PIN row on restaurant WITH owner -> Admin reset creates clean tombstone with pinVersion=1, hadPin=false; setup -> pinVersion=2
    const [f11MissingRest] = await db
      .insert(schema.restaurants)
      .values({
        name: "F11 Missing Row",
        slug: `f11-missing-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9844400022",
        email: `f11m-${Date.now()}@test.com`,
        ownerId: f11Owner[0].id,
      })
      .returning();
    const f11MissingChallengeId = crypto.randomUUID();
    await db.insert(schema.profilePinOtpChallenges).values({
      id: f11MissingChallengeId,
      restaurantId: f11MissingRest.id,
      ownerUserId: f11Owner[0].id,
      otpHmac: "ab".repeat(32),
      otpPepperVersion: 1,
      deliveryStatus: "pending",
      expiresAt: new Date(Date.now() + 300_000),
    });

    const resetMissingWithOwner = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${f11MissingRest.id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );
    expect(resetMissingWithOwner.status).toBe(200);
    expect(resetMissingWithOwner.body).toEqual({ ok: true, hadPin: false });

    const [createdTombstone] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, f11MissingRest.id))
      .limit(1);
    expect(createdTombstone).toBeDefined();
    expect(createdTombstone.pinHash).toBeNull();
    expect(createdTombstone.pinSetAt).toBeNull();
    expect(createdTombstone.pinVersion).toBe(1);

    const [invalidatedMissingOtp] = await db
      .select()
      .from(schema.profilePinOtpChallenges)
      .where(eq(schema.profilePinOtpChallenges.id, f11MissingChallengeId))
      .limit(1);
    expect(invalidatedMissingOtp.invalidationReason).toBe("admin_pin_reset");

    // Orphaned restaurant (ownerId: null, no PIN row) -> reset skips tombstone insert safely & returns hadPin: false
    const [orphanRest] = await db
      .insert(schema.restaurants)
      .values({
        name: "F11 Orphaned",
        slug: `f11-orphan-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9844400033",
        email: `f11o-${Date.now()}@test.com`,
        ownerId: null,
      })
      .returning();

    const orphanResetRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${orphanRest.id}/profile-pin/reset`,
      {},
      { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie },
    );
    expect(orphanResetRes.status).toBe(200);
    expect(orphanResetRes.body).toEqual({ ok: true, hadPin: false });

    const [orphanPinRow] = await db
      .select()
      .from(schema.restaurantProfilePins)
      .where(eq(schema.restaurantProfilePins.restaurantId, orphanRest.id))
      .limit(1);
    expect(orphanPinRow).toBeUndefined();
  }, 15_000);

  it("F-09: maps only SQLSTATE 23505 on uq_otp_challenges_one_active_per_owner_rest to HTTP 429 OTP_COOLDOWN after rollback, leaving unrelated 23505 untouched", async () => {
    const {
      extractPgConstraintName,
      isActiveOtpChallengeUniqueViolation,
      ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX,
      registerSecurityTestHooks,
      clearSecurityTestHooks,
    } = await import("../lib/securityTx");

    expect(extractPgConstraintName({ code: "23505", constraint: ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX })).toBe(
      ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX,
    );
    expect(extractPgConstraintName({ cause: { code: "23505", constraintName: "users_email_unique" } })).toBe(
      "users_email_unique",
    );
    expect(
      isActiveOtpChallengeUniqueViolation({ code: "23505", constraint: ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX }),
    ).toBe(true);
    expect(
      isActiveOtpChallengeUniqueViolation({ cause: { code: "23505", constraint: ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX } }),
    ).toBe(true);
    expect(isActiveOtpChallengeUniqueViolation({ code: "23505", constraint: "users_email_unique" })).toBe(false);
    expect(isActiveOtpChallengeUniqueViolation({ code: "23505" })).toBe(false);
    expect(
      isActiveOtpChallengeUniqueViolation({ code: "55P03", constraint: ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX }),
    ).toBe(false);

    const [f09Owner] = await db
      .insert(schema.users)
      .values({
        name: "F09 Owner",
        email: `f09-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "owner",
        restaurantId: null,
        registrationPhone: "9855500011",
        registrationPhoneNorm: "919855500011",
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
        registrationPhoneCapturedAt: new Date(),
      })
      .returning();
    const [f09Rest] = await db
      .insert(schema.restaurants)
      .values({
        name: "F09 Bistro",
        slug: `f09-bistro-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: "9855500011",
        email: `f09-${Date.now()}@test.com`,
        ownerId: f09Owner.id,
      })
      .returning();
    await db.update(schema.users).set({ restaurantId: f09Rest.id }).where(eq(schema.users.id, f09Owner.id));
    const f09Auth = {
      Authorization: `Bearer ${generateToken({ userId: f09Owner.id, email: f09Owner.email, role: "owner" })}`,
    };

    await reqJson(baseUrl, "POST", "/api/owner/profile/pin/setup", { pin: "1357", confirmPin: "1357" }, f09Auth);

    // 1) Target 23505 constraint inside Tx2 -> Tx2 rolls back and maps to 429 OTP_COOLDOWN with retryAfterSeconds=60
    const beforeCount = (
      await db
        .select()
        .from(schema.profilePinOtpChallenges)
        .where(eq(schema.profilePinOtpChallenges.restaurantId, f09Rest.id))
    ).length;

    registerSecurityTestHooks({
      onForgotOtpTx2AfterLock: async ({ restaurantId }) => {
        if (restaurantId === f09Rest.id) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint: ACTIVE_OTP_CHALLENGE_UNIQUE_INDEX,
          });
        }
      },
    });

    const target23505Res = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, f09Auth);
    clearSecurityTestHooks();
    expect(target23505Res.status).toBe(429);
    expect(target23505Res.body.code).toBe("OTP_COOLDOWN");
    expect(target23505Res.body.retryAfterSeconds).toBe(60);

    const afterCount = (
      await db
        .select()
        .from(schema.profilePinOtpChallenges)
        .where(eq(schema.profilePinOtpChallenges.restaurantId, f09Rest.id))
    ).length;
    expect(afterCount).toBe(beforeCount);

    // 2) Unrelated 23505 constraint MUST NOT map to OTP_COOLDOWN (normal unhandled error -> 500)
    registerSecurityTestHooks({
      onForgotOtpTx2AfterLock: async ({ restaurantId }) => {
        if (restaurantId === f09Rest.id) {
          throw Object.assign(new Error("duplicate key value violates unique constraint \"users_email_unique\""), {
            code: "23505",
            constraint: "users_email_unique",
          });
        }
      },
    });
    const unrelated23505Res = await reqJson(baseUrl, "POST", "/api/owner/profile/pin/forgot-otp", {}, f09Auth);
    clearSecurityTestHooks();
    expect(unrelated23505Res.status).toBe(500);
    expect(unrelated23505Res.body?.code).not.toBe("OTP_COOLDOWN");
  }, 15_000);

  it("F-13: invalidates open OTP challenges deterministically via ordered IDs and sweeps <= 100 expired rows per batch", async () => {
    const { invalidateActiveOtpChallengesOrdered, withBoundedSecurityTx } = await import("../lib/securityTx");

    // 1) Ordered multi-row invalidation helper test across two restaurants & multiple statuses
    const restBatch: typeof schema.restaurants.$inferInsert[] = [];
    const ownerBatch: typeof schema.users.$inferInsert[] = [];
    for (let i = 0; i < 11; i++) {
      ownerBatch.push({
        name: `Sweep Owner ${i}`,
        email: `sweep-o-${i}-${Date.now()}@test.local`,
        passwordHash: "hash",
        role: "owner",
        registrationPhone: `98666000${String(i).padStart(2, "0")}`,
        registrationPhoneNorm: `9198666000${String(i).padStart(2, "0")}`,
        registrationPhoneSource: "registration",
        registrationPhoneVerified: true,
      });
      restBatch.push({
        name: `Sweep Rest ${i}`,
        slug: `sweep-r-${i}-${Date.now()}`,
        cuisineType: "cafe",
        city: "Bengaluru",
        phone: `98666000${String(i).padStart(2, "0")}`,
        email: `sweep-r-${i}-${Date.now()}@test.local`,
      });
    }
    const insertedOwners = await db.insert(schema.users).values(ownerBatch).returning();
    const insertedRests = await db.insert(schema.restaurants).values(restBatch).returning();

    // Test direct invalidateActiveOtpChallengesOrdered cleanly marks active rows invalidated and ignores delivered-to-cancelled downgrade
    const orderedTestIds = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
    ].sort();
    // Temporarily seed 1 active challenge per distinct owner on insertedRests[0]
    await db.insert(schema.profilePinOtpChallenges).values([
      {
        id: orderedTestIds[1],
        restaurantId: insertedRests[0].id,
        ownerUserId: insertedOwners[0].id,
        otpHmac: "11".repeat(32),
        otpPepperVersion: 1,
        deliveryStatus: "pending",
        expiresAt: new Date(Date.now() + 600_000),
      },
      {
        id: orderedTestIds[0],
        restaurantId: insertedRests[0].id,
        ownerUserId: insertedOwners[1].id,
        otpHmac: "22".repeat(32),
        otpPepperVersion: 1,
        deliveryStatus: "delivered",
        deliveredAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    ]);

    const toCancelFromOrdered = await withBoundedSecurityTx(async (tx) => {
      return await invalidateActiveOtpChallengesOrdered(tx, {
        restaurantId: insertedRests[0].id,
        reason: "admin_pin_reset",
      });
    });
    expect(toCancelFromOrdered).toEqual([orderedTestIds[1]]);

    // 2) Seed 105 expired active OTP challenges using distinct (ownerUserId, restaurantId) pairs
    // First clear any pre-existing expired un-invalidated rows so our batch count of 100 vs 5 is exact
    await memClient.query(
      `UPDATE profile_pin_otp_challenges
       SET invalidated_at = clock_timestamp(), invalidation_reason = 'test_cleanup'
       WHERE invalidated_at IS NULL AND consumed_at IS NULL AND expires_at <= clock_timestamp()`,
    );

    const sortedExpiredUuids = Array.from({ length: 105 }, (_v, idx) =>
      `10000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
    );
    const expiredSeed: Array<typeof schema.profilePinOtpChallenges.$inferInsert> = [];
    for (let i = 0; i < 105; i++) {
      const owner = insertedOwners[i % insertedOwners.length];
      const rest = insertedRests[Math.floor(i / insertedOwners.length)];
      expiredSeed.push({
        id: sortedExpiredUuids[i],
        restaurantId: rest.id,
        ownerUserId: owner.id,
        otpHmac: "33".repeat(32),
        otpPepperVersion: 1,
        deliveryStatus: i % 2 === 0 ? "delivered" : "pending",
        deliveredAt: i % 2 === 0 ? new Date(Date.now() - 120_000) : null,
        cancelSyncStatus: "not_required",
        expiresAt: new Date(Date.now() - 60_000),
      });
    }
    await db.insert(schema.profilePinOtpChallenges).values(expiredSeed);

    // 1st reconciliation sweep MUST invalidate strictly the lowest 100 rows (ORDER BY id ASC LIMIT 100)
    await runSecurityOtpReconciliationSweep();
    const afterSweep1 = await memClient.query<{ id: string }>(
      `SELECT id::text AS id FROM profile_pin_otp_challenges
       WHERE id = ANY($1::uuid[]) AND invalidated_at IS NULL AND consumed_at IS NULL
       ORDER BY id ASC`,
      [sortedExpiredUuids],
    );
    expect(afterSweep1.rows.map((r) => r.id)).toEqual(sortedExpiredUuids.slice(100));

    // 2nd reconciliation sweep invalidates the remaining 5 rows
    await runSecurityOtpReconciliationSweep();
    const afterSweep2 = await memClient.query<{ id: string }>(
      `SELECT id::text AS id FROM profile_pin_otp_challenges
       WHERE id = ANY($1::uuid[]) AND invalidated_at IS NULL AND consumed_at IS NULL`,
      [sortedExpiredUuids],
    );
    expect(afterSweep2.rows.length).toBe(0);
  }, 15_000);

  it("G-02: validates Migration 0042 preflight aborts, deterministic pin_set_at backfill, CHECK constraints, and trigger-safe OTP dedup", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const migrationsDir = path.resolve(__dirname, "../../../../lib/db/drizzle");
    const sql0041 = fs.readFileSync(path.join(migrationsDir, "0041_profile_pin_and_otp.sql"), "utf-8");
    const sql0042 = fs.readFileSync(path.join(migrationsDir, "0042_profile_pin_concurrency_and_otp_unique.sql"), "utf-8");

    const runStatements = async (client: PGliteType, migrationSql: string) => {
      for (const stmt of migrationSql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await client.exec(stmt);
      }
    };

    const create0041Sandbox = async (): Promise<PGliteType> => {
      const pgMem = new PGlite();
      await pgMem.waitReady;
      await pgMem.exec(`
        CREATE TABLE "restaurants" (
          "id" serial PRIMARY KEY,
          "phone" text DEFAULT '' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "users" (
          "id" serial PRIMARY KEY,
          "restaurant_id" integer REFERENCES "restaurants"("id"),
          "role" text DEFAULT 'owner' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        INSERT INTO "restaurants" ("id", "phone") VALUES (1, '9800000001'), (2, '9800000002'), (3, '9800000003');
        INSERT INTO "users" ("id", "restaurant_id", "role") VALUES (1, 1, 'owner'), (2, 2, 'owner'), (3, 3, 'owner');
      `);
      await runStatements(pgMem, sql0041);
      // Drop pre-existing NOT NULL on pin_set_at/updated_at/pin_hash only to simulate legacy dirty schemas pre-0042
      await pgMem.exec(`
        ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "pin_hash" DROP NOT NULL;
        ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "pin_set_at" DROP NOT NULL;
        ALTER TABLE "restaurant_profile_pins" ALTER COLUMN "updated_at" DROP NOT NULL;
      `);
      return pgMem;
    };

    const validBcrypt = "$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890abcdefghijk".slice(0, 60);
    // Construct valid 60-char bcrypt string deterministically using bcrypt.hashSync
    const realValidHash = bcrypt.hashSync("preimage-placeholder", 4);

    // 1) Invalid pin_version, pepper_version, negative counters, invalid/empty hash, dirty tombstones all abort
    const sandbox = await create0041Sandbox();
    await sandbox.exec("BEGIN");
    const assertPreflightAbort = async (setupSql: string, match: RegExp) => {
      await sandbox.exec("SAVEPOINT sp_test");
      await sandbox.exec(setupSql);
      await expect(runStatements(sandbox, sql0042)).rejects.toThrow(match);
      await sandbox.exec("ROLLBACK TO SAVEPOINT sp_test");
    };

    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, '${realValidHash}', 0, 1, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*pin_version/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, '${realValidHash}', 1, 0, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*pepper_version/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, failed_attempts, pin_set_at, updated_at)
       VALUES (1, 1, '${realValidHash}', 1, 1, -1, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*failed_attempts/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, 'not-a-bcrypt-hash', 1, 1, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*pin_hash/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, '   ', 1, 1, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*pin_hash/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, NULL, 2, 1, now(), now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*Dirty tombstone/,
    );
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, failed_attempts, pin_set_at, updated_at)
       VALUES (1, 1, NULL, 2, 1, 3, NULL, now())`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*Dirty tombstone/,
    );
    // Missing pin_set_at with NO audit log and NULL updated_at aborts
    await assertPreflightAbort(
      `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
       VALUES (1, 1, '${realValidHash}', 1, 1, NULL, NULL)`,
      /MIGRATION_0042_PREFLIGHT_ABORT.*pin_set_at/,
    );
    await sandbox.exec("ROLLBACK");
    await sandbox.close();

    // 2) Deterministic backfill (audit log -> updated_at) + clean tombstone + trigger-safe OTP dedup + CHECK constraints
    const sandboxOk = await create0041Sandbox();
    expect(validBcrypt.length).toBeGreaterThan(10);

    // Seed Row 1: active pin missing pin_set_at -> backfilled from owner_security_audit_logs MAX(created_at)
    // Seed Row 2: active pin missing pin_set_at, no audit log -> backfilled from updated_at
    // Seed Row 3: clean admin-reset tombstone (pin_hash NULL, pin_set_at NULL, pin_version 2)
    await sandboxOk.exec(`
      INSERT INTO owner_security_audit_logs (restaurant_id_snapshot, owner_user_id_snapshot, actor_role, event_type, created_at)
      VALUES (1, 1, 'owner', 'profile_pin_set', '2026-01-10T10:00:00.000Z');
      INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at, updated_at)
      VALUES
        (1, 1, '${realValidHash}', 1, 1, NULL, '2026-02-01T00:00:00.000Z'),
        (2, 2, '${realValidHash}', 1, 1, NULL, '2026-01-20T12:30:00.000Z'),
        (3, 3, NULL, 2, 1, NULL, '2026-01-25T00:00:00.000Z');

      -- Seed duplicate active OTP challenges including 'delivered' state so dedup trigger-safety is verified
      INSERT INTO profile_pin_otp_challenges (id, restaurant_id, owner_user_id, otp_hmac, delivery_status, delivered_at, created_at, expires_at)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 1, 1, 'aa', 'delivered', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z', '2030-01-01T00:00:00.000Z'),
        ('22222222-2222-4222-8222-222222222222', 1, 1, 'bb', 'pending', NULL, '2026-01-01T00:02:00.000Z', '2030-01-01T00:00:00.000Z');
    `);

    await runStatements(sandboxOk, sql0042);

    // Re-running 0042 must remain strictly idempotent
    await runStatements(sandboxOk, sql0042);

    const pinRowsAfter = await sandboxOk.query<{
      restaurant_id: number;
      pin_hash: string | null;
      pin_set_at: Date | null;
    }>(`SELECT restaurant_id, pin_hash, pin_set_at FROM restaurant_profile_pins ORDER BY restaurant_id ASC`);

    expect(pinRowsAfter.rows[0].pin_set_at?.toISOString()).toBe("2026-01-10T10:00:00.000Z"); // From audit log
    expect(pinRowsAfter.rows[1].pin_set_at?.toISOString()).toBe("2026-01-20T12:30:00.000Z"); // Fallback to updated_at
    expect(pinRowsAfter.rows[2].pin_hash).toBeNull();
    expect(pinRowsAfter.rows[2].pin_set_at).toBeNull();

    // Duplicate delivered challenge was invalidated without violating trg_otp_challenge_monotonic (kept 'delivered')
    const otpRowsAfter = await sandboxOk.query<{
      id: string;
      delivery_status: string;
      invalidated_at: Date | null;
    }>(`SELECT id::text AS id, delivery_status, invalidated_at FROM profile_pin_otp_challenges ORDER BY created_at ASC`);
    expect(otpRowsAfter.rows[0].delivery_status).toBe("delivered");
    expect(otpRowsAfter.rows[0].invalidated_at).not.toBeNull();
    expect(otpRowsAfter.rows[1].invalidated_at).toBeNull();

    // Post-0042 CHECK constraints reject invalid versions and dirty tombstone rows
    await expect(
      sandboxOk.query(
        `INSERT INTO restaurant_profile_pins (restaurant_id, owner_user_id, pin_hash, pin_version, pepper_version, pin_set_at)
         VALUES (3, 3, NULL, 0, 1, NULL)`,
      ),
    ).rejects.toThrow();

    await expect(
      sandboxOk.query(
        `UPDATE restaurant_profile_pins SET failed_attempts = 1 WHERE restaurant_id = 3`,
      ),
    ).rejects.toThrow(/chk_restaurant_profile_pins_tombstone_consistency/);

    await sandboxOk.close();
  }, 15_000);
});


