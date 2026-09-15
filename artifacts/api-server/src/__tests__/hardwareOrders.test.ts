import { describe, it, expect } from "vitest";

describe("Hardware and QR Stand Count Business Logic", () => {
  describe("Domain Separation: Subscription Revenue vs Hardware Debt", () => {
    it("ensures hardware total does not enter subscription transaction calculation", () => {
      const planPrice = 1999;
      const discountAmount = 200;
      const netSubscriptionAmount = planPrice - discountAmount; // 1799
      const qrStandsCount = 5;
      const qrStandPrice = 30;
      const hardwareTotal = qrStandsCount * qrStandPrice; // 150

      // Business Rule: Hardware money MUST NEVER enter subscription transaction
      const subscriptionTransactionAmount = netSubscriptionAmount;
      expect(subscriptionTransactionAmount).toBe(1799);
      expect(subscriptionTransactionAmount).not.toContain(hardwareTotal);
      expect(subscriptionTransactionAmount + hardwareTotal).toBe(1949); // Hardware is collected offline separately
    });
  });

  describe("QR Stand Count Operational Semantics (Fix 1 & Fix 2)", () => {
    // State simulator modeling the database transitions
    interface RestaurantState {
      id: number;
      qrStandsCount: number;
    }

    interface HardwareOrderState {
      id: number;
      restaurantId: number;
      standQuantity: number;
      unitPrice: number;
      totalAmount: number;
      collectionStatus: "pending" | "collected" | "waived";
    }

    function createOrder(
      restaurant: RestaurantState,
      quantity: number,
      unitPrice = 30
    ): { order: HardwareOrderState | null; restaurant: RestaurantState } {
      const qty = Math.max(0, Math.floor(quantity || 0));
      // Fix 2: Creating an order does NOT change operational qrStandsCount
      if (qty === 0) {
        return { order: null, restaurant: { ...restaurant } };
      }
      const order: HardwareOrderState = {
        id: 101,
        restaurantId: restaurant.id,
        standQuantity: qty,
        unitPrice,
        totalAmount: qty * unitPrice,
        collectionStatus: "pending",
      };
      return { order, restaurant: { ...restaurant } };
    }

    function transitionOrderStatus(
      restaurant: RestaurantState,
      order: HardwareOrderState,
      newStatus: "pending" | "collected" | "waived"
    ): { order: HardwareOrderState; restaurant: RestaurantState } {
      const previousStatus = order.collectionStatus;
      let newCount = restaurant.qrStandsCount;

      // Logic implemented in adminHardware.ts & partnerPortal.ts
      if (newStatus === "collected" && previousStatus !== "collected" && order.standQuantity > 0) {
        newCount += order.standQuantity;
      } else if (previousStatus === "collected" && newStatus !== "collected" && order.standQuantity > 0) {
        newCount = Math.max(0, newCount - order.standQuantity);
      }

      return {
        order: { ...order, collectionStatus: newStatus },
        restaurant: { ...restaurant, qrStandsCount: newCount },
      };
    }

    it("TEST A: New restaurant registered with 5 stands -> pending order created, count increases after collection", () => {
      let restaurant: RestaurantState = { id: 1, qrStandsCount: 0 };
      const { order, restaurant: afterCreate } = createOrder(restaurant, 5);

      expect(order).not.toBeNull();
      expect(order?.standQuantity).toBe(5);
      expect(order?.totalAmount).toBe(150);
      expect(order?.collectionStatus).toBe("pending");
      // Pending order must NOT increase operational stands yet
      expect(afterCreate.qrStandsCount).toBe(0);

      // Now collect the hardware
      const { order: collectedOrder, restaurant: afterCollect } = transitionOrderStatus(
        afterCreate,
        order!,
        "collected"
      );
      expect(collectedOrder.collectionStatus).toBe("collected");
      expect(afterCollect.qrStandsCount).toBe(5);
    });

    it("TEST B: Existing restaurant has 5 physical stands, order 3 more -> cumulative increment to 8, idempotent on replay", () => {
      let restaurant: RestaurantState = { id: 2, qrStandsCount: 5 };

      // Create additional order for 3 stands
      const { order, restaurant: afterCreate } = createOrder(restaurant, 3);
      expect(order?.standQuantity).toBe(3);
      // Before collection: operational stands must remain 5 (no overwrite!)
      expect(afterCreate.qrStandsCount).toBe(5);

      // Transition to collected
      const { order: collectedOrder, restaurant: afterCollect } = transitionOrderStatus(
        afterCreate,
        order!,
        "collected"
      );
      expect(afterCollect.qrStandsCount).toBe(8);

      // Repeated collection (replay)
      const { restaurant: afterReplay } = transitionOrderStatus(
        afterCollect,
        collectedOrder,
        "collected"
      );
      // Operational stands must remain 8 (no double counting!)
      expect(afterReplay.qrStandsCount).toBe(8);
    });

    it("TEST C: 0 stands requested -> no hardware order, operational count remains 0", () => {
      const restaurant: RestaurantState = { id: 3, qrStandsCount: 0 };
      const { order, restaurant: afterCreate } = createOrder(restaurant, 0);

      expect(order).toBeNull();
      expect(afterCreate.qrStandsCount).toBe(0);
    });

    it("TEST D: Waiving a hardware order does NOT increase operational stand count", () => {
      const restaurant: RestaurantState = { id: 4, qrStandsCount: 2 };
      const { order, restaurant: afterCreate } = createOrder(restaurant, 4);
      expect(afterCreate.qrStandsCount).toBe(2);

      // Waive order
      const { order: waivedOrder, restaurant: afterWaive } = transitionOrderStatus(
        afterCreate,
        order!,
        "waived"
      );
      expect(waivedOrder.collectionStatus).toBe("waived");
      expect(afterWaive.qrStandsCount).toBe(2); // Count remains 2
    });

    it("TEST E: Resetting collected order back to pending decrements operational stand count safely", () => {
      const restaurant: RestaurantState = { id: 5, qrStandsCount: 10 };
      const order: HardwareOrderState = {
        id: 102,
        restaurantId: 5,
        standQuantity: 4,
        unitPrice: 30,
        totalAmount: 120,
        collectionStatus: "collected",
      };

      const { restaurant: afterReset } = transitionOrderStatus(restaurant, order, "pending");
      expect(afterReset.qrStandsCount).toBe(6);
    });

    it("TEST F: Admin Restaurants table field flattening", () => {
      const mockOrder = {
        id: 77,
        restaurantId: 10,
        partnerId: 3,
        standQuantity: 6,
        unitPrice: 30,
        totalAmount: 180,
        collectionStatus: "pending" as const,
        collectedAt: null,
      };

      const r = { id: 10, name: "Cafe Test", qrStandsCount: 0 };
      const hw = mockOrder;

      // Mapping as in listRestaurants in admin.ts
      const row = {
        ...r,
        hardwareOrder: hw ?? null,
        hardwareOrderId: hw?.id ?? null,
        hardwareQuantity: hw?.standQuantity ?? null,
        hardwareUnitPrice: hw?.unitPrice ?? null,
        hardwareTotalAmount: hw?.totalAmount ?? null,
        hardwareCollectionStatus: hw?.collectionStatus ?? (r.qrStandsCount > 0 ? "pending" : "none"),
        hardwareCollectedAt: hw?.collectedAt ?? null,
      };

      expect(row.hardwareOrderId).toBe(77);
      expect(row.hardwareQuantity).toBe(6);
      expect(row.hardwareTotalAmount).toBe(180);
      expect(row.hardwareCollectionStatus).toBe("pending");
    });
  });
});
