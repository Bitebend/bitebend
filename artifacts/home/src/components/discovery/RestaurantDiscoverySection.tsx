import React, { useEffect, useState, useRef } from "react";
import {
  Compass,
  RefreshCw,
  AlertCircle,
  Building2,
  ChevronRight,
  ArrowLeft,
  SearchX,
  UtensilsCrossed,
  LayoutList,
  Map as MapIcon,
} from "lucide-react";
import { useCustomerLocation } from "@/context/LocationContext";
import { fetchDiscoveredRestaurants } from "@/lib/api";
import type {
  DiscoveryResponse,
  DiscoveredRestaurant,
  SortOption,
  DiscoveryFilterOptions,
} from "@/types/discovery";
import type { CustomerLocation } from "@/types/location";
import { RestaurantDiscoveryCard } from "./RestaurantDiscoveryCard";
import { RestaurantDiscoveryFilters } from "./RestaurantDiscoveryFilters";
import { RestaurantDiscoveryMap } from "./RestaurantDiscoveryMap";

/**
 * Returns the canonical default sort option for a given customer location and mode.
 * - GPS: "nearest"
 * - Manual: "relevance"
 * - No Location / View All: "name_asc"
 */
function getDefaultSort(
  location: CustomerLocation | null,
  showAllUnfiltered: boolean
): SortOption {
  if (showAllUnfiltered || !location) return "name_asc";
  if (location.mode === "gps") return "nearest";
  if (location.mode === "manual") return "relevance";
  return "name_asc";
}

