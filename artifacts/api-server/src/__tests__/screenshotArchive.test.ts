import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import express from "express";

// In-memory mock database store for Payment Screenshot Inbox
interface InboxRecord {
  id: number;
  restaurantId: number;
  receivedAt: Date;
  senderJid: string | null;
  senderPhone: string | null;
  screenshotData: string | null;
  source: string;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  matchedSessionId: number | null;
  matchedBillId: number | null;
  matchingStrategy: string | null;
  imageHash: string | null;
  isDuplicate: boolean;
  duplicateOfId: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

let mockInboxRecords: InboxRecord[] = [];
let currentTestUserRestaurantId = 42;

vi.mock("@workspace/db", () => {
  return {
    paymentScreenshotInbox: {
      id: "id",
      restaurantId: "restaurantId",
      receivedAt: "receivedAt",
      senderJid: "senderJid",
      senderPhone: "senderPhone",
      screenshotData: "screenshotData",
      source: "source",
      matchStatus: "matchStatus",
      matchedSessionId: "matchedSessionId",
      matchedBillId: "matchedBillId",
      matchingStrategy: "matchingStrategy",
      isDuplicate: "isDuplicate",
      archivedAt: "archivedAt",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    sessionBills: {
      id: "id",
      restaurantId: "restaurantId",
      sessionId: "sessionId",
      billNumber: "billNumber",
      total: "total",
      status: "status",
    },
    tableSessions: {
      id: "id",
      restaurantId: "restaurantId",
      tableNumber: "tableNumber",
      status: "status",
    },
    orders: {
      id: "id",
      paymentScreenshotUrl: "paymentScreenshotUrl",
      paymentStatus: "paymentStatus",
      paymentVerificationStatus: "paymentVerificationStatus",
      updatedAt: "updatedAt",
    },
    db: {
      select: (fields?: any) => ({
        from: (_table: any) => ({
          where: (clause: any) => {
            const execute = () => {
              // Extract restaurantId & query conditions
              let results = [...mockInboxRecords].filter(
                (r) => r.restaurantId === currentTestUserRestaurantId,
              );

              if (clause && clause.__isArchivedOnly) {
                results = results.filter((r) => r.archivedAt !== null);
              } else if (clause && clause.__isActiveOnly) {
                results = results.filter((r) => r.archivedAt === null);
                if (clause.__status && clause.__status !== "all") {
                  results = results.filter((r) => r.matchStatus === clause.__status);
                }
              } else if (clause && clause.__byId) {
                results = results.filter((r) => r.id === clause.__byId);
              }

              // Transform for fields
              return results.map((r) => ({
                ...r,
                hasScreenshot: r.screenshotData !== null,
              }));
            };

            return {
              orderBy: () => ({
                limit: () => ({
                  offset: () => Promise.resolve(execute()),
                }),
              }),
              limit: (n: number) => {
                const res = execute();
                return Promise.resolve(n === 1 ? res.slice(0, 1) : res);
              },
              then: (resolve: any) => {
                const res = execute();
                if (fields && fields.total) {
                  return resolve([{ total: res.length }]);
                }
                return resolve(res);
              },
            };
          },
        }),
      }),
      update: (_table: any) => ({
        set: (updates: Partial<InboxRecord>) => ({
          where: (clause: any) => {
            const targetId = clause?.__byId;
            const target = mockInboxRecords.find(
              (r) => r.id === targetId && r.restaurantId === currentTestUserRestaurantId,
            );
            if (target) {
              Object.assign(target, updates);
            }
            return Promise.resolve(target ? [target] : []);
          },
        }),
      }),
    },
  };
});

// Mock drizzle-orm helpers to tag where-clauses for our mock store
vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => {
    if (col === "id") return { __byId: val };
    if (col === "restaurantId") return { __restaurantId: val };
    if (col === "matchStatus") return { __status: val };
    return { col, val };
  },
  and: (...clauses: any[]) => {
    const combined: any = {};
    for (const c of clauses) {
      if (!c) continue;
      if (c.__byId) combined.__byId = c.__byId;
      if (c.__isArchivedOnly) combined.__isArchivedOnly = true;
      if (c.__isActiveOnly) combined.__isActiveOnly = true;
      if (c.__status) combined.__status = c.__status;
    }
    return combined;
  },
  desc: (col: any) => ({ desc: col }),
  isNull: (col: any) => (col === "archivedAt" ? { __isActiveOnly: true } : {}),
  isNotNull: (col: any) => (col === "archivedAt" ? { __isArchivedOnly: true } : {}),
  sql: () => ({}),
}));

