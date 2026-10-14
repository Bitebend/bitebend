import { useLocation } from "wouter";
import { UtensilsCrossed, Sparkles, ArrowLeft, Layers } from "lucide-react";
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

export default function RestaurantPlatformPage() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" title="Restaurant" />

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
        {/* Platform Hero */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "28px 24px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
            <div
              style={{
                width: "56px",
                height: "56px",
                borderRadius: "16px",
                backgroundColor: C.orangeBg,
                border: "1px solid #ffedd5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <UtensilsCrossed style={{ width: "28px", height: "28px", color: C.orange }} />
            </div>

            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: "12px",
                backgroundColor: C.mutedBg,
                color: C.orange,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Foundation
            </span>
          </div>

          <div>
            <h1
              style={{
                margin: "0 0 8px 0",
                fontSize: "24px",
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: C.ink,
              }}
            >
              Restaurant
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: "15px",
                lineHeight: 1.55,
                color: C.muted,
              }}
            >
              Discover and access Bitebend restaurant services.
            </p>
          </div>

          {/* Action / Placeholder Notice */}
          <div
            style={{
              padding: "16px 18px",
              borderRadius: "14px",
              backgroundColor: C.bg,
              border: `1px solid ${C.border}`,
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <Layers style={{ width: "20px", height: "20px", color: C.orange, flexShrink: 0, marginTop: "2px" }} />
            <div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink, marginBottom: "4px" }}>
                Platform Shell
              </div>
              <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5, color: C.muted }}>
                Restaurant discovery, menus, ordering, and service capabilities will be available here as this platform expands.
              </p>
            </div>
          </div>

          <div>
            <button
              onClick={() => {}}
              style={{
                width: "100%",
                height: "46px",
                borderRadius: "12px",
                backgroundColor: C.orange,
                color: "#ffffff",
                border: "none",
                fontSize: "14px",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                cursor: "pointer",
                boxShadow: "0 2px 6px rgba(234, 88, 12, 0.25)",
              }}
            >
              <Sparkles style={{ width: "16px", height: "16px" }} />
              <span>Open Restaurant Platform</span>
            </button>
          </div>
        </section>

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
