import type { PlatformCardProps } from "./types";
import { ArrowRight } from "lucide-react";

export function PlatformCard({
  title,
  description,
  icon: Icon,
  badge,
  note,
  actionLabel = "Open →",
  onClick,
  disabled,
}: PlatformCardProps) {
  return (
    <div
      onClick={!disabled ? onClick : undefined}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #ede8e3",
        borderRadius: "18px",
        padding: "22px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
        transition: "box-shadow 0.2s ease, transform 0.15s ease, border-color 0.2s ease",
        cursor: disabled ? "default" : "pointer",
        outline: "none",
        userSelect: "none",
      }}
    >
      {/* ── Top Row: Platform Icon & Status Badge ─────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div
          style={{
            width: "48px",
            height: "48px",
            borderRadius: "14px",
            backgroundColor: "#f5f0eb",
            border: "1px solid #ede8e3",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon style={{ width: "24px", height: "24px", color: "#ea580c" }} />
        </div>

        {badge && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: "12px",
              backgroundColor: "#f5f0eb",
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {badge}
          </span>
        )}
      </div>

      {/* ── Platform Info ─────────────────────────────────────────── */}
      <div style={{ flex: 1 }}>
        <h3
          style={{
            margin: "0 0 6px 0",
            fontSize: "18px",
            fontWeight: 800,
            color: "#1a0a00",
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            lineHeight: 1.5,
            color: "#6b7280",
          }}
        >
          {description}
        </p>
      </div>

      {/* ── Optional Note ─────────────────────────────────────────── */}
      {note && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "10px",
            backgroundColor: "#faf9f6",
            border: "1px solid #ede8e3",
            fontSize: "12px",
            color: "#6b7280",
          }}
        >
          {note}
        </div>
      )}

      {/* ── Action Link ───────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: "6px",
          paddingTop: "2px",
        }}
      >
        <span
          style={{
            fontSize: "14px",
            fontWeight: 700,
            color: disabled ? "#9ca3af" : "#ea580c",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          {actionLabel}
          <ArrowRight style={{ width: "15px", height: "15px" }} />
        </span>
      </div>
    </div>
  );
}
