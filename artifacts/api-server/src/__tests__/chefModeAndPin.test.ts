import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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
import { hashPinDigest } from "../lib/staffToken";

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
  } catch {}
  return { status: res.status, body: parsed };
}

describe("Chef Mode Toggle & Staff PIN Generation (Real Express + PGlite Integration)", () => {
  let server: http.Server;
  let baseUrl = "";
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let ownerAId = 0;
  let restaurantAId = 0;
  let ownerAToken = "";

  let ownerBId = 0;
  let restaurantBId = 0;
  let ownerBToken = "";

  let nonOwnerToken = "";

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

    const [restA] = await db
      .insert(schema.restaurants)
      .values({
        name: "Test Kitchen A",
        slug: "test-kitchen-a",
        cuisineType: "Indian",
        address: "123 Main St",
        city: "Bengaluru",
        phone: "9999999991",
        email: "kitchena@test.local",
        chefDashboardEnabled: false,
      })
      .returning();
    restaurantAId = restA.id;

    const [userA] = await db
      .insert(schema.users)
      .values({
        name: "Owner A",
        email: "ownera@test.local",
        passwordHash: "hash",
        role: "owner",
        restaurantId: restaurantAId,
      })
      .returning();
    ownerAId = userA.id;
    ownerAToken = generateToken({ userId: ownerAId, role: "owner" });

    const [restB] = await db
      .insert(schema.restaurants)
      .values({
        name: "Test Kitchen B",
        slug: "test-kitchen-b",
        cuisineType: "Indian",
        address: "456 Side St",
        city: "Bengaluru",
        phone: "9999999992",
        email: "kitchenb@test.local",
        chefDashboardEnabled: false,
      })
      .returning();
    restaurantBId = restB.id;

    const [userB] = await db
      .insert(schema.users)
      .values({
        name: "Owner B",
        email: "ownerb@test.local",
        passwordHash: "hash",
        role: "owner",
        restaurantId: restaurantBId,
      })
      .returning();
    ownerBId = userB.id;
    ownerBToken = generateToken({ userId: ownerBId, role: "owner" });

    const [adminUser] = await db
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@test.local",
        passwordHash: "hash",
        role: "super_admin",
        restaurantId: null,
      })
      .returning();
    nonOwnerToken = generateToken({ userId: adminUser.id, role: "super_admin" });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await memClient.close();
  });

  it("enables and disables Chef Mode with zero staff members and persists across fetches", async () => {
    const auth = { Authorization: `Bearer ${ownerAToken}` };

    const staffCheck = await reqJson(baseUrl, "GET", "/api/owner/staff", undefined, auth);
    expect(staffCheck.status).toBe(200);
    expect(staffCheck.body.staff).toHaveLength(0);

    const initial = await reqJson(baseUrl, "GET", "/api/owner/chef-mode", undefined, auth);
    expect(initial.status).toBe(200);
    expect(initial.body.chefDashboardEnabled).toBe(false);

    const toggleOn = await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, auth);
    expect(toggleOn.status).toBe(200);
    expect(toggleOn.body.chefDashboardEnabled).toBe(true);

    const reloadOn = await reqJson(baseUrl, "GET", "/api/owner/chef-mode", undefined, auth);
    expect(reloadOn.status).toBe(200);
    expect(reloadOn.body.chefDashboardEnabled).toBe(true);

    const toggleOff = await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, auth);
    expect(toggleOff.status).toBe(200);
    expect(toggleOff.body.chefDashboardEnabled).toBe(false);

    const reloadOff = await reqJson(baseUrl, "GET", "/api/owner/chef-mode", undefined, auth);
    expect(reloadOff.status).toBe(200);
    expect(reloadOff.body.chefDashboardEnabled).toBe(false);
  });

  it("rejects unauthorized, non-owner, and invalid boolean Chef Mode requests without mutating DB", async () => {
    expect((await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true })).status).toBe(401);
    expect(
      (await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, { Authorization: `Bearer ${nonOwnerToken}` })).status,
    ).toBe(403);
    expect(
      (await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: "true" }, { Authorization: `Bearer ${ownerAToken}` })).status,
    ).toBe(400);
  });

  it("creates waiter & chef, generates 6-digit HMAC-hashed PIN (no plaintext in DB), supports single-use /staff/connect-pin, and toggles Chef KDS access", async () => {
    const authA = { Authorization: `Bearer ${ownerAToken}` };
    const authB = { Authorization: `Bearer ${ownerBToken}` };

    // 1. Create Waiter + Generate PIN
    const createWaiter = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/staff",
      { name: "Ramesh Waiter", role: "waiter", phone: "+91 9000011111" },
      authA,
    );
    expect(createWaiter.status).toBe(201);
    expect(createWaiter.body.staff.role).toBe("waiter");
    const waiterId = createWaiter.body.staff.id;

    // Duplicate phone rejected with 409 without creating duplicate
    const dupWaiter = await reqJson(
      baseUrl,
      "POST",
      "/api/owner/staff",
      { name: "Ramesh Clone", role: "waiter", phone: "+91 9000011111" },
      authA,
    );
    expect(dupWaiter.status).toBe(409);

    // Wrong tenant cannot generate PIN for Restaurant A's staff
    const crossTenantPin = await reqJson(baseUrl, "POST", `/api/owner/staff/${waiterId}/pin`, undefined, authB);
    expect(crossTenantPin.status).toBe(404);

    // Generate PIN for Waiter
    const beforeMs = Date.now();
    const waiterPinRes = await reqJson(baseUrl, "POST", `/api/owner/staff/${waiterId}/pin`, undefined, authA);
    expect(waiterPinRes.status).toBe(200);
    expect(waiterPinRes.body.pin).toMatch(/^\d{6}$/);
    expect(waiterPinRes.body.name).toBe("Ramesh Waiter");
    expect(waiterPinRes.body.role).toBe("waiter");
    const expDelta = new Date(waiterPinRes.body.expiresAt).getTime() - beforeMs;
    expect(expDelta).toBeGreaterThanOrEqual(9.5 * 60 * 1000);
    expect(expDelta).toBeLessThanOrEqual(10.5 * 60 * 1000);

    // Verify DB stores HMAC digest, NEVER plaintext PIN
    const [dbWaiter] = await db
      .select()
      .from(schema.restaurantStaff)
      .where(eq(schema.restaurantStaff.id, waiterId));
    expect(dbWaiter.connectionPinDigest).toBe(hashPinDigest(waiterPinRes.body.pin));
    expect(dbWaiter.connectionPinDigest).not.toBe(waiterPinRes.body.pin);

    // Waiters-only state: Chef Mode toggle STILL works cleanly
    const waiterOnlyChefOn = await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, authA);
    expect(waiterOnlyChefOn.status).toBe(200);
    expect(waiterOnlyChefOn.body.chefDashboardEnabled).toBe(true);

    // Staff connects via /api/staff/connect-pin using Waiter PIN
    const connectWaiter = await reqJson(baseUrl, "POST", "/api/staff/connect-pin", { pin: waiterPinRes.body.pin });
    expect(connectWaiter.status).toBe(200);
    expect(connectWaiter.body.token).toBeTruthy();
    expect(connectWaiter.body.staff.role).toBe("waiter");

    // Second use of same one-time PIN fails with 401
    const secondUse = await reqJson(baseUrl, "POST", "/api/staff/connect-pin", { pin: waiterPinRes.body.pin });
    expect(secondUse.status).toBe(401);

    // 2. Create Chef + Generate PIN + Test Chef KDS with Chef Mode ON and OFF
    const createChef = await reqJson(baseUrl, "POST", "/api/owner/staff", { name: "Sanjeev Chef", role: "chef" }, authA);
    expect(createChef.status).toBe(201);
    const chefId = createChef.body.staff.id;

    const chefPinRes = await reqJson(baseUrl, "POST", `/api/owner/staff/${chefId}/pin`, undefined, authA);
    expect(chefPinRes.status).toBe(200);
    expect(chefPinRes.body.pin).toMatch(/^\d{6}$/);
    expect(chefPinRes.body.role).toBe("chef");

    const connectChef = await reqJson(baseUrl, "POST", "/api/staff/connect-pin", { pin: chefPinRes.body.pin });
    expect(connectChef.status).toBe(200);
    const chefAuth = { Authorization: `Bearer ${connectChef.body.token}` };

    // Chef Mode is ON -> /api/staff/me returns true & /api/staff/chef/orders returns 200
    const meOn = await reqJson(baseUrl, "GET", "/api/staff/me", undefined, chefAuth);
    expect(meOn.status).toBe(200);
    expect(meOn.body.chefDashboardEnabled).toBe(true);
    const kdsOn = await reqJson(baseUrl, "GET", "/api/staff/chef/orders", undefined, chefAuth);
    expect(kdsOn.status).toBe(200);

    // Owner toggles Chef Mode OFF -> /api/staff/me returns false & /api/staff/chef/orders returns 403 CHEF_MODE_DISABLED
    await reqJson(baseUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, authA);
    const meOff = await reqJson(baseUrl, "GET", "/api/staff/me", undefined, chefAuth);
    expect(meOff.status).toBe(200);
    expect(meOff.body.chefDashboardEnabled).toBe(false);
    const kdsOff = await reqJson(baseUrl, "GET", "/api/staff/chef/orders", undefined, chefAuth);
    expect(kdsOff.status).toBe(403);
    expect(kdsOff.body.code).toBe("CHEF_MODE_DISABLED");

    // Regenerate PIN on existing chef without creating duplicate staff rows
    const regenPinRes = await reqJson(baseUrl, "POST", `/api/owner/staff/${chefId}/pin`, undefined, authA);
    expect(regenPinRes.status).toBe(200);
    expect(regenPinRes.body.pin).toMatch(/^\d{6}$/);

    const finalStaffList = await reqJson(baseUrl, "GET", "/api/owner/staff", undefined, authA);
    expect(finalStaffList.body.staff).toHaveLength(2);
  });

  it("rate limits excessive invalid PIN attempts on /api/staff/connect-pin", async () => {
    for (let i = 0; i < 5; i++) {
      await reqJson(baseUrl, "POST", "/api/staff/connect-pin", { pin: "000000" }, { "X-Forwarded-For": "203.0.113.55" });
    }
    const throttled = await reqJson(
      baseUrl,
      "POST",
      "/api/staff/connect-pin",
      { pin: "000000" },
      { "X-Forwarded-For": "203.0.113.55" },
    );
    expect(throttled.status).toBe(429);
  });
});
