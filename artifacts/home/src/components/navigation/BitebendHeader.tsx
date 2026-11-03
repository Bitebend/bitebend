import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, QrCode, MapPin, ChevronDown } from "lucide-react";
import { useCustomerLocation } from "@/context/LocationContext";
import { LocationSelectionModal } from "@/components/location/LocationSelectionModal";

interface BitebendHeaderProps {
  title?: string;
  showBack?: boolean;
  backTo?: string;
  showScanner?: boolean;
}

const C = {
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  orange: "#ea580c",
  mutedBg: "#f5f0eb",
  muted: "#6b7280",
} as const;

export function BitebendHeader({
  title,
  showBack = false,
  backTo = "/",
  showScanner = true,
}: BitebendHeaderProps) {
  const [, navigate] = useLocation();
  const { location } = useCustomerLocation();
  const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);

  // Formats a clean, compact label for mobile header button
  const getLocationLabel = (): string => {
    if (!location) return "Set Location";
    if (location.mode === "gps") return "Near Me";
    return location.locality || location.city || "Selected Area";
  };

  return (
    <>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          backgroundColor: C.card,
          borderBottom: `1px solid ${C.border}`,
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <div
          style={{
            height: "56px",
            padding: "0 12px",
            maxWidth: "720px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          {/* Left: Brand or Back Button */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, minWidth: 0 }}>
            {showBack ? (
              <button
                onClick={() => navigate(backTo)}
                aria-label="Back to Home"
                title="Back to Home"
                style={{
                  height: "36px",
                  padding: "0 10px 0 6px",
                  borderRadius: "18px",
                  backgroundColor: C.mutedBg,
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  border: "none",
                  cursor: "pointer",
                  color: C.ink,
                  fontSize: "13px",
                  fontWeight: 600,
                  transition: "background-color 0.15s ease",
                  flexShrink: 0,
                }}
              >
                <ArrowLeft style={{ width: "16px", height: "16px", color: C.muted }} />
                <span>Home</span>
              </button>
            ) : (
              <div
                onClick={() => navigate("/")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "8px",
                    backgroundColor: C.orange,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 2px 6px rgba(234, 88, 12, 0.35)",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      color: "#ffffff",
                      fontSize: "15px",
                      fontWeight: 900,
                      lineHeight: 1,
                    }}
                  >
                    B
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span
                    style={{
                      fontSize: "16px",
                      fontWeight: 800,
                      color: C.ink,
                      letterSpacing: "-0.02em",
                      lineHeight: 1.1,
                    }}
                  >
                    Bitebend
                  </span>
                  <span
                    className="hidden sm:inline"
                    style={{
                      fontSize: "10px",
                      fontWeight: 600,
                      color: C.muted,
                      letterSpacing: "0.02em",
                    }}
                  >
                    Public Platform
                  </span>
                </div>
              </div>
            )}

            {title && (
              <div
                style={{
                  paddingLeft: "8px",
                  borderLeft: `1px solid ${C.border}`,
                  fontSize: "13px",
                  fontWeight: 700,
                  color: C.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </div>
            )}
          </div>

          {/* Right Actions: Interactive Location Selector & QR Scanner */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            {/* Interactive Location Selector Button */}
            <button
              type="button"
              onClick={() => setIsLocationModalOpen(true)}
              aria-haspopup="dialog"
              aria-label={`Current location: ${location ? location.displayName : "Set location"}. Tap to change.`}
              title={`Current location: ${location ? location.displayName : "Set location"}. Tap to change.`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontSize: "12px",
                fontWeight: 600,
                color: location ? C.ink : C.orange,
                backgroundColor: location ? C.mutedBg : "#fff7ed",
                padding: "0 10px",
                height: "34px",
                borderRadius: "17px",
                border: `1px solid ${location ? C.border : "#fed7aa"}`,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
              className="max-w-[110px] xs:max-w-[140px] sm:max-w-[180px]"
            >
              <MapPin style={{ width: "13px", height: "13px", color: C.orange, flexShrink: 0 }} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "12px",
                }}
              >
                {getLocationLabel()}
              </span>
              <ChevronDown style={{ width: "12px", height: "12px", color: C.muted, flexShrink: 0 }} />
            </button>

            {/* Right Action: QR Scanner */}
            {showScanner && (
              <button
                onClick={() => navigate("/scanner")}
                aria-label="Scan QR Code"
                title="Scan QR Code"
                style={{
                  height: "34px",
                  padding: "0 12px",
                  borderRadius: "17px",
                  backgroundColor: C.orange,
                  color: "#ffffff",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  fontWeight: 700,
                  boxShadow: "0 2px 6px rgba(234, 88, 12, 0.25)",
                  transition: "transform 0.1s ease, box-shadow 0.15s ease",
                  flexShrink: 0,
                }}
              >
                <QrCode style={{ width: "14px", height: "14px" }} />
                <span className="hidden xs:inline">Scan QR</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Standalone Location Selection Modal */}
      <LocationSelectionModal
        isOpen={isLocationModalOpen}
        onClose={() => setIsLocationModalOpen(false)}
      />
    </>
  );
}
