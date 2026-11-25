import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PGlite as PGliteType } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../../../../lib/db/src/schema";

const { memClient, memPool } = await vi.hoisted(async () => {
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
  return {
    memClient: client,
    memPool: poolAdapter,
  };
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

async function reqJson(
  baseUrl: string,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
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
  return { status: res.status, body: parsed };
}

describe("Stage 1: Profile & Summary API Split + Deprecated Razorpay Exposure Removal", () => {
  let server: http.Server;
  let baseUrl = "";
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let ownerId = 0;
  let restaurantId = 0;
  let planId = 0;
  let ownerToken = "";
  let pinUnlockToken = "";
  let adminToken = "";
  let partnerId = 0;

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
        try {
          await memClient.exec(stmt);
        } catch {
          // Ignore idempotent migration re-runs
        }
      }
    }

    db = drizzle(memClient, { schema });

    const [plan] = await db
      .insert(schema.subscriptionPlans)
      .values({
        name: "Pro Plan",
        price: 999,
        customerLimit: 500,
        description: "Test Pro",
        isActive: true,
        displayOrder: 1,
        validityType: "days",
        validityValue: 30,
      })
      .returning();
    planId = plan.id;

    const [rest] = await db
      .insert(schema.restaurants)
      .values({
        name: "Stage One Bistro",
        slug: "stage-one-bistro",
        description: "Fine dining",
        cuisineType: "multi_cuisine",
        address: "10 MG Road",
        locality: "Indiranagar",
        city: "Bengaluru",
        state: "Karnataka",
        district: "Bengaluru Urban",
        latitude: 12.9716,
        longitude: 77.5946,
        phone: "9876543210",
        email: "owner@stage1.local",
        upiId: "bistro@okaxis",
        upiName: "Stage One Bistro",
        personalUpiEnabled: true,
        upiVerified: true,
        qrImageData: "data:image/png;base64,ZmFrZQ==",
        qrDecodedPayload: "upi://pay?pa=bistro@okaxis",
        qrMerchantName: "Stage One Bistro",
        qrExtractedUpiId: "bistro@okaxis",
        paymentQrEnabled: true,
        whatsappNumber: "919876543210",
        taxPercent: 5,
        seatingLabel: "Table",
        planId: plan.id,
        customerLimit: 500,
        customersUsed: 42,
        subscriptionStatus: "active",
        approvalStatus: "approved",
        isActive: true,
        razorpayKeyId: "rzp_live_secret_id",
        razorpayKeySecret: "rzp_live_secret_val",
        razorpayWebhookSecret: "rzp_live_webhook_secret",
      })
      .returning();
    restaurantId = rest.id;

    const passwordHash = await bcrypt.hash("oldpass123", 10);
    const [owner] = await db
      .insert(schema.users)
      .values({
        name: "Stage1 Owner",
        email: "owner@stage1.local",
        passwordHash,
        role: "owner",
        restaurantId,
      })
      .returning();
    ownerId = owner.id;
    await db.update(schema.restaurants).set({ ownerId }).where(eq(schema.restaurants.id, restaurantId));
    ownerToken = generateToken({ userId: ownerId, role: "owner" });

    const [admin] = await db
      .insert(schema.users)
      .values({
        name: "Stage1 Admin",
        email: "admin@stage1.local",
        passwordHash,
        role: "super_admin",
      })
      .returning();
    adminToken = generateToken({ userId: admin.id, role: "super_admin" });

    const [partnerUser] = await db
      .insert(schema.users)
      .values({
        name: "Stage1 Partner",
        email: "partner@stage1.local",
        passwordHash,
        role: "partner",
      })
      .returning();

    const [partner] = await db
      .insert(schema.partners)
      .values({
        userId: partnerUser.id,
        name: "Stage1 Partner",
        email: "partner@stage1.local",
        phone: "9111111111",
        referralCode: "STAGE1P",
        commissionPercentage: 10,
        status: "active",
      })
      .returning();
    partnerId = partner.id;

    await db.insert(schema.platformSettings).values([
      { key: "razorpay_key_id", value: "rzp_test_platform123" },
      { key: "razorpay_key_secret", value: "platform_secret_xyz" },
    ]);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /api/owner/restaurant/summary returns only approved non-sensitive fields", async () => {
    const unauth = await reqJson(baseUrl, "GET", "/api/owner/restaurant/summary");
    expect(unauth.status).toBe(401);

    const res = await reqJson(baseUrl, "GET", "/api/owner/restaurant/summary", undefined, {
      Authorization: `Bearer ${ownerToken}`,
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "approvalStatus",
      "customerLimit",
      "customersUsed",
      "id",
      "isActive",
      "name",
      "planId",
      "seatingLabel",
      "slug",
      "subscriptionExpiresAt",
      "subscriptionStartedAt",
      "subscriptionStatus",
    ]);
    expect(res.body.upiId).toBeUndefined();
    expect(res.body.qrImageData).toBeUndefined();
    expect(res.body.phone).toBeUndefined();
    expect(res.body.email).toBeUndefined();
    expect(res.body.razorpayKeyId).toBeUndefined();
    expect(res.body.razorpayKeySecret).toBeUndefined();
    expect(res.body.razorpayWebhookSecret).toBeUndefined();
  });

  it("PATCH /api/owner/tables/seating-mode validates input and updates only seatingLabel", async () => {
    const invalid = await reqJson(
      baseUrl,
      "PATCH",
      "/api/owner/tables/seating-mode",
      { seatingLabel: "Booth" },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(invalid.status).toBe(400);

    const off = await reqJson(
      baseUrl,
      "PATCH",
      "/api/owner/tables/seating-mode",
      { seatingLabel: null },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ seatingLabel: null });

    const on = await reqJson(
      baseUrl,
      "PATCH",
      "/api/owner/tables/seating-mode",
      { seatingLabel: "Table" },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ seatingLabel: "Table" });

    const [row] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId)).limit(1);
    expect(row.name).toBe("Stage One Bistro");
    expect(row.upiId).toBe("bistro@okaxis");
  });

  it("GET & PUT /api/owner/profile enforce Stage 2 Profile PIN gate, preserve email-sync & coordinate validation, ignore seatingLabel, and never expose Razorpay secrets", async () => {
    const gateBeforeSetup = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      Authorization: `Bearer ${ownerToken}`,
    });
    expect(gateBeforeSetup.status).toBe(403);
    expect(gateBeforeSetup.body.code).toBe("PIN_SETUP_REQUIRED");

    const setupRes = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/profile/pin/setup",
      { pin: "1234", confirmPin: "1234" },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(setupRes.status).toBe(201);
    expect(setupRes.body.ok).toBe(true);
    expect(typeof setupRes.body.unlockToken).toBe("string");
    pinUnlockToken = setupRes.body.unlockToken;

    const gateAfterSetupWithoutToken = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      Authorization: `Bearer ${ownerToken}`,
    });
    expect(gateAfterSetupWithoutToken.status).toBe(403);
    expect(gateAfterSetupWithoutToken.body.code).toBe("PIN_REQUIRED");

    const getRes = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      Authorization: `Bearer ${ownerToken}`,
      "X-Profile-Pin-Token": pinUnlockToken,
    });
    expect(getRes.status).toBe(200);
    expect(getRes.body.slug).toBe("stage-one-bistro");
    expect(getRes.body.upiId).toBe("bistro@okaxis");
    expect(getRes.body.razorpayKeyId).toBeUndefined();
    expect(getRes.body.razorpayKeySecret).toBeUndefined();
    expect(getRes.body.razorpayWebhookSecret).toBeUndefined();
    expect(getRes.body.seatingLabel).toBeUndefined();

    const badCoord = await reqJson(
      baseUrl,
      "PUT",
      "/api/owner/profile",
      { latitude: 120 },
      {
        Authorization: `Bearer ${ownerToken}`,
        "X-Profile-Pin-Token": pinUnlockToken,
      },
    );
    expect(badCoord.status).toBe(400);

    const putRes = await reqJson(
      baseUrl,
      "PUT",
      "/api/owner/profile",
      {
        name: "Stage One Bistro Updated",
        email: "spoofed@evil.com",
        upiId: "updated@okaxis",
        taxPercent: 12,
        seatingLabel: null,
        qrExtractedUpiId: "updated@okaxis",
        qrMerchantName: "Bistro Updated",
        paymentQrEnabled: true,
      },
      {
        Authorization: `Bearer ${ownerToken}`,
        "X-Profile-Pin-Token": pinUnlockToken,
      },
    );
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe("Stage One Bistro Updated");
    expect(putRes.body.slug).toBe("stage-one-bistro");
    expect(putRes.body.email).toBe("owner@stage1.local");
    expect(putRes.body.upiId).toBe("updated@okaxis");
    expect(putRes.body.taxPercent).toBe(12);
    expect(putRes.body.seatingLabel).toBeUndefined();
    expect(putRes.body.razorpayKeyId).toBeUndefined();
    expect(putRes.body.razorpayKeySecret).toBeUndefined();
    expect(putRes.body.razorpayWebhookSecret).toBeUndefined();

    const [row] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId)).limit(1);
    expect(row.seatingLabel).toBe("Table");
    expect(row.email).toBe("owner@stage1.local");
  });

  it("Legacy GET and PUT /api/owner/restaurant return HTTP 410 Gone", async () => {
    const legacyGet = await reqJson(baseUrl, "GET", "/api/owner/restaurant", undefined, {
      Authorization: `Bearer ${ownerToken}`,
    });
    expect(legacyGet.status).toBe(410);

    const legacyPut = await reqJson(
      baseUrl,
      "PUT",
      "/api/owner/restaurant",
      { name: "Should Not Update" },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(legacyPut.status).toBe(410);

    const [row] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId)).limit(1);
    expect(row.name).toBe("Stage One Bistro Updated");
  });

  it("GET /api/owner/stats, GET /api/menu/:id, and Admin restaurant routes omit deprecated Razorpay credentials while platform payment settings remain intact", async () => {
    const statsRes = await reqJson(baseUrl, "GET", "/api/owner/stats", undefined, {
      Authorization: `Bearer ${ownerToken}`,
    });
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.razorpayKeyId).toBeUndefined();

    const menuRes = await reqJson(baseUrl, "GET", `/api/menu/${restaurantId}`);
    expect(menuRes.status).toBe(200);
    expect(menuRes.body.restaurant.razorpayKeyId).toBeUndefined();
    expect(menuRes.body.restaurant.razorpayKeySecret).toBeUndefined();
    expect(menuRes.body.restaurant.razorpayWebhookSecret).toBeUndefined();

    const adminList = await reqJson(baseUrl, "GET", "/api/admin/restaurants", undefined, {
      Authorization: `Bearer ${adminToken}`,
    });
    expect(adminList.status).toBe(200);
    expect(adminList.body[0].razorpayKeyId).toBeUndefined();
    expect(adminList.body[0].razorpayKeySecret).toBeUndefined();
    expect(adminList.body[0].razorpayWebhookSecret).toBeUndefined();

    const assignRes = await reqJson(
      baseUrl,
      "PATCH",
      `/api/admin/restaurants/${restaurantId}/partner`,
      { partnerId },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.razorpayKeyId).toBeUndefined();
    expect(assignRes.body.razorpayKeySecret).toBeUndefined();
    expect(assignRes.body.razorpayWebhookSecret).toBeUndefined();

    const toggleRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${restaurantId}/toggle`,
      undefined,
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.razorpayKeyId).toBeUndefined();
    expect(toggleRes.body.razorpayKeySecret).toBeUndefined();
    expect(toggleRes.body.razorpayWebhookSecret).toBeUndefined();

    const suspendRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${restaurantId}/suspend`,
      { reason: "test" },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.razorpayKeyId).toBeUndefined();
    expect(suspendRes.body.razorpayKeySecret).toBeUndefined();
    expect(suspendRes.body.razorpayWebhookSecret).toBeUndefined();

    const activateRes = await reqJson(
      baseUrl,
      "POST",
      `/api/admin/restaurants/${restaurantId}/activate`,
      undefined,
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.razorpayKeyId).toBeUndefined();
    expect(activateRes.body.razorpayKeySecret).toBeUndefined();
    expect(activateRes.body.razorpayWebhookSecret).toBeUndefined();

    const adminUpdateRes = await reqJson(
      baseUrl,
      "PUT",
      `/api/admin/restaurants/${restaurantId}`,
      { name: "Stage One Bistro Admin Edited" },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(adminUpdateRes.status).toBe(200);
    expect(adminUpdateRes.body.razorpayKeyId).toBeUndefined();
    expect(adminUpdateRes.body.razorpayKeySecret).toBeUndefined();
    expect(adminUpdateRes.body.razorpayWebhookSecret).toBeUndefined();

    const platformPayRes = await reqJson(baseUrl, "GET", "/api/admin/payment-settings", undefined, {
      Authorization: `Bearer ${adminToken}`,
    });
    expect(platformPayRes.status).toBe(200);
    expect(platformPayRes.body.razorpayConfigured).toBe(true);
    expect(platformPayRes.body.razorpayKeyId).toContain("rzp_test_pla");
  });

  it("PUT /api/owner/account remains functional and mirrors email change to profile", async () => {
    const res = await reqJson(
      baseUrl,
      "PUT",
      "/api/owner/account",
      { currentPassword: "oldpass123", newEmail: "newowner@stage1.local" },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailChanged: true, passwordChanged: false });

    const profileAfter = await reqJson(baseUrl, "GET", "/api/owner/profile", undefined, {
      Authorization: `Bearer ${ownerToken}`,
      "X-Profile-Pin-Token": pinUnlockToken,
    });
    expect(profileAfter.status).toBe(200);
    expect(profileAfter.body.email).toBe("newowner@stage1.local");
  });

  it("POST /api/subscription/verify strips deprecated Razorpay credentials on initial and idempotent responses", async () => {
    const orderId = "order_stage1_test";
    const paymentId = "pay_stage1_test";
    const signature = crypto
      .createHmac("sha256", "platform_secret_xyz")
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const firstVerify = await reqJson(
      baseUrl,
      "POST",
      "/api/subscription/verify",
      {
        planId,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(firstVerify.status).toBe(200);
    expect(firstVerify.body.pending).toBe(false);
    expect(firstVerify.body.restaurant.id).toBe(restaurantId);
    expect(firstVerify.body.restaurant.razorpayKeyId).toBeUndefined();
    expect(firstVerify.body.restaurant.razorpayKeySecret).toBeUndefined();
    expect(firstVerify.body.restaurant.razorpayWebhookSecret).toBeUndefined();

    const idempotentVerify = await reqJson(
      baseUrl,
      "POST",
      "/api/subscription/verify",
      {
        planId,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      },
      { Authorization: `Bearer ${ownerToken}` },
    );
    expect(idempotentVerify.status).toBe(200);
    expect(idempotentVerify.body.pending).toBe(false);
    expect(idempotentVerify.body.restaurant.id).toBe(restaurantId);
    expect(idempotentVerify.body.restaurant.razorpayKeyId).toBeUndefined();
    expect(idempotentVerify.body.restaurant.razorpayKeySecret).toBeUndefined();
    expect(idempotentVerify.body.restaurant.razorpayWebhookSecret).toBeUndefined();
  });
});
