import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  partners,
  partnerCommissions,
  partnerAuditLogs,
  restaurants,
  users,
  subscriptionPlans,
  restaurantHardwareOrders,
} from "@workspace/db";
import { eq, sql, desc, and } from "drizzle-orm";
import { requirePartner } from "../middlewares/auth";
import type { RequestHandler } from "express";

const router = Router();

// ── POST /api/partner/register (Public Self-Registration) ────────────────────
const registerPartnerPublic: RequestHandler = async (req, res) => {
  try {
    const { name, email, phone, state, city, password, payoutDetails } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      state?: string;
      city?: string;
      password?: string;
      payoutDetails?: any;
    };

    if (!name?.trim() || !email?.trim() || !phone?.trim() || !password?.trim()) {
      res.status(400).json({ error: "Name, email, phone number, and password are required" });
      return;
    }

    if (password.trim().length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters long" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if email is already in users table
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (existingUser) {
      res.status(409).json({ error: "An account with this email address already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password.trim(), 10);

    // 1. Create User with role 'partner'
    const [newUser] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        name: name.trim(),
        passwordHash,
        role: "partner",
      })
      .returning();

    // 2. Create Partner record with status 'pending' and null referral code (awaiting approval)
    const [newPartner] = await db
      .insert(partners)
      .values({
        userId: newUser.id,
        name: name.trim(),
        email: normalizedEmail,
        phone: phone.trim(),
        state: state?.trim() || null,
        city: city?.trim() || null,
        referralCode: null,
        commissionPercentage: 10.0,
        status: "pending",
        payoutDetails: payoutDetails || null,
      })
      .returning();

    // 3. Log audit event
    await db.insert(partnerAuditLogs).values({
      partnerId: newPartner.id,
      action: "partner_registered",
      performedBy: newUser.id,
      details: {
        partnerId: newPartner.id,
        name: newPartner.name,
        email: newPartner.email,
        phone: newPartner.phone,
        state: newPartner.state,
        city: newPartner.city,
        status: "pending",
      },
    });

    res.status(201).json({
      success: true,
      message: "Your partner application has been submitted and is pending Bitebend Super Admin review.",
      partner: {
        id: newPartner.id,
        name: newPartner.name,
        email: newPartner.email,
        phone: newPartner.phone,
        status: newPartner.status,
      },
    });
  } catch (error: any) {
    console.error("[PartnerRegister] Error:", error);
    res.status(500).json({ error: "Failed to submit partner application. Please try again." });
  }
};

// Helper to load partner record from authenticated partner user
async function getAuthenticatedPartner(userId: number) {
  const [partner] = await db
    .select()
    .from(partners)
    .where(eq(partners.userId, userId))
    .limit(1);
  return partner || null;
}

// ── GET /api/partner/dashboard ───────────────────────────────────────────────
const getPartnerDashboard: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  // If partner is not active, return status without exposing sensitive analytics
  if (partner.status !== "active") {
    res.json({
      partner: {
        id: partner.id,
        name: partner.name,
        email: partner.email,
        phone: partner.phone,
        referralCode: partner.referralCode,
        commissionPercentage: partner.commissionPercentage,
        status: partner.status,
        payoutDetails: partner.payoutDetails,
        createdAt: partner.createdAt,
      },
      metrics: {
        totalRestaurants: 0,
        activeRestaurants: 0,
        totalEarned: 0,
        pendingPayout: 0,
        approvedPayout: 0,
        paidPayout: 0,
      },
      recentRestaurants: [],
      recentCommissions: [],
      isUnderReview: partner.status === "pending",
    });
    return;
  }

  // 1. Attributed restaurants list & stats
  const allRestaurants = await db
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
      isActive: restaurants.isActive,
      createdAt: restaurants.createdAt,
    })
    .from(restaurants)
    .where(eq(restaurants.partnerId, partner.id))
    .orderBy(desc(restaurants.createdAt));

  // 2. All commissions for this partner
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
    })
    .from(partnerCommissions)
    .leftJoin(restaurants, eq(partnerCommissions.restaurantId, restaurants.id))
    .where(eq(partnerCommissions.partnerId, partner.id))
    .orderBy(desc(partnerCommissions.createdAt));

  // Aggregates
  const totalEarned = commissions.reduce((sum, c) => sum + (c.status !== "cancelled" ? c.commissionAmount : 0), 0);
  const pendingPayout = commissions.reduce((sum, c) => sum + (c.status === "pending" ? c.commissionAmount : 0), 0);
  const approvedPayout = commissions.reduce((sum, c) => sum + (c.status === "approved" ? c.commissionAmount : 0), 0);
  const paidPayout = commissions.reduce((sum, c) => sum + (c.status === "paid" ? c.commissionAmount : 0), 0);

  const activeRestaurants = allRestaurants.filter((r) => r.isActive && r.subscriptionStatus === "active").length;

  res.json({
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      referralCode: partner.referralCode,
      commissionPercentage: partner.commissionPercentage,
      status: partner.status,
      payoutDetails: partner.payoutDetails,
      createdAt: partner.createdAt,
    },
    metrics: {
      totalRestaurants: allRestaurants.length,
      activeRestaurants,
      totalEarned,
      pendingPayout,
      approvedPayout,
      paidPayout,
    },
    recentRestaurants: allRestaurants.slice(0, 5),
    recentCommissions: commissions.slice(0, 10),
  });
};

