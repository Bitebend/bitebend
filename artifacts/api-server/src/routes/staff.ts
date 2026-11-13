import { Router, type IRouter, type RequestHandler } from "express";
import { db } from "@workspace/db";
import { restaurantStaff, restaurants, orders, orderItems, tableSessions, orderActivityLogs } from "@workspace/db/schema";
import { eq, and, gt, desc, inArray, asc } from "drizzle-orm";
import { createRateLimiter } from "../lib/rateLimiter";
import { hashPinDigest, generateStaffToken } from "../lib/staffToken";
import { requireStaff, requireStaffRole } from "../middlewares/staffAuth";

const router: IRouter = Router();

// Rate limiter: 5 attempts per 15-minute fixed window per IP
const pinRateLimiter = createRateLimiter({
  maxRequests: 5,
  windowMs: 15 * 60 * 1000,
  label: "staff_pin_connect",
  message: "Too many failed PIN attempts. Please wait 15 minutes before trying again.",
});

/**
 * POST /api/staff/connect-pin
 * Validates and atomically consumes a one-time 6-digit connection PIN.
 * Staff provides only the PIN; the backend identifies the restaurant, staff member, and role.
 */
const connectPin: RequestHandler = async (req, res) => {
  const { pin } = req.body as { pin?: string };

  if (!pin || typeof pin !== "string" || !/^\d{6}$/.test(pin.trim())) {
    res.status(400).json({ error: "Please enter a valid 6-digit connection PIN" });
    return;
  }

  const cleanPin = pin.trim();
  const digest = hashPinDigest(cleanPin);

  // Look up active staff member with matching, unexpired PIN digest
  const [staff] = await db
    .select({
      id: restaurantStaff.id,
      restaurantId: restaurantStaff.restaurantId,
      name: restaurantStaff.name,
      role: restaurantStaff.role,
      tokenVersion: restaurantStaff.tokenVersion,
      isActive: restaurantStaff.isActive,
      connectionPinExpiresAt: restaurantStaff.connectionPinExpiresAt,
      restaurantName: restaurants.name,
      restaurantSlug: restaurants.slug,
    })
    .from(restaurantStaff)
    .innerJoin(restaurants, eq(restaurants.id, restaurantStaff.restaurantId))
    .where(
      and(
        eq(restaurantStaff.connectionPinDigest, digest),
        eq(restaurantStaff.isActive, true),
        gt(restaurantStaff.connectionPinExpiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!staff) {
    res.status(401).json({
      error: "Invalid or expired connection PIN. Please ask your manager for a fresh PIN.",
    });
    return;
  }

  // Atomically consume the PIN so it can never be used again
  await db
    .update(restaurantStaff)
    .set({
      connectionPinDigest: null,
      connectionPinExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(restaurantStaff.id, staff.id));

  // Issue signed staff token (does NOT contain userId, enforcing role isolation)
  const token = generateStaffToken({
    staffId: staff.id,
    restaurantId: staff.restaurantId,
    role: staff.role as "waiter" | "chef",
    tokenVersion: staff.tokenVersion,
  });

  res.json({
    token,
    staff: {
      id: staff.id,
      name: staff.name,
      role: staff.role,
      restaurantId: staff.restaurantId,
      restaurantName: staff.restaurantName,
      restaurantSlug: staff.restaurantSlug,
    },
  });
};

function setNoStoreHeaders(res: Parameters<RequestHandler>[1]) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

/**
 * GET /api/staff/me
 * Returns profile, connection status, and authoritative Chef Mode state
 * for the currently authenticated staff member's restaurant.
 */
const getMe: RequestHandler = async (req, res) => {
  setNoStoreHeaders(res);
  const staff = req.staff!;
  const restaurant = req.restaurant;

  if (!restaurant) {
    res.status(404).json({ error: "Restaurant not found" });
    return;
  }

  res.json({
    staff: {
      id: staff.id,
      name: staff.name,
      role: staff.role,
      restaurantId: staff.restaurantId,
      restaurantName: restaurant.name,
      restaurantSlug: restaurant.slug,
    },
    chefDashboardEnabled: Boolean(restaurant.chefDashboardEnabled),
  });
};

/**
 * GET /api/staff/waiter/orders
 * Returns ONLY active orders strictly assigned to the authenticated waiter.
 * Role check (waiter) and tenant check (restaurantId) are strictly enforced.
 */
const listWaiterOrders: RequestHandler = async (req, res) => {
  setNoStoreHeaders(res);
  const staff = req.staff!;

  // Query only orders assigned to this waiter, in their restaurant, with active status
  const assignedOrders = await db
    .select({
      id: orders.id,
      sessionId: orders.sessionId,
      tableId: orders.tableId,
      tableNumber: orders.tableNumber,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      status: orders.status,
      notes: orders.notes,
      subtotal: orders.subtotal,
      tax: orders.tax,
      total: orders.total,
      assignmentSource: orders.assignmentSource,
      assignedWaiterId: orders.assignedWaiterId,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      sessionType: tableSessions.sessionType,
      sessionTableNumber: tableSessions.tableNumber,
    })
    .from(orders)
    .leftJoin(tableSessions, eq(tableSessions.id, orders.sessionId))
    .where(
      and(
        eq(orders.restaurantId, staff.restaurantId),
        eq(orders.assignedWaiterId, staff.id),
        inArray(orders.status, ["ordered", "preparing", "ready"]),
      ),
    )
    .orderBy(desc(orders.createdAt));

  if (assignedOrders.length === 0) {
    res.json([]);
    return;
  }

  const orderIds = assignedOrders.map((o) => o.id);
  const items = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      isVeg: orderItems.isVeg,
      notes: orderItems.notes,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds));

  const itemsByOrder = new Map<number, typeof items>();
  for (const item of items) {
    if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
    itemsByOrder.get(item.orderId)!.push(item);
  }

  const result = assignedOrders.map((o) => ({
    ...o,
    effectiveTableNumber: o.tableNumber || o.sessionTableNumber || null,
    items: itemsByOrder.get(o.id) ?? [],
  }));

  res.json(result);
};

/**
 * POST /api/staff/waiter/orders/:orderId/start-prep
 * Waiter marks order as preparing.
 * Waiter must be assigned to this order. Current status must be "ordered".
 * Allowed whether Chef Mode is ON or OFF.
 */
const startPreparation: RequestHandler = async (req, res) => {
  const staff = req.staff!;
  const orderId = parseInt(String(req.params.orderId));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // 1. Lock restaurant row FOR UPDATE
    const [resto] = await tx
      .select({ id: restaurants.id, chefDashboardEnabled: restaurants.chefDashboardEnabled })
      .from(restaurants)
      .where(eq(restaurants.id, staff.restaurantId))
      .limit(1)
      .for("update");

    if (!resto) {
      return { status: 404, error: "Restaurant not found" };
    }

    // 2. Lock target order row FOR UPDATE
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .limit(1)
      .for("update");

    if (!order) {
      return { status: 404, error: "Order not found" };
    }

    if (order.assignedWaiterId !== staff.id) {
      return { status: 403, error: "Order is not assigned to you" };
    }

    if (order.status !== "ordered") {
      return { status: 400, error: `Cannot start preparation: current status is ${order.status}` };
    }

    const [updatedOrder] = await tx
      .update(orders)
      .set({
        status: "preparing",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .returning();

    await tx.insert(orderActivityLogs).values({
      restaurantId: staff.restaurantId,
      sessionId: order.sessionId,
      orderId: order.id,
      action: "order_preparing",
      previousStatus: "ordered",
      newStatus: "preparing",
      actorType: "waiter",
      staffActorId: staff.id,
      userActorId: null,
      metadata: null,
    });

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: 200, data: { ...updatedOrder, items } };
  });

  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.data);
};

