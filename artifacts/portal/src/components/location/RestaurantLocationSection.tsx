import React, { useState, useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin, Navigation, Map as MapIcon, CheckCircle2, AlertCircle, RefreshCw, X, Loader2 } from "lucide-react";

export interface RestaurantLocationProps {
  locality: string;
  latitude: number | null;
  longitude: number | null;
  onLocalityChange: (locality: string) => void;
  onCoordinatesChange: (coords: { latitude: number | null; longitude: number | null }) => void;
  isSaved?: boolean; // True if displaying currently saved DB data in Profile
  disabled?: boolean;
}

// Custom SVG restaurant pin for Leaflet to avoid missing image asset issues
const createPinIcon = () => {
  return L.divIcon({
    className: "bb-custom-map-pin",
    html: `
      <div style="position: relative; width: 36px; height: 42px; transform: translate(-50%, -100%);">
        <svg viewBox="0 0 24 30" width="36" height="42" style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.35));">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 18 12 18s12-9 12-18c0-6.627-5.373-12-12-12z" fill="#ea580c"/>
          <circle cx="12" cy="11" r="5" fill="#ffffff"/>
          <path d="M10 9v4M14 9v4M12 8v6" stroke="#ea580c" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
    `,
    iconSize: [36, 42],
    iconAnchor: [18, 42],
  });
};

