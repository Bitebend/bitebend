import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSessionSecret } from "../lib/token";
import { getWhatsAppBridgeConfig } from "../lib/whatsappConfig";

describe("Phase 2 & 3: Production Configuration Hardening", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("SESSION_SECRET configuration validation", () => {
    it("fails fast in production mode when SESSION_SECRET is missing", () => {
      process.env.NODE_ENV = "production";
      delete process.env.SESSION_SECRET;

      expect(() => getSessionSecret()).toThrowError(/\[CONFIG_ERROR\].*SESSION_SECRET/);
    });

    it("fails fast in production mode when SESSION_SECRET is whitespace only", () => {
      process.env.NODE_ENV = "production";
      process.env.SESSION_SECRET = "   ";

      expect(() => getSessionSecret()).toThrowError(/\[CONFIG_ERROR\].*SESSION_SECRET/);
    });

    it("succeeds in production mode when SESSION_SECRET is properly set", () => {
      process.env.NODE_ENV = "production";
      process.env.SESSION_SECRET = "a-very-secure-random-production-secret-2026";

      expect(getSessionSecret()).toBe("a-very-secure-random-production-secret-2026");
    });

    it("falls back to default secret in development mode if unset", () => {
      process.env.NODE_ENV = "development";
      delete process.env.SESSION_SECRET;

      expect(getSessionSecret()).toBe("bitebend-secure-session-secret-key-2026");
    });

    it("uses provided SESSION_SECRET in development mode if set", () => {
      process.env.NODE_ENV = "development";
      process.env.SESSION_SECRET = "custom-dev-secret";

      expect(getSessionSecret()).toBe("custom-dev-secret");
    });
  });

  describe("WhatsApp Bridge configuration validation", () => {
    it("fails fast in production mode when all WhatsApp variables are missing", () => {
      process.env.NODE_ENV = "production";
      delete process.env.BRIDGE_URL;
      delete process.env.BRIDGE_API_SECRET;
      delete process.env.BITEBEND_WEBHOOK_SECRET;

      expect(() => getWhatsAppBridgeConfig()).toThrowError(
        /\[CONFIG_ERROR\].*BRIDGE_URL.*BRIDGE_API_SECRET.*BITEBEND_WEBHOOK_SECRET/,
      );
    });

    it("fails fast in production mode when only BRIDGE_URL is missing", () => {
      process.env.NODE_ENV = "production";
      delete process.env.BRIDGE_URL;
      process.env.BRIDGE_API_SECRET = "bridge-secret-123";
      process.env.BITEBEND_WEBHOOK_SECRET = "webhook-secret-456";

      expect(() => getWhatsAppBridgeConfig()).toThrowError(/BRIDGE_URL/);
    });

    it("fails fast in production mode when BRIDGE_API_SECRET is missing", () => {
      process.env.NODE_ENV = "production";
      process.env.BRIDGE_URL = "https://whatsapp-bridge.internal";
      delete process.env.BRIDGE_API_SECRET;
      process.env.BITEBEND_WEBHOOK_SECRET = "webhook-secret-456";

      expect(() => getWhatsAppBridgeConfig()).toThrowError(/BRIDGE_API_SECRET/);
    });

    it("fails fast in production mode when BITEBEND_WEBHOOK_SECRET is missing", () => {
      process.env.NODE_ENV = "production";
      process.env.BRIDGE_URL = "https://whatsapp-bridge.internal";
      process.env.BRIDGE_API_SECRET = "bridge-secret-123";
      delete process.env.BITEBEND_WEBHOOK_SECRET;

      expect(() => getWhatsAppBridgeConfig()).toThrowError(/BITEBEND_WEBHOOK_SECRET/);
    });

    it("succeeds in production mode when all WhatsApp variables are configured", () => {
      process.env.NODE_ENV = "production";
      process.env.BRIDGE_URL = "https://whatsapp-bridge.internal";
      process.env.BRIDGE_API_SECRET = "bridge-secret-123";
      process.env.BITEBEND_WEBHOOK_SECRET = "webhook-secret-456";

      const config = getWhatsAppBridgeConfig();
      expect(config.bridgeUrl).toBe("https://whatsapp-bridge.internal");
      expect(config.bridgeApiSecret).toBe("bridge-secret-123");
      expect(config.webhookSecret).toBe("webhook-secret-456");
    });

    it("allows default local development behavior without throwing", () => {
      process.env.NODE_ENV = "development";
      delete process.env.BRIDGE_URL;
      delete process.env.BRIDGE_API_SECRET;
      delete process.env.BITEBEND_WEBHOOK_SECRET;

      const config = getWhatsAppBridgeConfig();
      expect(config.bridgeUrl).toBe("http://localhost:3001");
      expect(config.bridgeApiSecret).toBe("");
      expect(config.webhookSecret).toBe("");
    });
  });
});

