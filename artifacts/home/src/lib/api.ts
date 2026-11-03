import type { CustomerLocation } from "@/types/location";
import type { DiscoveryResponse, DiscoveryFilterOptions } from "@/types/discovery";

/**
 * Resolves the centralized API base origin.
 *
 * Priorities:
 * 1. VITE_API_URL environment override (if set, stripped of trailing slashes and /api).
 * 2. In browser runtime on localhost / 127.0.0.1 or dev server: relative empty string "" (requests proxy to backend).
 * 3. In browser runtime on bitebend.in or any subdomain: "https://api.bitebend.in".
 * 4. Default production fallback: "https://api.bitebend.in".
 */
export function getApiOrigin(): string {
  let envUrl = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
  if (envUrl.endsWith("/api")) {
    envUrl = envUrl.slice(0, -4);
  }
  if (envUrl) {
    return envUrl;
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    // Local development or container host
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal")) {
      return "";
    }
    // Preview environment on Cloud Run (e.g. ais-dev-...run.app, ais-pre-...run.app)
    // where port 3000 serves both frontend and API routes on the same host
    if (host.includes(".run.app")) {
      return "";
    }
    // Production public Bitebend domain: API is hosted on api.bitebend.in
    if (host === "bitebend.in" || host.endsWith(".bitebend.in")) {
      return "https://api.bitebend.in";
    }
  }

  return "https://api.bitebend.in";
}

/**
 * Builds a clean, fully-qualified API URL without accidental double /api/api segments.
 */
export function buildApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const origin = getApiOrigin();
  if (cleanPath === "/api" || cleanPath.startsWith("/api/")) {
    return `${origin}${cleanPath}`;
  }
  return `${origin}/api${cleanPath}`;
}

export const API_BASE = buildApiUrl("/api");

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

  const url = buildApiUrl("/api/restaurants/discover");

  const response = await fetch(url, {
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
