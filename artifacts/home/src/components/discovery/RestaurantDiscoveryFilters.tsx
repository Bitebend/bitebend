import React from "react";
import { Search, X, ArrowUpDown, MapPin, RotateCcw } from "lucide-react";
import type { SortOption } from "@/types/discovery";

export interface RestaurantDiscoveryFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCuisine: string;
  onCuisineChange: (cuisine: string) => void;
  availableCuisines: string[];
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  isGpsMode: boolean;
  radiusKm: number;
  onRadiusChange: (radius: number) => void;
  onResetFilters: () => void;
  hasActiveFilters: boolean;
  disabled?: boolean;
}

export function RestaurantDiscoveryFilters({
  searchQuery,
  onSearchChange,
  selectedCuisine,
  onCuisineChange,
  availableCuisines,
  sortBy,
  onSortChange,
  isGpsMode,
  radiusKm,
  onRadiusChange,
  onResetFilters,
  hasActiveFilters,
  disabled = false,
}: RestaurantDiscoveryFiltersProps) {
  return (
    <div className="flex flex-col gap-3 p-3.5 bg-[#faf9f6] border border-[#ede8e3] rounded-2xl">
      {/* ── Row 1: Search, Sort & Radius ────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9ca3af] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            disabled={disabled}
            placeholder="Search by restaurant, cuisine, or dish..."
            aria-label="Search restaurants by name, cuisine, or description"
            className="w-full pl-9 pr-8 py-2 text-xs text-[#1a0a00] placeholder:text-[#9ca3af] bg-white border border-[#ede8e3] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#ea580c]/30 focus:border-[#ea580c] transition-all disabled:opacity-50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              disabled={disabled}
              aria-label="Clear search input"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-[#9ca3af] hover:text-[#1a0a00] hover:bg-[#f5f0eb] transition-colors cursor-pointer disabled:pointer-events-none"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Controls: Radius & Sort */}
        <div className="flex items-center flex-wrap gap-2 shrink-0">
          {/* Radius Selector (GPS Mode Only) */}
          {isGpsMode && (
            <div
              className="flex items-center gap-0.5 bg-white border border-[#ede8e3] p-1 rounded-xl"
              role="group"
              aria-label="GPS discovery radius"
            >
              <span className="text-[11px] font-semibold text-[#6b7280] px-1.5 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-[#ea580c]" />
                <span className="hidden xs:inline">Radius:</span>
              </span>
              {[5, 10, 15, 30].map((r) => {
                const isActive = radiusKm === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => onRadiusChange(r)}
                    disabled={disabled}
                    aria-pressed={isActive}
                    aria-label={`Set radius to ${r} kilometers`}
                    className={`px-2 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                      isActive
                        ? "bg-[#ea580c] text-white shadow-xs"
                        : "text-[#6b7280] hover:text-[#1a0a00] hover:bg-[#faf9f6]"
                    }`}
                  >
                    {r}km
                  </button>
                );
              })}
            </div>
          )}

          {/* Sort Selector */}
          <div className="relative inline-flex items-center">
            <label htmlFor="discovery-sort" className="sr-only">
              Sort restaurants
            </label>
            <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[#6b7280]">
              <ArrowUpDown className="w-3.5 h-3.5" />
            </div>
            <select
              id="discovery-sort"
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortOption)}
              disabled={disabled}
              aria-label="Sort restaurants by"
              className="pl-8 pr-7 py-2 text-xs font-semibold text-[#1a0a00] bg-white border border-[#ede8e3] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#ea580c]/30 focus:border-[#ea580c] transition-all cursor-pointer appearance-none disabled:opacity-50"
            >
              <option value="nearest">Nearest</option>
              <option value="relevance">Relevance</option>
              <option value="name_asc">A to Z</option>
              <option value="newest">Newest</option>
            </select>
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[#9ca3af] text-[10px]">
              ▼
            </div>
          </div>

          {/* Reset Filters Button */}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={onResetFilters}
              disabled={disabled}
              aria-label="Reset all discovery filters"
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-semibold text-[#ea580c] hover:text-[#c2410c] bg-[#fff7ed] hover:bg-[#ffedd5] border border-[#fed7aa] rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Row 2: Cuisine Chips (derived from current discovery set) ── */}
      {availableCuisines.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5" role="group" aria-label="Filter by cuisine">
          <span className="text-[11px] font-semibold text-[#6b7280] mr-1">Cuisines:</span>
          {/* "All" chip */}
          <button
            type="button"
            onClick={() => onCuisineChange("")}
            disabled={disabled}
            aria-pressed={selectedCuisine === ""}
            aria-label="Show all cuisines"
            className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
              selectedCuisine === ""
                ? "bg-[#1a0a00] text-white border-[#1a0a00] shadow-xs"
                : "bg-white text-[#6b7280] border-[#ede8e3] hover:text-[#1a0a00] hover:bg-[#faf9f6]"
            }`}
          >
            All
          </button>

          {/* Specific cuisine chips */}
          {availableCuisines.map((cuisine) => {
            const isSelected = selectedCuisine.toLowerCase() === cuisine.toLowerCase();
            return (
              <button
                key={cuisine}
                type="button"
                onClick={() => onCuisineChange(isSelected ? "" : cuisine)}
                disabled={disabled}
                aria-pressed={isSelected}
                aria-label={`Filter by ${cuisine} cuisine`}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                  isSelected
                    ? "bg-[#ea580c] text-white border-[#ea580c] shadow-xs"
                    : "bg-white text-[#6b7280] border-[#ede8e3] hover:text-[#1a0a00] hover:bg-[#faf9f6]"
                }`}
              >
                {cuisine}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