// ── GET /api/partner/restaurants ─────────────────────────────────────────────
const getPartnerRestaurants: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  if (partner.status !== "active") {
    res.json([]);
    return;
  }

  const rows = await db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      slug: restaurants.slug,
      phone: restaurants.phone,
      email: restaurants.email,
      city: restaurants.city,
      address: restaurants.address,
      cuisineType: restaurants.cuisineType,
      subscriptionStatus: restaurants.subscriptionStatus,
      customerLimit: restaurants.customerLimit,
      customersUsed: restaurants.customersUsed,
      isActive: restaurants.isActive,
      planId: restaurants.planId,
      planName: subscriptionPlans.name,
      qrStandsCount: restaurants.qrStandsCount,
      hardwareOrderId: restaurantHardwareOrders.id,
      hardwareQuantity: restaurantHardwareOrders.standQuantity,
      hardwareUnitPrice: restaurantHardwareOrders.unitPrice,
      hardwareTotalAmount: restaurantHardwareOrders.totalAmount,
      hardwareCollectionStatus: restaurantHardwareOrders.collectionStatus,
      hardwareCollectedAt: restaurantHardwareOrders.collectedAt,
      createdAt: restaurants.createdAt,
    })
    .from(restaurants)
    .leftJoin(subscriptionPlans, eq(restaurants.planId, subscriptionPlans.id))
    .leftJoin(restaurantHardwareOrders, eq(restaurantHardwareOrders.restaurantId, restaurants.id))
    .where(eq(restaurants.partnerId, partner.id))
    .orderBy(desc(restaurants.createdAt));

  res.json(rows);
};

// ── GET /api/partner/hardware-orders ────────────────────────────────────────
const getPartnerHardwareOrders: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);
  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  const rows = await db
    .select({
      id: restaurantHardwareOrders.id,
      restaurantId: restaurantHardwareOrders.restaurantId,
      restaurantName: restaurants.name,
      restaurantSlug: restaurants.slug,
      restaurantCity: restaurants.city,
      restaurantPhone: restaurants.phone,
      standQuantity: restaurantHardwareOrders.standQuantity,
      unitPrice: restaurantHardwareOrders.unitPrice,
      totalAmount: restaurantHardwareOrders.totalAmount,
      collectionStatus: restaurantHardwareOrders.collectionStatus,
      collectedAt: restaurantHardwareOrders.collectedAt,
      notes: restaurantHardwareOrders.notes,
      createdAt: restaurantHardwareOrders.createdAt,
    })
    .from(restaurantHardwareOrders)
    .innerJoin(restaurants, eq(restaurantHardwareOrders.restaurantId, restaurants.id))
    .where(eq(restaurantHardwareOrders.partnerId, partner.id))
    .orderBy(desc(restaurantHardwareOrders.createdAt));

  res.json(rows);
};