/**
 * POST /api/staff/chef/orders/:orderId/ready
 * Chef marks order as ready.
 * Chef Mode must be ON. Order must be in "preparing" status.
 * Independent of waiter assignment. Does not mutate assignment.
 */
const chefReady: RequestHandler = async (req, res) => {
  const staff = req.staff!;
  const orderId = parseInt(String(req.params.orderId));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // 1. Lock restaurant row FOR UPDATE
    const [resto] = await tx
      .select({ id: restaurants.id, chefDashboardEnabled: restaurants.chefDashboardEnabled })
      .from(restaurants)
      .where(eq(restaurants.id, staff.restaurantId))
      .limit(1)
      .for("update");

    if (!resto) {
      return { status: 404, error: "Restaurant not found" };
    }

    if (!resto.chefDashboardEnabled) {
      return {
        status: 403,
        error: "Chef mode is currently disabled by owner",
        code: "CHEF_MODE_DISABLED",
      };
    }

    // 2. Lock target order row FOR UPDATE
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .limit(1)
      .for("update");

    if (!order) {
      return { status: 404, error: "Order not found" };
    }

    if (order.status === "ordered") {
      return { status: 400, error: "Order must be in preparing status before marking ready" };
    }

    if (order.status !== "preparing") {
      return { status: 400, error: `Cannot mark order ready: current status is ${order.status}` };
    }

    // Chef does not alter assignedWaiterId, assignmentSource, or tableSessions.assignedWaiterId
    const [updatedOrder] = await tx
      .update(orders)
      .set({
        status: "ready",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .returning();

    await tx.insert(orderActivityLogs).values({
      restaurantId: staff.restaurantId,
      sessionId: order.sessionId,
      orderId: order.id,
      action: "order_ready",
      previousStatus: "preparing",
      newStatus: "ready",
      actorType: "chef",
      staffActorId: staff.id,
      userActorId: null,
      metadata: null,
    });

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: 200, data: { ...updatedOrder, items } };
  });

  if (result.error) {
    res.status(result.status).json(result.code ? { error: result.error, code: result.code } : { error: result.error });
    return;
  }

  res.json(result.data);
};

