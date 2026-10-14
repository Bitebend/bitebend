import { useLocation } from "wouter";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";
import { PlatformCard } from "@/components/platform/PlatformCard";
import { PLATFORMS } from "@/components/platform/platforms";
import { QrCode, ArrowRight, ShieldCheck, ExternalLink, Globe } from "lucide-react";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  ink: "#1a0a00",
  muted: "#6b7280",
  border: "#ede8e3",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  emerald: "#059669",
} as const;

export default function HomePage() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      {/* ── Bitebend Platform Header ────────────────────────────── */}
      <BitebendHeader showScanner={true} />

      {/* ── Main Launcher Viewport ──────────────────────────────── */}
      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "32px 16px 64px",
          display: "flex",
          flexDirection: "column",
          gap: "36px",
        }}
      >
        {/* Welcome & Discovery Section */}
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontWeight: 700,
              color: C.orange,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            <span>Bitebend Ecosystem</span>
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: C.ink,
              lineHeight: 1.2,
            }}
          >
            Welcome to Bitebend
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "16px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Your services and platforms, all in one place. Discover, launch, and connect across the Bitebend network.
          </p>
        </section>

        {/* ── Platforms Section (Rendered Dynamically from Registry) ── */}
        <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2
              style={{
                margin: 0,
                fontSize: "13px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: C.muted,
              }}
            >
              Platforms
            </h2>
            <span style={{ fontSize: "12px", color: C.muted, fontWeight: 500 }}>
              {PLATFORMS.filter((p) => p.enabled).length} available
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "16px",
            }}
          >
            {PLATFORMS.filter((p) => p.enabled).map((platform) => (
              <PlatformCard
                key={platform.id}
                id={platform.id}
                title={platform.title}
                description={platform.description}
                icon={platform.icon}
                badge={platform.badge}
                status={platform.status}
                note={platform.note}
                actionLabel={platform.actionLabel}
                onClick={() => navigate(platform.route)}
              />
            ))}
          </div>
        </section>

        {/* ── Quick Scanner Banner ── */}
        <section
          onClick={() => navigate("/scanner")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate("/scanner");
            }
          }}
          className="group cursor-pointer transition-all duration-200"
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "20px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "14px",
                backgroundColor: C.orangeBg,
                border: "1px solid #fed7aa",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <QrCode style={{ width: "24px", height: "24px", color: C.orange }} />
            </div>
            <div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: C.ink, marginBottom: "2px" }}>
                Universal QR Scanner
              </div>
              <div style={{ fontSize: "13px", color: C.muted }}>
                Scan any Bitebend restaurant table, counter, or service QR code
              </div>
            </div>
          </div>

          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "50%",
              backgroundColor: C.orangeBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
            className="group-hover:translate-x-1 transition-transform"
          >
            <ArrowRight style={{ width: "16px", height: "16px", color: C.orange }} />
          </div>
        </section>

        {/* ── Domain Architecture Information ── */}
        <section
          style={{
            backgroundColor: "#f5f0eb",
            borderRadius: "16px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            border: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Globe style={{ width: "16px", height: "16px", color: C.muted }} />
            <span style={{ fontSize: "13px", fontWeight: 700, color: C.ink }}>
              Bitebend Platform Network
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                backgroundColor: C.card,
                borderRadius: "10px",
                fontSize: "13px",
              }}
            >
              <div>
                <span style={{ fontWeight: 700, color: C.ink }}>bitebend.in</span>
                <span style={{ color: C.muted, marginLeft: "8px" }}>• Main Platform Launcher</span>
              </div>
              <span style={{ fontSize: "11px", fontWeight: 700, color: C.orange }}>Active</span>
            </div>

            <a
              href="https://menu.bitebend.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                backgroundColor: C.card,
                borderRadius: "10px",
                fontSize: "13px",
                textDecoration: "none",
              }}
            >
              <div>
                <span style={{ fontWeight: 700, color: C.ink }}>menu.bitebend.in</span>
                <span style={{ color: C.muted, marginLeft: "8px" }}>• Restaurant Customer Platform</span>
              </div>
              <ExternalLink style={{ width: "14px", height: "14px", color: C.muted }} />
            </a>

            <a
              href="https://www.bitebend.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                backgroundColor: C.card,
                borderRadius: "10px",
                fontSize: "13px",
                textDecoration: "none",
              }}
            >
              <div>
                <span style={{ fontWeight: 700, color: C.ink }}>www.bitebend.in</span>
                <span style={{ color: C.muted, marginLeft: "8px" }}>• Owner & Admin Portal</span>
              </div>
              <ExternalLink style={{ width: "14px", height: "14px", color: C.muted }} />
            </a>
          </div>
        </section>

        {/* Footer */}
        <footer style={{ textAlign: "center", fontSize: "12px", color: C.muted, padding: "8px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
            <ShieldCheck style={{ width: "14px", height: "14px", color: C.emerald }} />
            <span>Bitebend Official Platform Foundation • Extensible Multi-App Architecture</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
