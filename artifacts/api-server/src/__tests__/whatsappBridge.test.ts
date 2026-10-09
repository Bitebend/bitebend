import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import express from "express";

// Mock @workspace/db
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  paymentScreenshotInbox: {
    id: "id",
    restaurantId: "restaurantId",
    imageHash: "imageHash",
    createdAt: "createdAt",
  },
}));

// Mock requireOwner middleware to inject a simulated owner user
vi.mock("../middlewares/auth", () => ({
  requireOwner: (req: any, _res: any, next: any) => {
    req.user = { id: 10, email: "owner@test.com", role: "owner", restaurantId: 42 };
    next();
  },
}));

// Mock bridgeManager
vi.mock("../lib/bridgeManager", () => ({
  getBridgeState: vi.fn(() => "stopped"),
  isBridgeManaged: vi.fn(() => false),
}));

describe("WhatsApp Bridge Owner Routes & Proxy Tests", () => {
  const originalEnv = { ...process.env };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BITEBEND_WEBHOOK_SECRET = process.env.BITEBEND_WEBHOOK_SECRET || "test-webhook-secret";
    process.env.BRIDGE_API_SECRET = process.env.BRIDGE_API_SECRET || "secret-key-xyz";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GET /owner/whatsapp/qr-status forwards request to bridge and returns response", async () => {
    process.env.BRIDGE_URL = "https://wa.bitebend.in";
    process.env.BRIDGE_API_SECRET = "secret-key-xyz";

    let capturedUrl = "";
    let capturedHeaders: any = {};

    globalThis.fetch = vi.fn(async (url: any, options: any) => {
      capturedUrl = String(url);
      capturedHeaders = options?.headers ?? {};
      return {
        ok: true,
        json: async () => ({
          success: true,
          restaurantId: 42,
          status: "qr_pending",
          qr: "test-qr-code-payload-string",
          generatedAt: "2026-10-07T12:00:00.000Z",
          expiresAt: "2026-10-07T12:01:00.000Z",
        }),
      } as any;
    });

    const router = (await import("../routes/whatsappBridge")).default;
    const app = express();
    app.use(express.json());
    app.use(router);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };

    try {
      const res = await originalFetch(`http://127.0.0.1:${address.port}/owner/whatsapp/qr-status`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(capturedUrl).toBe("https://wa.bitebend.in/api/whatsapp/qr-status/42");
      expect(capturedHeaders["x-bridge-secret"]).toBe("secret-key-xyz");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");

      expect(body).toEqual({
        success: true,
        restaurantId: 42,
        status: "qr_pending",
        qr: "test-qr-code-payload-string",
        generatedAt: "2026-10-07T12:00:00.000Z",
        expiresAt: "2026-10-07T12:01:00.000Z",
        bridgeReachable: true,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("GET /owner/whatsapp/qr-status handles bridge unreachable gracefully", async () => {
    process.env.BRIDGE_URL = "https://wa.bitebend.in";

    globalThis.fetch = vi.fn(async () => {
      throw new Error("Connection refused");
    });

    const router = (await import("../routes/whatsappBridge")).default;
    const app = express();
    app.use(express.json());
    app.use(router);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };

    try {
      const res = await originalFetch(`http://127.0.0.1:${address.port}/owner/whatsapp/qr-status`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        success: false,
        restaurantId: 42,
        status: "not_initialised",
        qr: null,
        generatedAt: null,
        expiresAt: null,
        bridgeReachable: false,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
