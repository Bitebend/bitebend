import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { PGlite as PGliteType } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
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
    connect: async () => ({
      query: (...args: any[]) => poolAdapter.query(args[0], args[1], args[2]),
      release: () => {},
    }),
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
): Promise<{ status: number; body: any; headers: Headers }> {
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
  return { status: res.status, body: parsed, headers: res.headers };
}

describe("Waiter Order Sync, Option C Assignment & Connection Headers (Express + PGlite)", () => {
  let server: http.Server;
  let baseUrl = "";
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let restaurantAId = 0;
  let ownerAToken = "";
  let restaurantBId = 0;
  let menuItemAId = 0;
  let tableAId = 0;

  let waiterA1Id = 0;
  let waiterA1Token = "";
  let waiterA2Id = 0;
  let waiterA2Token = "";
  let chefAToken = "";
  let waiterB1Token = "";

  let sessionId = 0;
  let order1Id = 0;
  let order2Id = 0;

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
        name: "Sync Bistro A",
        slug: "sync-bistro-a",
        cuisineType: "Indian",
        address: "100 Floor St",
        city: "Bengaluru",
        phone: "9999991111",
        email: "bistroa@test.local",
        status: "active",
        approvalStatus: "approved",
        isActive: true,
        seatingLabel: "Table",
        chefDashboardEnabled: false,
      })
      .returning();
    restaurantAId = restA.id;

    const [ownerA] = await db
      .insert(schema.users)
      .values({
        name: "Owner A",
        email: "ownera@sync.local",
        passwordHash: "hash",
        role: "owner",
        restaurantId: restaurantAId,
      })
      .returning();
    ownerAToken = generateToken({ userId: ownerA.id, role: "owner" });

    const [catA] = await db
      .insert(schema.menuCategories)
      .values({ restaurantId: restaurantAId, name: "Mains", sortOrder: 1 })
      .returning();
    const [itemA] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId: catA.id,
        name: "Paneer Tikka",
        price: 250,
        isAvailable: true,
        isVeg: true,
      })
      .returning();
    menuItemAId = itemA.id;

    const [tblA] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId: restaurantAId,
        tableNumber: "T1",
        seatingCapacity: 4,
        qrCodeToken: "sync-qr-t1",
      })
      .returning();
    tableAId = tblA.id;

    const [restB] = await db
      .insert(schema.restaurants)
      .values({
        name: "Sync Bistro B",
        slug: "sync-bistro-b",
        cuisineType: "Cafe",
        address: "200 Floor St",
        city: "Mumbai",
        phone: "9999992222",
        email: "bistrob@test.local",
        status: "active",
        approvalStatus: "approved",
        isActive: true,
        seatingLabel: "Table",
        chefDashboardEnabled: false,
      })
      .returning();
    restaurantBId = restB.id;

    const [ownerB] = await db
      .insert(schema.users)
      .values({
        name: "Owner B",
        email: "ownerb@sync.local",
        passwordHash: "hash",
        role: "owner",
        restaurantId: restaurantBId,
      })
      .returning();
    const ownerBToken = generateToken({ userId: ownerB.id, role: "owner" });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Create Waiter A1, Waiter A2, Chef A, and Waiter B1 and connect via PIN
    const createAndConnect = async (ownerToken: string, name: string, role: "waiter" | "chef") => {
      const created = await reqJson(
        baseUrl,
        "POST",
        "/api/owner/staff",
        { name, role },
        { Authorization: `Bearer ${ownerToken}` },
      );
      expect(created.status).toBe(201);
      const staffId = created.body.staff.id as number;
      const pinRes = await reqJson(
        baseUrl,
        "POST",
        `/api/owner/staff/${staffId}/pin`,
        undefined,
        { Authorization: `Bearer ${ownerToken}` },
      );
      expect(pinRes.status).toBe(200);
      const connectRes = await reqJson(baseUrl, "POST", "/api/staff/connect-pin", { pin: pinRes.body.pin });
      expect(connectRes.status).toBe(200);
      return { id: staffId, token: connectRes.body.token as string };
    };

    const w1 = await createAndConnect(ownerAToken, "Waiter A1", "waiter");
    waiterA1Id = w1.id;
    waiterA1Token = w1.token;

    const w2 = await createAndConnect(ownerAToken, "Waiter A2", "waiter");
    waiterA2Id = w2.id;
    waiterA2Token = w2.token;

    const c1 = await createAndConnect(ownerAToken, "Chef A", "chef");
    chefAToken = c1.token;

    const wb = await createAndConnect(ownerBToken, "Waiter B1", "waiter");
    waiterB1Token = wb.token;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GET /api/staff/me and GET /api/staff/waiter/orders return JSON with strict no-store cache headers", async () => {
    const meRes = await reqJson(baseUrl, "GET", "/api/staff/me", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(meRes.status).toBe(200);
    expect(meRes.headers.get("content-type")).toContain("application/json");
    expect(meRes.headers.get("cache-control")).toContain("no-store");
    expect(meRes.headers.get("pragma")).toBe("no-cache");
    expect(meRes.body.staff.id).toBe(waiterA1Id);
    expect(meRes.body.chefDashboardEnabled).toBe(false);

    const ordersRes = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(ordersRes.status).toBe(200);
    expect(ordersRes.headers.get("content-type")).toContain("application/json");
    expect(ordersRes.headers.get("cache-control")).toContain("no-store");
    expect(ordersRes.body).toEqual([]);
  });

  it("assigning session waiter immediately exposes active orders in assigned waiter's feed and isolates others", async () => {
    const customerOrder1 = await reqJson(baseUrl, "POST", `/api/menu/${restaurantAId}/orders`, {
      tableId: tableAId,
      tableNumber: "T1",
      customerName: "Rohan",
      customerPhone: "9876543210",
      paymentMethod: "cash",
      items: [{ menuItemId: menuItemAId, quantity: 2 }],
    });
    expect(customerOrder1.status).toBe(201);
    order1Id = customerOrder1.body.id;
    sessionId = customerOrder1.body.sessionId;
    expect(sessionId).toBeGreaterThan(0);
    expect(customerOrder1.body.assignedWaiterId).toBeNull();

    // Unassigned -> neither Waiter A1 nor Waiter A2 sees it
    const w1Before = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1Before.body).toHaveLength(0);

    // Owner assigns session to Waiter A1
    const assignSessionRes = await reqJson(
      baseUrl,
      "POST",
      `/api/owner/sessions/${sessionId}/assign-waiter`,
      { waiterId: waiterA1Id },
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(assignSessionRes.status).toBe(200);
    expect(assignSessionRes.body.assignedWaiterId).toBe(waiterA1Id);
    expect(assignSessionRes.body.cascadedOrdersCount).toBe(1);

    // Waiter A1 immediately sees Order 1; Waiter A2 & cross-tenant Waiter B1 do not
    const w1After = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1After.status).toBe(200);
    expect(w1After.body).toHaveLength(1);
    expect(w1After.body[0].id).toBe(order1Id);
    expect(w1After.body[0].assignedWaiterId).toBe(waiterA1Id);
    expect(w1After.body[0].assignmentSource).toBe("inherited");
    expect(w1After.body[0].effectiveTableNumber).toBe("T1");

    const w2After = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(w2After.body).toHaveLength(0);

    const wbAfter = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterB1Token}`,
    });
    expect(wbAfter.body).toHaveLength(0);
  });

  it("new customer orders on an assigned session automatically inherit the session waiter and appear immediately", async () => {
    const customerOrder2 = await reqJson(baseUrl, "POST", `/api/menu/${restaurantAId}/orders`, {
      tableId: tableAId,
      tableNumber: "T1",
      customerName: "Rohan",
      customerPhone: "9876543210",
      paymentMethod: "cash",
      items: [{ menuItemId: menuItemAId, quantity: 1 }],
    });
    expect(customerOrder2.status).toBe(201);
    order2Id = customerOrder2.body.id;
    expect(customerOrder2.body.sessionId).toBe(sessionId);
    expect(customerOrder2.body.assignedWaiterId).toBe(waiterA1Id);
    expect(customerOrder2.body.assignmentSource).toBe("inherited");

    const w1Orders = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1Orders.body.map((o: any) => o.id).sort()).toEqual([order1Id, order2Id].sort());
  });

  it("preserves Option C manual overrides across session reassignments and reverts cleanly", async () => {
    // Override Order 2 specifically to Waiter A2
    const overrideRes = await reqJson(
      baseUrl,
      "POST",
      `/api/owner/orders/${order2Id}/assign-waiter`,
      { waiterId: waiterA2Id },
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.assignmentSource).toBe("manual_override");

    const w1Mid = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1Mid.body.map((o: any) => o.id)).toEqual([order1Id]);

    const w2Mid = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(w2Mid.body.map((o: any) => o.id)).toEqual([order2Id]);
    expect(w2Mid.body[0].assignmentSource).toBe("manual_override");

    // Reassign session to Waiter A2, then back to Waiter A1:
    // Order 1 (inherited) follows session to Waiter A2 then back to Waiter A1;
    // Order 2 (manual_override) remains on Waiter A2 throughout!
    await reqJson(
      baseUrl,
      "POST",
      `/api/owner/sessions/${sessionId}/assign-waiter`,
      { waiterId: waiterA2Id },
      { Authorization: `Bearer ${ownerAToken}` },
    );
    const w2Both = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(w2Both.body.map((o: any) => o.id).sort()).toEqual([order1Id, order2Id].sort());

    await reqJson(
      baseUrl,
      "POST",
      `/api/owner/sessions/${sessionId}/assign-waiter`,
      { waiterId: waiterA1Id },
      { Authorization: `Bearer ${ownerAToken}` },
    );

    const w1Back = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1Back.body.map((o: any) => o.id)).toEqual([order1Id]);

    const w2Preserved = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(w2Preserved.body.map((o: any) => o.id)).toEqual([order2Id]);

    // Revert Order 2 back to inherited session waiter (Waiter A1)
    const revertRes = await reqJson(
      baseUrl,
      "POST",
      `/api/owner/orders/${order2Id}/revert-waiter`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(revertRes.status).toBe(200);
    expect(revertRes.body.assignedWaiterId).toBe(waiterA1Id);
    expect(revertRes.body.assignmentSource).toBe("inherited");

    const w1All = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA1Token}`,
    });
    expect(w1All.body.map((o: any) => o.id).sort()).toEqual([order1Id, order2Id].sort());

    const w2Empty = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(w2Empty.body).toEqual([]);
  });

  it("enforces role isolation (403 for chef) and immediate token revocation (401 on disconnect)", async () => {
    const chefWaiterOrders = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${chefAToken}`,
    });
    expect(chefWaiterOrders.status).toBe(403);

    const disconnectRes = await reqJson(
      baseUrl,
      "POST",
      `/api/owner/staff/${waiterA2Id}/disconnect`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(disconnectRes.status).toBe(200);

    const revokedOrders = await reqJson(baseUrl, "GET", "/api/staff/waiter/orders", undefined, {
      Authorization: `Bearer ${waiterA2Token}`,
    });
    expect(revokedOrders.status).toBe(401);
  });
});