export const RestaurantLocationSection: React.FC<RestaurantLocationProps> = ({
  locality,
  latitude,
  longitude,
  onLocalityChange,
  onCoordinatesChange,
  isSaved = false,
  disabled = false,
}) => {
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectSuccess, setDetectSuccess] = useState(false);

  // Map Picker Modal State
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [mapSelectedCoords, setMapSelectedCoords] = useState<{ lat: number; lng: number } | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const hasCoordinates = latitude !== null && longitude !== null;

  // ── Method A: Detect Current Location via Geolocation API ─────────────────
  const handleDetectLocation = () => {
    setDetectError(null);
    setDetectSuccess(false);

    if (!navigator.geolocation) {
      setDetectError("Geolocation is not supported by your browser. Please use 'Choose on Map'.");
      return;
    }

    setIsDetecting(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsDetecting(false);
        const lat = Number(position.coords.latitude.toFixed(6));
        const lng = Number(position.coords.longitude.toFixed(6));
        onCoordinatesChange({ latitude: lat, longitude: lng });
        setDetectSuccess(true);
        setTimeout(() => setDetectSuccess(false), 5000);
      },
      (error) => {
        setIsDetecting(false);
        let msg = "Unable to detect your location. You can choose the restaurant location on the map instead.";
        if (error.code === error.PERMISSION_DENIED) {
          msg = "Location permission denied. Please enable location permissions or choose on the map.";
        } else if (error.code === error.TIMEOUT) {
          msg = "Location request timed out. Please try again or choose on the map.";
        }
        setDetectError(msg);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  };

  // ── Method B: Choose on Map ────────────────────────────────────────────────
  const handleOpenMap = () => {
    // Initialise selection with existing coordinates or default India center
    if (latitude !== null && longitude !== null) {
      setMapSelectedCoords({ lat: latitude, lng: longitude });
    } else {
      setMapSelectedCoords(null);
    }
    setIsMapOpen(true);
  };

  const handleConfirmMapLocation = () => {
    if (mapSelectedCoords) {
      const lat = Number(mapSelectedCoords.lat.toFixed(6));
      const lng = Number(mapSelectedCoords.lng.toFixed(6));
      onCoordinatesChange({ latitude: lat, longitude: lng });
      setDetectError(null);
    }
    setIsMapOpen(false);
  };

  // Initialize and update Leaflet Map inside Modal
  useEffect(() => {
    if (!isMapOpen) {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markerRef.current = null;
      }
      return;
    }

    // Small delay to ensure Dialog DOM container is fully mounted
    const timer = setTimeout(() => {
      if (!mapContainerRef.current) return;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
      }

      const defaultCenter: [number, number] =
        mapSelectedCoords ? [mapSelectedCoords.lat, mapSelectedCoords.lng]
        : hasCoordinates ? [latitude as number, longitude as number]
        : [20.5937, 78.9629]; // India center fallback

      const initialZoom = (mapSelectedCoords || hasCoordinates) ? 16 : 5;

      const map = L.map(mapContainerRef.current, {
        center: defaultCenter,
        zoom: initialZoom,
        zoomControl: true,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      const pinIcon = createPinIcon();

      const updateMarker = (lat: number, lng: number) => {
        setMapSelectedCoords({ lat, lng });
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng]);
        } else {
          const marker = L.marker([lat, lng], {
            icon: pinIcon,
            draggable: true,
          }).addTo(map);

          marker.on("dragend", (e) => {
            const pos = e.target.getLatLng();
            setMapSelectedCoords({ lat: pos.lat, lng: pos.lng });
          });

          markerRef.current = marker;
        }
      };

      if (mapSelectedCoords || hasCoordinates) {
        const initialLat = mapSelectedCoords ? mapSelectedCoords.lat : (latitude as number);
        const initialLng = mapSelectedCoords ? mapSelectedCoords.lng : (longitude as number);
        updateMarker(initialLat, initialLng);
      }

      map.on("click", (e: L.LeafletMouseEvent) => {
        updateMarker(e.latlng.lat, e.latlng.lng);
      });

      mapInstanceRef.current = map;
      setTimeout(() => map.invalidateSize(), 200);
    }, 100);

    return () => {
      clearTimeout(timer);
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMapOpen]);

  // Helper format for coordinate display
  const formatCoord = (val: number | null, positiveDir: string, negativeDir: string) => {
    if (val === null) return "";
    const dir = val >= 0 ? positiveDir : negativeDir;
    return `${Math.abs(val).toFixed(4)}° ${dir}`;
  };

  return (
    <div className="space-y-4">
      {/* Locality Input */}
      <div className="space-y-1.5">
        <Label htmlFor="restaurant-locality" className="text-sm font-medium">
          Locality / Area <span className="text-xs text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="restaurant-locality"
          placeholder="e.g. Bandra West, Koramangala, Connaught Place"
          value={locality}
          onChange={(e) => onLocalityChange(e.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Your neighborhood or commercial zone helps diners recognize your location.
        </p>
      </div>

      {/* Restaurant Location Section */}
      <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-orange-600" />
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Restaurant GPS Location</h3>
              {hasCoordinates && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="w-3 h-3" />
                  {isSaved ? "Saved" : "Selected"}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Accurate pin position enables customers to find your restaurant on Bitebend.
            </p>
          </div>

          {hasCoordinates && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onCoordinatesChange({ latitude: null, longitude: null })}
              disabled={disabled}
              className="text-xs text-slate-500 hover:text-red-600 h-7 px-2"
              title="Remove captured coordinates"
            >
              <X className="w-3.5 h-3.5 mr-1" />
              Remove
            </Button>
          )}
        </div>

        {/* Warning Note regarding physical location */}
        <div className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-900/40 rounded-lg p-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>
            <strong>Note:</strong> Make sure you are at the restaurant when using <em>Detect Restaurant Location</em>. If you are registering remotely, please use <em>Choose on Map</em>.
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDetectLocation}
            disabled={disabled || isDetecting}
            className="flex items-center gap-1.5 text-xs border-orange-200 hover:bg-orange-50 hover:text-orange-700 dark:border-orange-900 dark:hover:bg-orange-950"
          >
            {isDetecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-600" />
            ) : (
              <Navigation className="w-3.5 h-3.5 text-orange-600" />
            )}
            <span>{isDetecting ? "Detecting GPS..." : "Detect Restaurant Location"}</span>
          </Button>

          <span className="text-xs text-slate-400">or</span>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpenMap}
            disabled={disabled}
            className="flex items-center gap-1.5 text-xs border-slate-300 hover:bg-slate-100 dark:border-slate-700"
          >
            <MapIcon className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
            <span>{hasCoordinates ? "Change on Map" : "Choose on Map"}</span>
          </Button>
        </div>

        {/* Error notification */}
        {detectError && (
          <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg p-2.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p>{detectError}</p>
            </div>
          </div>
        )}

        {/* Success notification */}
        {detectSuccess && (
          <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 rounded-lg p-2.5 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Restaurant GPS coordinates detected successfully!</span>
          </div>
        )}

        {/* Status indicator when coordinates are set */}
        {hasCoordinates ? (
          <div className="flex items-center justify-between text-xs bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 mt-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                Location captured:
              </span>
              <span className="text-slate-500 font-mono text-[11px]">
                {formatCoord(latitude, "N", "S")}, {formatCoord(longitude, "E", "W")}
              </span>
            </div>
            <button
              type="button"
              onClick={handleOpenMap}
              className="text-orange-600 hover:underline font-medium text-xs flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Change
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic mt-1">
            Location not set. You can set it now or update it anytime later from your restaurant profile.
          </p>
        )}
      </div>

      {/* ── Map Selection Modal ────────────────────────────────────────────── */}
      <Dialog open={isMapOpen} onOpenChange={(open) => { if (!open) setIsMapOpen(false); }}>
        <DialogContent className="max-w-2xl sm:max-w-2xl w-full p-4 sm:p-6">
          <DialogHeader className="space-y-1">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <MapIcon className="w-5 h-5 text-orange-600" />
              Choose Restaurant Location on Map
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Click anywhere on the map to place the restaurant pin, or drag the pin to refine its position.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 mt-2">
            {/* Map Canvas */}
            <div
              ref={mapContainerRef}
              className="w-full h-[360px] rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden relative shadow-inner z-0"
              style={{ minHeight: "360px" }}
            />

            {/* Selection coordinates preview */}
            <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-orange-600 shrink-0" />
                {mapSelectedCoords ? (
                  <span>
                    Selected: <strong>{formatCoord(mapSelectedCoords.lat, "N", "S")}</strong>,{" "}
                    <strong>{formatCoord(mapSelectedCoords.lng, "E", "W")}</strong>
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">
                    Click anywhere on the map above to drop the pin.
                  </span>
                )}
              </div>

              {mapSelectedCoords && (
                <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded">
                  Pin placed ✓
                </span>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsMapOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="bg-orange-600 hover:bg-orange-700 text-white"
                onClick={handleConfirmMapLocation}
                disabled={!mapSelectedCoords}
              >
                Confirm Selected Location
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
