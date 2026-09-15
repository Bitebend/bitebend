import { db } from "@workspace/db";
import {
  partners,
  partnerCommissions,
  restaurants,
  subscriptionTransactions,
} from "@workspace/db";
import { eq } from "drizzle-orm";

export interface CommissionResult {
  created: boolean;
  commissionId?: number;
  reason?: string;
  commissionAmount?: number;
  commissionRate?: number;
}

/**
 * Centrally and idempotently records a partner commission for a paid subscription transaction.
 *
 * Requirements:
 * - Transaction must exist and be in "paid" status.
 * - Restaurant must have a valid partnerId.
 * - Partner must exist and be active (not suspended).
 * - Commission percentage is read at transaction execution time and stored as an immutable snapshot.
 * - Unique constraint on subscription_transaction_id ensures exactly 1 commission per transaction,
 *   even under concurrent webhook / verification retries.
 */
export async function recordPartnerCommission(
  subscriptionTransactionId: number
): Promise<CommissionResult> {
  if (!subscriptionTransactionId || isNaN(subscriptionTransactionId)) {
    return { created: false, reason: "invalid_transaction_id" };
  }

  try {
    // 1. Load subscription transaction
    const [txn] = await db
      .select()
      .from(subscriptionTransactions)
      .where(eq(subscriptionTransactions.id, subscriptionTransactionId))
      .limit(1);

    if (!txn) {
      return { created: false, reason: "transaction_not_found" };
    }

    if (txn.status !== "paid") {
      return { created: false, reason: "transaction_not_paid" };
    }

    // 2. Load restaurant
    const [restaurant] = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, txn.restaurantId))
      .limit(1);

    if (!restaurant) {
      return { created: false, reason: "restaurant_not_found" };
    }

    if (!restaurant.partnerId) {
      return { created: false, reason: "no_partner_attributed" };
    }

    // 3. Load partner
    const [partner] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, restaurant.partnerId))
      .limit(1);

    if (!partner) {
      return { created: false, reason: "partner_not_found" };
    }

    // Business rule: only active partners can earn new commissions, attribution remains intact
    if (partner.status !== "active") {
      return { created: false, reason: "partner_not_active" };
    }

    // 4. Check existing commission (idempotency check)
    const [existing] = await db
      .select()
      .from(partnerCommissions)
      .where(
        eq(
          partnerCommissions.subscriptionTransactionId,
          subscriptionTransactionId
        )
      )
      .limit(1);

    if (existing) {
      return {
        created: false,
        commissionId: existing.id,
        reason: "already_recorded",
        commissionAmount: existing.commissionAmount,
        commissionRate: existing.commissionRate,
      };
    }

    // 5. Compute snapshot commission amount
    const rate = Math.max(0, Math.min(100, partner.commissionPercentage || 10.0));
    const amount = Math.round(txn.amount * (rate / 100) * 100) / 100;

    // 6. Insert commission record with DB-level idempotency protection
    try {
      const [commission] = await db
        .insert(partnerCommissions)
        .values({
          partnerId: partner.id,
          restaurantId: restaurant.id,
          subscriptionTransactionId: txn.id,
          transactionAmount: txn.amount,
          commissionRate: rate,
          commissionAmount: amount,
          currency: "INR",
          status: "pending",
        })
        .returning();

      return {
        created: true,
        commissionId: commission.id,
        commissionAmount: amount,
        commissionRate: rate,
      };
    } catch (err: any) {
      // Catch unique violation (code 23505) in case of racing requests
      const pgCode =
        err?.code ??
        err?.cause?.code;
      if (pgCode === "23505") {
        const [existingRace] = await db
          .select()
          .from(partnerCommissions)
          .where(
            eq(
              partnerCommissions.subscriptionTransactionId,
              subscriptionTransactionId
            )
          )
          .limit(1);
        return {
          created: false,
          commissionId: existingRace?.id,
          reason: "already_recorded",
          commissionAmount: existingRace?.commissionAmount,
          commissionRate: existingRace?.commissionRate,
        };
      }
      throw err;
    }
  } catch (error: any) {
    console.error("[CommissionEngine] Error recording partner commission:", error?.message || error);
    return { created: false, reason: "internal_error" };
  }
}
