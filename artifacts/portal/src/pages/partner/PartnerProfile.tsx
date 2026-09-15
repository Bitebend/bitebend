import { useState, useEffect } from "react";
import { PartnerShell } from "@/components/layout/PartnerShell";
import { PartnerProfileTab } from "./PartnerProfileTab";
import { PartnerStatusScreen } from "./PartnerStatusScreen";
import { apiFetch } from "@/lib/api";
import type { PartnerProfile as IPartnerProfile } from "@/lib/types";
import { Loader2 } from "lucide-react";

export default function PartnerProfile() {
  const [partner, setPartner] = useState<IPartnerProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async () => {
    try {
      setLoading(true);
      const p = await apiFetch<IPartnerProfile>("/partner/profile");
      setPartner(p);
    } catch (err) {
      console.error("[PartnerProfile] Fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfile();
  }, []);

  if (loading && !partner) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-slate-950 text-slate-200">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        <p className="text-sm text-slate-400 font-medium">Loading Payout & Profile...</p>
      </div>
    );
  }

  if (partner && partner.status !== "active") {
    return <PartnerStatusScreen partner={partner} onRefresh={fetchProfile} />;
  }

  return (
    <PartnerShell activeSection="profile" partner={partner}>
      <PartnerProfileTab partner={partner} onProfileUpdated={fetchProfile} />
    </PartnerShell>
  );
}
