import { useState } from "react";
import { useLocation } from "wouter";
import {
  UtensilsCrossed,
  Sparkles,
  ArrowLeft,
  QrCode,
  ExternalLink,
  Store,
  Layers,
  ArrowRight,
} from "lucide-react";
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
  const [restaurantCode, setRestaurantCode] = useState("");

  const handleOpenRestaurantCode = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = restaurantCode.trim();
    if (!clean) return;
    const targetUrl = `https://menu.bitebend.in/${encodeURIComponent(clean)}`;
    window.location.href = targetUrl;
  };

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" title="Restaurant Platform" />

      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "32px 16px 64px",
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
              Active Platform
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
              Restaurant Customer Platform
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: "15px",
                lineHeight: 1.55,
                color: C.muted,
              }}
            >
              Access digital menus, contactless QR ordering, table service, and order tracking powered by Bitebend.
            </p>
          </div>

          {/* Primary Action Button */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <a
              href="https://menu.bitebend.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                width: "100%",
                height: "48px",
                borderRadius: "12px",
                backgroundColor: C.orange,
                color: "#ffffff",
                fontSize: "15px",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                textDecoration: "none",
                boxShadow: "0 2px 8px rgba(234, 88, 12, 0.28)",
              }}
            >
              <Sparkles style={{ width: "16px", height: "16px" }} />
              <span>Launch Restaurant App (menu.bitebend.in)</span>
              <ExternalLink style={{ width: "15px", height: "15px" }} />
            </a>

            <button
              onClick={() => navigate("/scanner")}
              style={{
                width: "100%",
                height: "46px",
                borderRadius: "12px",
                backgroundColor: C.orangeBg,
                color: C.orange,
                border: "1px solid #fed7aa",
                fontSize: "14px",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                cursor: "pointer",
              }}
            >
              <QrCode style={{ width: "16px", height: "16px" }} />
              <span>Scan Table or Counter QR Code</span>
            </button>
          </div>
        </section>

        {/* Enter Restaurant Code */}
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
            <Store style={{ width: "20px", height: "20px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: C.ink }}>
              Direct Restaurant Access
            </h2>
          </div>
          <p style={{ margin: 0, fontSize: "14px", color: C.muted, lineHeight: 1.5 }}>
            Know the restaurant code or slug? Enter it here to open their live digital menu directly on menu.bitebend.in.
          </p>

          <form onSubmit={handleOpenRestaurantCode} style={{ display: "flex", gap: "10px" }}>
            <input
              type="text"
              value={restaurantCode}
              onChange={(e) => setRestaurantCode(e.target.value)}
              placeholder="e.g. the-grand-bistro or table-id"
              style={{
                flex: 1,
                height: "44px",
                padding: "0 14px",
                borderRadius: "12px",
                border: `1px solid ${C.border}`,
                fontSize: "14px",
                outline: "none",
                backgroundColor: C.bg,
              }}
            />
            <button
              type="submit"
              disabled={!restaurantCode.trim()}
              style={{
                height: "44px",
                padding: "0 18px",
                borderRadius: "12px",
                backgroundColor: restaurantCode.trim() ? C.ink : "#d1d5db",
                color: "#ffffff",
                border: "none",
                fontSize: "14px",
                fontWeight: 700,
                cursor: restaurantCode.trim() ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>Go</span>
              <ArrowRight style={{ width: "14px", height: "14px" }} />
            </button>
          </form>
        </section>

        {/* Platform Capabilities Breakdown */}
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
            <Layers style={{ width: "20px", height: "20px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: C.ink }}>
              Restaurant Platform Features
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "12px" }}>
            <div style={{ padding: "12px 14px", borderRadius: "12px", backgroundColor: C.bg }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>Digital QR Ordering</div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Scan physical QR codes on tables or counters to view menus and place live orders.
              </div>
            </div>

            <div style={{ padding: "12px 14px", borderRadius: "12px", backgroundColor: C.bg }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>Phone-based Order History</div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Look up order receipts and live kitchen preparation status with no forced passwords.
              </div>
            </div>

            <div style={{ padding: "12px 14px", borderRadius: "12px", backgroundColor: C.bg }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>Direct Restaurant URLs</div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Canonical domain: <code style={{ color: C.orange }}>https://menu.bitebend.in/:restaurantId</code>
              </div>
            </div>
          </div>
        </section>

        {/* Back Link */}
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
