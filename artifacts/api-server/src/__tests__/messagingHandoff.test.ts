import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import http from "node:http";
import type { PGlite as PGliteType } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

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
  return { memClient: client, memPool: poolAdapter };
});

vi.mock("@workspace/db", async () => {
  const realSchema = await import("../../../../lib/db/src/schema");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dbInst = drizzle(memClient, { schema: realSchema });
  return {
    ...realSchema,
    db: dbInst,
    pool: memPool,
    pgliteInstance: memClient,
    ensureDbReady: async () => {},
  };
});

import { db, messagingHandoffTokens, internalRequestNonces, orders, restaurants } from "@workspace/db";
import messagingHandoffRouter from "../routes/messagingHandoff";

describe("messagingHandoff security & placeOrder isolation", () => {
  let server: http.Server;
  let baseUrl: string;
  let restaurantId: number;
  let orderId: number;

  const secret = "test-chat-hmac-secret-32-chars-minimum";

  beforeAll(async () => {
    process.env["CHAT_INTERNAL_HMAC_SECRET"] = secret;
    await memClient.waitReady;
    const migrationsDir = path.resolve(import.meta.dirname, "../../../../lib/db/drizzle");
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const stmts = content.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        try {
          await memClient.exec(stmt);
        } catch {
          // ignore idempotent statements
        }
      }
    }

    // Seed a minimal restaurant & order directly in test DB
    const [rest] = await db
      .insert(restaurants)
      .values({
        name: "Handoff Test Bistro",
        slug: `handoff-test-${Date.now()}`,
        cuisineType: "Indian",
        city: "Bengaluru",
        phone: "9876543210",
        email: `owner-${Date.now()}@test.local`,
      })
      .returning();
    restaurantId = rest.id;

    const [ord] = await db
      .insert(orders)
      .values({
        restaurantId,
        customerName: "Rohan Mehta",
        customerPhone: "9876543210",
        status: "pending",
        subtotal: 400,
        tax: 20,
        total: 420,
      })
      .returning();
    orderId = ord.id;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use("/api", messagingHandoffRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await db.delete(messagingHandoffTokens).where(eq(messagingHandoffTokens.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await db.delete(restaurants).where(eq(restaurants.id, restaurantId));
    server.close();
  });

  it("leaves placeOrder in menu.ts untouched", () => {
    const menuPath = path.resolve(import.meta.dirname, "../routes/menu.ts");
    const content = fs.readFileSync(menuPath, "utf8");
    expect(content).not.toContain("messaging-handoff");
    expect(content).not.toContain("messagingHandoffTokens");
  });

  it("rejects unauthorized cross-site origins with 403", async () => {
    const res = await fetch(`${baseUrl}/api/menu/messaging-handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil-attacker.example",
      },
      body: JSON.stringify({ restaurantId, orderId, customerPhone: "9876543210" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects raw duplicate handoff cookies with 400", async () => {
    const res = await fetch(`${baseUrl}/api/menu/messaging-handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://menu.bitebend.in",
        Cookie: "bb_msg_handoff=a; bb_msg_handoff=b",
      },
      body: JSON.stringify({ restaurantId, orderId, customerPhone: "9876543210" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("DUPLICATE_COOKIE");
  });

  it("mints hashed single-use token, verifies S2S HMAC, rejects replays & duplicate consumes", async () => {
    const mintRes = await fetch(`${baseUrl}/api/menu/messaging-handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://menu.bitebend.in",
      },
      body: JSON.stringify({ restaurantId, orderId, customerPhone: "9876543210" }),
    });
    expect(mintRes.status).toBe(201);

    const setCookies = mintRes.headers.getSetCookie();
    const handoffSet = setCookies.find((c) => c.startsWith("bb_msg_handoff=") || c.startsWith("__Secure-bb_msg_handoff="));
    expect(handoffSet).toBeDefined();
    const rawToken = decodeURIComponent(handoffSet!.split(";")[0].split("=")[1]);

    const signS2S = (ts: string, nonce: string, bodyStr: string) => {
      const bodySha = crypto.createHash("sha256").update(bodyStr, "utf8").digest("hex");
      const canonical = `POST\n/api/internal/messaging/handoff/verify-consume\n${ts}\n${nonce}\n${bodySha}`;
      return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
    };

    const bodyCanonical = JSON.stringify({ rawToken });

    // 1. Stale timestamp rejected
    const staleTs = String(Date.now() - 180_000);
    const staleNonce = crypto.randomBytes(16).toString("hex");
    const staleRes = await fetch(`${baseUrl}/api/internal/messaging/handoff/verify-consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bitebend-ts": staleTs,
        "x-bitebend-nonce": staleNonce,
        "x-bitebend-sig": signS2S(staleTs, staleNonce, bodyCanonical),
      },
      body: bodyCanonical,
    });
    expect(staleRes.status).toBe(401);

    // 2. Valid first consume succeeds
    const ts1 = String(Date.now());
    const nonce1 = crypto.randomBytes(16).toString("hex");
    const okRes = await fetch(`${baseUrl}/api/internal/messaging/handoff/verify-consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bitebend-ts": ts1,
        "x-bitebend-nonce": nonce1,
        "x-bitebend-sig": signS2S(ts1, nonce1, bodyCanonical),
      },
      body: bodyCanonical,
    });
    expect(okRes.status).toBe(200);
    const consumedData = (await okRes.json()) as { valid: boolean; customerPhone: string };
    expect(consumedData.valid).toBe(true);
    expect(consumedData.customerPhone).toBe("919876543210");

    // 3. Exact nonce replay rejected
    const replayRes = await fetch(`${baseUrl}/api/internal/messaging/handoff/verify-consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bitebend-ts": ts1,
        "x-bitebend-nonce": nonce1,
        "x-bitebend-sig": signS2S(ts1, nonce1, bodyCanonical),
      },
      body: bodyCanonical,
    });
    expect(replayRes.status).toBe(409);

    // 4. Fresh nonce with already-consumed token returns 409 HANDOFF_ALREADY_CONSUMED
    const ts2 = String(Date.now());
    const nonce2 = crypto.randomBytes(16).toString("hex");
    const secondConsume = await fetch(`${baseUrl}/api/internal/messaging/handoff/verify-consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bitebend-ts": ts2,
        "x-bitebend-nonce": nonce2,
        "x-bitebend-sig": signS2S(ts2, nonce2, bodyCanonical),
      },
      body: bodyCanonical,
    });
    expect(secondConsume.status).toBe(409);

    await db.delete(internalRequestNonces);
  });
});
