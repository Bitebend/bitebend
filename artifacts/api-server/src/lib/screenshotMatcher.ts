import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";

import { db, sessionBills, tableSessions } from "@workspace/db";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionBillRow {
  id: number;
  sessionId: number;
  restaurantId: number;
  billNumber: string;

  subtotal: number;
  tax: number;
  total: number;

  status: string;

  customerPhone: string | null;

  sentAt: Date | null;

  screenshotUrl: string | null;
  screenshotReceivedAt: Date | null;

  verifiedAt: Date | null;
  verifiedBy: number | null;

  resentAt: Date | null;
  resentCount: number;

  senderPhone: string | null;
  phoneMismatch: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type MatchStrategy = "phone_match" | "phone_mismatch" | "single_pending";

export type UnmatchedReason =
  | "ambiguous_phone_multiple_bills"
  | "no_recent_pending_bills"
  | "multiple_pending_bills"
  | "no_sent_bill_to_match";

export type MatchDecision =
  | {
      action: "attach";
      bill: SessionBillRow;
      strategy: MatchStrategy;
      phoneMismatch: boolean;
      effectivePhone: string | null;
      needsAutoReply: boolean;
    }
  | {
      action: "discard";
      reason: UnmatchedReason;
      details: string;
      candidates: number;
    };

export interface DecideMatchInput {
  normalizedPhone: string | null;
  phoneCandidates: SessionBillRow[];
  recentPendingBills: SessionBillRow[];
}

export interface MatchSuccess {
  ok: true;
  sessionId: number;
  sessionBillId: number;
  tableNumber: string | number | null;
  billNumber: string;
  total: number;
  effectivePhone: string | null;
  strategy: MatchStrategy;
  phoneMismatch: boolean;
  needsAutoReply: boolean;
}

export interface MatchFailure {
  ok: false;
  reason: UnmatchedReason;
  candidates: number;
}

export type MatchOutcome = MatchSuccess | MatchFailure;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    return digits;
  }

  return null;
}

function toSessionBillRow(
  row: typeof sessionBills.$inferSelect,
): SessionBillRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    restaurantId: row.restaurantId,
    billNumber: row.billNumber,

    subtotal: Number(row.subtotal),
    tax: Number(row.tax),
    total: Number(row.total),

    status: row.status,

    customerPhone: row.customerPhone ?? null,

    sentAt: row.sentAt ?? null,

    screenshotUrl: row.screenshotUrl ?? null,
    screenshotReceivedAt: row.screenshotReceivedAt ?? null,

    verifiedAt: row.verifiedAt ?? null,
    verifiedBy: row.verifiedBy ?? null,

    resentAt: row.resentAt ?? null,
    resentCount: row.resentCount ?? 0,

    senderPhone: row.senderPhone ?? null,
    phoneMismatch: row.phoneMismatch ?? false,

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision function
// ─────────────────────────────────────────────────────────────────────────────

