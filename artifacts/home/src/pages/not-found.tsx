import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";

export default function NotFound() {
  const [, navigate] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", backgroundColor: "#faf9f6" }}>
      <BitebendHeader showBack={true} backTo="/" title="Not Found" />

      <main
        style={{
          maxWidth: "480px",
          margin: "80px auto",
          padding: "0 16px",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <div
          style={{
            width: "64px",
            height: "64px",
            borderRadius: "20px",
            backgroundColor: "#fff7ed",
            color: "#ea580c",
            fontSize: "24px",
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          404
        </div>

        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 800, color: "#1a0a00" }}>
          Page Not Found
        </h1>

        <p style={{ margin: 0, fontSize: "14px", color: "#6b7280", lineHeight: 1.5 }}>
          The requested platform page does not exist on Bitebend Public Platform.
        </p>

        <button
          onClick={() => navigate("/")}
          style={{
            marginTop: "12px",
            height: "44px",
            padding: "0 20px",
            borderRadius: "12px",
            backgroundColor: "#ea580c",
            color: "#ffffff",
            border: "none",
            fontSize: "14px",
            fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <ArrowLeft style={{ width: "16px", height: "16px" }} />
          <span>Return to Bitebend Home</span>
        </button>
      </main>
    </div>
  );
}
