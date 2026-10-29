import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { CustomerLocation, CustomerLocationContextType, ManualLocationInput } from "@/types/location";

const STORAGE_KEY = "bb_customer_location";

const LocationContext = createContext<CustomerLocationContextType | undefined>(undefined);

export const LocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [location, setLocationState] = useState<CustomerLocation | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as CustomerLocation;
      }
    } catch {
      // Ignore localStorage read errors (e.g. private browsing mode)
    }
    return null;
  });

  const [isDetecting, setIsDetecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state to localStorage for session persistence across navigation
  useEffect(() => {
    try {
      if (location) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore localStorage write errors
    }
  }, [location]);

  // ── Option A: Detect Location via Device GPS ──────────────────────────────
  const detectLocation = useCallback(async (): Promise<CustomerLocation | null> => {
    setError(null);

    if (typeof window === "undefined" || !navigator.geolocation) {
      const errMsg = "Location detection isn't supported by this browser. Please choose your area manually.";
      setError(errMsg);
      return null;
    }

    setIsDetecting(true);

    return new Promise<CustomerLocation | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setIsDetecting(false);
          const lat = Number(position.coords.latitude.toFixed(6));
          const lng = Number(position.coords.longitude.toFixed(6));
          const accuracy = position.coords.accuracy ? Math.round(position.coords.accuracy) : null;

          const newLocation: CustomerLocation = {
            mode: "gps",
            latitude: lat,
            longitude: lng,
            locality: null,
            city: null,
            displayName: "Current Location",
            accuracyMeters: accuracy,
            timestamp: Date.now(),
          };

          setLocationState(newLocation);
          setError(null);
          resolve(newLocation);
        },
        (geoError) => {
          setIsDetecting(false);
          let message = "We couldn't detect your location. Please try again or choose your area manually.";

          switch (geoError.code) {
            case geoError.PERMISSION_DENIED:
              message = "Location permission was denied. You can choose your area manually instead.";
              break;
            case geoError.TIMEOUT:
              message = "We couldn't detect your location in time. Please try again or choose your area manually.";
              break;
            case geoError.POSITION_UNAVAILABLE:
              message = "Your location is currently unavailable. Please choose your area manually.";
              break;
          }

          setError(message);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000, // Reuse cached position within 60 seconds if fresh
        }
      );
    });
  }, []);

  // ── Option B: Set Manual Area Location ────────────────────────────────────
  const setManualLocation = useCallback((input: ManualLocationInput) => {
    const cleanCity = input.city.trim();
    const cleanLocality = input.locality?.trim() || null;

    if (!cleanCity) {
      setError("Please enter or select a city.");
      return;
    }

    const displayName = cleanLocality ? `${cleanLocality}, ${cleanCity}` : cleanCity;

    const newLocation: CustomerLocation = {
      mode: "manual",
      latitude: null,
      longitude: null,
      locality: cleanLocality,
      city: cleanCity,
      displayName,
      accuracyMeters: null,
      timestamp: Date.now(),
    };

    setLocationState(newLocation);
    setError(null);
  }, []);

  const clearLocation = useCallback(() => {
    setLocationState(null);
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <LocationContext.Provider
      value={{
        location,
        isDetecting,
        error,
        detectLocation,
        setManualLocation,
        clearLocation,
        clearError,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
};

export function useCustomerLocation(): CustomerLocationContextType {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error("useCustomerLocation must be used within a LocationProvider");
  }
  return context;
}
