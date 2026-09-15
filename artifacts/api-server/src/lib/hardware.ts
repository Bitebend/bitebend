import { db } from "@workspace/db";
import {
  platformSettings,
  restaurantHardwareOrders,
  restaurants,
  partners,
} from "@workspace/db";
import { eq } from "drizzle-orm";

export const DEFAULT_QR_STAND_PRICE = 30;

/**
 * Reads the current global default QR display stand price from platform_settings.
 * Returns 30 if not set or invalid.
 */
export async function getDefaultQrStandPrice(): Promise<number> {
  try {
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, "default_qr_stand_price"))
      .limit(1);

    if (row?.value) {
      const parsed = parseFloat(row.value);
      if (!isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("[hardware] Error reading default_qr_stand_price:", err);
  }
  return DEFAULT_QR_STAND_PRICE;
}

/**
 * Updates the global default QR display stand price in platform_settings.
 */
export async function setDefaultQrStandPrice(price: number): Promise<number> {
  const safePrice = Math.max(0, Math.round(price * 100) / 100);
  await db
    .insert(platformSettings)
    .values({
      key: "default_qr_stand_price",
      value: String(safePrice),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: {
        value: String(safePrice),
        updatedAt: new Date(),
      },
    });
  return safePrice;
}

interface CreateHardwareOrderParams {
  restaurantId: number;
  partnerId: number | null;
  standQuantity: number;
  unitPrice?: number;
  notes?: string | null;
}

/**
 * Creates a physical hardware order for a restaurant onboarding.
 * Hardware charges are completely separate from subscription revenue and partner commissions.
 */
export async function createHardwareOrder({
  restaurantId,
  partnerId,
  standQuantity,
  unitPrice,
  notes,
}: CreateHardwareOrderParams) {
  const qty = Math.max(0, Math.floor(standQuantity || 0));

  // If 0 stands requested, no pending hardware debt is generated
  if (qty === 0) {
    return null;
  }

  const effectivePrice =
    typeof unitPrice === "number" && unitPrice >= 0
      ? unitPrice
      : await getDefaultQrStandPrice();

  const totalAmount = Math.round(qty * effectivePrice * 100) / 100;

  const [order] = await db
    .insert(restaurantHardwareOrders)
    .values({
      restaurantId,
      partnerId: partnerId || null,
      standQuantity: qty,
      unitPrice: effectivePrice,
      totalAmount,
      collectionStatus: "pending",
      notes: notes || null,
    })
    .returning();

  return order;
}
