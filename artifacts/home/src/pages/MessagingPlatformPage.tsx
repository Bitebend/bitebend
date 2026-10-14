import { useState } from "react";
import { useLocation } from "wouter";
import {
  MessageSquare,
  ArrowLeft,
  Phone,
  Radio,
  Users,
  Search,
  CheckCheck,
  Send,
  Sparkles,
  Shield,
  BellRing,
} from "lucide-react";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
  emeraldDark: "#047857",
  mutedBg: "#f5f0eb",
} as const;

export default function MessagingPlatformPage() {
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"chats" | "updates" | "calls">("chats");
  const [chatMessage, setChatMessage] = useState("");

  const sampleChats = [
    {
      id: "1",
      name: "The Grand Bistro Concierge",
      message: "Your table #4 reservation is confirmed! Need to order ahead?",
      time: "12:45 PM",
      unread: 2,
      avatar: "GB",
    },
    {
      id: "2",
      name: "Bitebend Support",
      message: "Welcome to Bitebend Messaging. Real-time updates are active.",
      time: "Yesterday",
      unread: 0,
      avatar: "BB",
    },
    {
      id: "3",
      name: "Kitchen Status Updates",
      message: "Order #8492 is being prepared right now.",
      time: "Oct 12",
      unread: 0,
      avatar: "KS",
    },
  ];

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      <BitebendHeader showBack={true} backTo="/" title="Messaging" />

      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "32px 16px 64px",
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
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <Sparkles style={{ width: "12px", height: "12px" }} />
              Platform Preview
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
              Bitebend Messaging
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: "15px",
                lineHeight: 1.5,
                color: C.muted,
              }}
            >
              A WhatsApp-style conversational platform built for instant dining communications, direct merchant chats, and real-time order alerts.
            </p>
          </div>
        </section>

        {/* ── WhatsApp-Style UI Shell Preview ── */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.04)",
          }}
        >
          {/* WhatsApp-Style Dark Emerald App Bar */}
          <div
            style={{
              backgroundColor: C.emeraldDark,
              color: "#ffffff",
              padding: "16px 20px 12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <div style={{ fontSize: "19px", fontWeight: 700, letterSpacing: "-0.01em" }}>
                Bitebend Chats
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <Search style={{ width: "18px", height: "18px", opacity: 0.85 }} />
                <Users style={{ width: "18px", height: "18px", opacity: 0.85 }} />
              </div>
            </div>

            {/* Tabs: Chats, Updates, Calls */}
            <div style={{ display: "flex", gap: "24px", borderBottom: "2px solid rgba(255,255,255,0.15)" }}>
              {(["chats", "updates", "calls"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "8px 4px",
                    color: activeTab === tab ? "#ffffff" : "rgba(255,255,255,0.7)",
                    fontWeight: 700,
                    fontSize: "14px",
                    textTransform: "capitalize",
                    cursor: "pointer",
                    position: "relative",
                  }}
                >
                  {tab}
                  {activeTab === tab && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "-2px",
                        left: 0,
                        right: 0,
                        height: "3px",
                        backgroundColor: "#ffffff",
                        borderRadius: "2px",
                      }}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Chat List Preview */}
          <div style={{ padding: "8px 0", minHeight: "220px" }}>
            {activeTab === "chats" && (
              <div>
                {sampleChats.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      padding: "12px 18px",
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        borderRadius: "50%",
                        backgroundColor: C.emeraldBg,
                        color: C.emerald,
                        fontWeight: 800,
                        fontSize: "14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {c.avatar}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                        <div style={{ fontWeight: 700, fontSize: "15px", color: C.ink }}>{c.name}</div>
                        <div style={{ fontSize: "11px", color: C.muted }}>{c.time}</div>
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: C.muted,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        <CheckCheck style={{ width: "14px", height: "14px", color: C.emerald, flexShrink: 0 }} />
                        <span>{c.message}</span>
                      </div>
                    </div>

                    {c.unread > 0 && (
                      <div
                        style={{
                          width: "20px",
                          height: "20px",
                          borderRadius: "50%",
                          backgroundColor: C.emerald,
                          color: "#ffffff",
                          fontSize: "11px",
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {c.unread}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {activeTab === "updates" && (
              <div style={{ padding: "32px 20px", textAlign: "center", color: C.muted }}>
                <Radio style={{ width: "32px", height: "32px", color: C.emerald, margin: "0 auto 12px" }} />
                <div style={{ fontWeight: 700, color: C.ink, fontSize: "15px" }}>Restaurant Status Updates</div>
                <p style={{ fontSize: "13px", marginTop: "4px" }}>
                  Follow restaurant channels for daily specials, chef announcements, and special tastings.
                </p>
              </div>
            )}

            {activeTab === "calls" && (
              <div style={{ padding: "32px 20px", textAlign: "center", color: C.muted }}>
                <Phone style={{ width: "32px", height: "32px", color: C.emerald, margin: "0 auto 12px" }} />
                <div style={{ fontWeight: 700, color: C.ink, fontSize: "15px" }}>Direct Staff Calling</div>
                <p style={{ fontSize: "13px", marginTop: "4px" }}>
                  Call your server or host directly with encrypted audio connection.
                </p>
              </div>
            )}
          </div>

          {/* Quick Mock Input Bar */}
          <div
            style={{
              padding: "12px 16px",
              backgroundColor: C.bg,
              borderTop: `1px solid ${C.border}`,
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <input
              type="text"
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              placeholder="Type a message (Preview)..."
              style={{
                flex: 1,
                height: "40px",
                borderRadius: "20px",
                border: `1px solid ${C.border}`,
                padding: "0 16px",
                fontSize: "14px",
                outline: "none",
                backgroundColor: C.card,
              }}
            />
            <button
              onClick={() => {
                if (chatMessage) setChatMessage("");
              }}
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                backgroundColor: C.emerald,
                color: "#ffffff",
                border: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Send style={{ width: "16px", height: "16px" }} />
            </button>
          </div>
        </section>

        {/* Key Features Breakdown */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "12px",
          }}
        >
          <div
            style={{
              padding: "16px 18px",
              backgroundColor: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: "14px",
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <Shield style={{ width: "20px", height: "20px", color: C.emerald, flexShrink: 0, marginTop: "2px" }} />
            <div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>Privacy First</div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Customers and merchants communicate securely without sharing personal contact numbers.
              </div>
            </div>
          </div>

          <div
            style={{
              padding: "16px 18px",
              backgroundColor: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: "14px",
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <BellRing style={{ width: "20px", height: "20px", color: C.emerald, flexShrink: 0, marginTop: "2px" }} />
            <div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>Instant Order Signals</div>
              <div style={{ fontSize: "13px", color: C.muted, marginTop: "2px" }}>
                Receive real-time push notifications when food is plated and ready for pickup or table delivery.
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
