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
import { normalizeInboundPhone, sanitizeScreenshotDataUrl } from "../routes/whatsappBridge";

// Minimal valid 1x1 PNG & JPEG base64 payloads
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URI = `data:image/png;base64,${PNG_1X1_B64}`;
const JPEG_HEADER_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");
const WEBP_HEADER_B64 = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]).toString("base64");

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

describe("Payment Screenshot End-to-End Capture, Storage, Matching & Display Flow", () => {
  let server: http.Server;
  let baseUrl = "";
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let originalFetch: typeof globalThis.fetch;

  let restaurantAId = 0;
  let restaurantBId = 0;
  let ownerAToken = "";
  let ownerBToken = "";
  let tableAId = 0;
  let menuItemAId = 0;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
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
          // Ignore already-applied DDL
        }
      }
    }

    db = drizzle(memClient, { schema });

    const [restoA] = await db
      .insert(schema.restaurants)
      .values({
        name: "Screenshot Bistro A",
        slug: "ss-bistro-a",
        cuisineType: "Indian",
        address: "100 Floor St",
        city: "Bengaluru",
        phone: "9999991111",
        email: "ss-a@test.local",
        approvalStatus: "approved",
        isActive: true,
        upiId: "bistro@okicici",
      })
      .returning();

    const [restoB] = await db
      .insert(schema.restaurants)
      .values({
        name: "Screenshot Bistro B",
        slug: "ss-bistro-b",
        cuisineType: "Indian",
        address: "200 Floor St",
        city: "Bengaluru",
        phone: "9999992222",
        email: "ss-b@test.local",
        approvalStatus: "approved",
        isActive: true,
      })
      .returning();

    restaurantAId = restoA!.id;
    restaurantBId = restoB!.id;

    const [ownerA] = await db
      .insert(schema.users)
      .values({
        email: "owner-ss-a@bitebend.test",
        name: "Owner SS A",
        passwordHash: "x",
        role: "owner",
        restaurantId: restaurantAId,
      })
      .returning();

    const [ownerB] = await db
      .insert(schema.users)
      .values({
        email: "owner-ss-b@bitebend.test",
        name: "Owner SS B",
        passwordHash: "x",
        role: "owner",
        restaurantId: restaurantBId,
      })
      .returning();

    ownerAToken = generateToken({ userId: ownerA!.id, role: "owner" });
    ownerBToken = generateToken({ userId: ownerB!.id, role: "owner" });

    const [tableA] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId: restaurantAId,
        tableNumber: "T5",
        seatingCapacity: 4,
        qrCodeToken: "ss-qr-t5",
      })
      .returning();
    tableAId = tableA!.id;

    const [catA] = await db
      .insert(schema.menuCategories)
      .values({ restaurantId: restaurantAId, name: "Mains", sortOrder: 1 })
      .returning();

    const [itemA] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId: catA!.id,
        name: "Paneer Tikka",
        price: 300,
        isAvailable: true,
        isVeg: true,
      })
      .returning();
    menuItemAId = itemA!.id;

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function createSessionWithSentBill(opts: {
    customerPhone: string;
    chatJid?: string | null;
    billSuffix: string;
  }) {
    const [session] = await db
      .insert(schema.tableSessions)
      .values({
        restaurantId: restaurantAId,
        tableId: tableAId,
        tableNumber: "T5",
        status: "awaiting_payment",
        sessionType: "dine_in",
      })
      .returning();

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        tableId: tableAId,
        sessionId: session!.id,
        tableNumber: "T5",
        customerName: "Rohan",
        customerPhone: opts.customerPhone,
        status: "completed",
        subtotal: 300,
        tax: 15,
        total: 315,
        paymentMethod: "upi",
      })
      .returning();

    await db.insert(schema.orderItems).values({
      orderId: order!.id,
      menuItemId: menuItemAId,
      name: "Paneer Tikka",
      quantity: 1,
      unitPrice: 300,
    });

    const [bill] = await db
      .insert(schema.sessionBills)
      .values({
        sessionId: session!.id,
        restaurantId: restaurantAId,
        billNumber: `BILL-SS-${opts.billSuffix}`,
        subtotal: 300,
        tax: 15,
        total: 315,
        status: "sent",
        customerPhone: opts.customerPhone,
        chatJid: opts.chatJid ?? null,
        sentAt: new Date(),
      })
      .returning();

    return { session: session!, bill: bill! };
  }

  it("normalizes Indian, international non-LID, and opaque @lid phones properly", () => {
    expect(normalizeInboundPhone("9876543210")).toBe("919876543210");
    expect(normalizeInboundPhone("09876543210")).toBe("919876543210");
    expect(normalizeInboundPhone("919876543210")).toBe("919876543210");
    expect(normalizeInboundPhone("447911123456", "447911123456@c.us")).toBe("447911123456");
    expect(normalizeInboundPhone("268641748652129", "268641748652129@lid")).toBeNull();
    expect(normalizeInboundPhone("9876543210", "268641748652129@lid")).toBe("919876543210");
  });

  it("sanitizes data URIs and rejects empty/corrupt screenshot payloads", () => {
    const emptyRes = sanitizeScreenshotDataUrl("data:image/jpeg;base64,");
    expect(emptyRes.ok).toBe(false);

    const pngWithParams = sanitizeScreenshotDataUrl(`data:image/png;charset=utf-8;base64,${PNG_1X1_B64}`);
    expect(pngWithParams).toEqual({ ok: true, dataUrl: PNG_DATA_URI });

    const mislabeledJpeg = sanitizeScreenshotDataUrl(`data:application/octet-stream;base64,${JPEG_HEADER_B64}`);
    expect(mislabeledJpeg).toEqual({ ok: true, dataUrl: `data:image/jpeg;base64,${JPEG_HEADER_B64}` });

    const webpSniff = sanitizeScreenshotDataUrl(`data:image/jpeg;base64,${WEBP_HEADER_B64}`);
    expect(webpSniff).toEqual({ ok: true, dataUrl: `data:image/webp;base64,${WEBP_HEADER_B64}` });
  });

  it("rejects corrupt empty image data URI on /whatsapp/payment-screenshot with HTTP 400", async () => {
    const res = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919876543210",
      senderJid: "919876543210@c.us",
      imageUrl: "data:image/jpeg;base64,",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("completes full end-to-end GPay PNG flow: webhook → DB persistence → sessions list → screenshot fetch → refresh → tenant isolation", async () => {
    const { session, bill } = await createSessionWithSentBill({
      customerPhone: "919811112222",
      chatJid: "919811112222@c.us",
      billSuffix: "E2E-1",
    });

    const hookRes = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919811112222",
      senderJid: "919811112222@c.us",
      imageUrl: `data:image/png;charset=utf-8;base64,${PNG_1X1_B64}`,
      timestamp: new Date().toISOString(),
    });
    expect(hookRes.status).toBe(200);
    expect(hookRes.body.ok).toBe(true);
    expect(hookRes.body.matched).toBe("session_bill");
    expect(hookRes.body.sessionBillId).toBe(bill.id);

    // Simulate page refresh: GET /owner/sessions + GET /owner/screenshot-inbox
    const sessionsRes = await reqJson(baseUrl, "GET", "/api/owner/sessions", undefined, {
      Authorization: `Bearer ${ownerAToken}`,
    });
    expect(sessionsRes.status).toBe(200);
    const updatedSession = sessionsRes.body.find((s: any) => s.id === session.id);
    expect(updatedSession.status).toBe("awaiting_verification");
    expect(updatedSession.bill.status).toBe("awaiting_verification");
    expect(updatedSession.bill.hasScreenshot).toBe(true);

    const inboxRes = await reqJson(baseUrl, "GET", "/api/owner/screenshot-inbox?status=matched", undefined, {
      Authorization: `Bearer ${ownerAToken}`,
    });
    expect(inboxRes.status).toBe(200);
    const inboxItem = inboxRes.body.entries.find((e: any) => e.id === hookRes.body.inboxId);
    expect(inboxItem).toBeDefined();
    expect(inboxItem.hasScreenshot).toBe(true);
    expect(inboxItem.matchedBillId).toBe(bill.id);

    // Fetch both session bill screenshot & inbox image
    const billImgRes = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(billImgRes.status).toBe(200);
    expect(billImgRes.body.screenshotUrl).toBe(PNG_DATA_URI);

    const inboxImgRes = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/screenshot-inbox/${hookRes.body.inboxId}/image`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(inboxImgRes.status).toBe(200);
    expect(inboxImgRes.body.screenshotData).toBe(PNG_DATA_URI);

    // Cross-tenant isolation check
    const crossTenantRes = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerBToken}` },
    );
    expect(crossTenantRes.status).toBe(404);
  });

  it("supports >10MB GPay screenshot JSON payloads without 413 Payload Too Large", async () => {
    const { session, bill } = await createSessionWithSentBill({
      customerPhone: "919811113333",
      chatJid: "919811113333@c.us",
      billSuffix: "LARGE-1",
    });

    // Build an ~11.2 MB valid PNG-header base64 payload (would fail under old 10mb limit)
    const pngRaw = Buffer.from(PNG_1X1_B64, "base64");
    const bigRaw = Buffer.concat([pngRaw, Buffer.alloc(8_400_000, 0x41)]);
    const bigDataUri = `data:image/png;base64,${bigRaw.toString("base64")}`;
    expect(bigDataUri.length).toBeGreaterThan(10_500_000);

    const hookRes = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919811113333",
      senderJid: "919811113333@c.us",
      imageUrl: bigDataUri,
      timestamp: new Date().toISOString(),
    });
    expect(hookRes.status).toBe(200);
    expect(hookRes.body.matched).toBe("session_bill");
    expect(hookRes.body.sessionBillId).toBe(bill.id);

    const billImgRes = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(billImgRes.status).toBe(200);
    expect(billImgRes.body.screenshotUrl.length).toBe(bigDataUri.length);
  });

  it("allows duplicate screenshot resend after prior unmatched attempt or payment rejection, while blocking duplicate while bill is awaiting_verification", async () => {
    const uniqueImg = `data:image/jpeg;base64,${JPEG_HEADER_B64}AAABBBCC`;

    // 1. Customer sends screenshot BEFORE bill exists -> unmatched
    const firstHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919822220001",
      senderJid: "919822220001@c.us",
      imageUrl: uniqueImg,
      timestamp: new Date().toISOString(),
    });
    expect(firstHook.status).toBe(200);
    expect(firstHook.body.matched).toBe("none");

    // 2. Now create & send the bill, customer resends same screenshot -> MUST match!
    const { session, bill } = await createSessionWithSentBill({
      customerPhone: "919822220001",
      chatJid: "919822220001@c.us",
      billSuffix: "DUP-1",
    });

    const secondHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919822220001",
      senderJid: "919822220001@c.us",
      imageUrl: uniqueImg,
      timestamp: new Date().toISOString(),
    });
    expect(secondHook.status).toBe(200);
    expect(secondHook.body.matched).toBe("session_bill");
    expect(secondHook.body.sessionBillId).toBe(bill.id);

    // 3. Same image sent again while bill is awaiting_verification -> treated as duplicate
    const thirdHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919822220001",
      senderJid: "919822220001@c.us",
      imageUrl: uniqueImg,
      timestamp: new Date().toISOString(),
    });
    expect(thirdHook.status).toBe(200);
    expect(thirdHook.body.matched).toBe("none");
    expect(thirdHook.body.reason).toBe("duplicate");

    // 4. Reject bill (rolls back to 'sent') -> customer resends same screenshot -> MUST match again!
    const rejectRes = await reqJson(
      baseUrl,
      "PATCH",
      `/api/owner/sessions/${session.id}/bill/reject`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(rejectRes.status).toBe(200);

    const fourthHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "919822220001",
      senderJid: "919822220001@c.us",
      imageUrl: uniqueImg,
      timestamp: new Date().toISOString(),
    });
    expect(fourthHook.status).toBe(200);
    expect(fourthHook.body.matched).toBe("session_bill");
    expect(fourthHook.body.sessionBillId).toBe(bill.id);
  });

  it("matches international non-@lid phone and opaque @lid JID via chatJid", async () => {
    const intlBill = await createSessionWithSentBill({
      customerPhone: "447911123456",
      chatJid: null,
      billSuffix: "INTL-1",
    });

    const intlHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "447911123456",
      senderJid: "447911123456@c.us",
      imageUrl: `data:image/webp;base64,${WEBP_HEADER_B64}`,
      timestamp: new Date().toISOString(),
    });
    expect(intlHook.status).toBe(200);
    expect(intlHook.body.matched).toBe("session_bill");
    expect(intlHook.body.sessionBillId).toBe(intlBill.bill.id);

    const lidBill = await createSessionWithSentBill({
      customerPhone: "919833334444",
      chatJid: "268641748652129@lid",
      billSuffix: "LID-1",
    });

    const lidHook = await reqJson(baseUrl, "POST", "/api/whatsapp/payment-screenshot", {
      restaurantId: restaurantAId,
      customerPhone: "268641748652129",
      senderJid: "268641748652129@lid",
      imageUrl: `data:image/jpeg;base64,${JPEG_HEADER_B64}LIDTEST`,
      timestamp: new Date().toISOString(),
    });
    expect(lidHook.status).toBe(200);
    expect(lidHook.body.matched).toBe("session_bill");
    expect(lidHook.body.sessionBillId).toBe(lidBill.bill.id);
  });

  it("returns 410 for retention-purged screenshots, 404 when never received, and heals from inbox if bill column is null", async () => {
    // Never received -> 404
    const noSs = await createSessionWithSentBill({
      customerPhone: "919844445555",
      billSuffix: "404-1",
    });
    const res404 = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${noSs.session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(res404.status).toBe(404);

    // Purged (screenshotReceivedAt != null, screenshotUrl == null, no inbox backup) -> 410
    await db
      .update(schema.sessionBills)
      .set({ screenshotReceivedAt: new Date(), screenshotUrl: null })
      .where(eq(schema.sessionBills.id, noSs.bill.id));

    const res410 = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${noSs.session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(res410.status).toBe(410);

    const hist410 = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/history/${noSs.session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(hist410.status).toBe(410);

    // Self-healing inbox backup when inbox holds non-purged matched screenshot
    await db.insert(schema.paymentScreenshotInbox).values({
      restaurantId: restaurantAId,
      receivedAt: new Date(),
      senderPhone: "919844445555",
      screenshotData: PNG_DATA_URI,
      source: "whatsapp",
      matchStatus: "matched",
      matchedSessionId: noSs.session.id,
      matchedBillId: noSs.bill.id,
      matchingStrategy: "manual",
    });

    const healedRes = await reqJson(
      baseUrl,
      "GET",
      `/api/owner/sessions/${noSs.session.id}/bill/screenshot`,
      undefined,
      { Authorization: `Bearer ${ownerAToken}` },
    );
    expect(healedRes.status).toBe(200);
    expect(healedRes.body.screenshotUrl).toBe(PNG_DATA_URI);
  });
});
