import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { purgeExpiredScreenshots } from "../lib/screenshotCleanup.js";

interface MockInboxItem {
  id: number;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  screenshotData: string | null;
  archivedAt: Date | null;
  attachedAt: Date | null;
  matchedBillId: number | null;
  receivedAt: Date;
  updatedAt: Date;
}

interface MockSessionBill {
  id: number;
  billNumber: string;
  screenshotUrl: string | null;
  screenshotReceivedAt: Date | null;
  total: number;
  updatedAt: Date;
}

interface MockOrder {
  id: number;
  paymentScreenshotUrl: string | null;
  paymentStatus: string;
  paymentVerificationStatus: string;
  updatedAt: Date;
}

let mockInboxRecords: MockInboxItem[] = [];
let mockBills: MockSessionBill[] = [];
let mockOrders: MockOrder[] = [];

vi.mock("@workspace/db", () => {
  const makeCol = (name: string) => ({ _type: "col", name });
  return {
    paymentScreenshotInbox: {
      id: makeCol("id"),
      screenshotData: makeCol("screenshotData"),
      archivedAt: makeCol("archivedAt"),
      matchStatus: makeCol("matchStatus"),
      attachedAt: makeCol("attachedAt"),
      matchedBillId: makeCol("matchedBillId"),
      receivedAt: makeCol("receivedAt"),
      updatedAt: makeCol("updatedAt"),
      _tableName: "paymentScreenshotInbox",
    },
    sessionBills: {
      id: makeCol("id"),
      screenshotUrl: makeCol("screenshotUrl"),
      screenshotReceivedAt: makeCol("screenshotReceivedAt"),
      billNumber: makeCol("billNumber"),
      total: makeCol("total"),
      updatedAt: makeCol("updatedAt"),
      _tableName: "sessionBills",
    },
    orders: {
      id: makeCol("id"),
      paymentScreenshotUrl: makeCol("paymentScreenshotUrl"),
      paymentStatus: makeCol("paymentStatus"),
      paymentVerificationStatus: makeCol("paymentVerificationStatus"),
      updatedAt: makeCol("updatedAt"),
      _tableName: "orders",
    },
    db: {
      execute: vi.fn(async () => [{ locked: true }]),
      update: vi.fn((table: any) => ({
        set: (values: any) => ({
          where: (condition: any) => ({
            returning: async () => {
              const tableName = table._tableName || table;
              const matches: { id: number }[] = [];

              if (tableName === "paymentScreenshotInbox") {
                for (const row of mockInboxRecords) {
                  if (condition && condition(row)) {
                    if ("screenshotData" in values) {
                      row.screenshotData = values.screenshotData;
                    }
                    if ("updatedAt" in values) {
                      row.updatedAt = values.updatedAt;
                    }
                    matches.push({ id: row.id });
                  }
                }
              } else if (tableName === "sessionBills") {
                for (const row of mockBills) {
                  if (condition && condition(row)) {
                    if ("screenshotUrl" in values) {
                      row.screenshotUrl = values.screenshotUrl;
                    }
                    if ("updatedAt" in values) {
                      row.updatedAt = values.updatedAt;
                    }
                    matches.push({ id: row.id });
                  }
                }
              } else if (tableName === "orders") {
                for (const row of mockOrders) {
                  if (condition && condition(row)) {
                    if ("paymentScreenshotUrl" in values) {
                      row.paymentScreenshotUrl = values.paymentScreenshotUrl;
                    }
                    matches.push({ id: row.id });
                  }
                }
              }

              return matches;
            },
          }),
        }),
      })),
    },
  };
});

