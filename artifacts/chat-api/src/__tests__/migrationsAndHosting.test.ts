import { describe, expect, it, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocket } from "ws";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-chat-hosting-test-"));

vi.hoisted(() => {
  process.env["CHAT_PGLITE_DIR"] = ":memory:";
  process.env["CHAT_INTERNAL_HMAC_SECRET"] = "test-chat-secret-hmac-key-0123456789";
  process.env["CHAT_PHONE_PEPPER"] = "test-phone-pepper";
  process.env["CHAT_ADMIN_SECRET"] = "test-admin-secret-999";
  delete process.env["DATABASE_URL"];
  delete process.env["CHAT_DATABASE_URL"];
});

import { PGlite } from "@electric-sql/pglite";
import { isAllowedChatOrigin } from "../lib/origins";
import { createChatApp } from "../app";
import { attachChatWebSocketServer } from "../ws";
import { chatPool, ensureChatDbReady, runChatMigrations, findMigrationsDir } from "../db";

const REQUIRED_16_TABLES = [
  "rate_limit_windows",
  "messaging_accounts",
  "messaging_contact_claims",
  "messaging_devices",
  "messaging_one_time_prekeys",
  "messaging_fallback_keys",
  "messaging_sessions",
  "messaging_handoff_drafts",
  "messaging_device_link_tokens",
  "messaging_conversations",
  "messaging_conversation_members",
  "messaging_messages",
  "messaging_to_device_events",
  "messaging_device_list_changes",
  "messaging_attachments",
  "messaging_audit_events",
];

describe("Phase 1 DB Migrations & Railway/WS Hosting", () => {
  afterAll(async () => {
    await chatPool.end();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "locates non-empty SQL migrations directory and creates all 16 tables idempotently on fresh DB",
    async () => {
      const migDir = findMigrationsDir();
      expect(migDir).not.toBeNull();
      const sqlFiles = fs.readdirSync(migDir!).filter((f) => f.endsWith(".sql"));
      expect(sqlFiles.length).toBeGreaterThanOrEqual(1);
      expect(sqlFiles).toContain("0000_init_messaging.sql");

      // Verify transactional SQL execution on a brand new isolated PGlite directory
      const freshPg = new PGlite(path.join(tempDir, "fresh-db"));
      await freshPg.waitReady;
      const rawSql = fs.readFileSync(path.join(migDir!, "0000_init_messaging.sql"), "utf8");
      const statements = rawSql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await freshPg.exec("BEGIN");
      for (const stmt of statements) {
        await freshPg.exec(stmt);
      }
      await freshPg.exec("COMMIT");

      // Second run must be 100% idempotent
      await freshPg.exec("BEGIN");
      for (const stmt of statements) {
        await freshPg.exec(stmt);
      }
      await freshPg.exec("COMMIT");

      const tablesRes = await freshPg.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const created = new Set(tablesRes.rows.map((r) => r.table_name));
      for (const t of REQUIRED_16_TABLES) {
        expect(created.has(t), `Missing table ${t}`).toBe(true);
      }
      await freshPg.close();

      // Also verify runtime ensureChatDbReady + repeated runChatMigrations
      await ensureChatDbReady();
      await runChatMigrations();
    },
    20_000,
  );

  it("validates CORS/WebSocket origins including Railway domains and rejects untrusted origins", () => {
    expect(isAllowedChatOrigin(undefined)).toBe(true);
    expect(isAllowedChatOrigin("https://chat.bitebend.in")).toBe(true);
    expect(isAllowedChatOrigin("https://chat-api.bitebend.in")).toBe(true);
    expect(isAllowedChatOrigin("https://bitebend.in")).toBe(true);
    expect(isAllowedChatOrigin("https://www.bitebend.in")).toBe(true);
    expect(isAllowedChatOrigin("https://bitebend-chat.up.railway.app")).toBe(true);
    expect(isAllowedChatOrigin("https://bitebend-chat.run.app")).toBe(true);
    expect(isAllowedChatOrigin("http://localhost:5175")).toBe(true);

    expect(isAllowedChatOrigin("http://bitebend-chat.up.railway.app")).toBe(false);
    expect(isAllowedChatOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedChatOrigin("not-a-url")).toBe(false);
  });

  it("enforces Origin allowlist and session auth on WebSocket upgrade and connects authenticated clients", async () => {
    await ensureChatDbReady();
    const server = http.createServer(createChatApp());
    attachChatWebSocketServer(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const httpBase = `http://127.0.0.1:${addr.port}`;
    const wsBase = `ws://127.0.0.1:${addr.port}/api/chat/ws`;

    try {
      // 1) Disallowed Origin -> 403 rejection
      const statusDisallowed = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(wsBase, { origin: "https://attacker.example.com" });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
        ws.on("error", () => {
          // unexpected-response fires first
        });
        setTimeout(() => reject(new Error("WS 403 timeout")), 3000);
      });
      expect(statusDisallowed).toBe(403);

      // 2) Trusted Origin without session cookie -> 401 rejection
      const statusUnauth = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(wsBase, { origin: "https://bitebend-chat.up.railway.app" });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
        ws.on("error", () => {});
        setTimeout(() => reject(new Error("WS 401 timeout")), 3000);
      });
      expect(statusUnauth).toBe(401);

      // 3) Register account and connect WS with session cookie + Railway Origin
      const regRes = await fetch(`${httpBase}/api/chat/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://bitebend-chat.up.railway.app",
        },
        body: JSON.stringify({
          proposedAccountId: crypto.randomUUID(),
          username: "ws_tester_1",
          displayName: "WS Tester",
          device: {
            deviceLabel: "Test Browser",
            matrixDeviceId: "WSDEV1",
            deviceKeysJson: {
              keys: {
                "ed25519:WSDEV1": "ed_ws_1",
                "curve25519:WSDEV1": "curve_ws_1",
              },
            },
            oneTimeKeys: {
              "signed_curve25519:AA0": { key: "otpk_ws_0" },
            },
          },
        }),
      });
      expect(regRes.status).toBe(201);
      const setCookies = regRes.headers.getSetCookie?.() ?? [];
      const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      expect(cookieHeader).toContain("bb_chat_sess=");

      const connectedPayload = await new Promise<{ type: string; deviceId?: string }>((resolve, reject) => {
        const ws = new WebSocket(wsBase, {
          origin: "https://chat.bitebend.in",
          headers: { Cookie: cookieHeader },
        });
        ws.on("message", (data) => {
          const parsed = JSON.parse(data.toString()) as { type: string; deviceId?: string };
          ws.close();
          resolve(parsed);
        });
        ws.on("error", (err) => reject(err));
        setTimeout(() => reject(new Error("WS connect timeout")), 3000);
      });
      expect(connectedPayload.type).toBe("connected");
      expect(connectedPayload.deviceId).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
