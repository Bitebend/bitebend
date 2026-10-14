import { useState } from "react";
import { useLocation } from "wouter";
import {
  X,
  QrCode,
  ArrowRight,
  Store,
  ShoppingBag,
  ExternalLink,
  UtensilsCrossed,
  Sparkles,
} from "lucide-react";
import type { RecentRestaurantSession } from "./types";

interface RestaurantAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  recentSession?: RecentRestaurantSession | null;
}

export function RestaurantAccessModal({
  isOpen,
  onClose,
  recentSession,
}: RestaurantAccessModalProps) {
  const [, navigate] = useLocation();
  const [restaurantCode, setRestaurantCode] = useState("");
  const [inputError, setInputError] = useState("");

  if (!isOpen) return null;

  const handleOpenByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = restaurantCode.trim();
    if (!raw) {
      setInputError("Please enter a restaurant code or URL");
      return;
    }

    // Support entering either a slug or full link
    let slug = raw;
    try {
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const url = new URL(raw);
        const pathParts = url.pathname.split("/").filter(Boolean);
        if (pathParts.length > 0) {
          // Check if path is /menu/slug or just /slug
          if (pathParts[0] === "menu" && pathParts[1]) {
            slug = pathParts[1];
          } else {
            slug = pathParts[0];
          }
        }
      }
    } catch {
      // Use raw input if parsing fails
    }

    slug = slug.replace(/^\/+|\/+$/g, "");
    if (!slug) {
      setInputError("Invalid restaurant code format");
      return;
    }

    onClose();
    navigate(`/menu/${encodeURIComponent(slug)}`);
  };

  const handleResumeRecent = () => {
    if (!recentSession) return;
    onClose();
    if (recentSession.tableId) {
      navigate(`/menu/${encodeURIComponent(recentSession.slug)}/table/${encodeURIComponent(String(recentSession.tableId))}`);
    } else {
      navigate(`/menu/${encodeURIComponent(recentSession.slug)}`);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="access-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "520px",
          backgroundColor: "#ffffff",
          borderTopLeftRadius: "24px",
          borderTopRightRadius: "24px",
          boxShadow: "0 -8px 30px rgba(0, 0, 0, 0.2)",
          padding: "24px 20px 32px",
          maxHeight: "90vh",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: "max(32px, env(safe-area-inset-bottom, 24px))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Drag Handle for Mobile ─────────────────────────────── */}
        <div
          style={{
            width: "36px",
            height: "4px",
            borderRadius: "2px",
            backgroundColor: "#e5e7eb",
            margin: "0 auto 16px",
          }}
        />

        {/* ── Modal Header ────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "12px",
                backgroundColor: "#fff7ed",
                border: "1px solid #ffedd5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <UtensilsCrossed style={{ width: "20px", height: "20px", color: "#ea580c" }} />
            </div>
            <div>
              <h2
                id="access-modal-title"
                style={{
                  margin: 0,
                  fontSize: "18px",
                  fontWeight: 800,
                  color: "#1a0a00",
                  letterSpacing: "-0.01em",
                }}
              >
                Access Restaurant Menu
              </h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "#6b7280" }}>
                Choose how to open your restaurant's digital menu
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "16px",
              backgroundColor: "#f5f0eb",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6b7280",
              cursor: "pointer",
            }}
          >
            <X style={{ width: "16px", height: "16px" }} />
          </button>
        </div>

        {/* ── Option 1: Resume Recent Session (if available) ─────── */}
        {recentSession && (
          <div
            style={{
              marginBottom: "16px",
              padding: "14px 16px",
              borderRadius: "14px",
              backgroundColor: "#fef3c7",
              border: "1px solid #fde68a",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#92400e", textTransform: "uppercase" }}>
                Resume Recent Session
              </div>
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 800,
                  color: "#78350f",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {recentSession.name}
              </div>
              {recentSession.tableNumber && (
                <div style={{ fontSize: "12px", color: "#92400e" }}>
                  Table {recentSession.tableNumber}
                </div>
              )}
            </div>
            <button
              onClick={handleResumeRecent}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "#b45309",
                color: "#ffffff",
                border: "none",
                borderRadius: "10px",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <span>Resume</span>
              <ArrowRight style={{ width: "14px", height: "14px" }} />
            </button>
          </div>
        )}

        {/* ── Option 2: Scan Table QR ─────────────────────────────── */}
        <div
          style={{
            padding: "16px",
            borderRadius: "14px",
            backgroundColor: "#faf9f6",
            border: "1px solid #ede8e3",
            marginBottom: "16px",
            display: "flex",
            alignItems: "flex-start",
            gap: "14px",
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              backgroundColor: "#fff7ed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <QrCode style={{ width: "22px", height: "22px", color: "#ea580c" }} />
          </div>
          <div style={{ flex: 1 }}>
            <h3
              style={{
                margin: "0 0 4px 0",
                fontSize: "15px",
                fontWeight: 700,
                color: "#1a0a00",
              }}
            >
              Scan Table QR Code
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                lineHeight: 1.45,
                color: "#6b7280",
              }}
            >
              At your table or counter? Point your phone camera at the Bitebend QR stand. The camera automatically opens your live menu with table context.
            </p>
          </div>
        </div>

        {/* ── Option 3: Enter Restaurant Code / URL ──────────────── */}
        <div
          style={{
            padding: "16px",
            borderRadius: "14px",
            backgroundColor: "#ffffff",
            border: "1px solid #ede8e3",
            marginBottom: "20px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            <Store style={{ width: "16px", height: "16px", color: "#ea580c" }} />
            <h3
              style={{
                margin: 0,
                fontSize: "14px",
                fontWeight: 700,
                color: "#1a0a00",
              }}
            >
              Enter Restaurant Code or URL
            </h3>
          </div>
          <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "#6b7280" }}>
            Enter your restaurant's name, code, or menu link to open directly:
          </p>

          <form onSubmit={handleOpenByCode} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                placeholder="e.g. spice-garden or menu link"
                value={restaurantCode}
                onChange={(e) => {
                  setRestaurantCode(e.target.value);
                  setInputError("");
                }}
                style={{
                  flex: 1,
                  height: "40px",
                  padding: "0 12px",
                  borderRadius: "10px",
                  border: `1px solid ${inputError ? "#ef4444" : "#d1d5db"}`,
                  fontSize: "13px",
                  outline: "none",
                  backgroundColor: "#faf9f6",
                }}
              />
              <button
                type="submit"
                style={{
                  height: "40px",
                  padding: "0 16px",
                  borderRadius: "10px",
                  backgroundColor: "#ea580c",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexShrink: 0,
                }}
              >
                <span>Open</span>
                <ArrowRight style={{ width: "14px", height: "14px" }} />
              </button>
            </div>
            {inputError && (
              <span style={{ fontSize: "12px", color: "#ef4444" }}>
                {inputError}
              </span>
            )}
          </form>
        </div>

        {/* ── Modal Footer: Link to Order History ─────────────────── */}
        <div
          style={{
            paddingTop: "14px",
            borderTop: "1px solid #ede8e3",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "13px",
          }}
        >
          <span style={{ color: "#6b7280" }}>Looking for past orders?</span>
          <button
            onClick={() => {
              onClose();
              navigate("/my-orders");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: "#ea580c",
              fontWeight: 700,
              backgroundColor: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            <ShoppingBag style={{ width: "14px", height: "14px" }} />
            <span>View My Orders</span>
          </button>
        </div>
      </div>
    </div>
  );
}
