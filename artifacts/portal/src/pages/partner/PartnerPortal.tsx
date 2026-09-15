import { useState, useEffect } from "react";
import { PartnerShell, type PartnerSection } from "@/components/layout/PartnerShell";
import { PartnerDashboardTab } from "./PartnerDashboardTab";
import { PartnerRestaurantsTab } from "./PartnerRestaurantsTab";
import { PartnerCommissionsTab } from "./PartnerCommissionsTab";
import { PartnerProfileTab } from "./PartnerProfileTab";
import { apiFetch } from "@/lib/api";
import type { PartnerDashboardData } from "@/lib/types";
import { Loader2 } from "lucide-react";

export default function PartnerPortal() {
  const [activeSection, setActiveSection] = useState<PartnerSection>("dashboard");
  const [dashboardData, setDashboardData] = useState<PartnerDashboardData | null>(null);
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [commissions, setCommissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAllData = async () => {
    try {
      setLoading(true);
      const [dash, rests, comms] = await Promise.all([
        apiFetch<PartnerDashboardData>("/partner/dashboard"),
        apiFetch<any[]>("/partner/restaurants").catch(() => []),
        apiFetch<any[]>("/partner/commissions").catch(() => []),
      ]);
      setDashboardData(dash);
      setRestaurants(rests);
      setCommissions(comms);
    } catch (err) {
      console.error("[PartnerPortal] Fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, []);

  if (loading && !dashboardData) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-slate-50">
        <Loader2 className="w-8 h-8 text-amber-600 animate-spin" />
        <p className="text-sm text-slate-500 font-medium">Loading Partner Portal...</p>
      </div>
    );
  }

  if (!dashboardData) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-slate-50 p-6 text-center">
        <p className="text-base text-slate-700 font-semibold">Failed to load partner account details.</p>
        <button
          onClick={fetchAllData}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg text-xs font-bold"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <PartnerShell
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      partner={dashboardData.partner}
    >
      {activeSection === "dashboard" && (
        <PartnerDashboardTab
          data={dashboardData}
          onNavigateToRestaurants={() => setActiveSection("restaurants")}
          onNavigateToCommissions={() => setActiveSection("commissions")}
          onNavigateToProfile={() => setActiveSection("profile")}
        />
      )}

      {activeSection === "restaurants" && (
        <PartnerRestaurantsTab
          restaurants={restaurants}
          loading={loading}
          onRefresh={fetchAllData}
        />
      )}

      {activeSection === "commissions" && (
        <PartnerCommissionsTab
          commissions={commissions}
          loading={loading}
          onRefresh={fetchAllData}
        />
      )}

      {activeSection === "profile" && (
        <PartnerProfileTab
          partner={dashboardData.partner}
          onRefresh={fetchAllData}
        />
      )}
    </PartnerShell>
  );
}