export function RestaurantDiscoverySection() {
  const { location, clearLocation } = useCustomerLocation();
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Temporary unfiltered view state for empty-state discovery (Finding 2)
  // Preserves customer P2 location and localStorage intact while displaying all restaurants
  const [showAllUnfiltered, setShowAllUnfiltered] = useState<boolean>(false);

  // Manual refresh trigger incrementor
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // ── P6-B Filter & Sort State ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCuisine, setSelectedCuisine] = useState<string>("");
  const [availableCuisines, setAvailableCuisines] = useState<string[]>([]);
  const [selectedSort, setSelectedSort] = useState<SortOption | null>(null);
  const [selectedRadius, setSelectedRadius] = useState<number>(30);

  // ── P6-C Interactive Map View Mode ────────────────────────────────────────
  const [viewMode, setViewMode] = useState<"list" | "map">("list");

  // Auto-reset filters and temporary unfiltered view when customer changes their actual P2 location
  const prevLocationRef = useRef(location);
  useEffect(() => {
    if (prevLocationRef.current !== location) {
      prevLocationRef.current = location;
      setShowAllUnfiltered(false);
      setSearchQuery("");
      setSelectedCuisine("");
      setSelectedSort(null);
      setSelectedRadius(30);
    }
  }, [location]);

  const isGpsMode = !showAllUnfiltered && location?.mode === "gps";
  const activeSort = selectedSort ?? getDefaultSort(location, showAllUnfiltered);

  // Reset all local filters (preserves customer P5 location)
  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedCuisine("");
    setSelectedSort(null);
    setSelectedRadius(30);
  };

  const defaultSort = getDefaultSort(location, showAllUnfiltered);
  const hasActiveFilters = Boolean(
    searchQuery.trim() ||
      selectedCuisine ||
      (selectedSort !== null && selectedSort !== defaultSort) ||
      (isGpsMode && selectedRadius !== 30)
  );

  // ── Request sequencing and AbortController lifecycle ───────────────────────
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const activeLocation = showAllUnfiltered ? null : location;
    const currentSort = selectedSort ?? getDefaultSort(location, showAllUnfiltered);

    const options: DiscoveryFilterOptions = {
      sortBy: currentSort,
    };

    if (!showAllUnfiltered && location?.mode === "gps") {
      options.radiusKm = selectedRadius;
    }

    if (selectedCuisine) {
      options.cuisine = selectedCuisine;
    }

    fetchDiscoveredRestaurants(activeLocation, options, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setData(res);
          setLoading(false);

          // Harvest available unique cuisines from the result set
          if (res.restaurants && res.restaurants.length > 0) {
            const foundCuisines = res.restaurants
              .map((r) => r.cuisineType?.trim())
              .filter((c): c is string => Boolean(c));

            setAvailableCuisines((prev) => {
              const combined = selectedCuisine
                ? Array.from(new Set([...prev, ...foundCuisines]))
                : Array.from(new Set(foundCuisines));
              return combined.sort((a, b) => a.localeCompare(b));
            });
          }
        }
      })
      .catch((err: unknown) => {
        // Silently ignore aborted requests to prevent stale errors on location changes or unmount
        if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") {
          return;
        }
        console.error("[RestaurantDiscovery] Fetch error:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load nearby restaurants"
        );
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    location,
    showAllUnfiltered,
    refreshKey,
    selectedRadius,
    selectedCuisine,
    selectedSort,
  ]);

  // Derive contextual header text based on location mode & unfiltered override
  const getHeaderInfo = () => {
    if (showAllUnfiltered) {
      const areaName = location?.locality
        ? `${location.locality}, ${location.city}`
        : location?.city || location?.displayName || "your area";

      return {
        title: "All Restaurants",
        subtitle: `Showing all available restaurants (no matches in ${areaName})`,
        badge: "All Locations",
      };
    }

    if (!location) {
      return {
        title: "All Restaurants",
        subtitle: "Explore active dining venues across the Bitebend network",
        badge: "All Locations",
      };
    }

    if (location.mode === "gps") {
      return {
        title: "Restaurants Near You",
        subtitle: `Discovered via your device location within ${selectedRadius} km`,
        badge: "GPS Proximity",
      };
    }

    // Manual mode
    const areaName = location.locality
      ? `${location.locality}, ${location.city}`
      : location.city || "Selected Area";

    return {
      title: `Restaurants in ${areaName}`,
      subtitle: data?.fallback
        ? `No exact matches in ${location.locality || "locality"}, showing nearby restaurants in ${location.city}`
        : `Discovered based on your selected area`,
      badge: location.locality ? "Locality Matched" : "City Matched",
    };
  };

  const headerInfo = getHeaderInfo();
  const rawRestaurants: DiscoveredRestaurant[] = data?.restaurants || [];

  // Client-side search filtering across currently loaded discovery results
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredRestaurants = rawRestaurants.filter((restaurant) => {
    if (!trimmedQuery) return true;
    const nameMatches = restaurant.name.toLowerCase().includes(trimmedQuery);
    const cuisineMatches = restaurant.cuisineType
      ? restaurant.cuisineType.toLowerCase().includes(trimmedQuery)
      : false;
    const descMatches = restaurant.description
      ? restaurant.description.toLowerCase().includes(trimmedQuery)
      : false;
    return nameMatches || cuisineMatches || descMatches;
  });

  return (
    <section className="flex flex-col gap-4">
      {/* ── Section Header ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#ede8e3] pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#1a0a00] flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-[#ea580c]" />
              {headerInfo.title}
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#f5f0eb] text-[#6b7280]">
              {loading ? "..." : `${filteredRestaurants.length} found`}
            </span>
          </div>
          <p className="text-xs text-[#6b7280] mt-0.5">{headerInfo.subtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* List / Map View Toggle */}
          <div
            className="inline-flex items-center p-0.5 bg-[#f5f0eb] rounded-xl border border-[#ede8e3]"
            role="group"
            aria-label="Discovery view mode"
          >
            <button
              type="button"
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
              aria-label="List view"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                viewMode === "list"
                  ? "bg-white text-[#1a0a00] shadow-xs"
                  : "text-[#6b7280] hover:text-[#1a0a00]"
              }`}
            >
              <LayoutList className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">List</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("map")}
              aria-pressed={viewMode === "map"}
              aria-label="Map view"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                viewMode === "map"
                  ? "bg-white text-[#1a0a00] shadow-xs"
                  : "text-[#6b7280] hover:text-[#1a0a00]"
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">Map</span>
            </button>
          </div>

          {showAllUnfiltered ? (
            <button
              onClick={() => {
                setShowAllUnfiltered(false);
                handleResetFilters();
              }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#ea580c] hover:text-[#c2410c] px-2.5 py-1 rounded-lg bg-[#fff7ed] border border-[#fed7aa] transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3 h-3" />
              <span>Back to my area</span>
            </button>
          ) : location ? (
            <button
              onClick={() => clearLocation()}
              className="text-xs font-medium text-[#6b7280] hover:text-[#1a0a00] underline underline-offset-2 transition-colors cursor-pointer"
              aria-label="Clear saved location"
            >
              Clear location
            </button>
          ) : null}

          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
            aria-label="Refresh discovery results"
            className="p-1.5 rounded-lg border border-[#ede8e3] bg-white text-[#6b7280] hover:text-[#1a0a00] hover:bg-[#faf9f6] transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[#ea580c]" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* ── P6-B Filter & Sort Bar ───────────────────────────────────── */}
      <RestaurantDiscoveryFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCuisine={selectedCuisine}
        onCuisineChange={setSelectedCuisine}
        availableCuisines={availableCuisines}
        sortBy={activeSort}
        onSortChange={(sort) => setSelectedSort(sort)}
        isGpsMode={isGpsMode}
        radiusKm={selectedRadius}
        onRadiusChange={setSelectedRadius}
        onResetFilters={handleResetFilters}
        hasActiveFilters={hasActiveFilters}
        disabled={loading && !data}
      />

      {/* ── Loading Skeleton ─────────────────────────────────────────── */}
      {loading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white border border-[#ede8e3] rounded-2xl p-5 animate-pulse flex flex-col gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-gray-200 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-3/4" />
                  <div className="h-3 bg-gray-200 rounded w-1/2" />
                </div>
              </div>
              <div className="h-3 bg-gray-200 rounded w-full" />
              <div className="h-3 bg-gray-200 rounded w-2/3" />
            </div>
          ))}
        </div>
      )}

      {/* ── Error State ──────────────────────────────────────────────── */}
      {!loading && error && (
        <div className="bg-[#fff7ed] border border-[#fed7aa] rounded-2xl p-5 flex flex-col items-center text-center gap-3">
          <AlertCircle className="w-8 h-8 text-[#ea580c]" />
          <div>
            <h3 className="text-sm font-bold text-[#1a0a00]">Unable to load restaurants</h3>
            <p className="text-xs text-[#6b7280] mt-1 max-w-md">{error}</p>
          </div>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="px-4 py-2 bg-[#ea580c] text-white text-xs font-bold rounded-xl hover:bg-[#c2410c] transition-colors cursor-pointer"
          >
            Try Again
          </button>
        </div>
      )}

      {/* ── Empty State 1: Search returned zero results ──────────────── */}
      {!loading && !error && rawRestaurants.length > 0 && filteredRestaurants.length === 0 && (
        <div className="bg-white border border-[#ede8e3] rounded-2xl p-6 sm:p-8 flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-[#f5f0eb] flex items-center justify-center text-[#6b7280]">
            <SearchX className="w-6 h-6 text-[#9ca3af]" />
          </div>

          <div>
            <h3 className="text-base font-bold text-[#1a0a00]">No restaurants match your search</h3>
            <p className="text-xs text-[#6b7280] mt-1 max-w-sm leading-relaxed">
              We couldn&apos;t find any restaurants matching &quot;{searchQuery}&quot;. Try checking for
              spelling errors or search for a different name, cuisine, or dish.
            </p>
          </div>

          <button
            onClick={() => setSearchQuery("")}
            className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 bg-[#fff7ed] border border-[#fed7aa] text-[#ea580c] text-xs font-bold rounded-xl hover:bg-[#ffedd5] transition-colors cursor-pointer"
          >
            Clear Search
          </button>
        </div>
      )}

      {/* ── Empty State 2: Cuisine filter returned zero results from API ─ */}
      {!loading && !error && rawRestaurants.length === 0 && Boolean(selectedCuisine) && (
        <div className="bg-white border border-[#ede8e3] rounded-2xl p-6 sm:p-8 flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-[#f5f0eb] flex items-center justify-center text-[#6b7280]">
            <UtensilsCrossed className="w-6 h-6 text-[#9ca3af]" />
          </div>

          <div>
            <h3 className="text-base font-bold text-[#1a0a00]">
              No {selectedCuisine} restaurants found
            </h3>
            <p className="text-xs text-[#6b7280] mt-1 max-w-sm leading-relaxed">
              There are currently no active partner restaurants offering {selectedCuisine} in this
              area or radius.
            </p>
          </div>

          <button
            onClick={() => setSelectedCuisine("")}
            className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 bg-[#fff7ed] border border-[#fed7aa] text-[#ea580c] text-xs font-bold rounded-xl hover:bg-[#ffedd5] transition-colors cursor-pointer"
          >
            Clear Cuisine Filter
          </button>
        </div>
      )}

      {/* ── Empty State 3: Global / Area has zero restaurants ─────────── */}
      {!loading && !error && rawRestaurants.length === 0 && !selectedCuisine && (
        <div className="bg-white border border-[#ede8e3] rounded-2xl p-6 sm:p-8 flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-[#f5f0eb] flex items-center justify-center text-[#6b7280]">
            <Building2 className="w-6 h-6 text-[#9ca3af]" />
          </div>

          <div>
            <h3 className="text-base font-bold text-[#1a0a00]">No restaurants found</h3>
            <p className="text-xs text-[#6b7280] mt-1 max-w-sm leading-relaxed">
              {location?.mode === "gps"
                ? `No Bitebend partner restaurants were found within ${selectedRadius} km of your current location yet.`
                : location?.mode === "manual"
                ? `No Bitebend partner restaurants are currently listed in ${
                    location.locality ? `${location.locality}, ` : ""
                  }${location.city}.`
                : "There are currently no active Bitebend restaurants listed."}
            </p>
          </div>

          {location && (
            <button
              onClick={() => {
                setShowAllUnfiltered(true);
                handleResetFilters();
              }}
              className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 bg-[#fff7ed] border border-[#fed7aa] text-[#ea580c] text-xs font-bold rounded-xl hover:bg-[#ffedd5] transition-colors cursor-pointer"
            >
              <span>View All Restaurants</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* ── Discovered Restaurants (List or Map View) ────────────────── */}
      {!loading && !error && filteredRestaurants.length > 0 && (
        viewMode === "list" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredRestaurants.map((restaurant) => (
              <RestaurantDiscoveryCard
                key={restaurant.id}
                restaurant={restaurant}
                isGpsMode={!showAllUnfiltered && location?.mode === "gps"}
              />
            ))}
          </div>
        ) : (
          <RestaurantDiscoveryMap
            restaurants={filteredRestaurants}
            customerLocation={showAllUnfiltered ? null : location}
            isGpsMode={isGpsMode}
            radiusKm={selectedRadius}
          />
        )
      )}
    </section>
  );
}
