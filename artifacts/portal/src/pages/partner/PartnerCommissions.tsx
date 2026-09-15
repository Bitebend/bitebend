import { useState, useEffect, useCallback } from "react";
import { PartnerShell } from "@/components/layout/PartnerShell";
import { PartnerCommissionsTab } from "./PartnerCommissionsTab";
import { PartnerStatusScreen } from "./PartnerStatusScreen";
import { apiFetch } from "@/lib/api";
import type { PartnerProfile, PartnerCommissionItem } from "@/lib/types";
import { Loader2 } from "lucide-react";

export default function PartnerCommissions() {
  const [partner, setPartner] = useState<PartnerProfile | null>(null);
  const [commissions, setCommissions] = useState<PartnerCommissionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [profileData, commsData] = await Promise.all([
        apiFetch<PartnerProfile>("/partner/profile").catch(() => null),
        apiFetch<PartnerCommissionItem[]>("/partner/commissions").catch(() => []),
      ]);
      if (profileData) setPartner(profileData);
      setCommissions(commsData || []);
    } catch (err) {
      console.error("[PartnerCommissions] Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !partner && commissions.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-slate-950 text-slate-200">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        <p className="text-sm text-slate-400 font-medium">Loading Commissions...</p>
      </div>
    );
  }

  if (partner && partner.status !== "active") {
    return <PartnerStatusScreen partner={partner} onRefresh={fetchData} />;
  }

  return (
    <PartnerShell activeSection="commissions" partner={partner}>
      <PartnerCommissionsTab
        commissions={commissions}
        loading={loading}
        onRefresh={fetchData}
      />
    </PartnerShell>
  );
}
