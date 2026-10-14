import { useState } from "react";
import { useLocation } from "wouter";
import { MessageSquare, ArrowLeft, Phone, Radio, Users } from "lucide-react";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
  mutedBg: "#f5f0eb",
} as const;

export default function MessagingPlatformPage() {
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"chats" | "updates" | "calls">("chats");

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" title="Messaging" />

      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "32px 16px 56px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Platform Hero Card */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
            <div
              style={{
                width: "56px",
                height: "56px",
                borderRadius: "16px",
                backgroundColor: C.emeraldBg,
                border: "1px solid #d1fae5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <MessageSquare style={{ width: "28px", height: "28px", color: C.emerald }} />
            </div>

            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: "12px",
                backgroundColor: C.emeraldBg,
                color: C.emerald,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Coming Soon
            </span>
          </div>

          <div>
            <h1
              style={{
                margin: "0 0 6px 0",
                fontSize: "24px",
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: C.ink,
              }}
            >
              Messaging
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: "15px",
                lineHeight: 1.5,
                color: C.muted,
              }}
            >
              Connect and communicate through Bitebend.
            </p>
          </div>
        </section>

        {/* WhatsApp-Style Shell Preview */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
          }}
        >
          {/* WhatsApp Style Tab Navigation */}
          <div
            style={{
              display: "flex",
              borderBottom: `1px solid ${C.border}`,
              backgroundColor: "#fcfbf9",
            }}
          >
            <button
              onClick={() => setActiveTab("chats")}
              style={{
                flex: 1,
                padding: "14px 8px",
                border: "none",
                background: "none",
                fontSize: "14px",
                fontWeight: activeTab === "chats" ? 700 : 500,
                color: activeTab === "chats" ? C.emerald : C.muted,
                borderBottom: activeTab === "chats" ? `3px solid ${C.emerald}` : "3px solid transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <MessageSquare style={{ width: "16px", height: "16px" }} />
              <span>Chats</span>
            </button>
            <button
              onClick={() => setActiveTab("updates")}
              style={{
                flex: 1,
                padding: "14px 8px",
                border: "none",
                background: "none",
                fontSize: "14px",
                fontWeight: activeTab === "updates" ? 700 : 500,
                color: activeTab === "updates" ? C.emerald : C.muted,
                borderBottom: activeTab === "updates" ? `3px solid ${C.emerald}` : "3px solid transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <Radio style={{ width: "16px", height: "16px" }} />
              <span>Updates</span>
            </button>
            <button
              onClick={() => setActiveTab("calls")}
              style={{
                flex: 1,
                padding: "14px 8px",
                border: "none",
                background: "none",
                fontSize: "14px",
                fontWeight: activeTab === "calls" ? 700 : 500,
                color: activeTab === "calls" ? C.emerald : C.muted,
                borderBottom: activeTab === "calls" ? `3px solid ${C.emerald}` : "3px solid transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <Phone style={{ width: "16px", height: "16px" }} />
              <span>Calls</span>
            </button>
          </div>

          {/* Tab Content Placeholder */}
          <div style={{ padding: "36px 20px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "24px",
                backgroundColor: C.emeraldBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: C.emerald,
              }}
            >
              <Users style={{ width: "24px", height: "24px" }} />
            </div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Messaging Platform Concept
            </h3>
            <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5, color: C.muted, maxWidth: "340px" }}>
              Direct chats, group conversations, and interactive service notifications will be available here when Messaging launches.
            </p>
            <span
              style={{
                marginTop: "8px",
                fontSize: "12px",
                fontWeight: 600,
                color: C.emerald,
                backgroundColor: C.emeraldBg,
                padding: "4px 12px",
                borderRadius: "12px",
              }}
            >
              Platform shell under development
            </span>
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
