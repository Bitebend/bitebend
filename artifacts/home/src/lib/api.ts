import type { CustomerLocation } from "@/types/location";
import type { DiscoveryResponse, DiscoveryFilterOptions } from "@/types/discovery";

/**
 * Discovers active & approved restaurants based on current customer location
 * and optional discovery filters (radius, cuisine, sortBy).
 *
 * Uses POST to avoid passing customer coordinates or location query strings
 * in server access logs or browser history.
 */
export async function fetchDiscoveredRestaurants(
  location: CustomerLocation | null,
  signal?: AbortSignal
): Promise<DiscoveryResponse>;
export async function fetchDiscoveredRestaurants(
  location: CustomerLocation | null,
  options?: DiscoveryFilterOptions,
  signal?: AbortSignal
): Promise<DiscoveryResponse>;
export async function fetchDiscoveredRestaurants(
  location: CustomerLocation | null,
  optionsOrSignal?: DiscoveryFilterOptions | AbortSignal,
  maybeSignal?: AbortSignal
): Promise<DiscoveryResponse> {
  let options: DiscoveryFilterOptions | undefined;
  let signal: AbortSignal | undefined;

  if (optionsOrSignal instanceof AbortSignal) {
    signal = optionsOrSignal;
  } else if (optionsOrSignal && typeof optionsOrSignal === "object") {
    options = optionsOrSignal;
    signal = maybeSignal;
  }

  const payload: Record<string, unknown> = {};

  if (location) {
    if (location.mode === "gps" && location.latitude !== null && location.longitude !== null) {
      payload.latitude = location.latitude;
      payload.longitude = location.longitude;
    } else if (location.mode === "manual" && location.city) {
      payload.city = location.city;
      if (location.locality) {
        payload.locality = location.locality;
      }
    }
  }

  if (options) {
    if (options.radiusKm !== undefined) {
      payload.radiusKm = options.radiusKm;
    }
    if (options.cuisine !== undefined && options.cuisine.trim() !== "") {
      payload.cuisine = options.cuisine.trim();
    }
    if (options.sortBy !== undefined) {
      payload.sortBy = options.sortBy;
    }
  }

  const response = await fetch("/api/restaurants/discover", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch restaurants (${response.status}): ${errorText || response.statusText}`
    );
  }

  return (await response.json()) as DiscoveryResponse;
}
