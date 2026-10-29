import React from "react";
import { Utensils, MapPin, ArrowRight } from "lucide-react";
import type { DiscoveredRestaurant } from "@/types/discovery";
import { getRestaurantMenuUrl } from "@/lib/navigation";

interface RestaurantDiscoveryCardProps {
  restaurant: DiscoveredRestaurant;
  isGpsMode?: boolean;
}

export function RestaurantDiscoveryCard({
  restaurant,
  isGpsMode = false,
}: RestaurantDiscoveryCardProps) {
  const menuUrl = getRestaurantMenuUrl(restaurant.slug);

  const formatDistance = (km: number | null): string | null => {
    if (km === null || km === undefined) return null;
    if (km < 0.1) return "< 100 m away";
    if (km < 1) return `${Math.round(km * 1000)} m away`;
    return `${km.toFixed(1)} km away`;
  };

  const distanceText = isGpsMode && restaurant.distanceKm !== null
    ? formatDistance(restaurant.distanceKm)
    : null;

  // Format locality and city
  const locationLabel = [restaurant.locality, restaurant.city]
    .filter(Boolean)
    .join(", ");

  return (
    <article
      className="group relative bg-white border border-[#ede8e3] rounded-2xl p-4 sm:p-5 transition-all duration-200 hover:shadow-md hover:border-[#fed7aa] flex flex-col justify-between"
      style={{
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.02)",
      }}
    >
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          {/* Logo or Fallback Avatar */}
          <div className="flex items-center gap-3 min-w-0">
            {restaurant.logoUrl ? (
              <img
                src={restaurant.logoUrl}
                alt={`${restaurant.name} logo`}
                className="w-12 h-12 rounded-xl object-cover border border-[#ede8e3] shrink-0"
                loading="lazy"
                onError={(e) => {
                  // Fallback to initial avatar on broken image URL
                  (e.currentTarget as HTMLElement).style.display = "none";
                  const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                  if (fallback) fallback.style.display = "flex";
                }}
              />
            ) : null}

            <div
              className={`w-12 h-12 rounded-xl bg-[#fff7ed] border border-[#fed7aa] text-[#ea580c] font-bold text-lg items-center justify-center shrink-0 ${
                restaurant.logoUrl ? "hidden" : "flex"
              }`}
            >
              {restaurant.name.charAt(0).toUpperCase()}
            </div>

            <div className="min-w-0">
              <h3 className="text-base font-bold text-[#1a0a00] truncate group-hover:text-[#ea580c] transition-colors">
                {restaurant.name}
              </h3>

              {restaurant.cuisineType ? (
                <div className="flex items-center gap-1.5 text-xs text-[#6b7280] mt-0.5">
                  <Utensils className="w-3.5 h-3.5 text-[#ea580c] shrink-0" />
                  <span className="truncate">{restaurant.cuisineType}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Distance Badge for GPS mode */}
          {distanceText ? (
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-[#fff7ed] text-[#ea580c] border border-[#fed7aa] shrink-0">
              <MapPin className="w-3 h-3 text-[#ea580c]" />
              <span>{distanceText}</span>
            </div>
          ) : restaurant.matchType === "locality" && restaurant.locality ? (
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0] shrink-0">
              <MapPin className="w-3 h-3 text-[#059669]" />
              <span className="truncate max-w-[120px]">{restaurant.locality}</span>
            </div>
          ) : null}
        </div>

        {/* Description if present */}
        {restaurant.description ? (
          <p className="text-xs text-[#6b7280] line-clamp-2 mb-3 leading-relaxed">
            {restaurant.description}
          </p>
        ) : null}

        {/* Location Text */}
        {locationLabel ? (
          <div className="flex items-center gap-1.5 text-xs text-[#6b7280] mb-4">
            <MapPin className="w-3.5 h-3.5 text-[#9ca3af] shrink-0" />
            <span className="truncate">{locationLabel}</span>
          </div>
        ) : null}
      </div>

      {/* Action / View Menu */}
      <div className="pt-2 border-t border-[#f5f0eb] flex items-center justify-between mt-auto">
        <span className="text-xs font-medium text-[#9ca3af]">
          Digital Menu & Ordering
        </span>

        <a
          href={menuUrl}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#ea580c] hover:text-[#c2410c] px-3 py-1.5 rounded-lg bg-[#fff7ed] hover:bg-[#ffedd5] transition-colors"
          tabIndex={0}
          aria-label={`View menu for ${restaurant.name}`}
        >
          <span>View Menu</span>
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </a>
      </div>
    </article>
  );
}
