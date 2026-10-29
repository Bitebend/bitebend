import { Router, type RequestHandler } from "express";
import { db, restaurants } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

/**
 * Centralized discovery radius defaults.
 * 30 km covers typical urban dining travel and delivery radiuses across Indian metros and tier-2 cities.
 */
export const DEFAULT_DISCOVERY_RADIUS_KM = 30;
export const MIN_DISCOVERY_RADIUS_KM = 1;
export const MAX_DISCOVERY_RADIUS_KM = 100;

/**
 * Calculates geographic distance in kilometers between two points using the Haversine formula.
 * Earth mean radius: 6,371.0 km
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  // Defensively clamp 'a' to [0, 1] to prevent NaN for antipodal points due to floating-point rounding
  const clampedA = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  return 6371 * c;
}

export const ALLOWED_DISCOVERY_SORTS = ["nearest", "relevance", "name_asc", "newest"] as const;
export type DiscoverySortOption = (typeof ALLOWED_DISCOVERY_SORTS)[number];

/**
 * Coordinate validator. Ensures value is finite and within standard geographic boundaries.
 */
function isValidCoord(val: unknown, min: number, max: number): val is number {
  if (val === undefined || val === null || val === "") return false;
  const n = typeof val === "number" ? val : Number(val);
  return typeof n === "number" && !isNaN(n) && isFinite(n) && n >= min && n <= max;
}

/**
 * String normalizer for safe, case-insensitive, whitespace-trimmed comparison.
 */
function normalizeString(val: unknown): string {
  if (typeof val !== "string") return "";
  return val.trim().toLowerCase();
}

/**
 * GET & POST /restaurants/discover
 *
 * Public restaurant discovery endpoint.
 *
 * GET: Always returns all eligible active & approved restaurants (catalog mode).
 *      Query parameters are deliberately IGNORED to prevent customer coordinates
 *      from appearing in URL query strings or server access logs.
 *
 * POST: Accepts JSON body with:
 *      - latitude, longitude (for GPS proximity)
 *      - radiusKm (optional, between 1 and 100, defaults to DEFAULT_DISCOVERY_RADIUS_KM)
 *      - city, locality (for manual area matching)
 *      - cuisine (optional, case-insensitive substring match)
 *      - sortBy (optional: "nearest" | "relevance" | "name_asc" | "newest")
 *
 * Returns strictly public restaurant data with proximity distance or area match classification.
 * Public restaurant coordinates (latitude, longitude) are returned for map display.
 * Customer coordinates are NEVER persisted to database, NEVER logged, and NEVER exposed in output.
 */
