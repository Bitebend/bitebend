import { useState } from "react";
import { useLocation } from "wouter";
import { QrCode, ArrowLeft, Camera, Sparkles, ArrowRight, ExternalLink } from "lucide-react";
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
  const [manualCode, setManualCode] = useState("");

  const handleLaunchCode = (code: string) => {
    const clean = code.trim();
    if (!clean) return;

    // If full URL provided
    if (clean.startsWith("http://") || clean.startsWith("https://")) {
      window.location.href = clean;
      return;
    }

    // Otherwise redirect to menu.bitebend.in
    window.location.href = `https://menu.bitebend.in/${encodeURIComponent(clean)}`;
  };

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" showScanner={false} title="QR Scanner" />

      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "32px 16px 64px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        {/* Title Section */}
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "26px",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: C.ink,
            }}
          >
            Universal QR Scanner
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Scan any physical Bitebend table or counter QR code to instantly launch the digital menu.
          </p>
        </section>

        {/* Viewfinder Shell */}
        <section
          style={{
            backgroundColor: "#0d0907",
            borderRadius: "24px",
            padding: "36px 20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "24px",
            position: "relative",
            overflow: "hidden",
            boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
          }}
        >
          {/* Viewfinder Target */}
          <div
            style={{
              width: "220px",
              height: "220px",
              borderRadius: "20px",
              border: `2px dashed ${C.orange}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              backgroundColor: "rgba(234, 88, 12, 0.05)",
            }}
          >
            {/* Corner Markers */}
            <div
              style={{
                position: "absolute",
                top: "-2px",
                left: "-2px",
                width: "24px",
                height: "24px",
                borderTop: `4px solid ${C.orange}`,
                borderLeft: `4px solid ${C.orange}`,
                borderTopLeftRadius: "12px",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "-2px",
                right: "-2px",
                width: "24px",
                height: "24px",
                borderTop: `4px solid ${C.orange}`,
                borderRight: `4px solid ${C.orange}`,
                borderTopRightRadius: "12px",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: "-2px",
                left: "-2px",
                width: "24px",
                height: "24px",
                borderBottom: `4px solid ${C.orange}`,
                borderLeft: `4px solid ${C.orange}`,
                borderBottomLeftRadius: "12px",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: "-2px",
                right: "-2px",
                width: "24px",
                height: "24px",
                borderBottom: `4px solid ${C.orange}`,
                borderRight: `4px solid ${C.orange}`,
                borderBottomRightRadius: "12px",
              }}
            />

            <div style={{ textAlign: "center", color: "#ffffff" }}>
              <Camera style={{ width: "36px", height: "36px", margin: "0 auto 8px", opacity: 0.8 }} />
              <div style={{ fontSize: "12px", fontWeight: 600, opacity: 0.85 }}>
                Align QR Code in frame
              </div>
            </div>
          </div>

          <div style={{ color: "#d1d5db", fontSize: "13px", textAlign: "center", maxWidth: "280px" }}>
            Point your camera at a Bitebend QR code to automatically detect and open the menu.
          </div>
        </section>

        {/* Quick Test Demo QRs */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Sparkles style={{ width: "18px", height: "18px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Quick Demo QRs
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px" }}>
            <button
              onClick={() => handleLaunchCode("the-grand-bistro")}
              style={{
                padding: "14px 16px",
                borderRadius: "12px",
                backgroundColor: C.bg,
                border: `1px solid ${C.border}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                cursor: "pointer",
              }}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>
                  The Grand Bistro — Table #4
                </div>
                <div style={{ fontSize: "12px", color: C.muted, marginTop: "2px" }}>
                  menu.bitebend.in/the-grand-bistro/table/4
                </div>
              </div>
              <ExternalLink style={{ width: "16px", height: "16px", color: C.orange }} />
            </button>
          </div>
        </section>

        {/* Manual Code Input */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <QrCode style={{ width: "18px", height: "18px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Manual Code Entry
            </h2>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLaunchCode(manualCode);
            }}
            style={{ display: "flex", gap: "10px" }}
          >
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="e.g. the-grand-bistro"
              style={{
                flex: 1,
                height: "44px",
                borderRadius: "12px",
                border: `1px solid ${C.border}`,
                padding: "0 14px",
                fontSize: "14px",
                outline: "none",
                backgroundColor: C.bg,
              }}
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              style={{
                height: "44px",
                padding: "0 18px",
                borderRadius: "12px",
                backgroundColor: manualCode.trim() ? C.orange : "#d1d5db",
                color: "#ffffff",
                border: "none",
                fontSize: "14px",
                fontWeight: 700,
                cursor: manualCode.trim() ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>Open</span>
              <ArrowRight style={{ width: "14px", height: "14px" }} />
            </button>
          </form>
        </section>

        {/* Back Button */}
        <div style={{ textAlign: "center" }}>
          <button
            onClick={() => navigate("/")}
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <ArrowLeft style={{ width: "16px", height: "16px" }} />
            <span>Return to Bitebend Home</span>
          </button>
        </div>
      </main>
    </div>
  );
}
