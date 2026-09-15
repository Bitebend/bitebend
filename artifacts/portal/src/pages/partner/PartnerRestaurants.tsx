import { useState, useEffect, useCallback } from "react";
import { PartnerShell } from "@/components/layout/PartnerShell";
import { PartnerRestaurantsTab } from "./PartnerRestaurantsTab";
import { PartnerStatusScreen } from "./PartnerStatusScreen";
import { apiFetch } from "@/lib/api";
import type { PartnerProfile } from "@/lib/types";
import { Loader2 } from "lucide-react";

export default function PartnerRestaurants() {
  const [partner, setPartner] = useState<PartnerProfile | null>(null);
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [profileData, restsData] = await Promise.all([
        apiFetch<PartnerProfile>("/partner/profile").catch(() => null),
        apiFetch<any[]>("/partner/restaurants").catch(() => []),
      ]);
      if (profileData) setPartner(profileData);
      setRestaurants(restsData || []);
    } catch (err) {
      console.error("[PartnerRestaurants] Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !partner && restaurants.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-slate-950 text-slate-200">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        <p className="text-sm text-slate-400 font-medium">Loading My Restaurants...</p>
      </div>
    );
  }

  if (partner && partner.status !== "active") {
    return <PartnerStatusScreen partner={partner} onRefresh={fetchData} />;
  }

  return (
    <PartnerShell activeSection="restaurants" partner={partner}>
      <PartnerRestaurantsTab
        restaurants={restaurants}
        loading={loading}
        onRefresh={fetchData}
      />
    </PartnerShell>
  );
}