/**
 * POST /api/staff/waiter/orders/:orderId/ready
 * Normal waiter ready transition.
 * Permitted ONLY when Chef Mode is OFF.
 * Waiter must be assigned. Order must be in "preparing" status.
 */
const waiterReady: RequestHandler = async (req, res) => {
  const staff = req.staff!;
  const orderId = parseInt(String(req.params.orderId));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // 1. Lock restaurant row FOR UPDATE
    const [resto] = await tx
      .select({ id: restaurants.id, chefDashboardEnabled: restaurants.chefDashboardEnabled })
      .from(restaurants)
      .where(eq(restaurants.id, staff.restaurantId))
      .limit(1)
      .for("update");

    if (!resto) {
      return { status: 404, error: "Restaurant not found" };
    }

    // Reject if Chef Mode is enabled
    if (resto.chefDashboardEnabled) {
      return {
        status: 403,
        error: "Chef mode is enabled. Kitchen staff marks orders ready, or use emergency-ready with reason.",
      };
    }

    // 2. Lock target order row FOR UPDATE
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .limit(1)
      .for("update");

    if (!order) {
      return { status: 404, error: "Order not found" };
    }

    if (order.assignedWaiterId !== staff.id) {
      return { status: 403, error: "Order is not assigned to you" };
    }

    if (order.status !== "preparing") {
      return { status: 400, error: `Cannot mark order ready: current status is ${order.status}` };
    }

    const [updatedOrder] = await tx
      .update(orders)
      .set({
        status: "ready",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .returning();

    await tx.insert(orderActivityLogs).values({
      restaurantId: staff.restaurantId,
      sessionId: order.sessionId,
      orderId: order.id,
      action: "order_ready",
      previousStatus: "preparing",
      newStatus: "ready",
      actorType: "waiter",
      staffActorId: staff.id,
      userActorId: null,
      metadata: { chefMode: false },
    });

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: 200, data: { ...updatedOrder, items } };
  });

  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.data);
};

