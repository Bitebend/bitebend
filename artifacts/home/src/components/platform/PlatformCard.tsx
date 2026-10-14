import type { PlatformCardProps } from "./types";
import { ArrowRight, Sparkles } from "lucide-react";

const C = {
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
  grayBg: "#f3f4f6",
  grayText: "#4b5563",
} as const;

export function PlatformCard({
  title,
  description,
  icon: Icon,
  status = "active",
  badge,
  actionLabel = "Open →",
  note,
  onClick,
  className = "",
}: PlatformCardProps) {
  const isComingSoon = status === "coming_soon";

  const getBadgeStyle = () => {
    if (isComingSoon) {
      return {
        bg: C.emeraldBg,
        text: C.emerald,
        border: "#a7f3d0",
      };
    }
    return {
      bg: C.orangeBg,
      text: C.orange,
      border: "#ffedd5",
    };
  };

  const badgeStyle = getBadgeStyle();

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`group transition-all duration-200 cursor-pointer ${className}`}
      style={{
        backgroundColor: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: "20px",
        padding: "24px 20px",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.03)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        outline: "none",
      }}
    >
      {/* Top row: Icon and Badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div
          style={{
            width: "52px",
            height: "52px",
            borderRadius: "14px",
            backgroundColor: isComingSoon ? C.emeraldBg : C.orangeBg,
            border: `1px solid ${isComingSoon ? "#d1fae5" : "#fed7aa"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transition: "transform 0.2s ease",
          }}
          className="group-hover:scale-105"
        >
          <Icon
            style={{
              width: "26px",
              height: "26px",
              color: isComingSoon ? C.emerald : C.orange,
            }}
          />
        </div>

        {badge && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: "10px",
              backgroundColor: badgeStyle.bg,
              color: badgeStyle.text,
              border: `1px solid ${badgeStyle.border}`,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            {isComingSoon && <Sparkles style={{ width: "10px", height: "10px" }} />}
            {badge}
          </span>
        )}
      </div>

      {/* Title & Description */}
      <div>
        <h3
          style={{
            margin: "0 0 6px 0",
            fontSize: "20px",
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: C.ink,
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            lineHeight: 1.5,
            color: C.muted,
          }}
        >
          {description}
        </p>
      </div>

      {/* Optional Note */}
      {note && (
        <div
          style={{
            fontSize: "12px",
            padding: "8px 12px",
            borderRadius: "8px",
            backgroundColor: C.grayBg,
            color: C.grayText,
            lineHeight: 1.4,
          }}
        >
          {note}
        </div>
      )}

      {/* Action Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "12px",
          borderTop: `1px solid ${C.border}`,
          marginTop: "4px",
        }}
      >
        <span
          style={{
            fontSize: "13px",
            fontWeight: 700,
            color: isComingSoon ? C.emerald : C.orange,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>{actionLabel}</span>
          <ArrowRight
            style={{ width: "14px", height: "14px" }}
            className="group-hover:translate-x-1 transition-transform"
          />
        </span>

        <span
          style={{
            fontSize: "12px",
            color: C.muted,
            fontWeight: 500,
          }}
        >
          {isComingSoon ? "Preview available" : "Active platform"}
        </span>
      </div>
    </div>
  );
}
