import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DiscoveredRestaurant } from "@/types/discovery";
import type { CustomerLocation } from "@/types/location";
import { getRestaurantMenuUrl } from "@/lib/navigation";
import { MapPinOff } from "lucide-react";

interface RestaurantDiscoveryMapProps {
  restaurants: DiscoveredRestaurant[];
  customerLocation: CustomerLocation | null;
  isGpsMode: boolean;
  radiusKm?: number;
}

/**
 * Escapes unsafe characters for HTML injection into Leaflet popup strings.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Validates that a geographic coordinate pair consists of finite numbers
 * within legal terrestrial bounds:
 * - Latitude: [-90, 90]
 * - Longitude: [-180, 180]
 *
 * Explicitly preserves (0, 0) as a valid geographic coordinate.
 * Rejects NaN, Infinity, -Infinity, null, undefined, strings, and out-of-range values.
 */
export function isValidCoordinatePair(
  latitude: unknown,
  longitude: unknown
): latitude is number {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Formats distance in km to user-friendly string.
 */
function formatDistance(km: number | null): string | null {
  if (km === null || km === undefined) return null;
  if (km < 0.1) return "< 100 m away";
  if (km < 1) return `${Math.round(km * 1000)} m away`;
  return `${km.toFixed(1)} km away`;
}

/**
 * Creates a custom SVG restaurant pin icon to avoid Vite missing image asset issues.
 */
function createRestaurantPinIcon(): L.DivIcon {
  return L.divIcon({
    className: "bb-restaurant-map-pin",
    html: `
      <div style="width: 32px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer;">
        <svg viewBox="0 0 24 30" width="32" height="40" style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.32));">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 8.5 12 18 12 18s12-9.5 12-18c0-6.627-5.373-12-12-12z" fill="#ea580c"/>
          <circle cx="12" cy="11" r="5" fill="#ffffff"/>
          <path d="M10 9v4M14 9v4M12 8v6" stroke="#ea580c" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </div>
    `,
    iconSize: [32, 40],
    iconAnchor: [16, 40],
    popupAnchor: [0, -40],
  });
}

/**
 * Creates a custom SVG pulsing beacon icon for the customer's GPS position.
 */
function createCustomerGpsIcon(): L.DivIcon {
  return L.divIcon({
    className: "bb-customer-gps-pin",
    html: `
      <div style="width: 30px; height: 30px; position: relative; display: flex; align-items: center; justify-content: center;">
        <div style="position: absolute; width: 30px; height: 30px; border-radius: 50%; background: rgba(37, 99, 235, 0.3); animation: ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
        <div style="position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #2563eb; border: 3px solid #ffffff; box-shadow: 0 2px 6px rgba(0,0,0,0.35);"></div>
        <div style="position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #ffffff;"></div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16],
  });
}

export function RestaurantDiscoveryMap({
  restaurants,
  customerLocation,
  isGpsMode,
  radiusKm = 30,
}: RestaurantDiscoveryMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const prevBoundsKeyRef = useRef<string>("");

  // Determine valid coordinates among restaurants
  const validRestaurants = restaurants.filter(
    (r): r is DiscoveredRestaurant & { latitude: number; longitude: number } =>
      isValidCoordinatePair(r.latitude, r.longitude)
  );

  const hasCustomerGps = Boolean(
    isGpsMode &&
      isValidCoordinatePair(
        customerLocation?.latitude,
        customerLocation?.longitude
      )
  );

  const customerLat = hasCustomerGps ? (customerLocation!.latitude as number) : null;
  const customerLng = hasCustomerGps ? (customerLocation!.longitude as number) : null;

  // Initialize Leaflet map instance once on mount
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    // Base initial center before layer auto-bounds apply
    const map = L.map(mapContainerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
      scrollWheelZoom: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    markersLayerRef.current = layerGroup;
    mapInstanceRef.current = map;

    // Invalidate size once DOM stabilizes
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    // ResizeObserver to handle container layout changes smoothly
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && mapContainerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        map.invalidateSize();
      });
      resizeObserver.observe(mapContainerRef.current);
    }

    return () => {
      clearTimeout(timer);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      map.remove();
      mapInstanceRef.current = null;
      markersLayerRef.current = null;
    };
  }, []);

  // Sync markers and viewport bounds whenever restaurants, customer location, or radius changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = markersLayerRef.current;
    if (!map || !layerGroup) return;

    // Clear previous markers
    layerGroup.clearLayers();

    const boundsPoints: [number, number][] = [];

    // 1. Customer Location Marker & Proximity Circle
    if (hasCustomerGps && customerLat !== null && customerLng !== null) {
      boundsPoints.push([customerLat, customerLng]);

      const customerMarker = L.marker([customerLat, customerLng], {
        icon: createCustomerGpsIcon(),
        title: "Your Location",
        zIndexOffset: 1000, // keep customer marker on top
      });

      const customerPopupContent = `
        <div style="font-family: inherit; padding: 2px 4px; min-width: 140px;">
          <div style="font-size: 13px; font-weight: 700; color: #1e3a8a; margin-bottom: 2px;">Your Location</div>
          <div style="font-size: 11px; color: #6b7280;">GPS proximity active (${radiusKm} km radius)</div>
        </div>
      `;
      customerMarker.bindPopup(customerPopupContent, {
        closeButton: true,
        className: "bb-map-popup",
      });
      customerMarker.addTo(layerGroup);

      // Render search radius boundary circle
      if (radiusKm && radiusKm > 0) {
        const radiusCircle = L.circle([customerLat, customerLng], {
          radius: radiusKm * 1000,
          color: "#3b82f6",
          weight: 1.5,
          opacity: 0.35,
          dashArray: "4, 6",
          fillColor: "#3b82f6",
          fillOpacity: 0.05,
        });
        radiusCircle.addTo(layerGroup);
      }
    }

    // 2. Restaurant Markers
    validRestaurants.forEach((restaurant) => {
      boundsPoints.push([restaurant.latitude, restaurant.longitude]);

      const marker = L.marker([restaurant.latitude, restaurant.longitude], {
        icon: createRestaurantPinIcon(),
        title: restaurant.name,
      });

      const localityCity = [restaurant.locality, restaurant.city]
        .filter(Boolean)
        .join(", ");

      const distanceText =
        isGpsMode && restaurant.distanceKm !== null
          ? formatDistance(restaurant.distanceKm)
          : null;

      const menuUrl = getRestaurantMenuUrl(restaurant.slug);
      const safeMenuUrl = escapeHtml(menuUrl);

      const popupContent = `
        <div style="font-family: inherit; min-width: 200px; max-width: 260px; padding: 2px 2px 4px 2px;">
          <div style="font-size: 14px; font-weight: 700; color: #1a0a00; line-height: 1.3; margin-bottom: 4px;">
            ${escapeHtml(restaurant.name)}
          </div>
          ${
            restaurant.cuisineType
              ? `<div style="margin-bottom: 6px;">
                  <span style="display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; border-radius: 6px; padding: 2px 6px;">
                    ${escapeHtml(restaurant.cuisineType)}
                  </span>
                </div>`
              : ""
          }
          ${
            localityCity
              ? `<div style="font-size: 11px; color: #6b7280; margin-bottom: 6px; display: flex; align-items: center; gap: 4px;">
                  <span>📍 ${escapeHtml(localityCity)}</span>
                </div>`
              : ""
          }
          ${
            distanceText
              ? `<div style="font-size: 11px; font-weight: 600; color: #ea580c; margin-bottom: 8px;">
                  ${escapeHtml(distanceText)}
                </div>`
              : ""
          }
          <a
            href="${safeMenuUrl}"
            style="display: block; width: 100%; text-align: center; box-sizing: border-box; background: #ea580c; color: #ffffff; text-decoration: none; font-size: 12px; font-weight: 700; padding: 7px 12px; border-radius: 8px; transition: background 0.15s ease;"
            onmouseover="this.style.background='#c2410c'"
            onmouseout="this.style.background='#ea580c'"
          >
            View Menu →
          </a>
        </div>
      `;

      marker.bindPopup(popupContent, {
        closeButton: true,
        className: "bb-map-popup",
      });

      marker.addTo(layerGroup);
    });

    // 3. Viewport auto-fitting without jitter
    const currentBoundsKey = `${boundsPoints
      .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
      .sort()
      .join("|")}_gps_${hasCustomerGps}_r_${radiusKm}`;

    if (currentBoundsKey !== prevBoundsKeyRef.current) {
      prevBoundsKeyRef.current = currentBoundsKey;

      if (boundsPoints.length === 1) {
        map.setView(boundsPoints[0], 14, { animate: true });
      } else if (boundsPoints.length > 1) {
        const bounds = L.latLngBounds(boundsPoints);
        map.fitBounds(bounds, {
          padding: [45, 45],
          maxZoom: 15,
          animate: true,
        });
      }
    }
  }, [
    restaurants,
    customerLocation,
    isGpsMode,
    radiusKm,
    hasCustomerGps,
    customerLat,
    customerLng,
    validRestaurants,
  ]);

  const hasAnyCoordinates = validRestaurants.length > 0 || hasCustomerGps;

  return (
    <div className="relative w-full rounded-2xl overflow-hidden border border-[#ede8e3] bg-[#f8f6f2] shadow-sm">
      {/* Interactive Leaflet Map Container */}
      <div
        ref={mapContainerRef}
        className="w-full h-[460px] sm:h-[520px] z-0"
        tabIndex={0}
        aria-label="Interactive Restaurant Discovery Map"
      />

      {/* Empty Coordinates Overlay */}
      {!hasAnyCoordinates && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/85 backdrop-blur-[2px] p-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#f5f0eb] flex items-center justify-center text-[#6b7280] mb-3">
            <MapPinOff className="w-6 h-6 text-[#9ca3af]" />
          </div>
          <h4 className="text-sm font-bold text-[#1a0a00]">
            No Map Coordinates Available
          </h4>
          <p className="text-xs text-[#6b7280] mt-1 max-w-sm leading-relaxed">
            No restaurant location data is available for these results.
          </p>
        </div>
      )}

      {/* Floating Counter Badge in Top-Right of Map */}
      <div className="absolute top-3 right-3 z-[400] bg-white/95 backdrop-blur-sm border border-[#ede8e3] rounded-xl px-3 py-1.5 shadow-sm flex items-center gap-2 pointer-events-none text-xs font-semibold text-[#1a0a00]">
        <span className="w-2 h-2 rounded-full bg-[#ea580c]" />
        <span>
          {validRestaurants.length} of {restaurants.length} on map
        </span>
      </div>

      {/* Scoped Popup Styles */}
      <style>{`
        .bb-map-popup .leaflet-popup-content-wrapper {
          border-radius: 14px;
          padding: 4px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
          border: 1px solid #ede8e3;
        }
        .bb-map-popup .leaflet-popup-content {
          margin: 6px 8px;
          line-height: 1.4;
        }
        .bb-map-popup .leaflet-popup-tip {
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
      `}</style>
    </div>
  );
}
