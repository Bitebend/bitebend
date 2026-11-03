import { useState, useEffect } from "react";
import { useCustomerLocation } from "@/context/LocationContext";
import { fetchDiscoveredRestaurants } from "@/lib/api";
import type {
  DiscoveredRestaurant,
  DiscoveryResponse,
  SortOption,
} from "@/types/discovery";
import { RestaurantDiscoveryCard } from "./RestaurantDiscoveryCard";
import { RestaurantDiscoveryFilters } from "./RestaurantDiscoveryFilters";
import { RestaurantDiscoveryMap } from "./RestaurantDiscoveryMap";
import {
  Compass,
  LayoutList,
  Map as MapIcon,
  RefreshCw,
  AlertCircle,
  SearchX,
  UtensilsCrossed,
  Building2,
  ArrowLeft,
} from "lucide-react";

export function RestaurantDiscoverySection() {
  const { location, clearLocation } = useCustomerLocation();

  // State
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // View state: 'list' (default) or 'map'
  const [viewMode, setViewMode] = useState<"list" | "map">("list");

  // Discovery Filter State
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCuisine, setSelectedCuisine] = useState<string>("");
  const [selectedSort, setSelectedSort] = useState<SortOption>(() => {
    return location?.mode === "gps"
      ? "nearest"
      : location?.mode === "manual"
      ? "relevance"
      : "name_asc";
  });
  const [selectedRadius, setSelectedRadius] = useState<number>(30); // Default 30km for GPS
  const [availableCuisines, setAvailableCuisines] = useState<string[]>([]);

  // When customer has a location but wants to see all venues anyway without clearing location
  const [showAllUnfiltered, setShowAllUnfiltered] = useState<boolean>(false);

  // Synchronize default sort mode when customer location mode changes
  useEffect(() => {
    if (showAllUnfiltered) {
      setSelectedSort("name_asc");
      return;
    }

    if (location?.mode === "gps") {
      setSelectedSort("nearest");
    } else if (location?.mode === "manual") {
      setSelectedSort("relevance");
    } else {
      setSelectedSort("name_asc");
    }
  }, [location?.mode, showAllUnfiltered]);

  // Reset filters when location or unfiltered toggle changes
  useEffect(() => {
    setSearchQuery("");
    setSelectedCuisine("");
    setSelectedRadius(30);
  }, [location, showAllUnfiltered]);

  // Primary Data Fetching Effect
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const activeLocation = showAllUnfiltered ? null : location;

    const options = {
      radiusKm: activeLocation?.mode === "gps" ? selectedRadius : undefined,
      cuisine: selectedCuisine || undefined,
      sortBy: selectedSort,
    };

    fetchDiscoveredRestaurants(activeLocation, options, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setData(res);
          setLoading(false);
          setError(null);

          // Dynamically derive unique cuisines
          if (res.restaurants && res.restaurants.length > 0) {
            const foundCuisines = Array.from(
              new Set(
                res.restaurants
                  .map((r) => r.cuisineType)
                  .filter((c): c is string => Boolean(c && c.trim()))
              )
            );

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
        if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") {
          return;
        }
        console.error("[RestaurantDiscovery] Fetch error:", err);
        setError("Unable to connect to restaurants right now. Please check your connection and try again.");
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
        subtitle: `Showing all available restaurants across Bitebend (no matches in ${areaName})`,
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

  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedCuisine("");
    setSelectedRadius(30);
    if (location?.mode === "gps") {
      setSelectedSort("nearest");
    } else if (location?.mode === "manual") {
      setSelectedSort("relevance");
    } else {
      setSelectedSort("name_asc");
    }
  };

  const hasActiveFilters = Boolean(
    searchQuery.trim() ||
      selectedCuisine ||
      (location?.mode === "gps" && (selectedSort !== "nearest" || selectedRadius !== 30)) ||
      (location?.mode === "manual" && selectedSort !== "relevance") ||
      (!location && selectedSort !== "name_asc")
  );

  return (
    <section className="flex flex-col gap-3.5">
      {/* ── Section Header Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-[#ede8e3]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-extrabold text-[#1a0a00] flex items-center gap-1.5 truncate">
              <Compass className="w-4 h-4 text-[#ea580c] shrink-0" />
              <span className="truncate">{headerInfo.title}</span>
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#f5f0eb] text-[#6b7280] shrink-0">
              {loading ? "..." : `${filteredRestaurants.length} found`}
            </span>
          </div>
          <p className="text-xs text-[#6b7280] mt-0.5 truncate">{headerInfo.subtitle}</p>
        </div>

        {/* Action Controls: List/Map Switcher, Back/Clear, Refresh */}
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
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
              type="button"
              onClick={() => {
                setShowAllUnfiltered(false);
                handleResetFilters();
              }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#ea580c] hover:text-[#c2410c] px-2.5 py-1.5 rounded-lg bg-[#fff7ed] border border-[#fed7aa] transition-colors cursor-pointer"
              aria-label="Back to filtered area restaurants"
            >
              <ArrowLeft className="w-3 h-3" />
              <span>Back to my area</span>
            </button>
          ) : location ? (
            <button
              type="button"
              onClick={() => clearLocation()}
              className="text-xs font-medium text-[#6b7280] hover:text-[#dc2626] transition-colors cursor-pointer px-1 py-1"
              aria-label="Clear saved location"
            >
              Clear location
            </button>
          ) : null}

          {/* Refresh Action */}
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
            aria-label="Refresh discovery results"
            title="Refresh discovery results"
            className="p-1.5 rounded-lg border border-[#ede8e3] text-[#6b7280] hover:text-[#1a0a00] hover:bg-[#f5f0eb] transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[#ea580c]" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* ── Filter & Search Toolbar (Always accessible) ────────────────── */}
      <RestaurantDiscoveryFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCuisine={selectedCuisine}
        onCuisineChange={setSelectedCuisine}
        availableCuisines={availableCuisines}
        sortBy={selectedSort}
        onSortChange={setSelectedSort}
        isGpsMode={location?.mode === "gps" && !showAllUnfiltered}
        radiusKm={selectedRadius}
        onRadiusChange={setSelectedRadius}
        onResetFilters={handleResetFilters}
        hasActiveFilters={hasActiveFilters}
        disabled={loading && !data}
      />

      {/* ── Loading Skeleton ─────────────────────────────────────────── */}
      {loading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 animate-pulse">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white border border-[#ede8e3] rounded-2xl p-4 sm:p-5 flex flex-col gap-3 min-h-[140px]"
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

      {/* ── Error State (Non-disruptive, preserves filter toolbar) ──────── */}
      {!loading && error && (
        <div className="bg-[#fff7ed] border border-[#fed7aa] rounded-2xl p-5 flex flex-col items-center text-center gap-3">
          <AlertCircle className="w-8 h-8 text-[#ea580c]" />
          <div>
            <h3 className="text-sm font-bold text-[#1a0a00]">Unable to connect to restaurants</h3>
            <p className="text-xs text-[#6b7280] mt-1 max-w-md">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="px-4 py-2 bg-[#ea580c] text-white text-xs font-bold rounded-xl hover:bg-[#c2410c] transition-colors cursor-pointer shadow-xs"
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
            type="button"
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
            type="button"
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
                ? `No active Bitebend partner restaurants are listed in ${
                    location.locality ? `${location.locality}, ${location.city}` : location.city
                  } yet.`
                : `There are currently no active restaurants available on the network.`}
            </p>
          </div>

          {location && !showAllUnfiltered && (
            <button
              type="button"
              onClick={() => setShowAllUnfiltered(true)}
              className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 bg-[#fff7ed] border border-[#fed7aa] text-[#ea580c] text-xs font-bold rounded-xl hover:bg-[#ffedd5] transition-colors cursor-pointer"
            >
              <span>View All Restaurants Across Bitebend</span>
            </button>
          )}
        </div>
      )}

      {/* ── Discovery View: List vs Interactive Map ───────────────────── */}
      {!loading && !error && filteredRestaurants.length > 0 && (
        <>
          {viewMode === "list" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredRestaurants.map((restaurant) => (
                <RestaurantDiscoveryCard
                  key={restaurant.id}
                  restaurant={restaurant}
                  isGpsMode={location?.mode === "gps" && !showAllUnfiltered}
                />
              ))}
            </div>
          ) : (
            <RestaurantDiscoveryMap
              restaurants={filteredRestaurants}
              customerLocation={showAllUnfiltered ? null : location}
              radiusKm={location?.mode === "gps" && !showAllUnfiltered ? selectedRadius : null}
            />
          )}
        </>
      )}
    </section>
  );
}