// ── POST /api/partner/hardware-orders/:id/collect ───────────────────────────
const collectHardwareOrderPartner: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);
  if (!partner || partner.status !== "active") {
    res.status(403).json({ error: "Unauthorized or partner account is not active" });
    return;
  }

  const orderId = parseInt(String(req.params.id));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid hardware order ID" });
    return;
  }

  const [order] = await db
    .select()
    .from(restaurantHardwareOrders)
    .where(eq(restaurantHardwareOrders.id, orderId))
    .limit(1);

  if (!order) {
    res.status(404).json({ error: "Hardware order not found" });
    return;
  }

  if (order.partnerId !== partner.id) {
    res.status(403).json({ error: "You can only collect hardware orders attributed to your partner account" });
    return;
  }

  if (order.collectionStatus === "waived") {
    res.status(400).json({ error: "This hardware order was waived and cannot be collected" });
    return;
  }

  if (order.collectionStatus === "collected") {
    res.json({
      success: true,
      message: `Physical QR stand fee of ₹${order.totalAmount} marked as collected offline.`,
      order,
      alreadyCollected: true,
    });
    return;
  }

  const { notes, collectedDate } = req.body as { notes?: string; collectedDate?: string };
  const collectedAt = collectedDate ? new Date(collectedDate) : new Date();

  let updatedOrder = order;
  let actuallyUpdated = false;

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(restaurantHardwareOrders)
      .set({
        collectionStatus: "collected",
        collectedAt,
        collectedByPartnerId: partner.id,
        notes: notes?.trim() || order.notes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(restaurantHardwareOrders.id, orderId),
          eq(restaurantHardwareOrders.collectionStatus, "pending"),
        ),
      )
      .returning();

    if (updated) {
      actuallyUpdated = true;
      updatedOrder = updated;

      // Increment restaurant operational QR stands count upon confirmed physical collection
      if (order.standQuantity > 0) {
        await tx
          .update(restaurants)
          .set({
            qrStandsCount: sql`${restaurants.qrStandsCount} + ${order.standQuantity}`,
          })
          .where(eq(restaurants.id, order.restaurantId));
      }

      // Audit log
      await tx.insert(partnerAuditLogs).values({
        partnerId: partner.id,
        restaurantId: order.restaurantId,
        action: "partner_collected_hardware",
        performedBy: user.id,
        details: {
          orderId: order.id,
          standQuantity: order.standQuantity,
          totalAmount: order.totalAmount,
          collectedAt,
          notes: notes?.trim() || null,
        },
      });
    } else {
      // Concurrently collected by another request: read the collected state
      const [current] = await tx
        .select()
        .from(restaurantHardwareOrders)
        .where(eq(restaurantHardwareOrders.id, orderId))
        .limit(1);
      if (current) {
        updatedOrder = current;
      }
    }
  });

  // Note: Physical hardware money is collected offline directly by the partner. No Bitebend platform commission is created.
  res.json({
    success: true,
    message: `Physical QR stand fee of ₹${order.totalAmount} marked as collected offline.`,
    order: updatedOrder,
    ...(!actuallyUpdated ? { alreadyCollected: true } : {}),
  });
};

// ── GET /api/partner/commissions ─────────────────────────────────────────────
const getPartnerCommissions: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  if (partner.status !== "active") {
    res.json([]);
    return;
  }

  const rows = await db
    .select({
      id: partnerCommissions.id,
      restaurantId: partnerCommissions.restaurantId,
      restaurantName: restaurants.name,
      restaurantCity: restaurants.city,
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
    })
    .from(partnerCommissions)
    .leftJoin(restaurants, eq(partnerCommissions.restaurantId, restaurants.id))
    .where(eq(partnerCommissions.partnerId, partner.id))
    .orderBy(desc(partnerCommissions.createdAt));

  res.json(rows);
};

// ── GET /api/partner/profile ─────────────────────────────────────────────────
const getPartnerProfile: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  res.json(partner);
};