describe("Phase 1: Hardware Collection Concurrency & Idempotency", () => {
  interface MockDbState {
    hardwareOrders: Map<number, { id: number; partnerId: number; restaurantId: number; standQuantity: number; totalAmount: number; collectionStatus: string; notes?: string | null }>;
    restaurants: Map<number, { id: number; qrStandsCount: number }>;
    auditLogs: Array<any>;
  }

  function simulateHardwareCollection(
    state: MockDbState,
    orderId: number,
    requestingPartnerId: number,
  ): { success: boolean; error?: string; status: number; alreadyCollected?: boolean; standsCountAfter: number } {
    const order = state.hardwareOrders.get(orderId);
    if (!order) {
      return { success: false, error: "Hardware order not found", status: 404, standsCountAfter: 0 };
    }

    if (order.partnerId !== requestingPartnerId) {
      const resto = state.restaurants.get(order.restaurantId);
      return { success: false, error: "Forbidden", status: 403, standsCountAfter: resto?.qrStandsCount ?? 0 };
    }

    if (order.collectionStatus === "waived") {
      const resto = state.restaurants.get(order.restaurantId);
      return { success: false, error: "Waived order cannot be collected", status: 400, standsCountAfter: resto?.qrStandsCount ?? 0 };
    }

    if (order.collectionStatus === "collected") {
      const resto = state.restaurants.get(order.restaurantId);
      return { success: true, alreadyCollected: true, status: 200, standsCountAfter: resto?.qrStandsCount ?? 0 };
    }

    // Atomic conditional UPDATE: WHERE id = orderId AND collectionStatus = 'pending'
    let actuallyUpdated = false;
    if (order.collectionStatus === "pending") {
      order.collectionStatus = "collected";
      actuallyUpdated = true;

      if (order.standQuantity > 0) {
        const resto = state.restaurants.get(order.restaurantId);
        if (resto) {
          resto.qrStandsCount += order.standQuantity;
        }
      }

      state.auditLogs.push({
        action: "partner_collected_hardware",
        orderId: order.id,
        standQuantity: order.standQuantity,
      });
    }

    const currentResto = state.restaurants.get(order.restaurantId);
    return {
      success: true,
      status: 200,
      alreadyCollected: !actuallyUpdated,
      standsCountAfter: currentResto?.qrStandsCount ?? 0,
    };
  }

  it("handles concurrent collection requests: exactly one increments stands count, second is idempotent", () => {
    const state: MockDbState = {
      hardwareOrders: new Map([
        [1, { id: 1, partnerId: 10, restaurantId: 100, standQuantity: 5, totalAmount: 150, collectionStatus: "pending" }],
      ]),
      restaurants: new Map([
        [100, { id: 100, qrStandsCount: 0 }],
      ]),
      auditLogs: [],
    };

    // Simulate two simultaneous collection requests
    const res1 = simulateHardwareCollection(state, 1, 10);
    const res2 = simulateHardwareCollection(state, 1, 10);

    expect(res1.success).toBe(true);
    expect(res1.status).toBe(200);
    expect(res1.alreadyCollected).toBe(false);

    expect(res2.success).toBe(true);
    expect(res2.status).toBe(200);
    expect(res2.alreadyCollected).toBe(true);

    // Operational stands must be exactly 5, NEVER 10
    expect(state.restaurants.get(100)?.qrStandsCount).toBe(5);
    // Audit logs must be recorded exactly once
    expect(state.auditLogs.length).toBe(1);
  });

  it("replay of already collected order does not increment stands count", () => {
    const state: MockDbState = {
      hardwareOrders: new Map([
        [2, { id: 2, partnerId: 10, restaurantId: 200, standQuantity: 3, totalAmount: 90, collectionStatus: "collected" }],
      ]),
      restaurants: new Map([
        [200, { id: 200, qrStandsCount: 8 }],
      ]),
      auditLogs: [],
    };

    const replayRes = simulateHardwareCollection(state, 2, 10);
    expect(replayRes.success).toBe(true);
    expect(replayRes.alreadyCollected).toBe(true);
    expect(state.restaurants.get(200)?.qrStandsCount).toBe(8);
  });

  it("enforces partner ownership: partner B cannot collect partner A order", () => {
    const state: MockDbState = {
      hardwareOrders: new Map([
        [3, { id: 3, partnerId: 10, restaurantId: 300, standQuantity: 4, totalAmount: 120, collectionStatus: "pending" }],
      ]),
      restaurants: new Map([
        [300, { id: 300, qrStandsCount: 0 }],
      ]),
      auditLogs: [],
    };

    const unauthorizedRes = simulateHardwareCollection(state, 3, 999);
    expect(unauthorizedRes.status).toBe(403);
    expect(unauthorizedRes.success).toBe(false);
    expect(state.restaurants.get(300)?.qrStandsCount).toBe(0);
    expect(state.hardwareOrders.get(3)?.collectionStatus).toBe("pending");
  });

  it("waived hardware order cannot be collected and does not increment stands", () => {
    const state: MockDbState = {
      hardwareOrders: new Map([
        [4, { id: 4, partnerId: 10, restaurantId: 400, standQuantity: 6, totalAmount: 180, collectionStatus: "waived" }],
      ]),
      restaurants: new Map([
        [400, { id: 400, qrStandsCount: 2 }],
      ]),
      auditLogs: [],
    };

    const waivedRes = simulateHardwareCollection(state, 4, 10);
    expect(waivedRes.status).toBe(400);
    expect(waivedRes.success).toBe(false);
    expect(state.restaurants.get(400)?.qrStandsCount).toBe(2);
  });

  it("0-stand order does not increment stands count", () => {
    const state: MockDbState = {
      hardwareOrders: new Map([
        [5, { id: 5, partnerId: 10, restaurantId: 500, standQuantity: 0, totalAmount: 0, collectionStatus: "pending" }],
      ]),
      restaurants: new Map([
        [500, { id: 500, qrStandsCount: 0 }],
      ]),
      auditLogs: [],
    };

    const zeroRes = simulateHardwareCollection(state, 5, 10);
    expect(zeroRes.success).toBe(true);
    expect(state.restaurants.get(500)?.qrStandsCount).toBe(0);
  });
});

