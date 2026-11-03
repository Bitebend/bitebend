import React, { useState, useEffect, useRef } from "react";
import { useCustomerLocation } from "@/context/LocationContext";
import {
  Navigation,
  AlertCircle,
  X,
  Loader2,
  Building2,
  Compass,
  Trash2,
} from "lucide-react";

const C = {
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  mutedBg: "#f5f0eb",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  orangeBorder: "#fed7aa",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
  emeraldBorder: "#a7f3d0",
} as const;

// Common metro cities across India for quick one-tap selection
export const POPULAR_CITIES = [
  "Mumbai",
  "Bengaluru",
  "Delhi NCR",
  "Hyderabad",
  "Pune",
  "Kolkata",
  "Chennai",
  "Ahmedabad",
  "Guwahati",
  "Jaipur",
  "Chandigarh",
  "Kochi",
];

export interface LocationSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: "gps" | "manual";
}

export function LocationSelectionModal({
  isOpen,
  onClose,
  defaultTab = "gps",
}: LocationSelectionModalProps) {
  const {
    location,
    isDetecting,
    error,
    detectLocation,
    setManualLocation,
    clearLocation,
    clearError,
  } = useCustomerLocation();

  const [activeTab, setActiveTab] = useState<"gps" | "manual">(defaultTab);
  const [cityInput, setCityInput] = useState(location?.city ?? "");
  const [localityInput, setLocalityInput] = useState(location?.locality ?? "");
  const [manualFormError, setManualFormError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cityInputRef = useRef<HTMLInputElement>(null);

  // Background body scroll locking
  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  // Sync inputs when modal opens or location changes
  useEffect(() => {
    if (isOpen) {
      clearError();
      setManualFormError(null);
      if (location?.mode === "manual") {
        setCityInput(location.city ?? "");
        setLocalityInput(location.locality ?? "");
      } else {
        setCityInput("");
        setLocalityInput("");
      }
      setActiveTab(location?.mode === "manual" ? "manual" : defaultTab);
    }
  }, [isOpen, location, defaultTab, clearError]);

  // Focus restoration to the location trigger button after closing
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      return () => {
        previousFocusRef.current?.focus?.();
      };
    }
  }, [isOpen]);

  // Initial focus inside the modal when opened or tab switches
  useEffect(() => {
    if (!isOpen) return;

    const timer = window.setTimeout(() => {
      if (!modalRef.current) return;
      if (activeTab === "manual" && cityInputRef.current) {
        cityInputRef.current.focus();
        return;
      }
      const focusableSelector =
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusables = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter((el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

      if (focusables.length > 0) {
        focusables[0].focus();
      }
    }, 30);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen, activeTab]);

  // Keyboard navigation: Escape to close and Tab focus trapping
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab") {
        if (!modalRef.current) return;

        const focusableSelector =
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusableElements = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)
        ).filter((el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleGpsTrigger = async () => {
    clearError();
    const result = await detectLocation();
    if (result) {
      onClose();
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cityInput.trim()) {
      setManualFormError("Please enter or select a city.");
      return;
    }
    setManualLocation({
      city: cityInput.trim(),
      locality: localityInput.trim() || undefined,
    });
    onClose();
  };

  const handleSelectQuickCity = (city: string) => {
    setCityInput(city);
    setManualFormError(null);
  };

  const handleClearLocation = () => {
    clearLocation();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="location-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        animation: "fadeIn 0.15s ease-out",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: C.card,
          borderRadius: "24px",
          maxWidth: "500px",
          width: "100%",
          boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
          border: `1px solid ${C.border}`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div>
            <h3
              id="location-modal-title"
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 700,
                color: C.ink,
              }}
            >
              Set Your Location
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: "13px", color: C.muted }}>
              Choose how you want to discover restaurants and menus
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "16px",
              backgroundColor: C.mutedBg,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: C.muted,
            }}
            aria-label="Close location dialog"
          >
            <X style={{ width: "18px", height: "18px" }} />
          </button>
        </div>

        {/* Modal Tabs */}
        <div
          style={{
            display: "flex",
            padding: "12px 24px 0",
            gap: "8px",
            borderBottom: `1px solid ${C.border}`,
            backgroundColor: "#fcfbf9",
          }}
          role="tablist"
          aria-label="Location method"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "gps"}
            onClick={() => {
              setActiveTab("gps");
              clearError();
            }}
            style={{
              flex: 1,
              padding: "10px 14px",
              fontSize: "13px",
              fontWeight: 600,
              backgroundColor: activeTab === "gps" ? C.card : "transparent",
              color: activeTab === "gps" ? C.orange : C.muted,
              border: activeTab === "gps" ? `1px solid ${C.border}` : "1px solid transparent",
              borderBottom: activeTab === "gps" ? `2px solid ${C.orange}` : "2px solid transparent",
              borderRadius: "10px 10px 0 0",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            <Navigation style={{ width: "15px", height: "15px" }} />
            <span>GPS Location</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "manual"}
            onClick={() => {
              setActiveTab("manual");
              clearError();
            }}
            style={{
              flex: 1,
              padding: "10px 14px",
              fontSize: "13px",
              fontWeight: 600,
              backgroundColor: activeTab === "manual" ? C.card : "transparent",
              color: activeTab === "manual" ? C.orange : C.muted,
              border: activeTab === "manual" ? `1px solid ${C.border}` : "1px solid transparent",
              borderBottom: activeTab === "manual" ? `2px solid ${C.orange}` : "2px solid transparent",
              borderRadius: "10px 10px 0 0",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            <Building2 style={{ width: "15px", height: "15px" }} />
            <span>Choose Area</span>
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px 24px" }}>
          {/* TAB 1: GPS Location */}
          {activeTab === "gps" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", textAlign: "center" }}>
              <div
                style={{
                  width: "60px",
                  height: "60px",
                  borderRadius: "50%",
                  backgroundColor: C.orangeBg,
                  border: `2px solid ${C.orangeBorder}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "4px auto 0",
                }}
              >
                <Compass style={{ width: "30px", height: "30px", color: C.orange }} />
              </div>

              <div>
                <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 700, color: C.ink }}>
                  Automatic Device Geolocation
                </h4>
                <p style={{ margin: 0, fontSize: "13px", color: C.muted, lineHeight: 1.5 }}>
                  Bitebend will detect your approximate position to show verified dining and menus near you.
                  Coordinates remain private on your device.
                </p>
              </div>

              {error && (
                <div
                  style={{
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "10px",
                    padding: "10px 12px",
                    fontSize: "12px",
                    color: "#991b1b",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "6px",
                  }}
                >
                  <AlertCircle style={{ width: "16px", height: "16px", color: "#dc2626", flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={handleGpsTrigger}
                  disabled={isDetecting}
                  style={{
                    height: "44px",
                    borderRadius: "22px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "14px",
                    fontWeight: 600,
                    cursor: isDetecting ? "default" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    boxShadow: "0 3px 8px rgba(234, 88, 12, 0.3)",
                    opacity: isDetecting ? 0.75 : 1,
                  }}
                >
                  {isDetecting ? (
                    <>
                      <Loader2 style={{ width: "18px", height: "18px", animation: "spin 1s linear infinite" }} />
                      <span>Detecting Location…</span>
                    </>
                  ) : (
                    <>
                      <Navigation style={{ width: "18px", height: "18px" }} />
                      <span>Detect My Location</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("manual")}
                  style={{
                    height: "36px",
                    backgroundColor: "transparent",
                    border: "none",
                    color: C.muted,
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Or enter your city manually →
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: Manual Area Selection */}
          {activeTab === "manual" && (
            <form onSubmit={handleManualSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label
                  htmlFor="modal-city-input"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: C.ink,
                    marginBottom: "6px",
                  }}
                >
                  City / Town <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  ref={cityInputRef}
                  id="modal-city-input"
                  type="text"
                  placeholder="e.g. Mumbai, Bengaluru, Guwahati"
                  value={cityInput}
                  onChange={(e) => {
                    setCityInput(e.target.value);
                    setManualFormError(null);
                  }}
                  style={{
                    width: "100%",
                    height: "42px",
                    borderRadius: "12px",
                    border: `1px solid ${manualFormError ? "#ef4444" : C.border}`,
                    padding: "0 14px",
                    fontSize: "14px",
                    color: C.ink,
                    backgroundColor: "#ffffff",
                    outline: "none",
                  }}
                />
              </div>

              {/* Popular City Quick-Chips */}
              <div>
                <span style={{ fontSize: "11px", fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Popular Cities:
                </span>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                    marginTop: "6px",
                    maxHeight: "84px",
                    overflowY: "auto",
                  }}
                >
                  {POPULAR_CITIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => handleSelectQuickCity(c)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: "14px",
                        backgroundColor: cityInput.toLowerCase() === c.toLowerCase() ? C.orangeBg : C.mutedBg,
                        border: `1px solid ${cityInput.toLowerCase() === c.toLowerCase() ? C.orangeBorder : C.border}`,
                        color: cityInput.toLowerCase() === c.toLowerCase() ? C.orange : C.ink,
                        fontSize: "12px",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="modal-locality-input"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: C.ink,
                    marginBottom: "6px",
                  }}
                >
                  Locality / Area <span style={{ fontSize: "11px", color: C.muted, fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  id="modal-locality-input"
                  type="text"
                  placeholder="e.g. Koramangala, Bandra West, Dispur"
                  value={localityInput}
                  onChange={(e) => setLocalityInput(e.target.value)}
                  style={{
                    width: "100%",
                    height: "42px",
                    borderRadius: "12px",
                    border: `1px solid ${C.border}`,
                    padding: "0 14px",
                    fontSize: "14px",
                    color: C.ink,
                    backgroundColor: "#ffffff",
                    outline: "none",
                  }}
                />
              </div>

              {manualFormError && (
                <div
                  style={{
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "10px",
                    padding: "8px 12px",
                    fontSize: "12px",
                    color: "#991b1b",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <AlertCircle style={{ width: "14px", height: "14px", color: "#dc2626", flexShrink: 0 }} />
                  <span>{manualFormError}</span>
                </div>
              )}

              <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    flex: 1,
                    height: "42px",
                    borderRadius: "21px",
                    backgroundColor: C.mutedBg,
                    color: C.ink,
                    border: `1px solid ${C.border}`,
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    flex: 2,
                    height: "42px",
                    borderRadius: "21px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    boxShadow: "0 2px 6px rgba(234, 88, 12, 0.25)",
                  }}
                >
                  Set Location
                </button>
              </div>
            </form>
          )}

          {/* Quick Clear option if location is currently active */}
          {location && (
            <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: `1px solid ${C.border}`, textAlign: "center" }}>
              <button
                type="button"
                onClick={handleClearLocation}
                style={{
                  background: "none",
                  border: "none",
                  color: "#dc2626",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <Trash2 style={{ width: "12px", height: "12px" }} />
                <span>Clear current saved location</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