/**
 * POST /api/staff/waiter/orders/:orderId/emergency-ready
 * Waiter emergency ready override when Chef Mode is ON.
 * Requires reason string >= 5 chars.
 * Rejects with 400 if Chef Mode is OFF.
 */
const waiterEmergencyReady: RequestHandler = async (req, res) => {
  const staff = req.staff!;
  const orderId = parseInt(String(req.params.orderId));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const { reason } = req.body as { reason?: unknown };
  if (typeof reason !== "string" || reason.trim().length < 5) {
    res.status(400).json({
      error: "A valid reason (at least 5 characters) is required for emergency ready override",
    });
    return;
  }

  const cleanReason = reason.trim();

  const result = await db.transaction(async (tx) => {
    // 1. Lock restaurant row FOR UPDATE
    const [resto] = await tx
      .select({ id: restaurants.id, chefDashboardEnabled: restaurants.chefDashboardEnabled })
      .from(restaurants)
      .where(eq(restaurants.id, staff.restaurantId))
      .limit(1)
      .for("update");

    if (!resto) {
      return { status: 404, error: "Restaurant not found" };
    }

    // Must have Chef Mode ON to use emergency override
    if (!resto.chefDashboardEnabled) {
      return {
        status: 400,
        error: "Chef mode is disabled; emergency ready override is not required. Use standard ready endpoint.",
      };
    }

    // 2. Lock target order row FOR UPDATE
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .limit(1)
      .for("update");

    if (!order) {
      return { status: 404, error: "Order not found" };
    }

    if (order.assignedWaiterId !== staff.id) {
      return { status: 403, error: "Order is not assigned to you" };
    }

    if (order.status !== "preparing") {
      return { status: 400, error: `Cannot mark order ready: current status is ${order.status}` };
    }

    const [updatedOrder] = await tx
      .update(orders)
      .set({
        status: "ready",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .returning();

    await tx.insert(orderActivityLogs).values({
      restaurantId: staff.restaurantId,
      sessionId: order.sessionId,
      orderId: order.id,
      action: "order_emergency_ready",
      previousStatus: "preparing",
      newStatus: "ready",
      actorType: "waiter",
      staffActorId: staff.id,
      userActorId: null,
      metadata: { reason: cleanReason, chefMode: true },
    });

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: 200, data: { ...updatedOrder, items } };
  });

  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.data);
};

/**
 * POST /api/staff/waiter/orders/:orderId/complete
 * Waiter marks order as completed.
 * Allowed whether Chef Mode is ON or OFF.
 * Order must be in "ready" status. Waiter must be assigned.
 * Zero side effects on table occupancy or billing.
 */
const waiterComplete: RequestHandler = async (req, res) => {
  const staff = req.staff!;
  const orderId = parseInt(String(req.params.orderId));
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // 1. Lock restaurant row FOR UPDATE
    const [resto] = await tx
      .select({ id: restaurants.id, chefDashboardEnabled: restaurants.chefDashboardEnabled })
      .from(restaurants)
      .where(eq(restaurants.id, staff.restaurantId))
      .limit(1)
      .for("update");

    if (!resto) {
      return { status: 404, error: "Restaurant not found" };
    }

    // 2. Lock target order row FOR UPDATE
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .limit(1)
      .for("update");

    if (!order) {
      return { status: 404, error: "Order not found" };
    }

    if (order.assignedWaiterId !== staff.id) {
      return { status: 403, error: "Order is not assigned to you" };
    }

    if (order.status !== "ready") {
      return {
        status: 400,
        error: `Cannot complete order: current status is ${order.status}. Order must be ready.`,
      };
    }

    const [updatedOrder] = await tx
      .update(orders)
      .set({
        status: "completed",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, staff.restaurantId)))
      .returning();

    await tx.insert(orderActivityLogs).values({
      restaurantId: staff.restaurantId,
      sessionId: order.sessionId,
      orderId: order.id,
      action: "order_completed",
      previousStatus: "ready",
      newStatus: "completed",
      actorType: "waiter",
      staffActorId: staff.id,
      userActorId: null,
      metadata: null,
    });

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: 200, data: { ...updatedOrder, items } };
  });

  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.data);
};