const discoverRestaurants: RequestHandler = async (req, res) => {
  // If GET, query params are ignored so coordinates can never be passed in URLs.
  // Location discovery is strictly handled via POST JSON body.
  const isPost = req.method === "POST";
  const params: Record<string, unknown> = isPost && req.body && typeof req.body === "object" ? req.body : {};

  const rawLat = params.latitude;
  const rawLng = params.longitude;
  const rawRadius = params.radiusKm;
  const rawCity = params.city;
  const rawLocality = params.locality;
  const rawCuisine = params.cuisine;
  const rawSortBy = params.sortBy;

  const hasGpsParams =
    rawLat !== undefined && rawLat !== null && rawLat !== "" &&
    rawLng !== undefined && rawLng !== null && rawLng !== "";

  let customerLat: number | null = null;
  let customerLng: number | null = null;

  if (hasGpsParams) {
    if (!isValidCoord(rawLat, -90, 90) || !isValidCoord(rawLng, -180, 180)) {
      res.status(400).json({
        error: "Invalid coordinates. Latitude must be between -90 and 90, and longitude between -180 and 180.",
      });
      return;
    }
    customerLat = typeof rawLat === "number" ? rawLat : Number(rawLat);
    customerLng = typeof rawLng === "number" ? rawLng : Number(rawLng);
  }

  // Parse and validate radiusKm (1 <= radiusKm <= 100)
  let radiusKm = DEFAULT_DISCOVERY_RADIUS_KM;
  if (rawRadius !== undefined && rawRadius !== null && rawRadius !== "") {
    if (typeof rawRadius !== "number" && typeof rawRadius !== "string") {
      res.status(400).json({
        error: `Invalid radiusKm. Must be a number between ${MIN_DISCOVERY_RADIUS_KM} and ${MAX_DISCOVERY_RADIUS_KM}.`,
      });
      return;
    }
    const parsedRadius = Number(rawRadius);
    if (
      isNaN(parsedRadius) ||
      !isFinite(parsedRadius) ||
      parsedRadius < MIN_DISCOVERY_RADIUS_KM ||
      parsedRadius > MAX_DISCOVERY_RADIUS_KM
    ) {
      res.status(400).json({
        error: `Invalid radiusKm. Must be a number between ${MIN_DISCOVERY_RADIUS_KM} and ${MAX_DISCOVERY_RADIUS_KM}.`,
      });
      return;
    }
    radiusKm = parsedRadius;
  }

  // Validate cuisine filter (optional string)
  let filterCuisine = "";
  if (rawCuisine !== undefined && rawCuisine !== null) {
    if (typeof rawCuisine !== "string") {
      res.status(400).json({
        error: "Invalid cuisine. Must be a string.",
      });
      return;
    }
    filterCuisine = rawCuisine.trim().toLowerCase();
  }

  // Validate sortBy option
  let sortBy: DiscoverySortOption | undefined = undefined;
  if (rawSortBy !== undefined && rawSortBy !== null && rawSortBy !== "") {
    if (typeof rawSortBy !== "string" || !ALLOWED_DISCOVERY_SORTS.includes(rawSortBy as DiscoverySortOption)) {
      res.status(400).json({
        error: `Invalid sortBy. Must be one of: ${ALLOWED_DISCOVERY_SORTS.join(", ")}.`,
      });
      return;
    }
    sortBy = rawSortBy as DiscoverySortOption;
  }

  const normCity = normalizeString(rawCity);
  const normLocality = normalizeString(rawLocality);

  // ── Query Only Active & Approved Restaurants ───────────────────────────────
  const eligibleRecords = await db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      slug: restaurants.slug,
      description: restaurants.description,
      cuisineType: restaurants.cuisineType,
      logoUrl: restaurants.logoUrl,
      address: restaurants.address,
      locality: restaurants.locality,
      city: restaurants.city,
      state: restaurants.state,
      latitude: restaurants.latitude,
      longitude: restaurants.longitude,
      createdAt: restaurants.createdAt,
    })
    .from(restaurants)
    .where(
      and(
        eq(restaurants.isActive, true),
        eq(restaurants.approvalStatus, "approved")
      )
    );

  // Apply cuisine filter across eligible records if specified
  const filteredRecords = filterCuisine
    ? eligibleRecords.filter(
        (r) => r.cuisineType && r.cuisineType.toLowerCase().includes(filterCuisine)
      )
    : eligibleRecords;

  // ── Mode A: GPS Proximity Discovery ───────────────────────────────────────
  if (customerLat !== null && customerLng !== null) {
    interface GpsCandidate {
      restaurant: (typeof eligibleRecords)[number];
      distanceKm: number;
    }

    const candidates: GpsCandidate[] = [];

    for (const r of filteredRecords) {
      if (
        r.latitude !== null &&
        r.longitude !== null &&
        isValidCoord(r.latitude, -90, 90) &&
        isValidCoord(r.longitude, -180, 180)
      ) {
        const dist = calculateHaversineDistanceKm(customerLat, customerLng, r.latitude, r.longitude);
        if (dist <= radiusKm) {
          candidates.push({ restaurant: r, distanceKm: dist });
        }
      }
    }

    // Default sortBy for GPS is "nearest"
    const activeSort = sortBy || "nearest";

    candidates.sort((a, b) => {
      if (activeSort === "newest") {
        const timeDiff = new Date(b.restaurant.createdAt).getTime() - new Date(a.restaurant.createdAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.restaurant.name.localeCompare(b.restaurant.name);
      }
      if (activeSort === "name_asc") {
        return a.restaurant.name.localeCompare(b.restaurant.name);
      }
      // "nearest" or "relevance" (in GPS proximity mode, relevance is distance)
      const diff = a.distanceKm - b.distanceKm;
      if (Math.abs(diff) > 0.001) return diff;
      return a.restaurant.name.localeCompare(b.restaurant.name);
    });

    const result = candidates.map(({ restaurant, distanceKm }) => ({
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      description: restaurant.description,
      cuisineType: restaurant.cuisineType,
      logoUrl: restaurant.logoUrl,
      locality: restaurant.locality,
      city: restaurant.city,
      state: restaurant.state,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      distanceKm: Math.round(distanceKm * 10) / 10,
      matchType: "gps" as const,
    }));

    res.json({
      mode: "gps",
      total: result.length,
      radiusKm,
      restaurants: result,
    });
    return;
  }

  // ── Mode B: Manual City / Locality Discovery ──────────────────────────────
  if (normCity) {
    interface ManualCandidate {
      restaurant: (typeof eligibleRecords)[number];
      priority: number; // 3 = locality + city, 2 = locality contains + city, 1 = city only
    }

    const candidates: ManualCandidate[] = [];

    for (const r of filteredRecords) {
      const rCity = normalizeString(r.city);
      const rLocality = normalizeString(r.locality);

      // Must at least match city
      if (rCity === normCity || rCity.includes(normCity) || normCity.includes(rCity)) {
        let priority = 1;

        if (normLocality && rLocality) {
          if (rLocality === normLocality) {
            priority = 3;
          } else if (rLocality.includes(normLocality) || normLocality.includes(rLocality)) {
            priority = 2;
          }
        }

        candidates.push({ restaurant: r, priority });
      }
    }

    // Default sortBy for Manual is "relevance"
    const activeSort = sortBy || "relevance";

    candidates.sort((a, b) => {
      if (activeSort === "newest") {
        const timeDiff = new Date(b.restaurant.createdAt).getTime() - new Date(a.restaurant.createdAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.restaurant.name.localeCompare(b.restaurant.name);
      }
      if (activeSort === "name_asc") {
        return a.restaurant.name.localeCompare(b.restaurant.name);
      }
      // "relevance" or "nearest" (in manual mode without coords, nearest falls back to relevance/name)
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.restaurant.name.localeCompare(b.restaurant.name);
    });

    const result = candidates.map(({ restaurant, priority }) => ({
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      description: restaurant.description,
      cuisineType: restaurant.cuisineType,
      logoUrl: restaurant.logoUrl,
      locality: restaurant.locality,
      city: restaurant.city,
      state: restaurant.state,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      distanceKm: null,
      matchType: priority >= 2 ? ("locality" as const) : ("city" as const),
    }));

    res.json({
      mode: "manual",
      total: result.length,
      restaurants: result,
    });
    return;
  }

  // ── Mode C: No Location / General Discovery Fallback ───────────────────────
  // Default sortBy for Mode C is "name_asc"
  const activeSort = sortBy || "name_asc";

  const sortedAll = [...filteredRecords].sort((a, b) => {
    if (activeSort === "newest") {
      const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.name.localeCompare(b.name);
    }
    // "name_asc", "nearest", or "relevance" (in general catalog mode, fallback to name)
    return a.name.localeCompare(b.name);
  });

  const result = sortedAll.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    cuisineType: r.cuisineType,
    logoUrl: r.logoUrl,
    locality: r.locality,
    city: r.city,
    state: r.state,
    latitude: r.latitude,
    longitude: r.longitude,
    distanceKm: null,
    matchType: "all" as const,
  }));

  res.json({
    mode: "all",
    total: result.length,
    restaurants: result,
  });
};

router.get("/restaurants/discover", discoverRestaurants);
router.post("/restaurants/discover", discoverRestaurants);

export default router;
