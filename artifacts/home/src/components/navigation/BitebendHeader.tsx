import { useLocation } from "wouter";
import { ArrowLeft, QrCode, MapPin } from "lucide-react";
import { useCustomerLocation } from "@/context/LocationContext";

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

  return (
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
          padding: "0 16px",
          maxWidth: "720px",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        {/* Left: Brand or Back Button */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {showBack ? (
            <button
              onClick={() => navigate(backTo)}
              aria-label="Back to Home"
              title="Back to Home"
              style={{
                height: "36px",
                padding: "0 12px 0 8px",
                borderRadius: "18px",
                backgroundColor: C.mutedBg,
                display: "flex",
                alignItems: "center",
                gap: "6px",
                border: "none",
                cursor: "pointer",
                color: C.ink,
                fontSize: "13px",
                fontWeight: 600,
                transition: "background-color 0.15s ease",
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
                paddingLeft: "10px",
                borderLeft: `1px solid ${C.border}`,
                fontSize: "14px",
                fontWeight: 700,
                color: C.ink,
              }}
            >
              {title}
            </div>
          )}
        </div>

        {/* Right Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {location && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontSize: "12px",
                fontWeight: 600,
                color: C.ink,
                backgroundColor: C.mutedBg,
                padding: "0 10px",
                height: "32px",
                borderRadius: "16px",
                border: `1px solid ${C.border}`,
                maxWidth: "140px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={`Active location: ${location.displayName}`}
            >
              <MapPin style={{ width: "13px", height: "13px", color: C.orange, flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {location.mode === "gps" ? "Current Location" : location.locality || location.city}
              </span>
            </div>
          )}

          {/* Right Action: QR Scanner */}
          {showScanner && (
            <button
              onClick={() => navigate("/scanner")}
              aria-label="Scan QR Code"
              title="Scan QR Code"
              style={{
                height: "36px",
                padding: "0 14px",
                borderRadius: "18px",
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
              }}
            >
              <QrCode style={{ width: "15px", height: "15px" }} />
              <span>Scan QR</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
