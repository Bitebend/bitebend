import type { PlatformCardProps } from "./types";
import { ArrowRight, QrCode } from "lucide-react";

export function PlatformCard({
  title,
  description,
  icon: Icon,
  badge,
  note,
  actionLabel,
  onClick,
  disabled,
}: PlatformCardProps) {
  return (
    <div
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #ede8e3",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
        transition: "box-shadow 0.2s ease, border-color 0.2s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div
          style={{
            width: "44px",
            height: "44px",
            borderRadius: "12px",
            backgroundColor: "#fff7ed",
            border: "1px solid #ffedd5",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon style={{ width: "22px", height: "22px", color: "#ea580c" }} />
        </div>

        {badge && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: "12px",
              backgroundColor: "#f5f0eb",
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {badge}
          </span>
        )}
      </div>

      <div style={{ flex: 1 }}>
        <h3
          style={{
            margin: "0 0 6px 0",
            fontSize: "17px",
            fontWeight: 700,
            color: "#1a0a00",
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: "13px",
            lineHeight: 1.5,
            color: "#6b7280",
          }}
        >
          {description}
        </p>
      </div>

      {note && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "10px",
            backgroundColor: "#faf9f6",
            border: "1px solid #ede8e3",
            fontSize: "12px",
            color: "#4b5563",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <QrCode style={{ width: "16px", height: "16px", color: "#ea580c", flexShrink: 0 }} />
          <span>{note}</span>
        </div>
      )}

      {actionLabel && (
        <div style={{ paddingTop: "2px" }}>
          <button
            onClick={onClick}
            disabled={disabled}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "13px",
              fontWeight: 600,
              color: disabled ? "#9ca3af" : "#ea580c",
              backgroundColor: "transparent",
              border: "none",
              padding: 0,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <span>{actionLabel}</span>
            <ArrowRight style={{ width: "14px", height: "14px" }} />
          </button>
        </div>
      )}
    </div>
  );
}