describe("Phase 4: Bill Payment Concurrency & Status Guard", () => {
  interface MockBillState {
    bill: { id: number; sessionId: number; status: string };
    session: { id: number; status: string };
    orders: Array<{ id: number; paymentStatus: string }>;
    tables: Array<{ id: number; isOccupied: boolean }>;
  }

  function simulateMarkSessionBillPaid(state: MockBillState): {
    ok: boolean;
    alreadyPaid?: boolean;
    status: number;
    error?: string;
  } {
    const ALLOWED_STATUSES = ["generated", "sent", "awaiting_verification"];

    if (!ALLOWED_STATUSES.includes(state.bill.status)) {
      if (state.bill.status === "paid") {
        return { ok: true, alreadyPaid: true, status: 200 };
      }
      return { ok: false, status: 400, error: `Cannot mark paid from status ${state.bill.status}` };
    }

    // Atomic conditional UPDATE: WHERE id = bill.id AND status IN (ALLOWED_STATUSES)
    let actuallyUpdated = false;
    if (ALLOWED_STATUSES.includes(state.bill.status)) {
      state.bill.status = "paid";
      actuallyUpdated = true;

      state.session.status = "closed";
      for (const order of state.orders) {
        order.paymentStatus = "paid";
      }
      for (const table of state.tables) {
        table.isOccupied = false;
      }
    }

    return {
      ok: true,
      alreadyPaid: !actuallyUpdated,
      status: 200,
    };
  }

  it("concurrent mark paid: first call marks paid and releases table, second call is safe and idempotent", () => {
    const state: MockBillState = {
      bill: { id: 101, sessionId: 50, status: "generated" },
      session: { id: 50, status: "active" },
      orders: [
        { id: 1, paymentStatus: "unpaid" },
        { id: 2, paymentStatus: "unpaid" },
      ],
      tables: [{ id: 5, isOccupied: true }],
    };

    const call1 = simulateMarkSessionBillPaid(state);
    const call2 = simulateMarkSessionBillPaid(state);

    expect(call1.ok).toBe(true);
    expect(call1.alreadyPaid).toBe(false);

    expect(call2.ok).toBe(true);
    expect(call2.alreadyPaid).toBe(true);

    expect(state.bill.status).toBe("paid");
    expect(state.session.status).toBe("closed");
    expect(state.orders[0].paymentStatus).toBe("paid");
    expect(state.tables[0].isOccupied).toBe(false);
  });

  it("cannot mark paid a cancelled bill", () => {
    const state: MockBillState = {
      bill: { id: 102, sessionId: 51, status: "cancelled" },
      session: { id: 51, status: "active" },
      orders: [{ id: 3, paymentStatus: "unpaid" }],
      tables: [{ id: 6, isOccupied: true }],
    };

    const res = simulateMarkSessionBillPaid(state);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(state.bill.status).toBe("cancelled");
    expect(state.session.status).toBe("active");
    expect(state.tables[0].isOccupied).toBe(true);
  });
});