vi.mock("drizzle-orm", () => {
  return {
    sql: vi.fn(),
    eq: (column: any, val: any) => (row: any) => {
      const colName = column?.name || column;
      return row[colName] === val;
    },
    isNotNull: (column: any) => (row: any) => {
      const colName = column?.name || column;
      return row[colName] !== null && row[colName] !== undefined;
    },
    isNull: (column: any) => (row: any) => {
      const colName = column?.name || column;
      return row[colName] === null || row[colName] === undefined;
    },
    lte: (column: any, cutoff: Date) => (row: any) => {
      const colName = column?.name || column;
      const rawVal = row[colName];
      if (!rawVal) return false;
      const t = rawVal instanceof Date ? rawVal.getTime() : new Date(rawVal).getTime();
      return t <= cutoff.getTime();
    },
    and: (...conditions: any[]) => (row: any) =>
      conditions.every((cond) => (typeof cond === "function" ? cond(row) : Boolean(cond))),
    or: (...conditions: any[]) => (row: any) =>
      conditions.some((cond) => (typeof cond === "function" ? cond(row) : Boolean(cond))),
  };
});

describe("purgeExpiredScreenshots Media Retention (24-Hour and 30-Day policies)", () => {
  const referenceNow = new Date("2026-10-12T12:00:00.000Z");
  const exactly24HoursAgo = new Date("2026-10-11T12:00:00.000Z");
  const olderThan24Hours = new Date("2026-10-11T11:59:59.000Z");
  const lessThan24Hours = new Date("2026-10-11T12:00:01.000Z");

  const olderThan30Days = new Date("2026-09-10T12:00:00.000Z");
  const lessThan30Days = new Date("2026-10-01T12:00:00.000Z");

  beforeEach(() => {
    mockInboxRecords = [
      // 1: Archived >= 24h -> MUST PURGE media
      {
        id: 1,
        matchStatus: "unmatched",
        screenshotData: "data:image/jpeg;base64,archivedExpired",
        archivedAt: olderThan24Hours,
        attachedAt: null,
        matchedBillId: null,
        receivedAt: olderThan24Hours,
        updatedAt: olderThan24Hours,
      },
      // 2: Archived boundary exactly 24h -> MUST PURGE media
      {
        id: 2,
        matchStatus: "unmatched",
        screenshotData: "data:image/jpeg;base64,archivedBoundary",
        archivedAt: exactly24HoursAgo,
        attachedAt: null,
        matchedBillId: null,
        receivedAt: exactly24HoursAgo,
        updatedAt: exactly24HoursAgo,
      },
      // 3: Archived < 24h -> MUST RETAIN media
      {
        id: 3,
        matchStatus: "unmatched",
        screenshotData: "data:image/jpeg;base64,archivedFresh",
        archivedAt: lessThan24Hours,
        attachedAt: null,
        matchedBillId: null,
        receivedAt: lessThan24Hours,
        updatedAt: lessThan24Hours,
      },
      // 4: Successfully attached (attachedAt >= 24h) -> MUST PURGE media
      {
        id: 4,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,attachedExpired",
        archivedAt: null,
        attachedAt: olderThan24Hours,
        matchedBillId: 101,
        receivedAt: olderThan24Hours,
        updatedAt: olderThan24Hours,
      },
      // 5: Successfully attached boundary exactly 24h -> MUST PURGE media
      {
        id: 5,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,attachedBoundary",
        archivedAt: null,
        attachedAt: exactly24HoursAgo,
        matchedBillId: 102,
        receivedAt: exactly24HoursAgo,
        updatedAt: exactly24HoursAgo,
      },
      // 6: Successfully attached < 24h -> MUST RETAIN media
      {
        id: 6,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,attachedFresh",
        archivedAt: null,
        attachedAt: lessThan24Hours,
        matchedBillId: 103,
        receivedAt: lessThan24Hours,
        updatedAt: lessThan24Hours,
      },
      // 7: Matched but NOT attached (unmatched/ambiguous fresh < 30 days) -> MUST RETAIN media
      {
        id: 7,
        matchStatus: "unmatched",
        screenshotData: "data:image/jpeg;base64,unmatchedFresh",
        archivedAt: null,
        attachedAt: null,
        matchedBillId: null,
        receivedAt: lessThan30Days,
        updatedAt: lessThan30Days,
      },
      // 8: Unmatched > 30 days -> MUST PURGE media under 30d policy
      {
        id: 8,
        matchStatus: "unmatched",
        screenshotData: "data:image/jpeg;base64,unmatchedExpired",
        archivedAt: null,
        attachedAt: null,
        matchedBillId: null,
        receivedAt: olderThan30Days,
        updatedAt: olderThan30Days,
      },
      // 9: Legacy matched record with attachedAt = NULL and old updatedAt (> 24h) -> MUST NOT BE DELETED by attached rule
      {
        id: 9,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,legacyMatchedNoAttachedAt",
        archivedAt: null,
        attachedAt: null,
        matchedBillId: 104,
        receivedAt: lessThan30Days,
        updatedAt: olderThan24Hours,
      },
      // 10: Legacy matched record with attachedAt = NULL but archivedAt >= 24h -> MUST BE DELETED by independent archive rule
      {
        id: 10,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,legacyMatchedArchivedOld",
        archivedAt: olderThan24Hours,
        attachedAt: null,
        matchedBillId: 105,
        receivedAt: lessThan30Days,
        updatedAt: olderThan24Hours,
      },
    ];

    mockBills = [
      // Bill 1: screenshotReceivedAt >= 24h -> MUST PURGE media
      {
        id: 201,
        billNumber: "BILL-201",
        screenshotUrl: "data:image/jpeg;base64,billExpiredMedia",
        screenshotReceivedAt: olderThan24Hours,
        total: 550,
        updatedAt: olderThan24Hours,
      },
      // Bill 2: screenshotReceivedAt < 24h -> MUST RETAIN media
      {
        id: 202,
        billNumber: "BILL-202",
        screenshotUrl: "data:image/jpeg;base64,billFreshMedia",
        screenshotReceivedAt: lessThan24Hours,
        total: 820,
        updatedAt: lessThan24Hours,
      },
    ];

    mockOrders = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Permanently purges archived screenshot media at and past the 24-hour cutoff", async () => {
    const result = await purgeExpiredScreenshots(referenceNow);

    // IDs 1, 2, and 10 (which is archived >= 24h even though attachedAt is null)
    expect(result.archivedInboxPurged).toBe(3);
    expect(mockInboxRecords.find((r) => r.id === 1)?.screenshotData).toBeNull();
    expect(mockInboxRecords.find((r) => r.id === 2)?.screenshotData).toBeNull();
    expect(mockInboxRecords.find((r) => r.id === 10)?.screenshotData).toBeNull();

    // Fresh archived screenshot (< 24h) media must NOT be purged
    expect(mockInboxRecords.find((r) => r.id === 3)?.screenshotData).toBe(
      "data:image/jpeg;base64,archivedFresh",
    );
    // Non-media metadata must be preserved
    const archived1 = mockInboxRecords.find((r) => r.id === 1);
    expect(archived1?.archivedAt).not.toBeNull();
    expect(archived1?.matchStatus).toBe("unmatched");
  });

  it("2. Permanently purges attached screenshot media at and past 24 hours from attachedAt", async () => {
    const result = await purgeExpiredScreenshots(referenceNow);

    expect(result.attachedInboxPurged).toBe(2); // IDs 4 and 5
    expect(mockInboxRecords.find((r) => r.id === 4)?.screenshotData).toBeNull();
    expect(mockInboxRecords.find((r) => r.id === 5)?.screenshotData).toBeNull();

    // Fresh attached screenshot (< 24h) must NOT be purged
    expect(mockInboxRecords.find((r) => r.id === 6)?.screenshotData).toBe(
      "data:image/jpeg;base64,attachedFresh",
    );
    // Associated bill reference and metadata must be preserved
    const attached4 = mockInboxRecords.find((r) => r.id === 4);
    expect(attached4?.matchedBillId).toBe(101);
    expect(attached4?.matchStatus).toBe("matched");
    expect(attached4?.attachedAt).not.toBeNull();
  });

  it("3. Does NOT purge matched record with attachedAt = NULL merely because updatedAt is > 24 hours", async () => {
    const result = await purgeExpiredScreenshots(referenceNow);

    const legacyRecord = mockInboxRecords.find((r) => r.id === 9);
    expect(legacyRecord?.screenshotData).toBe("data:image/jpeg;base64,legacyMatchedNoAttachedAt");
    expect(legacyRecord?.matchStatus).toBe("matched");
    expect(legacyRecord?.matchedBillId).toBe(104);
  });

  it("4. Legacy record with attachedAt = NULL CAN still be deleted by independent archive rule when archivedAt >= 24h", async () => {
    await purgeExpiredScreenshots(referenceNow);

    const legacyArchivedRecord = mockInboxRecords.find((r) => r.id === 10);
    expect(legacyArchivedRecord?.screenshotData).toBeNull();
    expect(legacyArchivedRecord?.matchStatus).toBe("matched");
    expect(legacyArchivedRecord?.matchedBillId).toBe(105);
    expect(legacyArchivedRecord?.archivedAt).toEqual(olderThan24Hours);
  });

  it("5. Permanently purges sessionBills screenshotUrl 24 hours after screenshotReceivedAt", async () => {
    const result = await purgeExpiredScreenshots(referenceNow);

    expect(result.attachedBillsPurged).toBe(1); // Bill 201
    expect(mockBills.find((b) => b.id === 201)?.screenshotUrl).toBeNull();
    // Bill total, number and business metadata preserved
    expect(mockBills.find((b) => b.id === 201)?.billNumber).toBe("BILL-201");
    expect(mockBills.find((b) => b.id === 201)?.total).toBe(550);
    expect(mockBills.find((b) => b.id === 201)?.screenshotReceivedAt).not.toBeNull();

    // Fresh bill (< 24h) media must NOT be purged
    expect(mockBills.find((b) => b.id === 202)?.screenshotUrl).toBe(
      "data:image/jpeg;base64,billFreshMedia",
    );
  });

  it("6. Idempotency: Running purge multiple times yields 0 additional deletions", async () => {
    const firstRun = await purgeExpiredScreenshots(referenceNow);
    expect(firstRun.totalMediaPurged).toBeGreaterThan(0);

    const secondRun = await purgeExpiredScreenshots(referenceNow);
    expect(secondRun.archivedInboxPurged).toBe(0);
    expect(secondRun.attachedInboxPurged).toBe(0);
    expect(secondRun.attachedBillsPurged).toBe(0);
    expect(secondRun.unattachedInboxPurged).toBe(0);
    expect(secondRun.totalMediaPurged).toBe(0);
  });

  it("7. Boundary condition: Exactly 23h 59m 59s does NOT delete media", async () => {
    const justBeforeCutoff = new Date("2026-10-11T12:00:01.000Z");
    mockInboxRecords = [
      {
        id: 99,
        matchStatus: "matched",
        screenshotData: "data:image/jpeg;base64,boundaryFresh",
        archivedAt: null,
        attachedAt: justBeforeCutoff,
        matchedBillId: 999,
        receivedAt: justBeforeCutoff,
        updatedAt: justBeforeCutoff,
      },
    ];

    const result = await purgeExpiredScreenshots(referenceNow);
    expect(result.attachedInboxPurged).toBe(0);
    expect(mockInboxRecords[0].screenshotData).toBe("data:image/jpeg;base64,boundaryFresh");
  });

  it("8. Preserves 30-day legacy retention behavior for unmatched/ambiguous screenshots", async () => {
    const result = await purgeExpiredScreenshots(referenceNow);

    // ID 8 was received > 30 days ago and is unmatched -> purged
    expect(result.unattachedInboxPurged).toBe(1);
    expect(mockInboxRecords.find((r) => r.id === 8)?.screenshotData).toBeNull();
    // ID 7 was received < 30 days ago and is unmatched -> retained
    expect(mockInboxRecords.find((r) => r.id === 7)?.screenshotData).toBe(
      "data:image/jpeg;base64,unmatchedFresh",
    );
  });
});