/**
 * GET /api/staff/chef/orders
 * Returns active kitchen orders ("ordered", "preparing", "ready") for this restaurant.
 * Requires Chef role and Chef Mode to be enabled.
 * Strict data privacy: Phone, billing, payment, and screenshot fields are completely excluded.
 */
const listChefOrders: RequestHandler = async (req, res) => {
  setNoStoreHeaders(res);
  const staff = req.staff!;

  // Verify Chef Mode is enabled
  const [resto] = await db
    .select({ chefDashboardEnabled: restaurants.chefDashboardEnabled })
    .from(restaurants)
    .where(eq(restaurants.id, staff.restaurantId))
    .limit(1);

  if (!resto || !resto.chefDashboardEnabled) {
    res.status(403).json({
      error: "Chef mode is currently disabled by owner",
      code: "CHEF_MODE_DISABLED",
    });
    return;
  }

  const activeOrders = await db
    .select({
      id: orders.id,
      sessionId: orders.sessionId,
      tableId: orders.tableId,
      tableNumber: orders.tableNumber,
      customerName: orders.customerName,
      status: orders.status,
      notes: orders.notes,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      sessionType: tableSessions.sessionType,
      sessionTableNumber: tableSessions.tableNumber,
    })
    .from(orders)
    .leftJoin(tableSessions, eq(tableSessions.id, orders.sessionId))
    .where(
      and(
        eq(orders.restaurantId, staff.restaurantId),
        inArray(orders.status, ["ordered", "preparing", "ready"]),
      ),
    )
    .orderBy(asc(orders.createdAt));

  if (activeOrders.length === 0) {
    res.json([]);
    return;
  }

  const orderIds = activeOrders.map((o) => o.id);
  const items = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      isVeg: orderItems.isVeg,
      notes: orderItems.notes,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds));

  const itemsByOrder = new Map<number, typeof items>();
  for (const item of items) {
    if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
    itemsByOrder.get(item.orderId)!.push(item);
  }

  const result = activeOrders.map((o) => ({
    id: o.id,
    sessionId: o.sessionId,
    tableId: o.tableId,
    tableNumber: o.tableNumber,
    effectiveTableNumber: o.tableNumber || o.sessionTableNumber || null,
    sessionType: o.sessionType,
    customerName: o.customerName,
    status: o.status,
    notes: o.notes,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    items: itemsByOrder.get(o.id) ?? [],
  }));

  res.json(result);
};

router.post("/staff/connect-pin", pinRateLimiter, connectPin);
router.get("/staff/me", requireStaff, getMe);
router.get("/staff/waiter/orders", requireStaffRole("waiter"), listWaiterOrders);
router.post("/staff/waiter/orders/:orderId/start-prep", requireStaffRole("waiter"), startPreparation);
router.post("/staff/chef/orders/:orderId/ready", requireStaffRole("chef"), chefReady);
router.post("/staff/waiter/orders/:orderId/ready", requireStaffRole("waiter"), waiterReady);
router.post("/staff/waiter/orders/:orderId/emergency-ready", requireStaffRole("waiter"), waiterEmergencyReady);
router.post("/staff/waiter/orders/:orderId/complete", requireStaffRole("waiter"), waiterComplete);
router.get("/staff/chef/orders", requireStaffRole("chef"), listChefOrders);

export default router;
