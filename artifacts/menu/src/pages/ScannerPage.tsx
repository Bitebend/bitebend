import { useLocation } from "wouter";
import { QrCode, ArrowLeft, Camera, Sparkles } from "lucide-react";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  mutedBg: "#f5f0eb",
} as const;

export default function ScannerPage() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" showScanner={false} title="Scanner" />

      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "32px 16px 56px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        {/* Scanner Title Section */}
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: C.ink,
            }}
          >
            Scan
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Scan a QR code to access a Bitebend service.
          </p>
        </section>

        {/* Scanner Viewfinder Shell */}
        <section
          style={{
            backgroundColor: "#18181b",
            borderRadius: "24px",
            padding: "48px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "24px",
            position: "relative",
            overflow: "hidden",
            boxShadow: "0 8px 30px rgba(0, 0, 0, 0.15)",
          }}
        >
          {/* Target Reticle Frame */}
          <div
            style={{
              width: "220px",
              height: "220px",
              borderRadius: "20px",
              border: "2px dashed rgba(255, 255, 255, 0.35)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              position: "relative",
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            }}
          >
            {/* Reticle corner accents */}
            <div
              style={{
                position: "absolute",
                top: "-2px",
                left: "-2px",
                width: "20px",
                height: "20px",
                borderTop: `3px solid ${C.orange}`,
                borderLeft: `3px solid ${C.orange}`,
                borderTopLeftRadius: "18px",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "-2px",
                right: "-2px",
                width: "20px",
                height: "20px",
                borderTop: `3px solid ${C.orange}`,
                borderRight: `3px solid ${C.orange}`,
                borderTopRightRadius: "18px",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: "-2px",
                left: "-2px",
                width: "20px",
                height: "20px",
                borderBottom: `3px solid ${C.orange}`,
                borderLeft: `3px solid ${C.orange}`,
                borderBottomLeftRadius: "18px",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: "-2px",
                right: "-2px",
                width: "20px",
                height: "20px",
                borderBottom: `3px solid ${C.orange}`,
                borderRight: `3px solid ${C.orange}`,
                borderBottomRightRadius: "18px",
              }}
            />

            <Camera style={{ width: "36px", height: "36px", color: "rgba(255, 255, 255, 0.6)" }} />
            <span
              style={{
                color: "#ffffff",
                fontWeight: 700,
                fontSize: "14px",
                letterSpacing: "0.02em",
              }}
            >
              QR Scanner
            </span>
          </div>

          {/* Scanner Status Notice */}
          <div style={{ textAlign: "center", maxWidth: "300px" }}>
            <span
              style={{
                display: "inline-block",
                fontSize: "12px",
                fontWeight: 700,
                color: "#ffffff",
                backgroundColor: "rgba(234, 88, 12, 0.25)",
                border: "1px solid rgba(234, 88, 12, 0.45)",
                padding: "6px 14px",
                borderRadius: "20px",
                letterSpacing: "0.02em",
              }}
            >
              Scanner coming soon
            </span>
            <p
              style={{
                margin: "12px 0 0 0",
                fontSize: "13px",
                color: "rgba(255, 255, 255, 0.65)",
                lineHeight: 1.45,
              }}
            >
              Camera viewfinder will initialize here to scan Bitebend platform QR codes.
            </p>
          </div>
        </section>

        {/* Platform Capability Note */}
        <div
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "16px",
            padding: "16px 20px",
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
          }}
        >
          <Sparkles style={{ width: "18px", height: "18px", color: C.orange, flexShrink: 0, marginTop: "2px" }} />
          <div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: C.ink, marginBottom: "2px" }}>
              Bitebend Platform Scanner
            </div>
            <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.45, color: C.muted }}>
              The scanner is architecturally isolated to support services across Restaurant, Messaging, and future platforms.
            </p>
          </div>
        </div>

        {/* Back Navigation Link */}
        <div style={{ textAlign: "center" }}>
          <button
            onClick={() => navigate("/")}
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <ArrowLeft style={{ width: "14px", height: "14px" }} />
            <span>Return to Bitebend Home</span>
          </button>
        </div>
      </main>
    </div>
  );
}