export function decideMatch(input: DecideMatchInput): MatchDecision {
  const { normalizedPhone, phoneCandidates, recentPendingBills } = input;

  // ──────────────────────────────────────────────────────────────────────────
  // P1 — Exact phone match
  // ──────────────────────────────────────────────────────────────────────────

  if (normalizedPhone !== null) {
    if (phoneCandidates.length === 1) {
      const bill = phoneCandidates[0]!;

      return {
        action: "attach",
        bill,
        strategy: "phone_match",
        phoneMismatch: false,
        effectivePhone: normalizedPhone,
        needsAutoReply: false,
      };
    }

    // Never guess when multiple bills belong to the same phone.
    if (phoneCandidates.length > 1) {
      return {
        action: "discard",
        reason: "ambiguous_phone_multiple_bills",
        details:
          `${phoneCandidates.length} sent bills match the customer phone; ` +
          "cannot assign the screenshot unambiguously.",
        candidates: phoneCandidates.length,
      };
    }

    // No phone match.
    //
    // Legacy safety fallback:
    // only use it when exactly one recent pending bill exists.
    if (recentPendingBills.length === 1) {
      const bill = recentPendingBills[0]!;

      return {
        action: "attach",
        bill,
        strategy: "phone_mismatch",
        phoneMismatch: true,
        effectivePhone: normalizedPhone,
        needsAutoReply: true,
      };
    }

    return {
      action: "discard",
      reason:
        recentPendingBills.length === 0
          ? "no_recent_pending_bills"
          : "multiple_pending_bills",
      details:
        recentPendingBills.length === 0
          ? "Phone did not match any sent bill and no recent pending bills exist."
          : `Phone did not match any sent bill and ${recentPendingBills.length} ` +
            "recent pending bills exist; cannot assign unambiguously.",
      candidates: recentPendingBills.length,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // P2 — Phone unavailable
  // ──────────────────────────────────────────────────────────────────────────

  if (recentPendingBills.length === 1) {
    const bill = recentPendingBills[0]!;

    return {
      action: "attach",
      bill,
      strategy: "single_pending",
      phoneMismatch: false,
      effectivePhone: bill.customerPhone ?? null,
      needsAutoReply: false,
    };
  }

  return {
    action: "discard",
    reason:
      recentPendingBills.length === 0
        ? "no_recent_pending_bills"
        : "multiple_pending_bills",
    details:
      recentPendingBills.length === 0
        ? "Phone could not be resolved and no recent pending bills exist."
        : `Phone could not be resolved and ${recentPendingBills.length} ` +
          "recent pending bills exist; cannot assign unambiguously.",
    candidates: recentPendingBills.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database matcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the safest session bill for an incoming WhatsApp payment screenshot
 * and attaches the screenshot to that bill.
 *
 * IMPORTANT:
 * - senderJid is intentionally NOT accepted here.
 * - session_bills currently has no chatJid column.
 * - Matching is therefore based on normalized phone + recent pending bills.
 *
 * The screenshot inbox itself is persisted by the webhook BEFORE this function
 * runs. Therefore a failed match does not lose the screenshot.
 */
export async function matchAndAttachScreenshot(params: {
  restaurantId: number;
  normalizedPhone: string | null;
  screenshotDataUrl: string;
  now: Date;
}): Promise<MatchOutcome> {
  const { restaurantId, normalizedPhone, screenshotDataUrl, now } = params;

  // ---------------------------------------------------------------------------
  // Only bills that are currently waiting for a screenshot are candidates.
  // ---------------------------------------------------------------------------

  const pendingStatuses = ["sent"] as const;

  // Keep the fallback deliberately recent.
  //
  // This prevents an old unpaid bill from accidentally receiving a screenshot
  // when the phone cannot be matched.
  const fallbackCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // P1 — Find bills matching the customer's normalized phone.
  // ---------------------------------------------------------------------------

  let phoneCandidates: SessionBillRow[] = [];

  if (normalizedPhone) {
    const rows = await db
      .select()
      .from(sessionBills)
      .where(
        and(
          eq(sessionBills.restaurantId, restaurantId),
          eq(sessionBills.status, "sent"),
          or(
            eq(sessionBills.customerPhone, normalizedPhone),
            eq(sessionBills.senderPhone, normalizedPhone),
          ),
          isNull(sessionBills.verifiedAt),
        ),
      )
      .orderBy(desc(sessionBills.sentAt))
      .limit(2);

    phoneCandidates = rows.map(toSessionBillRow);
  }

  // ---------------------------------------------------------------------------
  // P2 — Find recent pending bills for safe fallback.
  // ---------------------------------------------------------------------------

  const recentRows = await db
    .select()
    .from(sessionBills)
    .where(
      and(
        eq(sessionBills.restaurantId, restaurantId),
        eq(sessionBills.status, "sent"),
        gt(sessionBills.sentAt, fallbackCutoff),
        isNull(sessionBills.verifiedAt),
      ),
    )
    .orderBy(desc(sessionBills.sentAt))
    .limit(3);

  const recentPendingBills = recentRows.map(toSessionBillRow);

  // ---------------------------------------------------------------------------
  // Decide without guessing.
  // ---------------------------------------------------------------------------

  const decision = decideMatch({
    normalizedPhone,
    phoneCandidates,
    recentPendingBills,
  });

  if (decision.action === "discard") {
    return {
      ok: false,
      reason: decision.reason,
      candidates: decision.candidates,
    };
  }

  const bill = decision.bill;

  // ---------------------------------------------------------------------------
  // Attach screenshot to the selected session bill.
  // ---------------------------------------------------------------------------

  const screenshotReceivedAt = now;

  const updatedRows = await db
    .update(sessionBills)
    .set({
      screenshotUrl: screenshotDataUrl,
      screenshotReceivedAt,

      senderPhone: decision.effectivePhone,

      phoneMismatch: decision.phoneMismatch,

      status: "awaiting_verification",

      updatedAt: now,
    })
    .where(
      and(
        eq(sessionBills.id, bill.id),
        eq(sessionBills.restaurantId, restaurantId),
        eq(sessionBills.status, "sent"),
      ),
    )
    .returning();

  const updatedBill = updatedRows[0];

  // Another request may have claimed the bill between SELECT and UPDATE.
  // Fail closed instead of attaching the screenshot to an already-claimed bill.
  if (!updatedBill) {
    return {
      ok: false,
      reason: "no_sent_bill_to_match",
      candidates: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Resolve table number from the associated table session.
  // ---------------------------------------------------------------------------

  const [session] = await db
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.id, bill.sessionId),
        eq(tableSessions.restaurantId, restaurantId),
      ),
    )
    .limit(1);

  const tableNumber =
    session?.tableNumber !== undefined && session?.tableNumber !== null
      ? session.tableNumber
      : null;

  return {
    ok: true,

    sessionId: bill.sessionId,

    sessionBillId: bill.id,

    tableNumber,

    billNumber: bill.billNumber,

    total: bill.total,

    effectivePhone: decision.effectivePhone,

    strategy: decision.strategy,

    phoneMismatch: decision.phoneMismatch,

    needsAutoReply: decision.needsAutoReply,
  };
}
