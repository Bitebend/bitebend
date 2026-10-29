/**
 * Bitebend Customer Restaurant Discovery Types (P3 / P6)
 */

export type DiscoveryMatchType = "gps" | "locality" | "city" | "all";

export type SortOption = "nearest" | "relevance" | "name_asc" | "newest";

export interface DiscoveryFilterOptions {
  radiusKm?: number;
  cuisine?: string;
  sortBy?: SortOption;
}

export interface DiscoveredRestaurant {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  cuisineType: string | null;
  logoUrl: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  matchType: DiscoveryMatchType;
}

export interface DiscoveryResponse {
  mode: DiscoveryMatchType;
  total: number;
  radiusKm?: number;
  matchedCity?: string;
  matchedLocality?: string;
  fallback?: boolean;
  restaurants: DiscoveredRestaurant[];
}
