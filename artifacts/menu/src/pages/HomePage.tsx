import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  UtensilsCrossed,
  QrCode,
  ShoppingBag,
  ArrowRight,
  Store,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { lsGet } from "@/pages/menu/utils";

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

interface RecentSession {
  slug: string;
  name: string;
  tableId?: string | number | null;
  timestamp?: number;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const [restaurantCode, setRestaurantCode] = useState("");
  const [recentSession, setRecentSession] = useState<RecentSession | null>(null);

  useEffect(() => {
    try {
      const stored = lsGet<RecentSession>("bb_last_restaurant", null as unknown as RecentSession);
      if (stored && stored.slug) {
        setRecentSession(stored);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const handleOpenRestaurant = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = restaurantCode.trim();
    if (!clean) return;
    navigate(`/menu/${encodeURIComponent(clean)}`);
  };

  const handleResumeRecent = () => {
    if (!recentSession) return;
    if (recentSession.tableId) {
      navigate(`/menu/${encodeURIComponent(recentSession.slug)}/table/${encodeURIComponent(recentSession.tableId)}`);
    } else {
      navigate(`/menu/${encodeURIComponent(recentSession.slug)}`);
    }
  };

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      {/* ── Restaurant Platform Header ── */}
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
            maxWidth: "680px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          {/* Brand */}
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
              <UtensilsCrossed style={{ width: "16px", height: "16px", color: "#ffffff" }} />
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
                  color: C.orange,
                  letterSpacing: "0.02em",
                }}
              >
                Restaurant Platform
              </span>
            </div>
          </div>

          {/* Quick Actions: Scanner + My Orders */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={() => navigate("/my-orders")}
              aria-label="View My Orders"
              style={{
                height: "36px",
                padding: "0 12px",
                borderRadius: "18px",
                backgroundColor: C.mutedBg,
                color: C.ink,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <ShoppingBag style={{ width: "14px", height: "14px", color: C.muted }} />
              <span>Orders</span>
            </button>

            <button
              onClick={() => navigate("/scanner")}
              aria-label="Scan Table QR"
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
              }}
            >
              <QrCode style={{ width: "14px", height: "14px" }} />
              <span>Scan QR</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Main Restaurant Customer Viewport ── */}
      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "28px 16px 56px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        {/* Welcome Section */}
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
            <span>Restaurant Dining Platform</span>
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: "26px",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              color: C.ink,
              lineHeight: 1.2,
            }}
          >
            Digital Dining & Ordering
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Scan a table or counter QR code to view the live menu, place orders, and track your kitchen status.
          </p>
        </section>

        {/* ── Resume Recent Restaurant Session if available ── */}
        {recentSession && (
          <section
            onClick={handleResumeRecent}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleResumeRecent();
              }
            }}
            className="group cursor-pointer transition-all duration-200"
            style={{
              backgroundColor: C.card,
              border: `2px solid ${C.orange}`,
              borderRadius: "20px",
              padding: "20px",
              boxShadow: "0 4px 16px rgba(234, 88, 12, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: "10px",
                  backgroundColor: C.orangeBg,
                  color: C.orange,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <Sparkles style={{ width: "12px", height: "12px" }} />
                Recent Visit
              </span>
              <span style={{ fontSize: "12px", color: C.muted, fontWeight: 500 }}>
                {recentSession.tableId ? `Table ${recentSession.tableId}` : "Digital Menu"}
              </span>
            </div>

            <div>
              <div style={{ fontSize: "18px", fontWeight: 800, color: C.ink }}>
                {recentSession.name || recentSession.slug}
              </div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Tap to resume your ordering session
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: "8px",
                borderTop: `1px solid ${C.border}`,
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  color: C.orange,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>Return to Menu</span>
                <ArrowRight
                  style={{ width: "14px", height: "14px" }}
                  className="group-hover:translate-x-1 transition-transform"
                />
              </span>
            </div>
          </section>
        )}

        {/* ── Scan Table QR Code ── */}
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
            padding: "24px 20px",
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
                width: "52px",
                height: "52px",
                borderRadius: "16px",
                backgroundColor: C.orangeBg,
                border: "1px solid #ffedd5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <QrCode style={{ width: "26px", height: "26px", color: C.orange }} />
            </div>

            <div>
              <div style={{ fontSize: "17px", fontWeight: 700, color: C.ink, marginBottom: "2px" }}>
                Scan Table QR Code
              </div>
              <div style={{ fontSize: "13px", color: C.muted, lineHeight: 1.4 }}>
                Point your camera at the QR code at your table or counter
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

        {/* ── Manual Restaurant Code Entry ── */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Store style={{ width: "20px", height: "20px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Enter Restaurant Code
            </h2>
          </div>

          <p style={{ margin: 0, fontSize: "13px", color: C.muted }}>
            Know your restaurant's handle or slug? Enter it below to open the digital menu.
          </p>

          <form onSubmit={handleOpenRestaurant} style={{ display: "flex", gap: "10px" }}>
            <input
              type="text"
              value={restaurantCode}
              onChange={(e) => setRestaurantCode(e.target.value)}
              placeholder="e.g. the-grand-bistro"
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
                backgroundColor: restaurantCode.trim() ? C.orange : "#d1d5db",
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
              <span>View</span>
              <ArrowRight style={{ width: "14px", height: "14px" }} />
            </button>
          </form>
        </section>

        {/* ── My Orders Quick Card ── */}
        <section
          onClick={() => navigate("/my-orders")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate("/my-orders");
            }
          }}
          className="group cursor-pointer transition-all duration-200"
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "12px",
                backgroundColor: C.mutedBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <ShoppingBag style={{ width: "20px", height: "20px", color: C.ink }} />
            </div>

            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: C.ink }}>
                View Past Orders & Receipts
              </div>
              <div style={{ fontSize: "13px", color: C.muted }}>
                Look up your orders by customer phone number
              </div>
            </div>
          </div>

          <ArrowRight
            style={{ width: "16px", height: "16px", color: C.muted }}
            className="group-hover:translate-x-1 transition-transform"
          />
        </section>

        {/* Ecosystem Notice */}
        <footer
          style={{
            textAlign: "center",
            fontSize: "12px",
            color: C.muted,
            paddingTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div>
            <span>Bitebend Restaurant Platform (menu.bitebend.in)</span>
          </div>
          <div>
            <a
              href="https://bitebend.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: C.orange,
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>Visit Bitebend Public Home (bitebend.in)</span>
              <ExternalLink style={{ width: "12px", height: "12px" }} />
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
