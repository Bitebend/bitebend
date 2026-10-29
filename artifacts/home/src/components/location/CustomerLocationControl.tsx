import React, { useState, useEffect } from "react";
import { useCustomerLocation } from "@/context/LocationContext";
import {
  MapPin,
  Navigation,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  Loader2,
  RefreshCw,
  Building2,
  Compass,
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
const POPULAR_CITIES = [
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

export function CustomerLocationControl() {
  const {
    location,
    isDetecting,
    error,
    detectLocation,
    setManualLocation,
    clearLocation,
    clearError,
  } = useCustomerLocation();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"gps" | "manual">("gps");

  // Manual Form State
  const [cityInput, setCityInput] = useState(location?.city ?? "");
  const [localityInput, setLocalityInput] = useState(location?.locality ?? "");
  const [manualFormError, setManualFormError] = useState<string | null>(null);

  // Sync inputs when location changes
  useEffect(() => {
    if (location?.mode === "manual") {
      setCityInput(location.city ?? "");
      setLocalityInput(location.locality ?? "");
    }
  }, [location]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isModalOpen) {
        setIsModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen]);

  const handleOpenModal = (tab: "gps" | "manual" = "gps") => {
    clearError();
    setManualFormError(null);
    setActiveTab(tab);
    if (location?.mode === "manual") {
      setCityInput(location.city ?? "");
      setLocalityInput(location.locality ?? "");
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    clearError();
    setManualFormError(null);
  };

  const handleGpsTrigger = async () => {
    clearError();
    const result = await detectLocation();
    if (result) {
      setIsModalOpen(false);
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
    setIsModalOpen(false);
  };

  const handleSelectQuickCity = (city: string) => {
    setCityInput(city);
    setManualFormError(null);
  };

  return (
    <>
      {/* ── Main Home Location Control Card ────────────────────────────── */}
      <section
        aria-label="Customer Location"
        style={{
          backgroundColor: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: "20px",
          padding: "20px 24px",
          boxShadow: "0 2px 10px rgba(0, 0, 0, 0.02)",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "12px",
                backgroundColor: location ? C.emeraldBg : C.orangeBg,
                border: `1px solid ${location ? C.emeraldBorder : C.orangeBorder}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <MapPin
                style={{
                  width: "22px",
                  height: "22px",
                  color: location ? C.emerald : C.orange,
                }}
              />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: location ? C.emerald : C.orange,
                  }}
                >
                  {location ? "Your Location" : "Set Your Location"}
                </span>

                {location && (
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: "12px",
                      backgroundColor: location.mode === "gps" ? C.emeraldBg : "#eff6ff",
                      color: location.mode === "gps" ? C.emerald : "#1d4ed8",
                      border: `1px solid ${location.mode === "gps" ? C.emeraldBorder : "#bfdbfe"}`,
                    }}
                  >
                    {location.mode === "gps" ? "GPS Detected" : "Area Selected"}
                  </span>
                )}
              </div>

              <div
                style={{
                  fontSize: "17px",
                  fontWeight: 700,
                  color: C.ink,
                  marginTop: "2px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>{location ? location.displayName : "Discover Services Near You"}</span>
                {location && <CheckCircle2 style={{ width: "16px", height: "16px", color: C.emerald }} />}
              </div>

              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                {location ? (
                  location.mode === "gps" ? (
                    "High-accuracy device GPS position active"
                  ) : (
                    `Manual location: ${location.city ?? ""}`
                  )
                ) : (
                  "Use GPS or pick your city to find Bitebend platforms and restaurants"
                )}
              </div>
            </div>
          </div>

          {/* If location is set, provide Change / Clear quick buttons */}
          {location && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                type="button"
                onClick={() => handleOpenModal(location.mode)}
                style={{
                  height: "32px",
                  padding: "0 12px",
                  borderRadius: "16px",
                  backgroundColor: C.mutedBg,
                  border: `1px solid ${C.border}`,
                  fontSize: "12px",
                  fontWeight: 600,
                  color: C.ink,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                  transition: "background-color 0.15s ease",
                }}
                title="Change your location"
              >
                <RefreshCw style={{ width: "12px", height: "12px", color: C.muted }} />
                <span>Change</span>
              </button>
              <button
                type="button"
                onClick={clearLocation}
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "16px",
                  backgroundColor: "transparent",
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: C.muted,
                  cursor: "pointer",
                }}
                title="Clear saved location"
                aria-label="Clear saved location"
              >
                <X style={{ width: "16px", height: "16px" }} />
              </button>
            </div>
          )}
        </div>

        {/* Action Buttons if Location is NOT set */}
        {!location && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
              paddingTop: "4px",
            }}
          >
            <button
              type="button"
              onClick={handleGpsTrigger}
              disabled={isDetecting}
              style={{
                height: "40px",
                padding: "0 18px",
                borderRadius: "20px",
                backgroundColor: C.orange,
                color: "#ffffff",
                border: "none",
                fontSize: "13px",
                fontWeight: 600,
                cursor: isDetecting ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                boxShadow: "0 2px 6px rgba(234, 88, 12, 0.25)",
                transition: "opacity 0.15s ease",
                opacity: isDetecting ? 0.75 : 1,
              }}
            >
              {isDetecting ? (
                <>
                  <Loader2 style={{ width: "16px", height: "16px", animation: "spin 1s linear infinite" }} />
                  <span>Detecting Location…</span>
                </>
              ) : (
                <>
                  <Navigation style={{ width: "16px", height: "16px" }} />
                  <span>Use My Location</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleOpenModal("manual")}
              style={{
                height: "40px",
                padding: "0 18px",
                borderRadius: "20px",
                backgroundColor: C.mutedBg,
                color: C.ink,
                border: `1px solid ${C.border}`,
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                transition: "background-color 0.15s ease",
              }}
            >
              <Building2 style={{ width: "16px", height: "16px", color: C.muted }} />
              <span>Choose Area</span>
            </button>
          </div>
        )}

        {/* Global detection error banner if present */}
        {error && (
          <div
            style={{
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "12px",
              padding: "10px 14px",
              fontSize: "12px",
              color: "#991b1b",
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
            }}
          >
            <AlertCircle style={{ width: "16px", height: "16px", color: "#dc2626", flexShrink: 0, marginTop: "1px" }} />
            <div style={{ flex: 1 }}>
              <span>{error}</span>
              <div style={{ marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={() => handleOpenModal("manual")}
                  style={{
                    backgroundColor: "transparent",
                    border: "none",
                    padding: 0,
                    color: C.orange,
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                    fontSize: "12px",
                  }}
                >
                  Choose area manually instead →
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={clearError}
              style={{
                backgroundColor: "transparent",
                border: "none",
                color: "#991b1b",
                cursor: "pointer",
                padding: 0,
              }}
              aria-label="Dismiss error"
            >
              <X style={{ width: "14px", height: "14px" }} />
            </button>
          </div>
        )}
      </section>

      {/* ── Location Selection Modal Overlay ───────────────────────────── */}
      {isModalOpen && (
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
            if (e.target === e.currentTarget) handleCloseModal();
          }}
        >
          <div
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
                  Choose how you want Bitebend to detect your location
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
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
            >
              <button
                type="button"
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
                      width: "64px",
                      height: "64px",
                      borderRadius: "50%",
                      backgroundColor: C.orangeBg,
                      border: `2px solid ${C.orangeBorder}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "8px auto 0",
                    }}
                  >
                    <Compass style={{ width: "32px", height: "32px", color: C.orange }} />
                  </div>

                  <div>
                    <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 700, color: C.ink }}>
                      Automatic Device Geolocation
                    </h4>
                    <p style={{ margin: 0, fontSize: "13px", color: C.muted, lineHeight: 1.5 }}>
                      Bitebend will request access to your device GPS to detect your approximate location.
                      Your coordinates are kept strictly private on your device.
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

                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
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
                          <span>Detecting GPS Location…</span>
                        </>
                      ) : (
                        <>
                          <Navigation style={{ width: "18px", height: "18px" }} />
                          <span>Detect My Location Now</span>
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
                      Or select your city manually →
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 2: Manual Area Selection */}
              {activeTab === "manual" && (
                <form onSubmit={handleManualSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <label
                      htmlFor="city-input"
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
                    <div style={{ position: "relative" }}>
                      <input
                        id="city-input"
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
                      htmlFor="locality-input"
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
                      id="locality-input"
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
                    <span style={{ fontSize: "11px", color: C.muted, marginTop: "4px", display: "block" }}>
                      Helps match restaurants in your neighborhood.
                    </span>
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
                      onClick={handleCloseModal}
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
