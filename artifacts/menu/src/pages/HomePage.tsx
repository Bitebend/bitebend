import { useLocation } from "wouter";
import { UtensilsCrossed, ShoppingBag } from "lucide-react";
import { PlatformCard } from "@/components/platform/PlatformCard";

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

export default function HomePage() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      {/* ── Sticky Platform Header ─────────────────────────────── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          backgroundColor: C.card,
          borderBottom: `1px solid ${C.border}`,
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <div
          style={{
            height: "56px",
            padding: "0 16px",
            maxWidth: "680px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          {/* Brand Wordmark */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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
              <span style={{ color: "#ffffff", fontWeight: 900, fontSize: "15px", lineHeight: 1 }}>
                B
              </span>
            </div>
            <span
              style={{
                fontSize: "19px",
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: C.ink,
              }}
            >
              Bitebend
            </span>
          </div>

          {/* Quick Action: My Orders */}
          <button
            onClick={() => navigate("/my-orders")}
            aria-label="My Orders"
            title="My Orders"
            style={{
              height: "36px",
              padding: "0 12px 0 10px",
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
            <ShoppingBag style={{ width: "15px", height: "15px", color: C.orange }} />
            <span>My Orders</span>
          </button>
        </div>
      </header>

      {/* ── Main Container ─────────────────────────────────────── */}
      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "24px 16px 48px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        {/* Welcome Section */}
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
            Welcome to Bitebend
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Your services and platforms, all in one place.
          </p>
        </section>

        {/* Platforms / Services Grid */}
        <section style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2
              style={{
                margin: 0,
                fontSize: "14px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: C.muted,
              }}
            >
              Platforms & Services
            </h2>
            <span style={{ fontSize: "12px", color: C.muted, fontWeight: 500 }}>
              1 available
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "14px",
            }}
          >
            {/* Restaurant Ordering Platform Card */}
            <PlatformCard
              id="restaurant-ordering"
              title="Restaurant Menu & Ordering"
              description="Browse digital menus, order directly from your table, and manage your orders seamlessly at partner restaurants."
              icon={UtensilsCrossed}
              badge="Active"
              note="Scan a restaurant's QR code at your table or counter to open its menu and start ordering."
              actionLabel="View My Orders"
              onClick={() => navigate("/my-orders")}
            />
          </div>
        </section>

        {/* Platform Info Footer Note */}
        <footer
          style={{
            marginTop: "16px",
            paddingTop: "20px",
            borderTop: `1px solid ${C.border}`,
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0, fontSize: "12px", color: C.muted }}>
            Bitebend Multi-Platform Ecosystem
          </p>
        </footer>
      </main>
    </div>
  );
}
