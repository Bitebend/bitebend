import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { PartnerShell } from "@/components/layout/PartnerShell";
import { PartnerDashboardTab } from "./PartnerDashboardTab";
import { PartnerStatusScreen } from "./PartnerStatusScreen";
import { apiFetch } from "@/lib/api";
import type { PartnerDashboardData } from "@/lib/types";
import { Loader2 } from "lucide-react";

export default function PartnerDashboard() {
  const [, navigate] = useLocation();
  const [data, setData] = useState<PartnerDashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      const dash = await apiFetch<PartnerDashboardData>("/partner/dashboard");
      setData(dash);
    } catch (err) {
      console.error("[PartnerDashboard] Error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-slate-950 text-slate-200">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        <p className="text-sm text-slate-400 font-medium">Loading Partner Dashboard...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-slate-950 p-6 text-center text-slate-200">
        <p className="text-base text-slate-300 font-semibold">Failed to load partner dashboard data.</p>
        <button
          onClick={fetchDashboard}
          className="px-4 py-2 bg-amber-500 text-slate-950 font-bold rounded-lg text-xs cursor-pointer hover:bg-amber-400"
        >
          Retry
        </button>
      </div>
    );
  }

  // If partner is pending, suspended, or rejected, show status gate screen
  if (data.partner.status !== "active") {
    return <PartnerStatusScreen partner={data.partner} onRefresh={fetchDashboard} />;
  }

  return (
    <PartnerShell activeSection="dashboard" partner={data.partner}>
      <PartnerDashboardTab
        data={data}
        onNavigateToRestaurants={() => navigate("/partner/restaurants")}
        onNavigateToCommissions={() => navigate("/partner/commissions")}
        onNavigateToProfile={() => navigate("/partner/profile")}
      />
    </PartnerShell>
  );
}