// ── PUT /api/partner/profile ─────────────────────────────────────────────────
const updatePartnerProfile: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  const { name, phone, state, city } = req.body as {
    name?: string;
    phone?: string;
    state?: string;
    city?: string;
  };
  const updates: Partial<typeof partners.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (name?.trim()) {
    updates.name = name.trim();
    await db.update(users).set({ name: name.trim() }).where(eq(users.id, user.id));
  }
  if (phone?.trim()) updates.phone = phone.trim();
  if (state !== undefined) updates.state = state?.trim() || null;
  if (city !== undefined) updates.city = city?.trim() || null;

  const [updated] = await db
    .update(partners)
    .set(updates)
    .where(eq(partners.id, partner.id))
    .returning();

  res.json(updated);
};

// ── PUT /api/partner/payout-details ──────────────────────────────────────────
const updatePartnerPayoutDetails: RequestHandler = async (req, res) => {
  const user = req.user!;
  const partner = await getAuthenticatedPartner(user.id);

  if (!partner) {
    res.status(404).json({ error: "Partner profile not found" });
    return;
  }

  const { upiId, accountName, accountNumber, ifsc, bankName } = req.body as {
    upiId?: string;
    accountName?: string;
    accountNumber?: string;
    ifsc?: string;
    bankName?: string;
  };

  const payoutDetails = {
    upiId: upiId?.trim() || null,
    accountName: accountName?.trim() || null,
    accountNumber: accountNumber?.trim() || null,
    ifsc: ifsc?.trim()?.toUpperCase() || null,
    bankName: bankName?.trim() || null,
    updatedAt: new Date().toISOString(),
  };

  const [updated] = await db
    .update(partners)
    .set({
      payoutDetails,
      updatedAt: new Date(),
    })
    .where(eq(partners.id, partner.id))
    .returning();

  res.json(updated);
};

// ── POST /api/partner/change-password ─────────────────────────────────────────
const changePartnerPassword: RequestHandler = async (req, res) => {
  try {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword?.trim() || !newPassword?.trim()) {
      res.status(400).json({ error: "Current password and new password are required" });
      return;
    }

    if (newPassword.trim().length < 6) {
      res.status(400).json({ error: "New password must be at least 6 characters long" });
      return;
    }

    const [userRecord] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (!userRecord) {
      res.status(404).json({ error: "User account not found" });
      return;
    }

    const isValid = await bcrypt.compare(currentPassword.trim(), userRecord.passwordHash);
    if (!isValid) {
      res.status(400).json({ error: "Current password is incorrect" });
      return;
    }

    const newHash = await bcrypt.hash(newPassword.trim(), 10);
    await db
      .update(users)
      .set({
        passwordHash: newHash,
        tempPassword: newPassword.trim(),
      })
      .where(eq(users.id, user.id));

    // Audit log
    const [partner] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.userId, user.id))
      .limit(1);

    if (partner) {
      await db.insert(partnerAuditLogs).values({
        partnerId: partner.id,
        action: "partner_changed_password",
        performedBy: user.id,
        details: { email: userRecord.email },
      });
    }

    res.json({ success: true, message: "Password updated successfully." });
  } catch (error: any) {
    console.error("[PartnerChangePassword] Error:", error);
    res.status(500).json({ error: "Failed to update password. Please try again." });
  }
};

// Public self-registration
router.post("/partner/register", registerPartnerPublic);
router.post("/partners/register", registerPartnerPublic);

// Partner-authenticated routes
router.get("/partner/dashboard", requirePartner, getPartnerDashboard);
router.get("/partner/restaurants", requirePartner, getPartnerRestaurants);
router.get("/partner/hardware-orders", requirePartner, getPartnerHardwareOrders);
router.post("/partner/hardware-orders/:id/collect", requirePartner, collectHardwareOrderPartner);
router.get("/partner/commissions", requirePartner, getPartnerCommissions);
router.get("/partner/profile", requirePartner, getPartnerProfile);
router.put("/partner/profile", requirePartner, updatePartnerProfile);
router.put("/partner/payout-details", requirePartner, updatePartnerPayoutDetails);
router.post("/partner/change-password", requirePartner, changePartnerPassword);

export default router;
