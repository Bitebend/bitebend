import { Router, RequestHandler } from "express";
import { db } from "@workspace/db";
import {
  restaurantHardwareOrders,
  restaurants,
  partners,
  users,
  partnerAuditLogs,
} from "@workspace/db";
import { eq, desc, and, or, ilike, sql, isNull } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import {
  getDefaultQrStandPrice,
  setDefaultQrStandPrice,
} from "../lib/hardware";

const router = Router();

// ── GET /api/admin/hardware-orders ──────────────────────────────────────────
const listHardwareOrders: RequestHandler = async (req, res) => {
  try {
    const { status, partnerId, restaurantId, search } = req.query as {
      status?: string;
      partnerId?: string;
      restaurantId?: string;
      search?: string;
    };

    const conditions: any[] = [];

    if (status && status !== "all") {
      conditions.push(eq(restaurantHardwareOrders.collectionStatus, status as any));
    }

    if (partnerId) {
      if (partnerId === "unassigned") {
        conditions.push(isNull(restaurantHardwareOrders.partnerId));
      } else {
        const pid = parseInt(partnerId);
        if (!isNaN(pid)) {
          conditions.push(eq(restaurantHardwareOrders.partnerId, pid));
        }
      }
    }

    if (restaurantId) {
      const rid = parseInt(restaurantId);
      if (!isNaN(rid)) {
        conditions.push(eq(restaurantHardwareOrders.restaurantId, rid));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rawOrders = await db
      .select({
        id: restaurantHardwareOrders.id,
        restaurantId: restaurantHardwareOrders.restaurantId,
        partnerId: restaurantHardwareOrders.partnerId,
        standQuantity: restaurantHardwareOrders.standQuantity,
        unitPrice: restaurantHardwareOrders.unitPrice,
        totalAmount: restaurantHardwareOrders.totalAmount,
        collectionStatus: restaurantHardwareOrders.collectionStatus,
        collectedAt: restaurantHardwareOrders.collectedAt,
        collectedByPartnerId: restaurantHardwareOrders.collectedByPartnerId,
        waivedAt: restaurantHardwareOrders.waivedAt,
        waivedByUserId: restaurantHardwareOrders.waivedByUserId,
        waiveReason: restaurantHardwareOrders.waiveReason,
        notes: restaurantHardwareOrders.notes,
        createdAt: restaurantHardwareOrders.createdAt,
        updatedAt: restaurantHardwareOrders.updatedAt,
        restaurantName: restaurants.name,
        restaurantSlug: restaurants.slug,
        restaurantCity: restaurants.city,
        restaurantPhone: restaurants.phone,
        restaurantAddress: restaurants.address,
        restaurantIsActive: restaurants.isActive,
        restaurantSubStatus: restaurants.subscriptionStatus,
        partnerName: partners.name,
        partnerReferralCode: partners.referralCode,
        partnerPhone: partners.phone,
      })
      .from(restaurantHardwareOrders)
      .leftJoin(restaurants, eq(restaurantHardwareOrders.restaurantId, restaurants.id))
      .leftJoin(partners, eq(restaurantHardwareOrders.partnerId, partners.id))
      .where(whereClause)
      .orderBy(desc(restaurantHardwareOrders.createdAt));

    // Optional client-side style filter for search string
    let filteredOrders = rawOrders;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filteredOrders = rawOrders.filter(
        (o) =>
          o.restaurantName?.toLowerCase().includes(q) ||
          o.restaurantCity?.toLowerCase().includes(q) ||
          o.partnerName?.toLowerCase().includes(q) ||
          o.partnerReferralCode?.toLowerCase().includes(q)
      );
    }

    // Compute global summary stats
    const allRows = await db
      .select({
        standQuantity: restaurantHardwareOrders.standQuantity,
        totalAmount: restaurantHardwareOrders.totalAmount,
        collectionStatus: restaurantHardwareOrders.collectionStatus,
      })
      .from(restaurantHardwareOrders);

    let totalStands = 0;
    let totalAmount = 0;
    let pendingAmount = 0;
    let collectedAmount = 0;
    let waivedCount = 0;

    for (const r of allRows) {
      totalStands += r.standQuantity;
      totalAmount += r.totalAmount;
      if (r.collectionStatus === "pending") {
        pendingAmount += r.totalAmount;
      } else if (r.collectionStatus === "collected") {
        collectedAmount += r.totalAmount;
      } else if (r.collectionStatus === "waived") {
        waivedCount++;
      }
    }

    const defaultQrStandPrice = await getDefaultQrStandPrice();

    res.json({
      orders: filteredOrders,
      stats: {
        totalStands,
        totalAmount: Math.round(totalAmount * 100) / 100,
        pendingAmount: Math.round(pendingAmount * 100) / 100,
        collectedAmount: Math.round(collectedAmount * 100) / 100,
        waivedCount,
        totalOrders: allRows.length,
      },
      defaultQrStandPrice,
    });
  } catch (err: any) {
    console.error("[AdminHardware] Error listing orders:", err);
    res.status(500).json({ error: "Failed to list hardware orders." });
  }
};

// ── PATCH /api/admin/hardware-orders/:id/status ─────────────────────────────
const updateHardwareOrderStatus: RequestHandler = async (req, res) => {
  try {
    const adminUser = req.user!;
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

    const { status, waiveReason, notes, collectedDate } = req.body as {
      status: "collected" | "waived" | "pending";
      waiveReason?: string;
      notes?: string;
      collectedDate?: string;
    };

    if (!["collected", "waived", "pending"].includes(status)) {
      res.status(400).json({ error: "Invalid status. Must be 'collected', 'waived', or 'pending'." });
      return;
    }

    const updateFields: any = {
      collectionStatus: status,
      updatedAt: new Date(),
    };

    if (notes !== undefined) {
      updateFields.notes = notes ? notes.trim() : null;
    }

    if (status === "collected") {
      updateFields.collectedAt = collectedDate ? new Date(collectedDate) : new Date();
      updateFields.waivedAt = null;
      updateFields.waivedByUserId = null;
      updateFields.waiveReason = null;
    } else if (status === "waived") {
      updateFields.waivedAt = new Date();
      updateFields.waivedByUserId = adminUser.id;
      updateFields.waiveReason = waiveReason?.trim() || "Waived by Super Admin";
      updateFields.collectedAt = null;
      updateFields.collectedByPartnerId = null;
    } else if (status === "pending") {
      updateFields.collectedAt = null;
      updateFields.collectedByPartnerId = null;
      updateFields.waivedAt = null;
      updateFields.waivedByUserId = null;
      updateFields.waiveReason = null;
    }

    const previousStatus = order.collectionStatus;

    const [updated] = await db
      .update(restaurantHardwareOrders)
      .set(updateFields)
      .where(eq(restaurantHardwareOrders.id, orderId))
      .returning();

    // Synchronize restaurant's operational QR stands count based on physical collection transition
    if (status === "collected" && previousStatus !== "collected" && order.standQuantity > 0) {
      await db
        .update(restaurants)
        .set({
          qrStandsCount: sql`${restaurants.qrStandsCount} + ${order.standQuantity}`,
        })
        .where(eq(restaurants.id, order.restaurantId));
    } else if (previousStatus === "collected" && status !== "collected" && order.standQuantity > 0) {
      await db
        .update(restaurants)
        .set({
          qrStandsCount: sql`GREATEST(0, ${restaurants.qrStandsCount} - ${order.standQuantity})`,
        })
        .where(eq(restaurants.id, order.restaurantId));
    }

    // Log admin action in partner audit log if partner assigned
    if (order.partnerId) {
      await db.insert(partnerAuditLogs).values({
        partnerId: order.partnerId,
        restaurantId: order.restaurantId,
        action: `admin_hardware_status_${status}`,
        performedBy: adminUser.id,
        details: {
          orderId: order.id,
          previousStatus: order.collectionStatus,
          newStatus: status,
          waiveReason: updateFields.waiveReason ?? null,
          notes: updateFields.notes ?? null,
        },
      });
    }

    res.json({
      success: true,
      message:
        status === "collected"
          ? `Hardware order marked as Collected Offline (₹${order.totalAmount}).`
          : status === "waived"
          ? `Hardware order marked as Waived.`
          : `Hardware order reset to Pending.`,
      order: updated,
    });
  } catch (err: any) {
    console.error("[AdminHardware] Error updating status:", err);
    res.status(500).json({ error: "Failed to update hardware order status." });
  }
};

// ── PATCH /api/admin/hardware-orders/:id/assign-partner ──────────────────────
const assignHardwareOrderPartner: RequestHandler = async (req, res) => {
  try {
    const adminUser = req.user!;
    const orderId = parseInt(String(req.params.id));
    if (isNaN(orderId)) {
      res.status(400).json({ error: "Invalid hardware order ID" });
      return;
    }

    const { partnerId } = req.body as { partnerId: number };
    if (!partnerId || isNaN(Number(partnerId))) {
      res.status(400).json({ error: "Valid partnerId is required" });
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

    const [partner] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);

    if (!partner) {
      res.status(404).json({ error: "Partner not found" });
      return;
    }

    const [updated] = await db
      .update(restaurantHardwareOrders)
      .set({
        partnerId: partner.id,
        updatedAt: new Date(),
      })
      .where(eq(restaurantHardwareOrders.id, orderId))
      .returning();

    // Also update restaurant's partnerId if it doesn't already have one
    const [rest] = await db
      .select({ id: restaurants.id, partnerId: restaurants.partnerId })
      .from(restaurants)
      .where(eq(restaurants.id, order.restaurantId))
      .limit(1);

    if (rest && !rest.partnerId) {
      await db
        .update(restaurants)
        .set({ partnerId: partner.id })
        .where(eq(restaurants.id, order.restaurantId));
    }

    // Audit log
    await db.insert(partnerAuditLogs).values({
      partnerId: partner.id,
      restaurantId: order.restaurantId,
      action: "hardware_order_partner_assigned",
      performedBy: adminUser.id,
      details: {
        orderId: order.id,
        previousPartnerId: order.partnerId,
        newPartnerId: partner.id,
      },
    });

    res.json({
      success: true,
      message: `Assigned hardware order to partner ${partner.name}.`,
      order: updated,
    });
  } catch (err: any) {
    console.error("[AdminHardware] Error assigning partner:", err);
    res.status(500).json({ error: "Failed to assign partner to hardware order." });
  }
};

// ── GET /api/admin/settings/stand-price ─────────────────────────────────────
const getStandPriceSettings: RequestHandler = async (_req, res) => {
  try {
    const defaultQrStandPrice = await getDefaultQrStandPrice();
    res.json({ defaultQrStandPrice });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get stand price setting." });
  }
};

// ── PUT /api/admin/settings/stand-price ─────────────────────────────────────
const updateStandPriceSettings: RequestHandler = async (req, res) => {
  try {
    const { price } = req.body as { price: number };
    const numPrice = Number(price);
    if (isNaN(numPrice) || numPrice < 0) {
      res.status(400).json({ error: "Price must be a valid non-negative number." });
      return;
    }

    const savedPrice = await setDefaultQrStandPrice(numPrice);
    res.json({
      success: true,
      message: `Default QR stand price updated to ₹${savedPrice}.`,
      defaultQrStandPrice: savedPrice,
    });
  } catch (err: any) {
    console.error("[AdminHardware] Error updating stand price:", err);
    res.status(500).json({ error: "Failed to update stand price setting." });
  }
};

// Admin routes
router.get("/admin/hardware-orders", requireAdmin, listHardwareOrders);
router.patch("/admin/hardware-orders/:id/status", requireAdmin, updateHardwareOrderStatus);
router.patch("/admin/hardware-orders/:id/assign-partner", requireAdmin, assignHardwareOrderPartner);
router.get("/admin/settings/stand-price", requireAdmin, getStandPriceSettings);
router.put("/admin/settings/stand-price", requireAdmin, updateStandPriceSettings);

export default router;