// Mock requireOwner
vi.mock("../middlewares/auth", () => ({
  requireOwner: (req: any, _res: any, next: any) => {
    req.user = { id: 10, email: "owner@test.com", role: "owner", restaurantId: currentTestUserRestaurantId };
    next();
  },
}));

// Mock orderEvents & logger
vi.mock("../lib/orderEvents", () => ({
  emitSessionScreenshotEvent: vi.fn(),
  emitScreenshotInboxEvent: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../lib/screenshotMatcher", () => ({
  matchAndAttachScreenshot: vi.fn(),
}));

describe("Payment Screenshot Inbox: Archive / Remove Feature", () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    currentTestUserRestaurantId = 42;
    mockInboxRecords = [
      {
        id: 1,
        restaurantId: 42,
        receivedAt: new Date("2026-10-09T06:00:00Z"),
        senderJid: "919876543210@s.whatsapp.net",
        senderPhone: "9876543210",
        screenshotData: "data:image/jpeg;base64,validBase64Data1",
        source: "whatsapp",
        matchStatus: "unmatched",
        matchedSessionId: null,
        matchedBillId: null,
        matchingStrategy: null,
        imageHash: "hash1",
        isDuplicate: false,
        duplicateOfId: null,
        archivedAt: null, // Active
        createdAt: new Date("2026-10-09T06:00:00Z"),
        updatedAt: new Date("2026-10-09T06:00:00Z"),
      },
      {
        id: 2,
        restaurantId: 42,
        receivedAt: new Date("2026-10-09T06:30:00Z"),
        senderJid: "919876543211@s.whatsapp.net",
        senderPhone: "9876543211",
        screenshotData: "data:image/jpeg;base64,validBase64Data2",
        source: "whatsapp",
        matchStatus: "matched",
        matchedSessionId: 101,
        matchedBillId: 202,
        matchingStrategy: "exact_phone_single_bill",
        imageHash: "hash2",
        isDuplicate: false,
        duplicateOfId: null,
        archivedAt: new Date("2026-10-09T07:00:00Z"), // Already Archived
        createdAt: new Date("2026-10-09T06:30:00Z"),
        updatedAt: new Date("2026-10-09T07:00:00Z"),
      },
      {
        id: 3,
        restaurantId: 42,
        receivedAt: new Date("2026-10-09T06:45:00Z"),
        senderJid: "919876543212@s.whatsapp.net",
        senderPhone: "9876543212",
        screenshotData: null, // Expired media (purged)
        source: "whatsapp",
        matchStatus: "unmatched",
        matchedSessionId: null,
        matchedBillId: null,
        matchingStrategy: null,
        imageHash: "hash3",
        isDuplicate: false,
        duplicateOfId: null,
        archivedAt: new Date("2026-10-09T07:15:00Z"), // Archived with expired media
        createdAt: new Date("2026-10-09T06:45:00Z"),
        updatedAt: new Date("2026-10-09T07:15:00Z"),
      },
      {
        id: 99,
        restaurantId: 999, // Belongs to Restaurant B!
        receivedAt: new Date("2026-10-09T06:50:00Z"),
        senderJid: "919999999999@s.whatsapp.net",
        senderPhone: "9999999999",
        screenshotData: "data:image/jpeg;base64,restaurantBData",
        source: "whatsapp",
        matchStatus: "unmatched",
        matchedSessionId: null,
        matchedBillId: null,
        matchingStrategy: null,
        imageHash: "hash99",
        isDuplicate: false,
        duplicateOfId: null,
        archivedAt: null,
        createdAt: new Date("2026-10-09T06:50:00Z"),
        updatedAt: new Date("2026-10-09T06:50:00Z"),
      },
    ];

    const router = (await import("../routes/screenshotInbox")).default;
    app = express();
    app.use(express.json());
    app.use(router);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.clearAllMocks();
  });

  it("1. GET /owner/screenshot-inbox excludes archived items from the All list", async () => {
    const res = await fetch(`${baseUrl}/owner/screenshot-inbox?status=all`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    // Should contain active screenshot #1, NOT archived #2 or #3
    const ids = body.entries.map((e: any) => e.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
  });

  it("2. GET /owner/screenshot-inbox?status=archived returns only archived items in Archived / Removed", async () => {
    const res = await fetch(`${baseUrl}/owner/screenshot-inbox?status=archived`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.entries.map((e: any) => e.id);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(1);
  });

  it("3. Archiving an active screenshot sets archived_at and removes it from All", async () => {
    // Screenshot 1 is currently active
    const archiveRes = await fetch(`${baseUrl}/owner/screenshot-inbox/1/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.ok).toBe(true);
    expect(archiveBody.id).toBe(1);
    expect(archiveBody.archivedAt).toBeDefined();

    // Verify record in database
    const rec = mockInboxRecords.find((r) => r.id === 1);
    expect(rec?.archivedAt).not.toBeNull();
    // Verify media file is NOT deleted!
    expect(rec?.screenshotData).toBe("data:image/jpeg;base64,validBase64Data1");

    // Re-query All list — should now be empty of active items
    const listRes = await fetch(`${baseUrl}/owner/screenshot-inbox?status=all`);
    const listBody = await listRes.json();
    expect(listBody.entries.map((e: any) => e.id)).not.toContain(1);

    // Query Archived list — should now include 1
    const archListRes = await fetch(`${baseUrl}/owner/screenshot-inbox?status=archived`);
    const archListBody = await archListRes.json();
    expect(archListBody.entries.map((e: any) => e.id)).toContain(1);
  });

  it("4. Restoring an archived screenshot returns it to All and resets archived_at", async () => {
    // Screenshot 2 is currently archived with valid media
    const restoreRes = await fetch(`${baseUrl}/owner/screenshot-inbox/2/restore`, {
      method: "POST",
    });
    expect(restoreRes.status).toBe(200);
    const restoreBody = await restoreRes.json();
    expect(restoreBody.ok).toBe(true);
    expect(restoreBody.restored).toBe(true);

    const rec = mockInboxRecords.find((r) => r.id === 2);
    expect(rec?.archivedAt).toBeNull();
    // Bill association and media remain 100% intact
    expect(rec?.matchedBillId).toBe(202);
    expect(rec?.matchedSessionId).toBe(101);
    expect(rec?.screenshotData).toBe("data:image/jpeg;base64,validBase64Data2");

    // Re-query All list — 2 should now appear
    const listRes = await fetch(`${baseUrl}/owner/screenshot-inbox?status=all`);
    const listBody = await listRes.json();
    expect(listBody.entries.map((e: any) => e.id)).toContain(2);
  });

  it("5. Restoring an archived screenshot with expired media (purged) is rejected with 410", async () => {
    // Screenshot 3 has screenshotData: null
    const res = await fetch(`${baseUrl}/owner/screenshot-inbox/3/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/expired|retention policy/i);
  });

  it("6. Tenant isolation: Restaurant A cannot archive, restore, or view Restaurant B screenshots", async () => {
    // Screenshot 99 belongs to restaurant 999, caller is restaurant 42
    const archiveRes = await fetch(`${baseUrl}/owner/screenshot-inbox/99/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(404);

    const restoreRes = await fetch(`${baseUrl}/owner/screenshot-inbox/99/restore`, {
      method: "POST",
    });
    expect(restoreRes.status).toBe(404);

    const imageRes = await fetch(`${baseUrl}/owner/screenshot-inbox/99/image`);
    expect(imageRes.status).toBe(404);
  });

  it("7. Attaching or retrying an archived screenshot is rejected with 422", async () => {
    // Screenshot 2 is archived
    const attachRes = await fetch(`${baseUrl}/owner/screenshot-inbox/2/attach`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionBillId: 10 }),
    });
    expect(attachRes.status).toBe(422);
    const attachBody = await attachRes.json();
    expect(attachBody.error).toMatch(/Cannot attach an archived screenshot/i);

    const retryRes = await fetch(`${baseUrl}/owner/screenshot-inbox/2/retry-match`, {
      method: "POST",
    });
    expect(retryRes.status).toBe(422);
    const retryBody = await retryRes.json();
    expect(retryBody.error).toMatch(/Cannot retry matching on an archived screenshot/i);
  });

  it("8. Archive and restore operations are idempotent and safe to retry", async () => {
    // Screenshot 2 is already archived
    const archiveRes = await fetch(`${baseUrl}/owner/screenshot-inbox/2/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.alreadyArchived).toBe(true);

    // Screenshot 1 is active (not archived)
    const restoreRes = await fetch(`${baseUrl}/owner/screenshot-inbox/1/restore`, {
      method: "POST",
    });
    expect(restoreRes.status).toBe(200);
    const restoreBody = await restoreRes.json();
    expect(restoreBody.alreadyRestored).toBe(true);
  });

  it("9. View image succeeds for archived screenshot when media file is present", async () => {
    const res = await fetch(`${baseUrl}/owner/screenshot-inbox/2/image`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.screenshotData).toBe("data:image/jpeg;base64,validBase64Data2");
  });

  it("10. View image returns 410 when media file has expired", async () => {
    const res = await fetch(`${baseUrl}/owner/screenshot-inbox/3/image`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/retention policy/i);
  });
});
