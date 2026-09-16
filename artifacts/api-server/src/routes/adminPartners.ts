import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  users,
  partners,
  partnerCommissions,
  partnerAuditLogs,
  restaurants,
  subscriptionTransactions,
  subscriptionPlans,
} from "@workspace/db";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import type { RequestHandler } from "express";

const router = Router();

// Helper to generate a clean, unique BBP-XXXXXX referral code (authoritative server-side)
export async function generateUniqueBbpReferralCode(): Promise<string> {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // skip confusing chars (0, 1, I, O)
  for (let attempt = 0; attempt < 25; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) {
      const idx = crypto.randomInt(0, chars.length);
      suffix += chars[idx];
    }
    const code = `BBP-${suffix}`;
    const [existing] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.referralCode, code))
      .limit(1);
    if (!existing) return code;
  }
  return `BBP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

// ── GET /api/admin/partners ──────────────────────────────────────────────────
// List all partners with aggregate statistics and login credentials info
const listPartnersAdmin: RequestHandler = async (_req, res) => {
  try {
    const allPartners = await db
      .select({
        id: partners.id,
        userId: partners.userId,
        name: partners.name,
        email: partners.email,
        phone: partners.phone,
        state: partners.state,
        city: partners.city,
        referralCode: partners.referralCode,
        commissionPercentage: partners.commissionPercentage,
        status: partners.status,
        payoutDetails: partners.payoutDetails,
        createdAt: partners.createdAt,
        updatedAt: partners.updatedAt,
        tempPassword: users.tempPassword,
      })
      .from(partners)
      .leftJoin(users, eq(partners.userId, users.id))
      .orderBy(desc(partners.createdAt));

    if (allPartners.length === 0) {
      res.json([]);
      return;
    }

    const partnerIds = allPartners.map((p) => p.id);

    // Restaurant counts per partner
    const restCounts = await db
      .select({
        partnerId: restaurants.partnerId,
        count: sql<number>`count(*)::int`,
      })
      .from(restaurants)
      .where(inArray(restaurants.partnerId, partnerIds))
      .groupBy(restaurants.partnerId);

    const restCountMap = new Map(restCounts.map((r) => [r.partnerId!, r.count]));

    // Commissions aggregates per partner
    const commStats = await db
      .select({
        partnerId: partnerCommissions.partnerId,
        totalEarned: sql<number>`coalesce(sum(case when status in ('pending', 'approved', 'paid') then commission_amount else 0 end), 0)::float8`,
        totalPending: sql<number>`coalesce(sum(case when status = 'pending' then commission_amount else 0 end), 0)::float8`,
        totalApproved: sql<number>`coalesce(sum(case when status = 'approved' then commission_amount else 0 end), 0)::float8`,
        totalPaid: sql<number>`coalesce(sum(case when status = 'paid' then commission_amount else 0 end), 0)::float8`,
      })
      .from(partnerCommissions)
      .where(inArray(partnerCommissions.partnerId, partnerIds))
      .groupBy(partnerCommissions.partnerId);

    const commMap = new Map(commStats.map((c) => [c.partnerId, c]));

    const result = allPartners.map((p) => {
      const stats = commMap.get(p.id) || {
        totalEarned: 0,
        totalPending: 0,
        totalApproved: 0,
        totalPaid: 0,
      };
      return {
        ...p,
        totalRestaurants: restCountMap.get(p.id) ?? 0,
        totalEarned: stats.totalEarned,
        totalPending: stats.totalPending,
        totalApproved: stats.totalApproved,
        totalPaid: stats.totalPaid,
      };
    });

    res.json(result);
  } catch (error: any) {
    console.error("[AdminPartners] List error:", error);
    res.status(500).json({ error: "Failed to fetch partners" });
  }
};

// ── POST /api/admin/partners ─────────────────────────────────────────────────
// Create a new partner account
const createPartnerAdmin: RequestHandler = async (req, res) => {
  const adminUser = req.user!;
  const {
    name,
    email,
    password,
    phone,
    state,
    city,
    referralCode,
    commissionPercentage,
    payoutDetails,
  } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    phone?: string;
    state?: string;
    city?: string;
    referralCode?: string;
    commissionPercentage?: number;
    payoutDetails?: any;
  };

  if (!name?.trim() || !email?.trim() || !phone?.trim() || !password?.trim()) {
    res.status(400).json({ error: "Name, email, phone, and password are required" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check email collision in users table
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingUser) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }

  // Generate or sanitize referral code
  let finalRefCode = (referralCode?.trim().toUpperCase() || "").replace(/[^A-Z0-9_-]/g, "");
  if (!finalRefCode) {
    finalRefCode = await generateUniqueBbpReferralCode();
  } else {
    // Check referral code collision
    const [existingCode] = await db
      .select()
      .from(partners)
      .where(eq(partners.referralCode, finalRefCode))
      .limit(1);

    if (existingCode) {
      res.status(409).json({ error: "Referral code already exists. Please choose another or leave empty to auto-generate." });
      return;
    }
  }

  const commissionRate = typeof commissionPercentage === "number" && !isNaN(commissionPercentage)
    ? Math.max(0, Math.min(100, commissionPercentage))
    : 10.0;

  const passwordHash = await bcrypt.hash(password.trim(), 10);

  // Create user
  const [newUser] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      tempPassword: password.trim(),
      role: "partner",
    })
    .returning();

  // Create partner profile
  const [newPartner] = await db
    .insert(partners)
    .values({
      userId: newUser.id,
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      state: state?.trim() || null,
      city: city?.trim() || null,
      referralCode: finalRefCode,
      commissionPercentage: commissionRate,
      status: "active",
      payoutDetails: payoutDetails || null,
    })
    .returning();

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId: newPartner.id,
    action: "create_partner",
    performedBy: adminUser.id,
    details: {
      partnerId: newPartner.id,
      name: newPartner.name,
      email: newPartner.email,
      state: newPartner.state,
      city: newPartner.city,
      referralCode: finalRefCode,
      commissionPercentage: commissionRate,
    },
  });

  res.status(201).json(newPartner);
};

// ── GET /api/admin/partners/:id ──────────────────────────────────────────────
// Get partner details, attributed restaurants, and commission ledger
const getPartnerAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const [partner] = await db
    .select({
      id: partners.id,
      userId: partners.userId,
      name: partners.name,
      email: partners.email,
      phone: partners.phone,
      state: partners.state,
      city: partners.city,
      referralCode: partners.referralCode,
      commissionPercentage: partners.commissionPercentage,
      status: partners.status,
      payoutDetails: partners.payoutDetails,
      createdAt: partners.createdAt,
      updatedAt: partners.updatedAt,
      tempPassword: users.tempPassword,
    })
    .from(partners)
    .leftJoin(users, eq(partners.userId, users.id))
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  // Attributed restaurants
  const attributedRestaurants = await db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      slug: restaurants.slug,
      phone: restaurants.phone,
      email: restaurants.email,
      city: restaurants.city,
      subscriptionStatus: restaurants.subscriptionStatus,
      subscriptionPlan: restaurants.subscriptionPlan,
      planId: restaurants.planId,
      createdAt: restaurants.createdAt,
    })
    .from(restaurants)
    .where(eq(restaurants.partnerId, partnerId))
    .orderBy(desc(restaurants.createdAt));

  // Commission ledger
  const commissions = await db
    .select({
      id: partnerCommissions.id,
      partnerId: partnerCommissions.partnerId,
      restaurantId: partnerCommissions.restaurantId,
      restaurantName: restaurants.name,
      subscriptionTransactionId: partnerCommissions.subscriptionTransactionId,
      transactionAmount: partnerCommissions.transactionAmount,
      commissionRate: partnerCommissions.commissionRate,
      commissionAmount: partnerCommissions.commissionAmount,
      currency: partnerCommissions.currency,
      status: partnerCommissions.status,
      payoutReference: partnerCommissions.payoutReference,
      paidAt: partnerCommissions.paidAt,
      notes: partnerCommissions.notes,
      createdAt: partnerCommissions.createdAt,
      updatedAt: partnerCommissions.updatedAt,
    })
    .from(partnerCommissions)
    .leftJoin(restaurants, eq(partnerCommissions.restaurantId, restaurants.id))
    .where(eq(partnerCommissions.partnerId, partnerId))
    .orderBy(desc(partnerCommissions.createdAt));

  // Compute summary stats
  const totalEarned = commissions.reduce((sum, c) => sum + (c.status !== "cancelled" ? c.commissionAmount : 0), 0);
  const totalPending = commissions.reduce((sum, c) => sum + (c.status === "pending" ? c.commissionAmount : 0), 0);
  const totalApproved = commissions.reduce((sum, c) => sum + (c.status === "approved" ? c.commissionAmount : 0), 0);
  const totalPaid = commissions.reduce((sum, c) => sum + (c.status === "paid" ? c.commissionAmount : 0), 0);

  res.json({
    partner,
    restaurants: attributedRestaurants,
    commissions,
    stats: {
      totalRestaurants: attributedRestaurants.length,
      totalEarned,
      totalPending,
      totalApproved,
      totalPaid,
    },
  });
};

// ── PUT /api/admin/partners/:id ──────────────────────────────────────────────
// Update partner profile, commission percentage, or status
const updatePartnerAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  const {
    name,
    phone,
    state,
    city,
    referralCode,
    commissionPercentage,
    status,
    payoutDetails,
  } = req.body as {
    name?: string;
    phone?: string;
    state?: string;
    city?: string;
    referralCode?: string;
    commissionPercentage?: number;
    status?: "active" | "suspended";
    payoutDetails?: any;
  };

  const updates: Partial<typeof partners.$inferInsert> = {};

  if (name?.trim()) updates.name = name.trim();
  if (phone?.trim()) updates.phone = phone.trim();
  if (state !== undefined) updates.state = state?.trim() || null;
  if (city !== undefined) updates.city = city?.trim() || null;
  if (status === "active" || status === "suspended") updates.status = status;
  if (typeof commissionPercentage === "number" && !isNaN(commissionPercentage)) {
    updates.commissionPercentage = Math.max(0, Math.min(100, commissionPercentage));
  }
  if (payoutDetails !== undefined) {
    updates.payoutDetails = payoutDetails;
  }

  if (referralCode?.trim() && referralCode.trim().toUpperCase() !== existing.referralCode) {
    const cleanCode = referralCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const [codeCollision] = await db
      .select()
      .from(partners)
      .where(eq(partners.referralCode, cleanCode))
      .limit(1);

    if (codeCollision && codeCollision.id !== partnerId) {
      res.status(409).json({ error: "Referral code is already taken by another partner" });
      return;
    }
    updates.referralCode = cleanCode;
  }

  updates.updatedAt = new Date();

  const [updated] = await db
    .update(partners)
    .set(updates)
    .where(eq(partners.id, partnerId))
    .returning();

  // If name updated, also sync user name
  if (name?.trim()) {
    await db.update(users).set({ name: name.trim() }).where(eq(users.id, existing.userId));
  }

  // Audit log
  const isCommissionUpdated =
    updates.commissionPercentage !== undefined &&
    updates.commissionPercentage !== existing.commissionPercentage;

  if (isCommissionUpdated) {
    await db.insert(partnerAuditLogs).values({
      partnerId,
      action: "update_commission_percentage",
      performedBy: adminUser.id,
      details: {
        previousCommissionPercentage: existing.commissionPercentage,
        newCommissionPercentage: updated.commissionPercentage,
        partnerId,
        partnerName: updated.name,
        adminId: adminUser.id,
        timestamp: new Date().toISOString(),
      },
    });
  }

  await db.insert(partnerAuditLogs).values({
    partnerId,
    action: "update_partner",
    performedBy: adminUser.id,
    details: {
      before: existing,
      after: updated,
    },
  });

  res.json(updated);
};

// ── POST /api/admin/partners/:id/toggle-status ───────────────────────────────
const togglePartnerStatusAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  const nextStatus = existing.status === "active" ? "suspended" : "active";

  const [updated] = await db
    .update(partners)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(partners.id, partnerId))
    .returning();

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId,
    action: nextStatus === "active" ? "activate_partner" : "suspend_partner",
    performedBy: adminUser.id,
    details: {
      previousStatus: existing.status,
      newStatus: nextStatus,
    },
  });

  res.json(updated);
};

// ── POST /api/admin/partners/:id/approve ─────────────────────────────────────
// Super Admin approves partner application, auto-generating unique BBP-XXXXXX code
const approvePartnerAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  const { commissionPercentage } = req.body as { commissionPercentage?: number };

  // Generate unique BBP-XXXXXX code if partner doesn't have one
  let referralCode = existing.referralCode;
  if (!referralCode || !referralCode.trim()) {
    referralCode = await generateUniqueBbpReferralCode();
  }

  const updates: Partial<typeof partners.$inferInsert> = {
    status: "active",
    referralCode,
    updatedAt: new Date(),
  };

  if (typeof commissionPercentage === "number" && !isNaN(commissionPercentage)) {
    updates.commissionPercentage = Math.max(0, Math.min(100, commissionPercentage));
  }

  const [updated] = await db
    .update(partners)
    .set(updates)
    .where(eq(partners.id, partnerId))
    .returning();

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId,
    action: "partner_approved",
    performedBy: adminUser.id,
    details: {
      partnerId,
      name: updated.name,
      email: updated.email,
      referralCode: updated.referralCode,
      commissionPercentage: updated.commissionPercentage,
      previousStatus: existing.status,
    },
  });

  res.json(updated);
};

// ── POST /api/admin/partners/:id/reject ──────────────────────────────────────
// Super Admin rejects partner application
const rejectPartnerAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  const { reason } = req.body as { reason?: string };

  const [updated] = await db
    .update(partners)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(partners.id, partnerId))
    .returning();

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId,
    action: "partner_rejected",
    performedBy: adminUser.id,
    details: {
      partnerId,
      name: updated.name,
      email: updated.email,
      reason: reason || null,
      previousStatus: existing.status,
    },
  });

  res.json(updated);
};

// ── POST /api/admin/partners/:id/reset-password ──────────────────────────────
const resetPartnerPasswordAdmin: RequestHandler = async (req, res) => {
  const partnerId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  if (isNaN(partnerId)) {
    res.status(400).json({ error: "Invalid partner ID" });
    return;
  }

  const { customPassword } = req.body as { customPassword?: string };

  const [partner] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!partner) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  let newPassword = "";
  if (customPassword && customPassword.trim().length >= 6) {
    newPassword = customPassword.trim();
  } else {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    const rand = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    newPassword = rand(4) + "-" + rand(4) + "-" + rand(4);
  }

  const hash = await bcrypt.hash(newPassword, 10);

  await db
    .update(users)
    .set({ passwordHash: hash, tempPassword: newPassword })
    .where(eq(users.id, partner.userId));

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId,
    action: "reset_partner_password",
    performedBy: adminUser.id,
    details: { email: partner.email, isCustom: Boolean(customPassword) },
  });

  res.json({ success: true, email: partner.email, tempPassword: newPassword });
};

// ── GET /api/admin/commissions ───────────────────────────────────────────────
// List all commissions across the system with filters
const listAllCommissionsAdmin: RequestHandler = async (req, res) => {
  try {
    const { partnerId, status, restaurantId } = req.query as {
      partnerId?: string;
      status?: string;
      restaurantId?: string;
    };

    let query = db
      .select({
        id: partnerCommissions.id,
        partnerId: partnerCommissions.partnerId,
        partnerName: partners.name,
        partnerEmail: partners.email,
        partnerReferralCode: partners.referralCode,
        partnerPayoutDetails: partners.payoutDetails,
        restaurantId: partnerCommissions.restaurantId,
        restaurantName: restaurants.name,
        subscriptionTransactionId: partnerCommissions.subscriptionTransactionId,
        transactionAmount: partnerCommissions.transactionAmount,
        commissionRate: partnerCommissions.commissionRate,
        commissionAmount: partnerCommissions.commissionAmount,
        currency: partnerCommissions.currency,
        status: partnerCommissions.status,
        payoutReference: partnerCommissions.payoutReference,
        paidAt: partnerCommissions.paidAt,
        notes: partnerCommissions.notes,
        createdAt: partnerCommissions.createdAt,
        updatedAt: partnerCommissions.updatedAt,
      })
      .from(partnerCommissions)
      .leftJoin(partners, eq(partnerCommissions.partnerId, partners.id))
      .leftJoin(restaurants, eq(partnerCommissions.restaurantId, restaurants.id))
      .orderBy(desc(partnerCommissions.createdAt))
      .$dynamic();

    const conditions = [];
    if (partnerId && !isNaN(parseInt(partnerId))) {
      conditions.push(eq(partnerCommissions.partnerId, parseInt(partnerId)));
    }
    if (restaurantId && !isNaN(parseInt(restaurantId))) {
      conditions.push(eq(partnerCommissions.restaurantId, parseInt(restaurantId)));
    }
    if (status && ["pending", "approved", "paid", "cancelled"].includes(status)) {
      conditions.push(eq(partnerCommissions.status, status as any));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query.limit(300);
    res.json(rows);
  } catch (error: any) {
    console.error("[AdminCommissions] List error:", error);
    res.status(500).json({ error: "Failed to list commissions" });
  }
};

// ── POST /api/admin/commissions/:id/status ───────────────────────────────────
// Admin controls commission payout lifecycle (approve, mark paid, cancel)
const updateCommissionStatusAdmin: RequestHandler = async (req, res) => {
  const commissionId = parseInt(String(req.params.id));
  const adminUser = req.user!;
  const { status, payoutReference, notes } = req.body as {
    status?: "pending" | "approved" | "paid" | "cancelled";
    payoutReference?: string;
    notes?: string;
  };

  if (isNaN(commissionId)) {
    res.status(400).json({ error: "Invalid commission ID" });
    return;
  }

  if (!status || !["pending", "approved", "paid", "cancelled"].includes(status)) {
    res.status(400).json({ error: "Invalid status. Allowed: pending, approved, paid, cancelled" });
    return;
  }

  const [existing] = await db
    .select()
    .from(partnerCommissions)
    .where(eq(partnerCommissions.id, commissionId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Commission not found" });
    return;
  }

  const updates: Partial<typeof partnerCommissions.$inferInsert> = {
    status,
    updatedAt: new Date(),
  };

  if (status === "paid") {
    updates.paidAt = new Date();
    if (payoutReference?.trim()) {
      updates.payoutReference = payoutReference.trim();
    }
  } else if (status === "pending" || status === "approved") {
    // If transitioning back
    if (existing.status === "paid") {
      updates.paidAt = null;
    }
  }

  if (notes !== undefined) {
    updates.notes = notes.trim();
  }

  const [updated] = await db
    .update(partnerCommissions)
    .set(updates)
    .where(eq(partnerCommissions.id, commissionId))
    .returning();

  // Audit log
  await db.insert(partnerAuditLogs).values({
    partnerId: existing.partnerId,
    restaurantId: existing.restaurantId,
    action: `commission_status_${status}`,
    performedBy: adminUser.id,
    details: {
      commissionId,
      previousStatus: existing.status,
      newStatus: status,
      payoutReference,
      notes,
    },
  });

  res.json(updated);
};

// ── GET /api/admin/partners/audit-logs ───────────────────────────────────────
const listPartnerAuditLogs: RequestHandler = async (_req, res) => {
  const logs = await db
    .select({
      id: partnerAuditLogs.id,
      partnerId: partnerAuditLogs.partnerId,
      partnerName: partners.name,
      restaurantId: partnerAuditLogs.restaurantId,
      restaurantName: restaurants.name,
      action: partnerAuditLogs.action,
      performedBy: partnerAuditLogs.performedBy,
      performerName: users.name,
      details: partnerAuditLogs.details,
      createdAt: partnerAuditLogs.createdAt,
    })
    .from(partnerAuditLogs)
    .leftJoin(partners, eq(partnerAuditLogs.partnerId, partners.id))
    .leftJoin(restaurants, eq(partnerAuditLogs.restaurantId, restaurants.id))
    .leftJoin(users, eq(partnerAuditLogs.performedBy, users.id))
    .orderBy(desc(partnerAuditLogs.createdAt))
    .limit(100);

  res.json(logs);
};

// ── Public: validate referral code for registration page ────────────────────
const validateReferralCode: RequestHandler = async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) {
    res.status(400).json({ valid: false, error: "Referral code required" });
    return;
  }

  const [partner] = await db
    .select({
      id: partners.id,
      name: partners.name,
      referralCode: partners.referralCode,
      status: partners.status,
    })
    .from(partners)
    .where(eq(sql`UPPER(${partners.referralCode})`, code.toUpperCase()))
    .limit(1);

  if (!partner || partner.status !== "active") {
    res.json({ valid: false, message: "Invalid or inactive referral code" });
    return;
  }

  res.json({
    valid: true,
    partner: {
      name: partner.name,
      referralCode: partner.referralCode,
    },
  });
};

// Routes
router.get("/admin/partners", requireAdmin, listPartnersAdmin);
router.post("/admin/partners", requireAdmin, createPartnerAdmin);
router.get("/admin/partners/audit-logs", requireAdmin, listPartnerAuditLogs);
router.get("/admin/partners/:id", requireAdmin, getPartnerAdmin);
router.put("/admin/partners/:id", requireAdmin, updatePartnerAdmin);
router.patch("/admin/partners/:id", requireAdmin, updatePartnerAdmin);
router.post("/admin/partners/:id/approve", requireAdmin, approvePartnerAdmin);
router.post("/admin/partners/:id/reject", requireAdmin, rejectPartnerAdmin);
router.post("/admin/partners/:id/toggle-status", requireAdmin, togglePartnerStatusAdmin);
router.post("/admin/partners/:id/reset-password", requireAdmin, resetPartnerPasswordAdmin);

router.get("/admin/commissions", requireAdmin, listAllCommissionsAdmin);
router.post("/admin/commissions/:id/status", requireAdmin, updateCommissionStatusAdmin);

// Public referral code validator
router.get("/partners/validate-code/:code", validateReferralCode);

export default router;
