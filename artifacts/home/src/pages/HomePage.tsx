import { useLocation } from "wouter";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";
import { RestaurantDiscoverySection } from "@/components/discovery/RestaurantDiscoverySection";
import { MessageSquare, QrCode, ArrowRight, Sparkles, Utensils, ExternalLink } from "lucide-react";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  ink: "#1a0a00",
  muted: "#6b7280",
  border: "#ede8e3",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
} as const;

export default function HomePage() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      {/* ── Sticky Bitebend Platform Header ───────────────────────── */}
      <BitebendHeader showScanner={true} />

      {/* ── Main Food Discovery Viewport ─────────────────────────── */}
      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "20px 16px 48px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* ── Compact Welcome / Hero Section ──────────────────────── */}
        <section style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              color: C.orange,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            <Utensils style={{ width: "13px", height: "13px" }} />
            <span>Digital Dining & Menus</span>
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: C.ink,
              lineHeight: 1.25,
            }}
          >
            Discover Great Food Near You
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Browse verified local restaurants, explore live menus, or scan your table QR code to order instantly.
          </p>
        </section>

        {/* ── Primary Content: Restaurant Discovery ────────────────── */}
        <RestaurantDiscoverySection />

        {/* ── Secondary Ecosystem Section: More from Bitebend ──────── */}
        <section style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "12px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: C.muted,
            }}
          >
            More from Bitebend
          </h3>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "12px",
            }}
          >
            {/* Table Service / Universal Scanner Shortcut */}
            <div
              onClick={() => navigate("/scanner")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate("/scanner");
                }
              }}
              style={{
                backgroundColor: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: "16px",
                padding: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                cursor: "pointer",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 4px rgba(0,0,0,0.02)",
              }}
              className="hover:border-[#fed7aa] hover:shadow-xs group"
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "12px",
                    backgroundColor: C.orangeBg,
                    border: "1px solid #fed7aa",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <QrCode style={{ width: "20px", height: "20px", color: C.orange }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink, lineHeight: 1.3 }}>
                    Table QR Scanner
                  </div>
                  <div style={{ fontSize: "12px", color: C.muted, marginTop: "2px" }} className="truncate">
                    Scan table QR stand to open restaurant menu
                  </div>
                </div>
              </div>
              <ArrowRight
                style={{ width: "16px", height: "16px", color: C.orange, flexShrink: 0 }}
                className="group-hover:translate-x-0.5 transition-transform"
              />
            </div>

            {/* Messaging Platform (Coming Soon Preview) */}
            <div
              onClick={() => navigate("/messaging")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate("/messaging");
                }
              }}
              style={{
                backgroundColor: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: "16px",
                padding: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                cursor: "pointer",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 4px rgba(0,0,0,0.02)",
              }}
              className="hover:border-[#a7f3d0] hover:shadow-xs group"
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "12px",
                    backgroundColor: C.emeraldBg,
                    border: "1px solid #a7f3d0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <MessageSquare style={{ width: "20px", height: "20px", color: C.emerald }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: C.ink, lineHeight: 1.3 }}>
                      Bitebend Chat
                    </span>
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        padding: "1px 6px",
                        borderRadius: "8px",
                        backgroundColor: C.emeraldBg,
                        color: C.emerald,
                        border: "1px solid #a7f3d0",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "2px",
                      }}
                    >
                      <Sparkles style={{ width: "9px", height: "9px" }} />
                      Soon
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: C.muted, marginTop: "2px" }} className="truncate">
                    Connect and message in real time with restaurants
                  </div>
                </div>
              </div>
              <ArrowRight
                style={{ width: "16px", height: "16px", color: C.emerald, flexShrink: 0 }}
                className="group-hover:translate-x-0.5 transition-transform"
              />
            </div>
          </div>
        </section>

        {/* ── Minimal Consumer-Friendly Footer ─────────────────────── */}
        <footer
          style={{
            marginTop: "16px",
            paddingTop: "20px",
            borderTop: `1px solid ${C.border}`,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            alignItems: "center",
            textAlign: "center",
            fontSize: "12px",
            color: C.muted,
          }}
        >
          {/* Partner & Owner Portal Link */}
          <a
            href="https://www.bitebend.in"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              color: C.orange,
              fontWeight: 600,
              textDecoration: "none",
              fontSize: "12px",
              padding: "4px 8px",
              borderRadius: "8px",
              transition: "background-color 0.15s ease",
            }}
            className="hover:bg-[#fff7ed]"
          >
            <span>Are you a restaurant owner? Partner with Bitebend</span>
            <ExternalLink style={{ width: "12px", height: "12px" }} />
          </a>

          {/* Copyright & Info */}
          <div style={{ fontSize: "11px", color: "#9ca3af", lineHeight: 1.5 }}>
            © {new Date().getFullYear()} Bitebend Technologies. All rights reserved. • Contactless Dining Platform
          </div>
        </footer>
      </main>
    </div>
  );
}
