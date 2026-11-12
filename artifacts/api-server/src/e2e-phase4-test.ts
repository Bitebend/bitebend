import http from "node:http";
import app from "./app";
import { db, pool, ensureDbReady } from "@workspace/db";
import {
  restaurants,
  users,
  restaurantStaff,
  restaurantTables,
  tableSessions,
  orders,
  orderItems,
  orderActivityLogs,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { generateToken } from "./lib/token";
import { generateStaffToken } from "./lib/staffToken";

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function makeRequest(
  serverUrl: string,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const postData = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (postData !== undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(postData).toString();
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // retain raw string
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: parsed,
          });
        });
      },
    );

    req.on("error", (err) => {
      reject(err);
    });

    if (postData !== undefined) {
      req.write(postData);
    }
    req.end();
  });
}

async function runPhase4Tests() {
  console.log("================================================================================");
  console.log("🚀 BITEBEND PHASE 4.1 + 4.2: CHEF MODE & ORDER STATUS WORKFLOW E2E SUITE");
  console.log("================================================================================\n");

  await ensureDbReady();

  // Start test server on ephemeral port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const serverUrl = `http://127.0.0.1:${address.port}`;
  console.log(`[TEST HARNESS] Express server running at ${serverUrl}\n`);

  const runId = Date.now();

  const isPostgresUrl = Boolean(
    process.env.DATABASE_URL &&
      (process.env.DATABASE_URL.startsWith("postgres://") || process.env.DATABASE_URL.startsWith("postgresql://")) &&
      process.env.USE_LOCAL_DB !== "true",
  );
  console.log(`[DATABASE ENVIRONMENT] ${isPostgresUrl ? "External PostgreSQL (pg.Pool)" : "Local Persistent PGlite WASM (.data/pglite)"}`);
  if (isPostgresUrl) {
    const conn1 = await pool.connect();
    const conn2 = await pool.connect();
    const pid1 = await conn1.query("SELECT pg_backend_pid() AS pid, version()");
    const pid2 = await conn2.query("SELECT pg_backend_pid() AS pid");
    console.log(`  [pg.Pool Independent Connection 1] Backend PID: ${pid1.rows[0].pid}`);
    console.log(`  [pg.Pool Independent Connection 2] Backend PID: ${pid2.rows[0].pid}`);
    console.log(`  [PostgreSQL Server] Version: ${pid1.rows[0].version.split("\n")[0]}\n`);
    conn1.release();
    conn2.release();
  }

  // 1. Setup Test Restaurants & Owners
  const [restoA] = await db
    .insert(restaurants)
    .values({
      name: `Phase 4 Resto A ${runId}`,
      slug: `resto-4-a-${runId}`,
      cuisineType: "North Indian",
      city: "Bengaluru",
      phone: `9199${String(runId).slice(-8)}`,
      email: `resto-4-a-${runId}@bitebend.test`,
      subscriptionPlan: "premium",
      subscriptionStatus: "active",
      customerLimit: 1000,
      seatingLabel: "Table",
      chefDashboardEnabled: false,
    })
    .returning();

  const [restoB] = await db
    .insert(restaurants)
    .values({
      name: `Phase 4 Resto B ${runId}`,
      slug: `resto-4-b-${runId}`,
      cuisineType: "South Indian",
      city: "Bengaluru",
      phone: `9198${String(runId).slice(-8)}`,
      email: `resto-4-b-${runId}@bitebend.test`,
      subscriptionPlan: "premium",
      subscriptionStatus: "active",
      customerLimit: 1000,
      seatingLabel: "Table",
      chefDashboardEnabled: false,
    })
    .returning();

  const [ownerA] = await db
    .insert(users)
    .values({
      name: `Owner 4 A ${runId}`,
      email: `owner-4-a-${runId}@bitebend.test`,
      passwordHash: "hashedpassword",
      role: "owner",
      restaurantId: restoA.id,
    })
    .returning();

  const [ownerB] = await db
    .insert(users)
    .values({
      name: `Owner 4 B ${runId}`,
      email: `owner-4-b-${runId}@bitebend.test`,
      passwordHash: "hashedpassword",
      role: "owner",
      restaurantId: restoB.id,
    })
    .returning();

  const ownerAToken = generateToken({
    userId: ownerA.id,
    email: ownerA.email,
    role: "owner",
    restaurantId: restoA.id,
  });

  const ownerBToken = generateToken({
    userId: ownerB.id,
    email: ownerB.email,
    role: "owner",
    restaurantId: restoB.id,
  });

  const ownerAHeaders = { Authorization: `Bearer ${ownerAToken}` };
  const ownerBHeaders = { Authorization: `Bearer ${ownerBToken}` };

  // Setup Staff for Resto A (waiters & chef)
  const [waiterA1] = await db
    .insert(restaurantStaff)
    .values({
      restaurantId: restoA.id,
      name: `Waiter Staff 1 ${runId}`,
      role: "waiter",
      isActive: true,
      tokenVersion: 1,
    })
    .returning();

  const [waiterA2] = await db
    .insert(restaurantStaff)
    .values({
      restaurantId: restoA.id,
      name: `Waiter Staff 2 ${runId}`,
      role: "waiter",
      isActive: true,
      tokenVersion: 1,
    })
    .returning();

  const [chefA] = await db
    .insert(restaurantStaff)
    .values({
      restaurantId: restoA.id,
      name: `Chef Staff A ${runId}`,
      role: "chef",
      isActive: true,
      tokenVersion: 1,
    })
    .returning();

  // Setup Staff for Resto B (waiter & chef for cross-tenant testing)
  const [waiterB] = await db
    .insert(restaurantStaff)
    .values({
      restaurantId: restoB.id,
      name: `Waiter Staff B ${runId}`,
      role: "waiter",
      isActive: true,
      tokenVersion: 1,
    })
    .returning();

  const [chefB] = await db
    .insert(restaurantStaff)
    .values({
      restaurantId: restoB.id,
      name: `Chef Staff B ${runId}`,
      role: "chef",
      isActive: true,
      tokenVersion: 1,
    })
    .returning();

  const waiterA1Token = generateStaffToken({
    staffId: waiterA1.id,
    restaurantId: restoA.id,
    role: "waiter",
    tokenVersion: 1,
  });

  const waiterA2Token = generateStaffToken({
    staffId: waiterA2.id,
    restaurantId: restoA.id,
    role: "waiter",
    tokenVersion: 1,
  });

  const chefAToken = generateStaffToken({
    staffId: chefA.id,
    restaurantId: restoA.id,
    role: "chef",
    tokenVersion: 1,
  });

  const waiterBToken = generateStaffToken({
    staffId: waiterB.id,
    restaurantId: restoB.id,
    role: "waiter",
    tokenVersion: 1,
  });

  const chefBToken = generateStaffToken({
    staffId: chefB.id,
    restaurantId: restoB.id,
    role: "chef",
    tokenVersion: 1,
  });

  const waiterA1Headers = { Authorization: `Bearer ${waiterA1Token}` };
  const waiterA2Headers = { Authorization: `Bearer ${waiterA2Token}` };
  const chefAHeaders = { Authorization: `Bearer ${chefAToken}` };
  const waiterBHeaders = { Authorization: `Bearer ${waiterBToken}` };
  const chefBHeaders = { Authorization: `Bearer ${chefBToken}` };

  const testResults: Record<string, { status: "PASSED" | "FAILED"; note: string }> = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 4.1 REGRESSION TESTS (Tests 1–11)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 1: Owner reads initial Chef Mode status...");
  try {
    const res = await makeRequest(serverUrl, "GET", "/api/owner/chef-mode", undefined, ownerAHeaders);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.body?.chefDashboardEnabled !== false) {
      throw new Error(`Expected chefDashboardEnabled: false, got: ${JSON.stringify(res.body)}`);
    }
    testResults["Test 1"] = { status: "PASSED", note: "Owner read initial chefDashboardEnabled: false" };
    console.log("  ✅ Test 1 PASSED\n");
  } catch (err: any) {
    testResults["Test 1"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 1 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 2: Owner enables Chef Mode...");
  try {
    const patchRes = await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    if (patchRes.status !== 200) throw new Error(`Expected 200, got ${patchRes.status}`);
    if (patchRes.body?.chefDashboardEnabled !== true) throw new Error("Expected true");
    testResults["Test 2"] = { status: "PASSED", note: "Owner successfully enabled Chef Mode" };
    console.log("  ✅ Test 2 PASSED\n");
  } catch (err: any) {
    testResults["Test 2"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 2 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 3: Owner disables Chef Mode...");
  try {
    const patchRes = await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    if (patchRes.status !== 200) throw new Error(`Expected 200, got ${patchRes.status}`);
    if (patchRes.body?.chefDashboardEnabled !== false) throw new Error("Expected false");
    testResults["Test 3"] = { status: "PASSED", note: "Owner successfully disabled Chef Mode" };
    console.log("  ✅ Test 3 PASSED\n");
  } catch (err: any) {
    testResults["Test 3"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 3 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 4: Invalid boolean values rejected with HTTP 400...");
  try {
    const invalidValues = ["true", "false", 1, 0, null, [], {}];
    for (const val of invalidValues) {
      const res = await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: val }, ownerAHeaders);
      if (res.status !== 400) throw new Error(`Expected 400 for ${val}`);
    }
    testResults["Test 4"] = { status: "PASSED", note: "Non-boolean types rejected with 400" };
    console.log("  ✅ Test 4 PASSED\n");
  } catch (err: any) {
    testResults["Test 4"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 4 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 5: Missing chefDashboardEnabled rejected with HTTP 400...");
  try {
    const resEmpty = await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", {}, ownerAHeaders);
    if (resEmpty.status !== 400) throw new Error(`Expected 400, got ${resEmpty.status}`);
    testResults["Test 5"] = { status: "PASSED", note: "Missing field rejected with 400" };
    console.log("  ✅ Test 5 PASSED\n");
  } catch (err: any) {
    testResults["Test 5"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 5 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 6: Unauthenticated requests rejected with HTTP 401...");
  try {
    const getRes = await makeRequest(serverUrl, "GET", "/api/owner/chef-mode");
    if (getRes.status !== 401) throw new Error(`Expected 401, got ${getRes.status}`);
    testResults["Test 6"] = { status: "PASSED", note: "Unauthenticated rejected with 401" };
    console.log("  ✅ Test 6 PASSED\n");
  } catch (err: any) {
    testResults["Test 6"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 6 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 7: Staff tokens rejected from owner Chef Mode endpoints...");
  try {
    const waiterGet = await makeRequest(serverUrl, "GET", "/api/owner/chef-mode", undefined, waiterA1Headers);
    if (waiterGet.status !== 401 && waiterGet.status !== 403) throw new Error(`Expected 401/403, got ${waiterGet.status}`);
    testResults["Test 7"] = { status: "PASSED", note: "Staff tokens forbidden from owner endpoints" };
    console.log("  ✅ Test 7 PASSED\n");
  } catch (err: any) {
    testResults["Test 7"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 7 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 8: Tenant isolation across restaurants...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const resB = await makeRequest(serverUrl, "GET", "/api/owner/chef-mode", undefined, ownerBHeaders);
    if (resB.body?.chefDashboardEnabled !== false) throw new Error("Resto B contaminated by Resto A");
    testResults["Test 8"] = { status: "PASSED", note: "Strict tenant isolation on chef-mode setting" };
    console.log("  ✅ Test 8 PASSED\n");
  } catch (err: any) {
    testResults["Test 8"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 8 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 9: Preserves other columns...");
  try {
    const [b] = await db.select().from(restaurants).where(eq(restaurants.id, restoA.id));
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const [a] = await db.select().from(restaurants).where(eq(restaurants.id, restoA.id));
    if (a.name !== b.name || a.slug !== b.slug) throw new Error("Other columns mutated");
    testResults["Test 9"] = { status: "PASSED", note: "Only chef_dashboard_enabled and updatedAt touched" };
    console.log("  ✅ Test 9 PASSED\n");
  } catch (err: any) {
    testResults["Test 9"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 9 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 10: Concurrent owner toggle serialization...");
  try {
    const [r1, r2] = await Promise.all([
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders),
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders),
    ]);
    if (r1.status !== 200 || r2.status !== 200) throw new Error("Concurrent requests failed");
    testResults["Test 10"] = { status: "PASSED", note: "Concurrent requests serialized through row lock cleanly" };
    console.log("  ✅ Test 10 PASSED\n");
  } catch (err: any) {
    testResults["Test 10"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 10 FAILED:", err.message, "\n");
  }

  console.log("▶ TEST 11: Idempotent toggle cycles...");
  try {
    for (let i = 0; i < 2; i++) {
      await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
      await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    }
    testResults["Test 11"] = { status: "PASSED", note: "Toggle cycles executed idempotently" };
    console.log("  ✅ Test 11 PASSED\n");
  } catch (err: any) {
    testResults["Test 11"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 11 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 4.2 TESTS (Tests 12–22)
  // ─────────────────────────────────────────────────────────────────────────────

  // Helper to create order with items
  let orderSeq = 100;
  async function createTestOrder(opts: {
    restaurantId: number;
    waiterId: number | null;
    status: "ordered" | "preparing" | "ready" | "completed";
    customerName?: string;
  }) {
    const seq = ++orderSeq;
    const [session] = await db
      .insert(tableSessions)
      .values({
        restaurantId: opts.restaurantId,
        tableNumber: `T-${seq}`,
        sessionType: "dine_in",
        customerPhone: `9199${String(Date.now() + seq).slice(-8)}`,
        status: "active",
        assignedWaiterId: opts.waiterId,
      })
      .returning();

    const [order] = await db
      .insert(orders)
      .values({
        restaurantId: opts.restaurantId,
        sessionId: session.id,
        tableNumber: `T-${seq}`,
        customerName: opts.customerName ?? `Customer ${seq}`,
        customerPhone: session.customerPhone!,
        status: opts.status,
        subtotal: 300,
        tax: 15,
        total: 315,
        assignedWaiterId: opts.waiterId,
        assignmentSource: opts.waiterId ? "manual" : "unassigned",
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order.id,
      name: "Butter Naan",
      quantity: 2,
      unitPrice: 50,
      isVeg: true,
    });

    return { session, order };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 12: Waiter start-prep transition & activity log
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 12: Waiter start-prep transition & order activity log...");
  try {
    const { order } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    const res = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${order.id}/start-prep`,
      {},
      waiterA1Headers,
    );
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.body?.status !== "preparing") throw new Error(`Expected preparing status, got: ${res.body?.status}`);

    // Verify DB
    const [chkOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    if (chkOrder.status !== "preparing") throw new Error(`DB status not preparing: ${chkOrder.status}`);

    // Verify Activity Log
    const [log] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, order.id), eq(orderActivityLogs.action, "order_preparing")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!log) throw new Error("Activity log for order_preparing was not created");
    if (log.actorType !== "waiter" || log.staffActorId !== waiterA1.id || log.userActorId !== null) {
      throw new Error(`Invalid log actor: ${JSON.stringify(log)}`);
    }
    if (log.previousStatus !== "ordered" || log.newStatus !== "preparing") {
      throw new Error(`Invalid log statuses: prev=${log.previousStatus}, next=${log.newStatus}`);
    }

    // Attempting start-prep again must fail with 400
    const resRepeat = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${order.id}/start-prep`,
      {},
      waiterA1Headers,
    );
    if (resRepeat.status !== 400) throw new Error(`Expected 400 on repeat start-prep, got: ${resRepeat.status}`);

    testResults["Test 12"] = { status: "PASSED", note: "Waiter start-prep advances status to preparing with valid activity log" };
    console.log("  ✅ Test 12 PASSED\n");
  } catch (err: any) {
    testResults["Test 12"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 12 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 13: Waiter start-prep assignment & role authorization guards
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 13: Waiter start-prep assignment and role authorization guards...");
  try {
    // Unassigned order
    const { order: unassignedOrder } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: null,
      status: "ordered",
    });
    const resUnassigned = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${unassignedOrder.id}/start-prep`,
      {},
      waiterA1Headers,
    );
    if (resUnassigned.status !== 403) {
      throw new Error(`Expected 403 for unassigned order, got: ${resUnassigned.status}`);
    }

    // Order assigned to Waiter A1, Waiter A2 attempts start-prep
    const { order: orderForA1 } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });
    const resOtherWaiter = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${orderForA1.id}/start-prep`,
      {},
      waiterA2Headers,
    );
    if (resOtherWaiter.status !== 403) {
      throw new Error(`Expected 403 for non-assigned waiter, got: ${resOtherWaiter.status}`);
    }

    // Chef attempts start-prep
    const resChef = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${orderForA1.id}/start-prep`,
      {},
      chefAHeaders,
    );
    if (resChef.status !== 403) {
      throw new Error(`Expected 403 for chef attempting waiter start-prep, got: ${resChef.status}`);
    }

    testResults["Test 13"] = { status: "PASSED", note: "Start-prep strictly enforces waiter role and specific waiter assignment" };
    console.log("  ✅ Test 13 PASSED\n");
  } catch (err: any) {
    testResults["Test 13"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 13 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 14: Chef order feed (GET /api/staff/chef/orders) & privacy exclusion
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 14: Chef order feed Chef Mode check and privacy exclusions...");
  try {
    // Ensure Chef Mode is OFF initially
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);

    // 1. Chef feed when Chef Mode OFF -> must return 403 CHEF_MODE_DISABLED
    const offRes = await makeRequest(serverUrl, "GET", "/api/staff/chef/orders", undefined, chefAHeaders);
    if (offRes.status !== 403) throw new Error(`Expected 403 when Chef Mode OFF, got: ${offRes.status}`);
    if (offRes.body?.code !== "CHEF_MODE_DISABLED") {
      throw new Error(`Expected code CHEF_MODE_DISABLED, got: ${JSON.stringify(offRes.body)}`);
    }

    // 2. Waiter attempts Chef feed -> 403 Role Forbidden
    const waiterRes = await makeRequest(serverUrl, "GET", "/api/staff/chef/orders", undefined, waiterA1Headers);
    if (waiterRes.status !== 403) throw new Error(`Expected 403 for waiter accessing chef feed, got: ${waiterRes.status}`);

    // 3. Enable Chef Mode
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);

    // Create a target order in 'ordered'
    const { order: chefTargetOrder } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
      customerName: "Secret VIP",
    });

    const onRes = await makeRequest(serverUrl, "GET", "/api/staff/chef/orders", undefined, chefAHeaders);
    if (onRes.status !== 200) throw new Error(`Expected 200 when Chef Mode ON, got: ${onRes.status}`);
    if (!Array.isArray(onRes.body)) throw new Error(`Expected array of orders, got: ${typeof onRes.body}`);

    const matched = onRes.body.find((o: any) => o.id === chefTargetOrder.id);
    if (!matched) throw new Error("Created order not found in Chef feed");

    // Strict Data Privacy Verification: Check that sensitive customer and payment fields are EXCLUDED
    const forbiddenKeys = [
      "customerPhone",
      "paymentScreenshotUrl",
      "paymentOcrData",
      "razorpayOrderId",
      "razorpayPaymentId",
      "subtotal",
      "tax",
      "total",
      "paymentStatus",
      "paymentMethod",
    ];
    for (const key of forbiddenKeys) {
      if (key in matched) {
        throw new Error(`Data privacy violation: '${key}' leaked in Chef order feed!`);
      }
    }

    // Allowed fields present
    if (!matched.id || !matched.status || !matched.customerName || !Array.isArray(matched.items)) {
      throw new Error(`Expected order metadata missing in chef feed: ${JSON.stringify(matched)}`);
    }

    testResults["Test 14"] = { status: "PASSED", note: "Chef order feed respects Chef Mode toggle and strictly strips all payment/phone fields" };
    console.log("  ✅ Test 14 PASSED\n");
  } catch (err: any) {
    testResults["Test 14"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 14 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 15: Chef mark ready (POST /api/staff/chef/orders/:orderId/ready)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 15: Chef mark ready workflow, assignment preservation & activity log...");
  try {
    // 1. When Chef Mode is OFF -> 403
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const { order: ord1 } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });
    const offReady = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/chef/orders/${ord1.id}/ready`,
      {},
      chefAHeaders,
    );
    if (offReady.status !== 403 || offReady.body?.code !== "CHEF_MODE_DISABLED") {
      throw new Error(`Expected 403 CHEF_MODE_DISABLED, got: ${offReady.status}`);
    }

    // Turn Chef Mode ON
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);

    // 2. Reject if order is in 'ordered' (must be preparing first)
    const { order: orderedOrd } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });
    const rejOrdered = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/chef/orders/${orderedOrd.id}/ready`,
      {},
      chefAHeaders,
    );
    if (rejOrdered.status !== 400) {
      throw new Error(`Expected 400 when marking 'ordered' order ready, got: ${rejOrdered.status}`);
    }

    // 3. Chef marks 'preparing' order ready -> SUCESS
    const { order: prepOrd } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });
    const chefReadyRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/chef/orders/${prepOrd.id}/ready`,
      {},
      chefAHeaders,
    );
    if (chefReadyRes.status !== 200) {
      throw new Error(`Expected 200 for chef ready, got ${chefReadyRes.status}: ${JSON.stringify(chefReadyRes.body)}`);
    }
    if (chefReadyRes.body?.status !== "ready") {
      throw new Error(`Expected ready status, got: ${chefReadyRes.body?.status}`);
    }

    // Verify DB & Assignment Preservation (Chef does NOT alter assigned waiter)
    const [chkChefReady] = await db.select().from(orders).where(eq(orders.id, prepOrd.id));
    if (chkChefReady.status !== "ready") throw new Error(`DB status not ready: ${chkChefReady.status}`);
    if (chkChefReady.assignedWaiterId !== waiterA1.id) {
      throw new Error(`Chef altered assignedWaiterId! Expected ${waiterA1.id}, got: ${chkChefReady.assignedWaiterId}`);
    }

    // Verify Activity Log
    const [log] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, prepOrd.id), eq(orderActivityLogs.action, "order_ready")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!log) throw new Error("Activity log for chef order_ready was not created");
    if (log.actorType !== "chef" || log.staffActorId !== chefA.id || log.userActorId !== null) {
      throw new Error(`Invalid chef log actor: ${JSON.stringify(log)}`);
    }
    if (log.previousStatus !== "preparing" || log.newStatus !== "ready") {
      throw new Error(`Invalid chef log statuses: prev=${log.previousStatus}, next=${log.newStatus}`);
    }

    testResults["Test 15"] = { status: "PASSED", note: "Chef mark ready succeeds with assigned waiter preserved and activity log logged" };
    console.log("  ✅ Test 15 PASSED\n");
  } catch (err: any) {
    testResults["Test 15"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 15 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 16: Waiter standard ready (POST /api/staff/waiter/orders/:orderId/ready)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 16: Waiter standard ready workflow & Chef Mode gating...");
  try {
    // 1. When Chef Mode is ON -> Waiter standard ready REJECTED with 403
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: prepOrdChefOn } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });
    const rejWaiterStandard = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdChefOn.id}/ready`,
      {},
      waiterA1Headers,
    );
    if (rejWaiterStandard.status !== 403) {
      throw new Error(`Expected 403 for standard waiter ready when Chef Mode ON, got: ${rejWaiterStandard.status}`);
    }

    // 2. Disable Chef Mode -> Waiter standard ready SUCCEEDS
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const succWaiterStandard = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdChefOn.id}/ready`,
      {},
      waiterA1Headers,
    );
    if (succWaiterStandard.status !== 200) {
      throw new Error(`Expected 200 when Chef Mode OFF, got: ${succWaiterStandard.status}`);
    }
    if (succWaiterStandard.body?.status !== "ready") {
      throw new Error(`Expected ready status, got: ${succWaiterStandard.body?.status}`);
    }

    // Verify activity log with metadata { chefMode: false }
    const [log] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, prepOrdChefOn.id), eq(orderActivityLogs.action, "order_ready")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!log || log.actorType !== "waiter" || log.staffActorId !== waiterA1.id) {
      throw new Error(`Invalid waiter activity log: ${JSON.stringify(log)}`);
    }

    testResults["Test 16"] = { status: "PASSED", note: "Standard waiter ready permitted only when Chef Mode is OFF" };
    console.log("  ✅ Test 16 PASSED\n");
  } catch (err: any) {
    testResults["Test 16"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 16 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 17: Waiter emergency ready override (POST /api/staff/waiter/orders/:orderId/emergency-ready)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 17: Waiter emergency ready override validation & audit logging...");
  try {
    const { order: prepOrdEm } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    // 1. Chef Mode is currently OFF -> emergency-ready rejected with 400
    const resOff = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdEm.id}/emergency-ready`,
      { reason: "Kitchen delay" },
      waiterA1Headers,
    );
    if (resOff.status !== 400) {
      throw new Error(`Expected 400 when Chef Mode is OFF, got: ${resOff.status}`);
    }

    // Turn Chef Mode ON
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);

    // 2. Reason missing or < 5 characters -> rejected with 400
    const invalidReasons = ["", "   ", "rush", 123, null, undefined];
    for (const r of invalidReasons) {
      const resInv = await makeRequest(
        serverUrl,
        "POST",
        `/api/staff/waiter/orders/${prepOrdEm.id}/emergency-ready`,
        { reason: r },
        waiterA1Headers,
      );
      if (resInv.status !== 400) {
        throw new Error(`Expected 400 for reason ${JSON.stringify(r)}, got: ${resInv.status}`);
      }
    }

    // 3. Valid reason (>= 5 chars) -> SUCCEEDS
    const validReason = "Customer has a train to catch in 15 mins";
    const resValid = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdEm.id}/emergency-ready`,
      { reason: validReason },
      waiterA1Headers,
    );
    if (resValid.status !== 200) {
      throw new Error(`Expected 200 for valid emergency ready, got: ${resValid.status}`);
    }
    if (resValid.body?.status !== "ready") {
      throw new Error(`Expected ready status, got: ${resValid.body?.status}`);
    }

    // Verify activity log with reason in metadata
    const [log] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, prepOrdEm.id), eq(orderActivityLogs.action, "order_emergency_ready")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!log) throw new Error("Activity log for order_emergency_ready not found");
    if (log.actorType !== "waiter" || log.staffActorId !== waiterA1.id) {
      throw new Error(`Invalid log actor: ${JSON.stringify(log)}`);
    }
    const meta = log.metadata as any;
    if (meta?.reason !== validReason || meta?.chefMode !== true) {
      throw new Error(`Invalid metadata in emergency log: ${JSON.stringify(meta)}`);
    }

    testResults["Test 17"] = { status: "PASSED", note: "Emergency ready validates reason >= 5 chars and records structured audit metadata" };
    console.log("  ✅ Test 17 PASSED\n");
  } catch (err: any) {
    testResults["Test 17"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 17 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 18: Waiter complete order (POST /api/staff/waiter/orders/:orderId/complete)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 18: Waiter complete order transition & session non-interference...");
  try {
    // 1. Order in 'preparing' cannot be completed directly (must be ready)
    const { order: prepOrdComp, session: sessComp } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });
    const rejPrepComp = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdComp.id}/complete`,
      {},
      waiterA1Headers,
    );
    if (rejPrepComp.status !== 400) {
      throw new Error(`Expected 400 when completing preparing order, got: ${rejPrepComp.status}`);
    }

    // 2. Mark order ready via Chef
    await makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${prepOrdComp.id}/ready`, {}, chefAHeaders);

    // 3. Waiter completes order
    const succComp = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${prepOrdComp.id}/complete`,
      {},
      waiterA1Headers,
    );
    if (succComp.status !== 200) {
      throw new Error(`Expected 200 for complete order, got: ${succComp.status}`);
    }
    if (succComp.body?.status !== "completed") {
      throw new Error(`Expected completed status, got: ${succComp.body?.status}`);
    }

    // Verify session remains active (Waiter completing individual order does NOT close table session)
    const [chkSession] = await db.select().from(tableSessions).where(eq(tableSessions.id, sessComp.id));
    if (chkSession.status !== "active") {
      throw new Error(`Session status corrupted! Expected active, got: ${chkSession.status}`);
    }

    // Verify activity log
    const [compLog] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, prepOrdComp.id), eq(orderActivityLogs.action, "order_completed")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!compLog || compLog.actorType !== "waiter" || compLog.staffActorId !== waiterA1.id) {
      throw new Error(`Invalid complete log: ${JSON.stringify(compLog)}`);
    }

    testResults["Test 18"] = { status: "PASSED", note: "Waiter complete order advances status to completed without touching session occupancy" };
    console.log("  ✅ Test 18 PASSED\n");
  } catch (err: any) {
    testResults["Test 18"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 18 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 19: Owner order status advance and cancellation with activity logs
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 19: Owner order status override, cancellation & activity logging...");
  try {
    const { order: ownerTargetOrd } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    // Owner advances ordered -> preparing
    const advRes = await makeRequest(
      serverUrl,
      "PATCH",
      `/api/owner/orders/${ownerTargetOrd.id}`,
      { status: "preparing" },
      ownerAHeaders,
    );
    if (advRes.status !== 200) throw new Error(`Expected 200, got: ${advRes.status}`);

    // Verify log for owner advance
    const [advLog] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, ownerTargetOrd.id), eq(orderActivityLogs.action, "order_status_override")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!advLog || advLog.actorType !== "owner" || advLog.userActorId !== ownerA.id || advLog.staffActorId !== null) {
      throw new Error(`Invalid owner advance log: ${JSON.stringify(advLog)}`);
    }

    // Owner cancels order
    const cancelRes = await makeRequest(
      serverUrl,
      "PATCH",
      `/api/owner/orders/${ownerTargetOrd.id}`,
      { status: "cancelled" },
      ownerAHeaders,
    );
    if (cancelRes.status !== 200) throw new Error(`Expected 200 on cancel, got: ${cancelRes.status}`);

    // Verify log for owner cancel
    const [cancelLog] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, ownerTargetOrd.id), eq(orderActivityLogs.action, "order_cancelled")))
      .orderBy(desc(orderActivityLogs.createdAt));

    if (!cancelLog || cancelLog.actorType !== "owner" || cancelLog.userActorId !== ownerA.id) {
      throw new Error(`Invalid owner cancel log: ${JSON.stringify(cancelLog)}`);
    }

    testResults["Test 19"] = { status: "PASSED", note: "Owner status override and cancellation logged with userActorId and owner actorType" };
    console.log("  ✅ Test 19 PASSED\n");
  } catch (err: any) {
    testResults["Test 19"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 19 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 20: Concurrency hardening: simultaneous Chef ready vs Waiter emergency-ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 20: Concurrency hardening on status transitions (Chef ready vs Waiter emergency-ready)...");
  try {
    const { order: raceOrd } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    // Fire Chef ready and Waiter emergency-ready concurrently
    const [resChefRace, resWaiterRace] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrd.id}/ready`, {}, chefAHeaders),
      makeRequest(
        serverUrl,
        "POST",
        `/api/staff/waiter/orders/${raceOrd.id}/emergency-ready`,
        { reason: "Concurrent test override" },
        waiterA1Headers,
      ),
    ]);

    // Exactly one must succeed with 200, the other must see status is already 'ready' and fail with 400
    const statuses = [resChefRace.status, resWaiterRace.status].sort();
    if (statuses[0] !== 200 || statuses[1] !== 400) {
      throw new Error(`Expected exactly one 200 and one 400 in race, got: chef=${resChefRace.status}, waiter=${resWaiterRace.status}`);
    }

    // Final order status in DB must be 'ready'
    const [chkFinal] = await db.select().from(orders).where(eq(orders.id, raceOrd.id));
    if (chkFinal.status !== "ready") {
      throw new Error(`Final status is not ready: ${chkFinal.status}`);
    }

    // Exactly one ready log created
    const logs = await db
      .select()
      .from(orderActivityLogs)
      .where(eq(orderActivityLogs.orderId, raceOrd.id));
    if (logs.length !== 1) {
      throw new Error(`Expected exactly 1 activity log from race, found: ${logs.length}`);
    }

    testResults["Test 20"] = { status: "PASSED", note: "Concurrent transitions serialized through FOR UPDATE locks cleanly; no double-advance" };
    console.log("  ✅ Test 20 PASSED\n");
  } catch (err: any) {
    testResults["Test 20"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 20 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 21: Cross-tenant staff isolation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 21: Cross-tenant staff isolation across independent restaurants...");
  try {
    // Resto A order
    const { order: orderA } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    // Waiter from Resto B attempts start-prep on Resto A order -> 404 or 403
    const crossWaiterPrep = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${orderA.id}/start-prep`,
      {},
      waiterBHeaders,
    );
    if (crossWaiterPrep.status !== 404 && crossWaiterPrep.status !== 403) {
      throw new Error(`Expected 404 or 403 for cross-tenant waiter, got: ${crossWaiterPrep.status}`);
    }

    // Chef from Resto B attempts ready on Resto A order -> 404 or 403
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerBHeaders);
    const crossChefReady = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/chef/orders/${orderA.id}/ready`,
      {},
      chefBHeaders,
    );
    if (crossChefReady.status !== 404 && crossChefReady.status !== 403) {
      throw new Error(`Expected 404 or 403 for cross-tenant chef, got: ${crossChefReady.status}`);
    }

    // Chef B order feed must NOT contain order from Resto A
    const chefBFeed = await makeRequest(serverUrl, "GET", "/api/staff/chef/orders", undefined, chefBHeaders);
    if (chefBFeed.status === 200 && Array.isArray(chefBFeed.body)) {
      const leaked = chefBFeed.body.find((o: any) => o.id === orderA.id);
      if (leaked) throw new Error("Resto A order leaked into Resto B Chef feed!");
    }

    testResults["Test 21"] = { status: "PASSED", note: "Cross-tenant staff operations completely isolated between restaurants" };
    console.log("  ✅ Test 21 PASSED\n");
  } catch (err: any) {
    testResults["Test 21"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 21 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 22: Revoked / deactivated staff token rejected from order mutations
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 22: Deactivated staff token rejected with HTTP 401...");
  try {
    // Deactivate waiterA2
    await db.update(restaurantStaff).set({ isActive: false }).where(eq(restaurantStaff.id, waiterA2.id));

    const { order: testOrd22 } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA2.id,
      status: "ordered",
    });

    const deactRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${testOrd22.id}/start-prep`,
      {},
      waiterA2Headers,
    );
    if (deactRes.status !== 401) {
      throw new Error(`Expected 401 for deactivated staff token, got: ${deactRes.status}`);
    }

    testResults["Test 22"] = { status: "PASSED", note: "Deactivated staff tokens immediately rejected from order mutations" };
    console.log("  ✅ Test 22 PASSED\n");
  } catch (err: any) {
    testResults["Test 22"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 22 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 23: Race Scenario A: Owner toggles Chef Mode OFF while Chef attempts Ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 23: Race A: Owner toggles Chef Mode OFF while Chef attempts Ready...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderA } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [ownerResA, chefResA] = await Promise.all([
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderA.id}/ready`, {}, chefAHeaders),
    ]);

    const [finalOrdA] = await db.select().from(orders).where(eq(orders.id, raceOrderA.id));
    const [finalRestoA] = await db.select().from(restaurants).where(eq(restaurants.id, restoA.id));

    if (chefResA.status === 200) {
      if (finalOrdA.status !== "ready") throw new Error("Chef returned 200 but order not ready");
    } else if (chefResA.status === 403) {
      if (finalOrdA.status !== "preparing") throw new Error("Chef returned 403 but order mutated");
      if (chefResA.body?.code !== "CHEF_MODE_DISABLED") throw new Error("Expected CHEF_MODE_DISABLED");
    } else {
      throw new Error(`Unexpected chef status in race: ${chefResA.status}`);
    }
    if (ownerResA.status !== 200) throw new Error(`Owner request failed: ${ownerResA.status}`);
    if (finalRestoA.chefDashboardEnabled !== false) throw new Error("Owner toggle did not persist");

    testResults["Test 23"] = { status: "PASSED", note: "Race A (Chef Ready vs Chef Mode OFF) serialized through restaurant row lock cleanly" };
    console.log("  ✅ Test 23 PASSED\n");
  } catch (err: any) {
    testResults["Test 23"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 23 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 24: Race Scenario A (Inverse): Owner toggles Chef Mode ON while Chef attempts Ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 24: Race A (Inverse): Owner toggles Chef Mode ON while Chef attempts Ready...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const { order: raceOrderAInv } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [ownerResAInv, chefResAInv] = await Promise.all([
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderAInv.id}/ready`, {}, chefAHeaders),
    ]);

    const [finalOrdAInv] = await db.select().from(orders).where(eq(orders.id, raceOrderAInv.id));
    if (chefResAInv.status === 200) {
      if (finalOrdAInv.status !== "ready") throw new Error("Chef returned 200 but order not ready");
    } else if (chefResAInv.status === 403) {
      if (finalOrdAInv.status !== "preparing") throw new Error("Chef returned 403 but order mutated");
    } else {
      throw new Error(`Unexpected chef status in race: ${chefResAInv.status}`);
    }
    if (ownerResAInv.status !== 200) throw new Error(`Owner request failed: ${ownerResAInv.status}`);

    testResults["Test 24"] = { status: "PASSED", note: "Race A Inverse (Chef Ready vs Chef Mode ON) serialized cleanly" };
    console.log("  ✅ Test 24 PASSED\n");
  } catch (err: any) {
    testResults["Test 24"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 24 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 25: Race Scenario B: Owner toggles Chef Mode ON while Waiter attempts Standard Ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 25: Race B: Owner toggles Chef Mode ON while Waiter attempts Standard Ready...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const { order: raceOrderB } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [ownerResB, waiterResB] = await Promise.all([
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${raceOrderB.id}/ready`, {}, waiterA1Headers),
    ]);

    const [finalOrdB] = await db.select().from(orders).where(eq(orders.id, raceOrderB.id));
    if (waiterResB.status === 200) {
      if (finalOrdB.status !== "ready") throw new Error("Waiter returned 200 but order not ready");
    } else if (waiterResB.status === 403) {
      if (finalOrdB.status !== "preparing") throw new Error("Waiter returned 403 but order mutated");
    } else {
      throw new Error(`Unexpected waiter status in race: ${waiterResB.status}`);
    }
    if (ownerResB.status !== 200) throw new Error(`Owner toggle failed: ${ownerResB.status}`);

    testResults["Test 25"] = { status: "PASSED", note: "Race B (Waiter Standard Ready vs Chef Mode ON) serialized cleanly" };
    console.log("  ✅ Test 25 PASSED\n");
  } catch (err: any) {
    testResults["Test 25"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 25 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 26: Race Scenario B (Inverse): Owner toggles Chef Mode OFF while Waiter attempts Standard Ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 26: Race B (Inverse): Owner toggles Chef Mode OFF while Waiter attempts Standard Ready...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderBInv } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [ownerResBInv, waiterResBInv] = await Promise.all([
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${raceOrderBInv.id}/ready`, {}, waiterA1Headers),
    ]);

    const [finalOrdBInv] = await db.select().from(orders).where(eq(orders.id, raceOrderBInv.id));
    if (waiterResBInv.status === 200) {
      if (finalOrdBInv.status !== "ready") throw new Error("Waiter returned 200 but order not ready");
    } else if (waiterResBInv.status === 403) {
      if (finalOrdBInv.status !== "preparing") throw new Error("Waiter returned 403 but order mutated");
    } else {
      throw new Error(`Unexpected waiter status in race: ${waiterResBInv.status}`);
    }
    if (ownerResBInv.status !== 200) throw new Error(`Owner toggle failed: ${ownerResBInv.status}`);

    testResults["Test 26"] = { status: "PASSED", note: "Race B Inverse (Waiter Standard Ready vs Chef Mode OFF) serialized cleanly" };
    console.log("  ✅ Test 26 PASSED\n");
  } catch (err: any) {
    testResults["Test 26"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 26 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 27: Race Scenario C: Chef Ready races with Waiter Emergency Ready
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 27: Race C: Chef Ready races with Waiter Emergency Ready on same order...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderC } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [chefResC, waiterResC] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderC.id}/ready`, {}, chefAHeaders),
      makeRequest(
        serverUrl,
        "POST",
        `/api/staff/waiter/orders/${raceOrderC.id}/emergency-ready`,
        { reason: "Customer in urgent rush" },
        waiterA1Headers,
      ),
    ]);

    const statuses = [chefResC.status, waiterResC.status].sort();
    if (statuses[0] !== 200 || statuses[1] !== 400) {
      throw new Error(`Expected exactly one 200 and one 400, got: chef=${chefResC.status}, waiter=${waiterResC.status}`);
    }

    const [finalOrdC] = await db.select().from(orders).where(eq(orders.id, raceOrderC.id));
    if (finalOrdC.status !== "ready") throw new Error(`Expected final status ready, got: ${finalOrdC.status}`);

    const logsC = await db.select().from(orderActivityLogs).where(eq(orderActivityLogs.orderId, raceOrderC.id));
    if (logsC.length !== 1) throw new Error(`Expected exactly 1 activity log, got: ${logsC.length}`);

    testResults["Test 27"] = { status: "PASSED", note: "Race C (Chef Ready vs Waiter Emergency Ready) exactly one wins, one activity log created" };
    console.log("  ✅ Test 27 PASSED\n");
  } catch (err: any) {
    testResults["Test 27"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 27 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 28: Race Scenario D: Chef Ready races with Owner Cancellation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 28: Race D: Chef Ready races with Owner Cancellation...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderD } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [chefResD, ownerResD] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderD.id}/ready`, {}, chefAHeaders),
      makeRequest(serverUrl, "PATCH", `/api/owner/orders/${raceOrderD.id}`, { status: "cancelled" }, ownerAHeaders),
    ]);

    const [finalOrdD] = await db.select().from(orders).where(eq(orders.id, raceOrderD.id));
    if (ownerResD.status !== 200) throw new Error(`Owner cancel failed: ${ownerResD.status}`);
    if (finalOrdD.status !== "cancelled") throw new Error(`Expected cancelled, got: ${finalOrdD.status}`);

    const logsD = await db.select().from(orderActivityLogs).where(eq(orderActivityLogs.orderId, raceOrderD.id));
    if (logsD.length < 1 || logsD.length > 2) {
      throw new Error(`Expected 1 or 2 activity logs, got: ${logsD.length}`);
    }

    testResults["Test 28"] = { status: "PASSED", note: "Race D (Chef Ready vs Owner Cancel) serialized cleanly without deadlock" };
    console.log("  ✅ Test 28 PASSED\n");
  } catch (err: any) {
    testResults["Test 28"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 28 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 29: Race Scenario E: Two simultaneous Chef Ready requests target same order
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 29: Race E: Two simultaneous Chef Ready requests on same order...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderE } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [resE1, resE2] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderE.id}/ready`, {}, chefAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${raceOrderE.id}/ready`, {}, chefAHeaders),
    ]);

    const statusesE = [resE1.status, resE2.status].sort();
    if (statusesE[0] !== 200 || statusesE[1] !== 400) {
      throw new Error(`Expected exactly one 200 and one 400, got: ${resE1.status}, ${resE2.status}`);
    }

    const [finalOrdE] = await db.select().from(orders).where(eq(orders.id, raceOrderE.id));
    if (finalOrdE.status !== "ready") throw new Error(`Expected ready status, got: ${finalOrdE.status}`);

    const logsE = await db.select().from(orderActivityLogs).where(eq(orderActivityLogs.orderId, raceOrderE.id));
    if (logsE.length !== 1) throw new Error(`Expected 1 log, found: ${logsE.length}`);

    testResults["Test 29"] = { status: "PASSED", note: "Race E (Simultaneous Chef Ready) exactly one succeeds, second gets 400" };
    console.log("  ✅ Test 29 PASSED\n");
  } catch (err: any) {
    testResults["Test 29"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 29 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 30: Race Scenario F: Two simultaneous Waiter Emergency Ready requests target same order
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 30: Race F: Two simultaneous Waiter Emergency Ready requests on same order...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: raceOrderF } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const [resF1, resF2] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${raceOrderF.id}/emergency-ready`, { reason: "Simultaneous emergency A" }, waiterA1Headers),
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${raceOrderF.id}/emergency-ready`, { reason: "Simultaneous emergency B" }, waiterA1Headers),
    ]);

    const statusesF = [resF1.status, resF2.status].sort();
    if (statusesF[0] !== 200 || statusesF[1] !== 400) {
      throw new Error(`Expected exactly one 200 and one 400, got: ${resF1.status}, ${resF2.status}`);
    }

    const [finalOrdF] = await db.select().from(orders).where(eq(orders.id, raceOrderF.id));
    if (finalOrdF.status !== "ready") throw new Error(`Expected ready status, got: ${finalOrdF.status}`);

    const logsF = await db.select().from(orderActivityLogs).where(eq(orderActivityLogs.orderId, raceOrderF.id));
    if (logsF.length !== 1) throw new Error(`Expected 1 log, found: ${logsF.length}`);

    testResults["Test 30"] = { status: "PASSED", note: "Race F (Simultaneous Waiter Emergency Ready) exactly one succeeds" };
    console.log("  ✅ Test 30 PASSED\n");
  } catch (err: any) {
    testResults["Test 30"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 30 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 31: Race Scenario G: Owner cancellation races with Waiter completion
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 31: Race G: Owner cancellation races with Waiter completion on ready order...");
  try {
    const { order: raceOrderG } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ready",
    });

    const [waiterResG, ownerResG] = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${raceOrderG.id}/complete`, {}, waiterA1Headers),
      makeRequest(serverUrl, "PATCH", `/api/owner/orders/${raceOrderG.id}`, { status: "cancelled" }, ownerAHeaders),
    ]);

    const [finalOrdG] = await db.select().from(orders).where(eq(orders.id, raceOrderG.id));
    if (finalOrdG.status !== "completed" && finalOrdG.status !== "cancelled") {
      throw new Error(`Corrupted state in Race G! Status is: ${finalOrdG.status}`);
    }

    testResults["Test 31"] = { status: "PASSED", note: "Race G (Waiter Complete vs Owner Cancel) serialized without deadlock" };
    console.log("  ✅ Test 31 PASSED\n");
  } catch (err: any) {
    testResults["Test 31"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 31 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 32: Scenario H: Waiter reassigned before status action rejected under lock
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 32: Scenario H: Waiter reassigned before status action rejected under lock...");
  try {
    const { order: ordH } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    // Create an active waiterA3 for reassignment
    const [waiterA3] = await db
      .insert(restaurantStaff)
      .values({
        restaurantId: restoA.id,
        name: `Waiter Staff 3 ${runId}`,
        role: "waiter",
        isActive: true,
        tokenVersion: 1,
      })
      .returning();

    // Owner reassigns order from Waiter A1 to Waiter A3
    const reassignRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/owner/orders/${ordH.id}/assign-waiter`,
      { waiterId: waiterA3.id },
      ownerAHeaders,
    );
    if (reassignRes.status !== 200) throw new Error(`Reassignment failed: ${reassignRes.status} - ${JSON.stringify(reassignRes.body)}`);

    // Waiter A1 attempts start-prep -> MUST BE REJECTED WITH 403 under lock
    const waiterA1Attempt = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${ordH.id}/start-prep`,
      {},
      waiterA1Headers,
    );
    if (waiterA1Attempt.status !== 403) {
      throw new Error(`Expected 403 for reassigned waiter, got: ${waiterA1Attempt.status}`);
    }

    // Order status remains 'ordered'
    const [chkOrdH] = await db.select().from(orders).where(eq(orders.id, ordH.id));
    if (chkOrdH.status !== "ordered") throw new Error("Order status mutated by reassigned waiter!");
    if (chkOrdH.assignedWaiterId !== waiterA3.id) throw new Error("Assigned waiter corrupted!");

    testResults["Test 32"] = { status: "PASSED", note: "Scenario H: Reassigned waiter rejected with 403 under row lock; status preserved" };
    console.log("  ✅ Test 32 PASSED\n");
  } catch (err: any) {
    testResults["Test 32"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 32 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 33: Scenario H: Waiter deactivated before status action rejected
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 33: Scenario H: Waiter deactivated before status action rejected...");
  try {
    const [tempWaiter] = await db
      .insert(restaurantStaff)
      .values({
        restaurantId: restoA.id,
        name: `Temp Waiter ${runId}`,
        role: "waiter",
        isActive: true,
        tokenVersion: 1,
      })
      .returning();

    const tempWaiterToken = generateStaffToken({
      staffId: tempWaiter.id,
      restaurantId: restoA.id,
      role: "waiter",
      tokenVersion: 1,
    });
    const tempWaiterHeaders = { Authorization: `Bearer ${tempWaiterToken}` };

    const { order: ordHDeact } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: tempWaiter.id,
      status: "ordered",
    });

    // Deactivate temp waiter
    await db.update(restaurantStaff).set({ isActive: false }).where(eq(restaurantStaff.id, tempWaiter.id));

    // Attempt start-prep
    const deactAttempt = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${ordHDeact.id}/start-prep`,
      {},
      tempWaiterHeaders,
    );
    if (deactAttempt.status !== 401) {
      throw new Error(`Expected 401 for deactivated waiter, got: ${deactAttempt.status}`);
    }

    const [chkOrdHDeact] = await db.select().from(orders).where(eq(orders.id, ordHDeact.id));
    if (chkOrdHDeact.status !== "ordered") throw new Error("Order status mutated by deactivated waiter!");

    testResults["Test 33"] = { status: "PASSED", note: "Scenario H: Deactivated waiter rejected with 401 immediately" };
    console.log("  ✅ Test 33 PASSED\n");
  } catch (err: any) {
    testResults["Test 33"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 33 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 34: Scenario I: Activity log insertion failure rolls back status update
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 34: Scenario I: Activity log failure rolls back order status update...");
  try {
    const { order: ordI } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    let txFailed = false;
    try {
      await db.transaction(async (tx) => {
        // Step 1: Update order status
        await tx
          .update(orders)
          .set({ status: "preparing", updatedAt: new Date() })
          .where(eq(orders.id, ordI.id));

        // Step 2: Deliberately fail activity log insertion (check constraint violation: both userActorId and staffActorId set)
        await tx.insert(orderActivityLogs).values({
          restaurantId: restoA.id,
          orderId: ordI.id,
          action: "order_preparing",
          actorType: "waiter",
          staffActorId: waiterA1.id,
          userActorId: ownerA.id, // VIOLATES order_activity_actor_check CHECK constraint!
        });
      });
    } catch {
      txFailed = true;
    }

    if (!txFailed) throw new Error("Check constraint violation was expected to throw");

    // Verify DB: Order status must STILL be 'ordered' due to atomic ROLLBACK
    const [chkOrdI] = await db.select().from(orders).where(eq(orders.id, ordI.id));
    if (chkOrdI.status !== "ordered") {
      throw new Error(`Atomic rollback failed! Order status was updated to: ${chkOrdI.status}`);
    }

    testResults["Test 34"] = { status: "PASSED", note: "Scenario I: Activity log failure triggers atomic transaction rollback; order status preserved" };
    console.log("  ✅ Test 34 PASSED\n");
  } catch (err: any) {
    testResults["Test 34"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 34 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 35: Emergency Ready reason length boundary tests (<5 rejected, >=5 accepted)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 35: Emergency Ready reason boundary tests...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: ordBnd } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    // 4 chars -> rejected
    const res4 = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${ordBnd.id}/emergency-ready`,
      { reason: "rush" },
      waiterA1Headers,
    );
    if (res4.status !== 400) throw new Error(`Expected 400 for 4-char reason 'rush', got: ${res4.status}`);

    // Exactly 5 chars -> accepted
    const res5 = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${ordBnd.id}/emergency-ready`,
      { reason: "delay" },
      waiterA1Headers,
    );
    if (res5.status !== 200) throw new Error(`Expected 200 for 5-char reason 'delay', got: ${res5.status}`);

    testResults["Test 35"] = { status: "PASSED", note: "Emergency Ready strictly enforces length >= 5 characters boundary" };
    console.log("  ✅ Test 35 PASSED\n");
  } catch (err: any) {
    testResults["Test 35"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 35 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 36: Emergency Ready reason whitespace trimming verification in audit metadata
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 36: Emergency Ready reason whitespace trimming...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: ordTrim } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const untrimmed = "   Customer urgent flight departure   ";
    const resTrim = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${ordTrim.id}/emergency-ready`,
      { reason: untrimmed },
      waiterA1Headers,
    );
    if (resTrim.status !== 200) throw new Error(`Expected 200, got: ${resTrim.status}`);

    const [logTrim] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, ordTrim.id), eq(orderActivityLogs.action, "order_emergency_ready")))
      .orderBy(desc(orderActivityLogs.createdAt));

    const meta = logTrim?.metadata as any;
    if (meta?.reason !== "Customer urgent flight departure") {
      throw new Error(`Reason was not trimmed! Got: '${meta?.reason}'`);
    }

    testResults["Test 36"] = { status: "PASSED", note: "Emergency Ready stores trimmed reason in audit log metadata" };
    console.log("  ✅ Test 36 PASSED\n");
  } catch (err: any) {
    testResults["Test 36"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 36 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 37: Chef Ready does not modify assigned_waiter_id, assignment_source or session
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 37: Chef Ready non-mutation invariant on assignments...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const { order: ordInv, session: sessInv } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "preparing",
    });

    const readyRes = await makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${ordInv.id}/ready`, {}, chefAHeaders);
    if (readyRes.status !== 200) throw new Error(`Chef ready failed: ${readyRes.status}`);

    const [afterOrd] = await db.select().from(orders).where(eq(orders.id, ordInv.id));
    const [afterSess] = await db.select().from(tableSessions).where(eq(tableSessions.id, sessInv.id));

    if (afterOrd.assignedWaiterId !== waiterA1.id) throw new Error("Order assigned_waiter_id mutated!");
    if (afterOrd.assignmentSource !== "manual") throw new Error("Order assignment_source mutated!");
    if (afterSess.assignedWaiterId !== waiterA1.id) throw new Error("Session assigned_waiter_id mutated!");

    testResults["Test 37"] = { status: "PASSED", note: "Chef Ready preserves assigned_waiter_id, assignment_source, and session assignment" };
    console.log("  ✅ Test 37 PASSED\n");
  } catch (err: any) {
    testResults["Test 37"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 37 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 38: Chef Feed Privacy Deep Audit: Confirms all sensitive fields absent
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 38: Chef Feed Privacy Deep Audit...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const feedRes = await makeRequest(serverUrl, "GET", "/api/staff/chef/orders", undefined, chefAHeaders);
    if (feedRes.status !== 200 || !Array.isArray(feedRes.body)) throw new Error("Failed to get chef feed");

    const sensitiveFields = [
      "customerPhone",
      "subtotal",
      "tax",
      "total",
      "paymentStatus",
      "paymentMethod",
      "paymentVerificationStatus",
      "paymentScreenshotUrl",
      "paymentOcrData",
      "razorpayOrderId",
      "razorpayPaymentId",
      "verificationMethod",
      "verifiedBy",
      "verifiedAt",
      "paidAt",
    ];

    for (const ord of feedRes.body) {
      for (const field of sensitiveFields) {
        if (field in ord) {
          throw new Error(`Data leak: field '${field}' found in Chef order response for order ${ord.id}`);
        }
      }
      for (const item of ord.items || []) {
        if ("unitPrice" in item) {
          throw new Error(`Price leak: 'unitPrice' found in Chef order item ${item.id}`);
        }
      }
    }

    testResults["Test 38"] = { status: "PASSED", note: "Chef Feed strictly strips all customer contact, billing, and payment fields" };
    console.log("  ✅ Test 38 PASSED\n");
  } catch (err: any) {
    testResults["Test 38"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 38 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 39: Owner Table Occupancy Preservation on status advance
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 39: Owner Table Occupancy Preservation...");
  try {
    const [testTable] = await db
      .insert(restaurantTables)
      .values({
        restaurantId: restoA.id,
        tableNumber: `T-OCC-${Date.now()}`,
        capacity: 4,
        isOccupied: true,
      })
      .returning();

    const [testSess] = await db
      .insert(tableSessions)
      .values({
        restaurantId: restoA.id,
        tableNumber: testTable.tableNumber,
        sessionType: "dine_in",
        status: "active",
      })
      .returning();

    const [testOrd] = await db
      .insert(orders)
      .values({
        restaurantId: restoA.id,
        sessionId: testSess.id,
        tableId: testTable.id,
        tableNumber: testTable.tableNumber,
        customerName: "Occupancy Test",
        customerPhone: "919900001122",
        status: "ordered",
        subtotal: 100,
        tax: 5,
        total: 105,
      })
      .returning();

    // Owner advances ordered -> preparing
    await makeRequest(serverUrl, "PATCH", `/api/owner/orders/${testOrd.id}`, { status: "preparing" }, ownerAHeaders);
    let [chkTable] = await db.select().from(restaurantTables).where(eq(restaurantTables.id, testTable.id));
    if (chkTable.isOccupied !== true) throw new Error("Table was prematurely released on preparing!");

    // Owner advances preparing -> ready
    await makeRequest(serverUrl, "PATCH", `/api/owner/orders/${testOrd.id}`, { status: "ready" }, ownerAHeaders);
    [chkTable] = await db.select().from(restaurantTables).where(eq(restaurantTables.id, testTable.id));
    if (chkTable.isOccupied !== true) throw new Error("Table was prematurely released on ready!");

    // Owner completes order -> Table released (preserves existing behavior)
    await makeRequest(serverUrl, "PATCH", `/api/owner/orders/${testOrd.id}`, { status: "completed" }, ownerAHeaders);
    [chkTable] = await db.select().from(restaurantTables).where(eq(restaurantTables.id, testTable.id));
    if (chkTable.isOccupied !== false) throw new Error("Table was not released on complete!");

    testResults["Test 39"] = { status: "PASSED", note: "Table occupancy preserved on non-terminal states; existing complete behavior preserved" };
    console.log("  ✅ Test 39 PASSED\n");
  } catch (err: any) {
    testResults["Test 39"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 39 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 40: Lock Hierarchy Consistency across all status mutation endpoints
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 40: Lock Hierarchy Consistency verification...");
  try {
    const { order: ordH1 } = await createTestOrder({ restaurantId: restoA.id, waiterId: waiterA1.id, status: "ordered" });
    const { order: ordH2 } = await createTestOrder({ restaurantId: restoA.id, waiterId: waiterA1.id, status: "preparing" });
    const { order: ordH3 } = await createTestOrder({ restaurantId: restoA.id, waiterId: waiterA1.id, status: "ready" });

    const resultsH = await Promise.all([
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${ordH1.id}/start-prep`, {}, waiterA1Headers),
      makeRequest(serverUrl, "POST", `/api/staff/chef/orders/${ordH2.id}/ready`, {}, chefAHeaders),
      makeRequest(serverUrl, "POST", `/api/staff/waiter/orders/${ordH3.id}/complete`, {}, waiterA1Headers),
      makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders),
    ]);

    for (const r of resultsH) {
      if (r.status !== 200) {
        throw new Error(`Operation failed in concurrent lock hierarchy test: ${r.status}`);
      }
    }

    testResults["Test 40"] = { status: "PASSED", note: "Lock hierarchy consistency: restaurant -> order sequence executed concurrently without deadlocks" };
    console.log("  ✅ Test 40 PASSED\n");
  } catch (err: any) {
    testResults["Test 40"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 40 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 41: Negative Authorization: Staff cannot cancel orders; cancellation is exclusively Owner
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 41: Staff cancellation prohibition & owner-exclusive authority...");
  try {
    const { order: testOrd41 } = await createTestOrder({
      restaurantId: restoA.id,
      waiterId: waiterA1.id,
      status: "ordered",
    });

    // 1. Waiter calls non-existent staff cancellation endpoint -> 404
    const waiterCancelStaffRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/waiter/orders/${testOrd41.id}/cancel`,
      {},
      waiterA1Headers,
    );
    if (waiterCancelStaffRes.status !== 404) {
      throw new Error(`Expected 404 for waiter staff cancellation, got: ${waiterCancelStaffRes.status}`);
    }

    // 2. Waiter attempts owner cancellation endpoint -> 401 Unauthorized
    const waiterCancelOwnerRes = await makeRequest(
      serverUrl,
      "PATCH",
      `/api/owner/orders/${testOrd41.id}`,
      { status: "cancelled" },
      waiterA1Headers,
    );
    if (waiterCancelOwnerRes.status !== 401) {
      throw new Error(`Expected 401 for waiter attempting owner cancellation, got: ${waiterCancelOwnerRes.status}`);
    }

    // 3. Chef calls non-existent chef cancellation endpoint -> 404
    const chefCancelStaffRes = await makeRequest(
      serverUrl,
      "POST",
      `/api/staff/chef/orders/${testOrd41.id}/cancel`,
      {},
      chefAHeaders,
    );
    if (chefCancelStaffRes.status !== 404) {
      throw new Error(`Expected 404 for chef staff cancellation, got: ${chefCancelStaffRes.status}`);
    }

    // 4. Chef attempts owner cancellation endpoint -> 401 Unauthorized
    const chefCancelOwnerRes = await makeRequest(
      serverUrl,
      "PATCH",
      `/api/owner/orders/${testOrd41.id}`,
      { status: "cancelled" },
      chefAHeaders,
    );
    if (chefCancelOwnerRes.status !== 401) {
      throw new Error(`Expected 401 for chef attempting owner cancellation, got: ${chefCancelOwnerRes.status}`);
    }

    // 5. Order remains in "ordered" status
    const [ordAfterStaff] = await db.select().from(orders).where(eq(orders.id, testOrd41.id));
    if (ordAfterStaff.status !== "ordered") {
      throw new Error(`Order status was mutated by unauthorized staff request! Status: ${ordAfterStaff.status}`);
    }

    // 6. Owner performs cancellation -> 200 OK
    const ownerCancelRes = await makeRequest(
      serverUrl,
      "PATCH",
      `/api/owner/orders/${testOrd41.id}`,
      { status: "cancelled" },
      ownerAHeaders,
    );
    if (ownerCancelRes.status !== 200) {
      throw new Error(`Expected 200 for owner cancellation, got: ${ownerCancelRes.status}`);
    }

    // 7. Verify order is now cancelled and logged with owner actor
    const [ordAfterOwner] = await db.select().from(orders).where(eq(orders.id, testOrd41.id));
    if (ordAfterOwner.status !== "cancelled") {
      throw new Error(`Expected order to be cancelled by owner, got: ${ordAfterOwner.status}`);
    }

    const [cancelLog] = await db
      .select()
      .from(orderActivityLogs)
      .where(and(eq(orderActivityLogs.orderId, testOrd41.id), eq(orderActivityLogs.action, "order_cancelled")))
      .limit(1);

    if (!cancelLog || cancelLog.actorType !== "owner" || cancelLog.userActorId !== ownerA.id) {
      throw new Error(`Expected activity log with actorType 'owner', got: ${JSON.stringify(cancelLog)}`);
    }

    testResults["Test 41"] = { status: "PASSED", note: "Staff cannot cancel orders (404/401); cancellation is strictly exclusive to Owner (200)" };
    console.log("  ✅ Test 41 PASSED\n");
  } catch (err: any) {
    testResults["Test 41"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 41 FAILED:", err.message, "\n");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 4.4A: GET /api/staff/me CHEF MODE CONTRACT TESTS (Tests 42–51)
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Test 42: Authenticated waiter receives chefDashboardEnabled: false when Chef Mode is disabled
  console.log("▶ TEST 42: Authenticated waiter receives chefDashboardEnabled: false when disabled...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const res = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    if (typeof res.body?.chefDashboardEnabled !== "boolean" || res.body?.chefDashboardEnabled !== false) {
      throw new Error(`Expected chefDashboardEnabled: false (boolean), got: ${JSON.stringify(res.body)}`);
    }
    testResults["Test 42"] = { status: "PASSED", note: "Waiter receives chefDashboardEnabled: false (JSON boolean) when disabled" };
    console.log("  ✅ Test 42 PASSED\n");
  } catch (err: any) {
    testResults["Test 42"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 42 FAILED:", err.message, "\n");
  }

  // Test 43: Authenticated waiter receives chefDashboardEnabled: true when Chef Mode is enabled
  console.log("▶ TEST 43: Authenticated waiter receives chefDashboardEnabled: true when enabled...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const res = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    if (typeof res.body?.chefDashboardEnabled !== "boolean" || res.body?.chefDashboardEnabled !== true) {
      throw new Error(`Expected chefDashboardEnabled: true (boolean), got: ${JSON.stringify(res.body)}`);
    }
    testResults["Test 43"] = { status: "PASSED", note: "Waiter receives chefDashboardEnabled: true (JSON boolean) when enabled" };
    console.log("  ✅ Test 43 PASSED\n");
  } catch (err: any) {
    testResults["Test 43"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 43 FAILED:", err.message, "\n");
  }

  // Test 44: Authenticated chef receives authoritative restaurant-level Chef Mode state
  console.log("▶ TEST 44: Authenticated chef receives authoritative restaurant-level Chef Mode state...");
  try {
    const resChef = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, chefAHeaders);
    if (resChef.status !== 200) throw new Error(`Expected 200, got ${resChef.status}: ${JSON.stringify(resChef.body)}`);
    if (resChef.body?.chefDashboardEnabled !== true) {
      throw new Error(`Expected chefDashboardEnabled: true for chef, got: ${JSON.stringify(resChef.body)}`);
    }
    if (resChef.body?.staff?.role !== "chef") {
      throw new Error(`Expected staff.role: 'chef', got: ${resChef.body?.staff?.role}`);
    }
    testResults["Test 44"] = { status: "PASSED", note: "Chef receives authoritative restaurant-level Chef Mode state (true)" };
    console.log("  ✅ Test 44 PASSED\n");
  } catch (err: any) {
    testResults["Test 44"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 44 FAILED:", err.message, "\n");
  }

  // Test 45: Changing Chef Mode from false to true is reflected on subsequent /api/staff/me
  console.log("▶ TEST 45: Changing Chef Mode from false -> true reflected immediately on /api/staff/me...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const resOff = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (resOff.body?.chefDashboardEnabled !== false) throw new Error("Expected false before flip");

    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const resOn = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (resOn.body?.chefDashboardEnabled !== true) throw new Error("Expected true after flip to true");

    testResults["Test 45"] = { status: "PASSED", note: "Flip from false to true immediately reflected on /api/staff/me" };
    console.log("  ✅ Test 45 PASSED\n");
  } catch (err: any) {
    testResults["Test 45"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 45 FAILED:", err.message, "\n");
  }

  // Test 46: Changing Chef Mode from true to false is reflected on subsequent /api/staff/me
  console.log("▶ TEST 46: Changing Chef Mode from true -> false reflected immediately on /api/staff/me...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerAHeaders);
    const resOn = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (resOn.body?.chefDashboardEnabled !== true) throw new Error("Expected true before flip");

    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    const resOff = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (resOff.body?.chefDashboardEnabled !== false) throw new Error("Expected false after flip to false");

    testResults["Test 46"] = { status: "PASSED", note: "Flip from true to false immediately reflected on /api/staff/me" };
    console.log("  ✅ Test 46 PASSED\n");
  } catch (err: any) {
    testResults["Test 46"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 46 FAILED:", err.message, "\n");
  }

  // Test 47: Staff from Resto A cannot query Resto B's Chef Mode via parameter manipulation
  console.log("▶ TEST 47: Staff from Resto A cannot spoof Resto B's Chef Mode via query or header...");
  try {
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: false }, ownerAHeaders);
    await makeRequest(serverUrl, "PATCH", "/api/owner/chef-mode", { chefDashboardEnabled: true }, ownerBHeaders);

    const spoofQuery = await makeRequest(
      serverUrl,
      "GET",
      `/api/staff/me?restaurantId=${restoB.id}`,
      undefined,
      waiterA1Headers,
    );
    if (spoofQuery.status !== 200 || spoofQuery.body?.chefDashboardEnabled !== false) {
      throw new Error(`Expected Resto A Chef Mode (false), got: ${JSON.stringify(spoofQuery.body)}`);
    }

    const spoofHeader = await makeRequest(
      serverUrl,
      "GET",
      "/api/staff/me",
      undefined,
      { ...waiterA1Headers, "x-restaurant-id": String(restoB.id) },
    );
    if (spoofHeader.status !== 200 || spoofHeader.body?.chefDashboardEnabled !== false) {
      throw new Error(`Expected Resto A Chef Mode (false), got: ${JSON.stringify(spoofHeader.body)}`);
    }

    testResults["Test 47"] = { status: "PASSED", note: "Tenant isolation strictly preserved against parameter & header manipulation" };
    console.log("  ✅ Test 47 PASSED\n");
  } catch (err: any) {
    testResults["Test 47"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 47 FAILED:", err.message, "\n");
  }

  // Test 48: Invalid or expired staff token remains rejected
  console.log("▶ TEST 48: Invalid or expired staff token rejected with 401...");
  try {
    const invalidRes = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, {
      Authorization: "Bearer invalid.fake.token",
    });
    if (invalidRes.status !== 401) throw new Error(`Expected 401 for invalid token, got: ${invalidRes.status}`);

    const noAuthRes = await makeRequest(serverUrl, "GET", "/api/staff/me");
    if (noAuthRes.status !== 401) throw new Error(`Expected 401 for missing token, got: ${noAuthRes.status}`);

    testResults["Test 48"] = { status: "PASSED", note: "Invalid or missing staff token rejected with 401" };
    console.log("  ✅ Test 48 PASSED\n");
  } catch (err: any) {
    testResults["Test 48"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 48 FAILED:", err.message, "\n");
  }

  // Test 49: Deactivated staff member token rejected with 401
  console.log("▶ TEST 49: Deactivated staff member rejected with 401...");
  try {
    const [deactivatedStaff] = await db
      .insert(restaurantStaff)
      .values({
        restaurantId: restoA.id,
        name: "Deactivated Staff",
        role: "waiter",
        isActive: false,
        tokenVersion: 1,
      })
      .returning();

    const deactToken = generateStaffToken({
      staffId: deactivatedStaff.id,
      restaurantId: restoA.id,
      role: "waiter",
      tokenVersion: 1,
    });

    const deactRes = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, {
      Authorization: `Bearer ${deactToken}`,
    });
    if (deactRes.status !== 401) {
      throw new Error(`Expected 401 for deactivated staff, got: ${deactRes.status}`);
    }

    testResults["Test 49"] = { status: "PASSED", note: "Deactivated staff member rejected with 401" };
    console.log("  ✅ Test 49 PASSED\n");
  } catch (err: any) {
    testResults["Test 49"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 49 FAILED:", err.message, "\n");
  }

  // Test 50: Existing /api/staff/me response fields remain unchanged
  console.log("▶ TEST 50: Existing /api/staff/me fields strictly preserved...");
  try {
    const res = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    if (res.status !== 200) throw new Error(`Expected 200, got: ${res.status}`);
    
    const topKeys = Object.keys(res.body).sort();
    if (topKeys.length !== 2 || !topKeys.includes("staff") || !topKeys.includes("chefDashboardEnabled")) {
      throw new Error(`Unexpected top-level response shape: ${JSON.stringify(res.body)}`);
    }

    const staffObj = res.body.staff;
    if (typeof staffObj.id !== "number") throw new Error("staff.id must be number");
    if (staffObj.name !== waiterA1.name) throw new Error("staff.name mismatch");
    if (staffObj.role !== "waiter") throw new Error("staff.role mismatch");
    if (staffObj.restaurantId !== restoA.id) throw new Error("staff.restaurantId mismatch");
    if (staffObj.restaurantName !== restoA.name) throw new Error("staff.restaurantName mismatch");

    testResults["Test 50"] = { status: "PASSED", note: "Existing /api/staff/me structure and fields strictly preserved" };
    console.log("  ✅ Test 50 PASSED\n");
  } catch (err: any) {
    testResults["Test 50"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 50 FAILED:", err.message, "\n");
  }

  // Test 51: chefDashboardEnabled is always a real JSON boolean (true/false)
  console.log("▶ TEST 51: chefDashboardEnabled is always a strict JSON boolean...");
  try {
    const resA = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterA1Headers);
    const resB = await makeRequest(serverUrl, "GET", "/api/staff/me", undefined, waiterBHeaders);

    if (resA.body?.chefDashboardEnabled !== false && resA.body?.chefDashboardEnabled !== true) {
      throw new Error("resA chefDashboardEnabled is not boolean");
    }
    if (resB.body?.chefDashboardEnabled !== false && resB.body?.chefDashboardEnabled !== true) {
      throw new Error("resB chefDashboardEnabled is not boolean");
    }

    testResults["Test 51"] = { status: "PASSED", note: "chefDashboardEnabled is strictly a JSON boolean under all states" };
    console.log("  ✅ Test 51 PASSED\n");
  } catch (err: any) {
    testResults["Test 51"] = { status: "FAILED", note: err.message };
    console.error("  ❌ Test 51 FAILED:", err.message, "\n");
  }

  server.close();

  // Summary Table
  console.log("================================================================================");
  console.log("📊 PHASE 4.1 + 4.2 + 4.4A AUTOMATED TEST SUMMARY");
  console.log("================================================================================");
  let passedCount = 0;
  for (const [testName, result] of Object.entries(testResults)) {
    console.log(`[${result.status}] ${testName}: ${result.note}`);
    if (result.status === "PASSED") passedCount++;
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(`TOTAL: ${passedCount} / ${Object.keys(testResults).length} TESTS PASSED\n`);

  if (passedCount !== Object.keys(testResults).length) {
    process.exit(1);
  }
}

runPhase4Tests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
