import { useState, useEffect, useCallback } from "react";
import {
  Handshake,
  Plus,
  Search,
  Percent,
  DollarSign,
  Store,
  Clock,
  CheckCircle2,
  XCircle,
  MoreVertical,
  KeyRound,
  Edit2,
  Copy,
  Check,
  Eye,
  EyeOff,
  UserCheck,
  UserX,
  Building2,
  Calendar,
  Save,
  AlertCircle,
  Loader2,
  ChevronRight,
  ExternalLink,
  MapPin,
  Lock,
  ShieldCheck,
  Share2,
  RefreshCw,
  Send,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { PartnerProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STATE_NAMES, getDistricts } from "@/data/india-states-districts";

interface AdminPartnerRow extends PartnerProfile {
  totalRestaurants: number;
  totalEarned: number;
  totalPending: number;
  totalApproved: number;
  totalPaid: number;
}

export function AdminPartnersTab() {
  const { toast } = useToast();
  const [partners, setPartners] = useState<AdminPartnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"directory" | "credentials">("directory");
  const [showPassMap, setShowPassMap] = useState<Record<number, boolean>>({});

  // Create Partner Modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    state: "",
    city: "",
    referralCode: "",
    commissionPercentage: 10,
  });

  // Edit Partner Modal
  const [editingPartner, setEditingPartner] = useState<AdminPartnerRow | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    phone: "",
    state: "",
    city: "",
    referralCode: "",
    commissionPercentage: 10,
    status: "active" as "active" | "suspended",
    accountName: "",
    accountNumber: "",
    ifsc: "",
    bankName: "",
  });

  // Detail Inspector Modal
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [detailData, setDetailData] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTierInput, setDetailTierInput] = useState<number>(10);
  const [detailTierSaving, setDetailTierSaving] = useState(false);

  // Inline Table Row Tier Editing
  const [editingRowTierId, setEditingRowTierId] = useState<number | null>(null);
  const [rowTierInput, setRowTierInput] = useState<number>(10);
  const [rowTierSaving, setRowTierSaving] = useState(false);

  // Reset / Change Password Modal
  const [resetModal, setResetModal] = useState<{ email: string; tempPass: string } | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [customPassModal, setCustomPassModal] = useState<{
    partner: AdminPartnerRow;
    customPassword: string;
    useRandom: boolean;
  } | null>(null);
  const [savingCustomPass, setSavingCustomPass] = useState(false);

  // Quick Credentials Detail Card Modal
  const [credDetailsPartner, setCredDetailsPartner] = useState<AdminPartnerRow | null>(null);

  // Approve & Reject Application Modals
  const [approveModal, setApproveModal] = useState<{ partner: AdminPartnerRow; commissionPercentage: number } | null>(null);
  const [approving, setApproving] = useState(false);

  const [rejectModal, setRejectModal] = useState<{ partner: AdminPartnerRow; reason: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchPartners = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<AdminPartnerRow[]>("/admin/partners");
      setPartners(data);
    } catch (err: any) {
      toast({
        title: "Error fetching partners",
        description: err.message || "Failed to load partners",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchPartners();
  }, [fetchPartners]);

  const handleApprovePartner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approveModal) return;
    setApproving(true);
    try {
      const res = await apiFetch<any>(`/admin/partners/${approveModal.partner.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ commissionPercentage: Number(approveModal.commissionPercentage) }),
      });
      toast({
        title: "Partner Approved",
        description: `Partner ${res.name} approved with referral code ${res.referralCode}.`,
      });
      setApproveModal(null);
      fetchPartners();
    } catch (err: any) {
      toast({
        title: "Approval Failed",
        description: err.message || "Failed to approve partner application",
        variant: "destructive",
      });
    } finally {
      setApproving(false);
    }
  };

  const handleRejectPartner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectModal) return;
    setRejecting(true);
    try {
      const res = await apiFetch<any>(`/admin/partners/${rejectModal.partner.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: rejectModal.reason }),
      });
      toast({
        title: "Application Rejected",
        description: `Application for ${res.name} has been rejected.`,
      });
      setRejectModal(null);
      fetchPartners();
    } catch (err: any) {
      toast({
        title: "Action Failed",
        description: err.message || "Failed to reject partner application",
        variant: "destructive",
      });
    } finally {
      setRejecting(false);
    }
  };

  const handleCreatePartner = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await apiFetch("/admin/partners", {
        method: "POST",
        body: JSON.stringify({
          name: createForm.name,
          email: createForm.email,
          password: createForm.password,
          phone: createForm.phone,
          state: createForm.state || undefined,
          city: createForm.city || undefined,
          referralCode: createForm.referralCode || undefined,
          commissionPercentage: Number(createForm.commissionPercentage),
        }),
      });
      toast({
        title: "Partner Created",
        description: `Successfully onboarded partner ${createForm.name}.`,
      });
      setCreateModalOpen(false);
      setCreateForm({
        name: "",
        email: "",
        password: "",
        phone: "",
        state: "",
        city: "",
        referralCode: "",
        commissionPercentage: 10,
      });
      fetchPartners();
    } catch (err: any) {
      toast({
        title: "Creation Failed",
        description: err.message || "Failed to create partner account",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleOpenEdit = (p: AdminPartnerRow) => {
    setEditingPartner(p);
    setEditForm({
      name: p.name,
      phone: p.phone,
      state: p.state || "",
      city: p.city || "",
      referralCode: p.referralCode || "",
      commissionPercentage: p.commissionPercentage,
      status: (p.status === "suspended" ? "suspended" : "active") as "active" | "suspended",
      accountName: p.payoutDetails?.accountName || "",
      accountNumber: p.payoutDetails?.accountNumber || "",
      ifsc: p.payoutDetails?.ifsc || "",
      bankName: p.payoutDetails?.bankName || "",
    });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPartner) return;
    setEditSaving(true);
    try {
      await apiFetch(`/admin/partners/${editingPartner.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: editForm.name,
          phone: editForm.phone,
          state: editForm.state || null,
          city: editForm.city || null,
          referralCode: editForm.referralCode,
          commissionPercentage: Number(editForm.commissionPercentage),
          status: editForm.status,
          payoutDetails: {
            accountName: editForm.accountName || null,
            accountNumber: editForm.accountNumber || null,
            ifsc: editForm.ifsc || null,
            bankName: editForm.bankName || null,
          },
        }),
      });
      toast({
        title: "Partner Updated",
        description: `Updated partner settings for ${editForm.name}.`,
      });
      setEditingPartner(null);
      fetchPartners();
    } catch (err: any) {
      toast({
        title: "Update Failed",
        description: err.message || "Failed to update partner",
        variant: "destructive",
      });
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggleStatus = async (p: AdminPartnerRow) => {
    try {
      await apiFetch(`/admin/partners/${p.id}/toggle-status`, { method: "POST" });
      toast({
        title: "Status Toggled",
        description: `Partner ${p.name} is now ${p.status === "active" ? "suspended" : "active"}.`,
      });
      fetchPartners();
    } catch (err: any) {
      toast({
        title: "Action Failed",
        description: err.message || "Failed to toggle partner status",
        variant: "destructive",
      });
    }
  };

  const toggleShowPassword = (partnerId: number) => {
    setShowPassMap((prev) => ({
      ...prev,
      [partnerId]: !prev[partnerId],
    }));
  };

  const handleResetPassword = async (p: AdminPartnerRow, customPassword?: string) => {
    setResettingId(p.id);
    try {
      const res = await apiFetch<{ email: string; tempPassword: string }>(
        `/admin/partners/${p.id}/reset-password`,
        {
          method: "POST",
          body: JSON.stringify({ customPassword: customPassword?.trim() || undefined }),
        }
      );
      setResetModal({ email: res.email, tempPass: res.tempPassword });
      setCustomPassModal(null);
      fetchPartners();
      if (selectedPartnerId === p.id) {
        handleOpenDetail(p.id);
      }
      toast({
        title: "Password Updated",
        description: `Login password for ${p.email} has been updated.`,
      });
    } catch (err: any) {
      toast({
        title: "Reset Failed",
        description: err.message || "Failed to reset partner password",
        variant: "destructive",
      });
    } finally {
      setResettingId(null);
    }
  };

  const handleCopyFullCredentials = (p: AdminPartnerRow) => {
    const loginUrl = `${window.location.origin}/partner/auth`;
    const pass = p.tempPassword || "(Use existing password or request reset)";
    const text = `🎉 *Bitebend Partner Portal Credentials*\n\nPartner Name: ${p.name}\nLogin ID: ${p.email}\nPassword: ${pass}\nReferral Code: ${p.referralCode || "N/A"}\n\nLogin Portal: ${loginUrl}\n\nPlease keep your credentials confidential.`;
    handleCopy(text, `full-cred-${p.id}`);
    toast({
      title: "Credentials Formatted & Copied",
      description: "Ready to share with the partner via WhatsApp or Email.",
    });
  };

  const handleOpenDetail = async (partnerId: number) => {
    setSelectedPartnerId(partnerId);
    setDetailLoading(true);
    try {
      const data = await apiFetch<any>(`/admin/partners/${partnerId}`);
      setDetailData(data);
      setDetailTierInput(data.partner?.commissionPercentage ?? 10);
    } catch (err: any) {
      toast({
        title: "Failed to load details",
        description: err.message,
        variant: "destructive",
      });
      setSelectedPartnerId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSaveDetailTier = async (targetPercentage?: number) => {
    if (!detailData?.partner) return;
    const newRate = typeof targetPercentage === "number" ? targetPercentage : Number(detailTierInput);
    if (isNaN(newRate) || newRate < 0 || newRate > 100) {
      toast({
        title: "Invalid Commission Rate",
        description: "Commission tier percentage must be between 0% and 100%.",
        variant: "destructive",
      });
      return;
    }
    setDetailTierSaving(true);
    try {
      await apiFetch<any>(`/admin/partners/${detailData.partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({ commissionPercentage: newRate }),
      });
      toast({
        title: "Commission Tier Updated",
        description: `Updated ${detailData.partner.name}'s tier to ${newRate}%. Relative payouts for all new subscription transactions will use this rate.`,
      });
      setDetailTierInput(newRate);
      setDetailData((prev: any) =>
        prev
          ? {
              ...prev,
              partner: {
                ...prev.partner,
                commissionPercentage: newRate,
              },
            }
          : null
      );
      setPartners((prev) =>
        prev.map((p) =>
          p.id === detailData.partner.id ? { ...p, commissionPercentage: newRate } : p
        )
      );
    } catch (err: any) {
      toast({
        title: "Failed to update tier",
        description: err.message || "Could not update commission percentage",
        variant: "destructive",
      });
    } finally {
      setDetailTierSaving(false);
    }
  };

  const handleSaveRowTier = async (partnerId: number) => {
    const newRate = Number(rowTierInput);
    if (isNaN(newRate) || newRate < 0 || newRate > 100) {
      toast({
        title: "Invalid Rate",
        description: "Commission rate must be between 0% and 100%.",
        variant: "destructive",
      });
      return;
    }
    setRowTierSaving(true);
    try {
      await apiFetch(`/admin/partners/${partnerId}`, {
        method: "PATCH",
        body: JSON.stringify({ commissionPercentage: newRate }),
      });
      toast({
        title: "Commission Tier Saved",
        description: `Partner commission tier updated to ${newRate}%.`,
      });
      setPartners((prev) =>
        prev.map((p) => (p.id === partnerId ? { ...p, commissionPercentage: newRate } : p))
      );
      setEditingRowTierId(null);
    } catch (err: any) {
      toast({
        title: "Failed to update tier",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setRowTierSaving(false);
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filteredPartners = partners.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.referralCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.phone.includes(searchTerm);

    const matchesStatus = statusFilter === "all" ? true : p.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const totalPartners = partners.length;
  const activePartners = partners.filter((p) => p.status === "active").length;
  const totalAttributedRestaurants = partners.reduce((sum, p) => sum + (p.totalRestaurants || 0), 0);
  const totalPartnerEarned = partners.reduce((sum, p) => sum + (p.totalEarned || 0), 0);

  return (
    <div className="space-y-6">
      {/* Top Banner & Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Partners</span>
          <p className="text-2xl font-bold text-slate-900 mt-1">{totalPartners}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-emerald-600 font-medium">{activePartners} active</span>
            {partners.filter((p) => p.status === "pending").length > 0 && (
              <span className="text-xs text-amber-600 font-bold bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                {partners.filter((p) => p.status === "pending").length} pending
              </span>
            )}
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Attributed Outlets</span>
          <p className="text-2xl font-bold text-slate-900 mt-1">{totalAttributedRestaurants}</p>
          <p className="text-xs text-slate-500 mt-0.5">Onboarded via partners</p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Commission Earned</span>
          <p className="text-2xl font-bold text-emerald-700 mt-1">
            ₹{totalPartnerEarned.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">All-time partner earnings</p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
          <div>
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">New Partner</span>
            <p className="text-xs text-slate-400 mt-0.5">Add channel partner account</p>
          </div>
          <button
            onClick={() => setCreateModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold transition-colors shadow-2xs mt-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Create Partner</span>
          </button>
        </div>
      </div>

      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Channel Partner Management</h2>
          <p className="text-sm text-slate-500">
            Review open registrations, configure commission rates, monitor attributed restaurants, and manage partner accounts.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search partner, email, code..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white shadow-2xs"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-2xs"
          >
            <option value="all">All Statuses ({partners.length})</option>
            <option value="pending">Pending ({partners.filter((p) => p.status === "pending").length})</option>
            <option value="active">Active ({partners.filter((p) => p.status === "active").length})</option>
            <option value="suspended">Suspended ({partners.filter((p) => p.status === "suspended").length})</option>
            <option value="rejected">Rejected ({partners.filter((p) => p.status === "rejected").length})</option>
          </select>
        </div>
      </div>

      {/* Status Filter Pills */}
      {/* View Switcher & Status Filter Pills */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <button
            onClick={() => setStatusFilter("all")}
            className={cn(
              "px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
              statusFilter === "all"
                ? "bg-slate-900 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            )}
          >
            <span>All</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-700 text-slate-200">
              {partners.length}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("pending")}
            className={cn(
              "px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
              statusFilter === "pending"
                ? "bg-amber-600 text-white shadow-xs"
                : "bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200"
            )}
          >
            <span>Pending Review</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500 text-white font-bold">
              {partners.filter((p) => p.status === "pending").length}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("active")}
            className={cn(
              "px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
              statusFilter === "active"
                ? "bg-emerald-600 text-white shadow-xs"
                : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200"
            )}
          >
            <span>Active</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500 text-white">
              {partners.filter((p) => p.status === "active").length}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("suspended")}
            className={cn(
              "px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
              statusFilter === "suspended"
                ? "bg-rose-600 text-white shadow-xs"
                : "bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-200"
            )}
          >
            <span>Suspended</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-rose-500 text-white">
              {partners.filter((p) => p.status === "suspended").length}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("rejected")}
            className={cn(
              "px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
              statusFilter === "rejected"
                ? "bg-slate-700 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200"
            )}
          >
            <span>Rejected</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-500 text-white">
              {partners.filter((p) => p.status === "rejected").length}
            </span>
          </button>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200 shrink-0">
          <button
            onClick={() => setViewMode("directory")}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
              viewMode === "directory"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <Handshake className="w-3.5 h-3.5 text-amber-600" />
            <span>Directory Overview</span>
          </button>
          <button
            onClick={() => setViewMode("credentials")}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
              viewMode === "credentials"
                ? "bg-white text-amber-900 shadow-xs border border-amber-200"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <KeyRound className="w-3.5 h-3.5 text-amber-600" />
            <span>Password & Login Store</span>
          </button>
        </div>
      </div>

      {/* Partners Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm">Loading partners...</div>
        ) : filteredPartners.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Handshake className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="text-base font-bold text-slate-700">No partners found</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              No partners match the selected filter criteria.
            </p>
          </div>
        ) : viewMode === "credentials" ? (
          /* ── DEDICATED PASSWORD & LOGIN CREDENTIALS STORE TABLE ── */
          <div className="overflow-x-auto">
            <div className="p-4 bg-gradient-to-r from-amber-500/10 via-orange-500/5 to-amber-500/10 border-b border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-600 text-white flex items-center justify-center shadow-xs">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Partner Password Store & Access Keys</h3>
                  <p className="text-[11px] text-slate-500">View stored temporary passwords, decrypt credentials, copy formatted onboarding messages, or trigger resets.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-amber-900 bg-amber-100/80 px-2.5 py-1 rounded-md border border-amber-300">
                  {filteredPartners.length} Partner Accounts
                </span>
              </div>
            </div>

            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Partner Identity</th>
                  <th className="px-5 py-3.5">Login Email (User ID)</th>
                  <th className="px-5 py-3.5">Portal Password</th>
                  <th className="px-5 py-3.5">Referral Code</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5 text-right">Quick Credential Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredPartners.map((p) => {
                  const isPassRevealed = Boolean(showPassMap[p.id]);
                  const displayPass = p.tempPassword || null;

                  return (
                    <tr key={p.id} className="hover:bg-amber-50/30 transition-colors">
                      <td className="px-5 py-4">
                        <div>
                          <div className="font-bold text-slate-900 text-sm flex items-center gap-1.5">
                            <span>{p.name}</span>
                            <button
                              onClick={() => handleOpenDetail(p.id)}
                              className="text-slate-400 hover:text-amber-600 cursor-pointer"
                              title="Inspect Details"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono mt-0.5">{p.phone}</div>
                          {(p.city || p.state) && (
                            <span className="text-[10px] text-slate-400">
                              {[p.city, p.state].filter(Boolean).join(", ")}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-5 py-4">
                        <div className="inline-flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200 font-mono text-slate-900 text-xs">
                          <span className="select-all">{p.email}</span>
                          <button
                            onClick={() => handleCopy(p.email, `email-${p.id}`)}
                            className="text-slate-400 hover:text-slate-700 cursor-pointer"
                            title="Copy Email ID"
                          >
                            {copiedKey === `email-${p.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      </td>

                      <td className="px-5 py-4">
                        {displayPass ? (
                          <div className="inline-flex items-center gap-2 bg-amber-50/80 px-2.5 py-1.5 rounded-lg border border-amber-200 font-mono text-xs shadow-2xs">
                            <span className="font-bold text-slate-900 select-all">
                              {isPassRevealed ? displayPass : "••••••••••••"}
                            </span>
                            <button
                              onClick={() => toggleShowPassword(p.id)}
                              className="text-amber-700 hover:text-amber-900 p-0.5 rounded cursor-pointer"
                              title={isPassRevealed ? "Hide Password" : "Show Password"}
                            >
                              {isPassRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => handleCopy(displayPass, `pass-${p.id}`)}
                              className="text-amber-700 hover:text-amber-900 p-0.5 rounded cursor-pointer"
                              title="Copy Password"
                            >
                              {copiedKey === `pass-${p.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 bg-slate-100 px-2 py-1 rounded border border-slate-200">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Encrypted Hash</span>
                            <button
                              onClick={() => setCustomPassModal({ partner: p, customPassword: "", useRandom: true })}
                              className="text-amber-700 hover:text-amber-900 font-bold ml-1 hover:underline cursor-pointer"
                              title="Set or reset password for this partner"
                            >
                              Set Password
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="px-5 py-4">
                        {p.referralCode ? (
                          <div className="inline-flex items-center gap-1.5 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 font-mono font-bold text-amber-900 text-xs">
                            <span>{p.referralCode}</span>
                            <button
                              onClick={() => handleCopy(p.referralCode, `ref-${p.id}`)}
                              className="text-amber-600 hover:text-amber-800 cursor-pointer"
                              title="Copy Code"
                            >
                              {copiedKey === `ref-${p.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400 italic">Pending Approval</span>
                        )}
                      </td>

                      <td className="px-5 py-4">
                        {p.status === "pending" && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-50 text-amber-800 border border-amber-300">
                            Pending
                          </span>
                        )}
                        {p.status === "active" && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Active
                          </span>
                        )}
                        {p.status === "suspended" && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-rose-50 text-rose-700 border border-rose-200">
                            Suspended
                          </span>
                        )}
                        {p.status === "rejected" && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-slate-100 text-slate-600 border border-slate-300">
                            Rejected
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleCopyFullCredentials(p)}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold text-xs inline-flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                            title="Copy Full Login Instructions for WhatsApp / Email"
                          >
                            <Share2 className="w-3.5 h-3.5 text-amber-700" />
                            <span>{copiedKey === `full-cred-${p.id}` ? "Copied!" : "Copy Invite"}</span>
                          </button>

                          <button
                            onClick={() => setCustomPassModal({ partner: p, customPassword: "", useRandom: true })}
                            disabled={resettingId === p.id}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs inline-flex items-center gap-1 shadow-2xs cursor-pointer transition-colors disabled:opacity-50"
                            title="Set custom password or auto-generate reset token"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>Reset / Set</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* ── STANDARD DIRECTORY OVERVIEW TABLE ── */
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Partner Details</th>
                  <th className="px-5 py-3.5">Referral Code</th>
                  <th className="px-5 py-3.5">Login ID & Password</th>
                  <th className="px-5 py-3.5">Commission Tier</th>
                  <th className="px-5 py-3.5">Attributed Outlets</th>
                  <th className="px-5 py-3.5">Financials (Earned / Pending)</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredPartners.map((p) => {
                  const isPassRevealed = Boolean(showPassMap[p.id]);
                  const displayPass = p.tempPassword || null;

                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-4">
                        <div>
                          <span className="font-bold text-slate-900 text-sm">{p.name}</span>
                          <div className="text-[11px] text-slate-500 mt-0.5">{p.email}</div>
                          <div className="text-[11px] text-slate-400">{p.phone}</div>
                          {(p.city || p.state) && (
                            <div className="flex items-center gap-1 text-[11px] text-amber-800 bg-amber-50/80 px-2 py-0.5 rounded border border-amber-200/60 mt-1.5 w-fit">
                              <MapPin className="w-3 h-3 text-amber-600" />
                              <span>{[p.city, p.state].filter(Boolean).join(", ")}</span>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        {p.referralCode ? (
                          <div className="inline-flex items-center gap-1.5 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200 font-mono font-bold text-amber-900 text-xs">
                            <span>{p.referralCode}</span>
                            <button
                              onClick={() => handleCopy(p.referralCode, `ref-${p.id}`)}
                              className="text-amber-600 hover:text-amber-800 cursor-pointer"
                              title="Copy Code"
                            >
                              {copiedKey === `ref-${p.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400 italic">
                            Generated on Approval (BBP-XXXXXX)
                          </span>
                        )}
                      </td>

                      {/* Login ID & Password column */}
                      <td className="px-5 py-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-slate-600 font-mono text-[11px]">
                            <span className="truncate max-w-[130px]" title={p.email}>{p.email}</span>
                            <button
                              onClick={() => handleCopy(p.email, `em-${p.id}`)}
                              className="text-slate-400 hover:text-slate-700 cursor-pointer shrink-0"
                              title="Copy Email ID"
                            >
                              {copiedKey === `em-${p.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>

                          {displayPass ? (
                            <div className="flex items-center gap-1 bg-amber-50/70 px-2 py-0.5 rounded border border-amber-200/80 font-mono text-[11px] text-slate-800 w-fit">
                              <span className="font-bold">
                                {isPassRevealed ? displayPass : "••••••••"}
                              </span>
                              <button
                                onClick={() => toggleShowPassword(p.id)}
                                className="text-amber-700 hover:text-amber-900 cursor-pointer p-0.5"
                                title={isPassRevealed ? "Hide Password" : "Show Password"}
                              >
                                {isPassRevealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                              </button>
                              <button
                                onClick={() => handleCopy(displayPass, `pass-${p.id}`)}
                                className="text-amber-700 hover:text-amber-900 cursor-pointer p-0.5"
                                title="Copy Password"
                              >
                                {copiedKey === `pass-${p.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setCustomPassModal({ partner: p, customPassword: "", useRandom: true })}
                              className="text-[10px] text-amber-700 hover:text-amber-900 font-bold hover:underline cursor-pointer flex items-center gap-1"
                            >
                              <KeyRound className="w-2.5 h-2.5" />
                              <span>Set / Reset Password</span>
                            </button>
                          )}
                        </div>
                      </td>

                      <td className="px-5 py-4">
                        {editingRowTierId === p.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.5"
                              value={rowTierInput}
                              onChange={(e) => setRowTierInput(Number(e.target.value))}
                              className="w-16 px-1.5 py-1 text-xs font-bold border border-amber-400 rounded focus:ring-2 focus:ring-amber-500 outline-none bg-white shadow-2xs"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveRowTier(p.id);
                                if (e.key === "Escape") setEditingRowTierId(null);
                              }}
                            />
                            <span className="text-xs font-bold text-slate-500">%</span>
                            <button
                              disabled={rowTierSaving}
                              onClick={() => handleSaveRowTier(p.id)}
                              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded cursor-pointer disabled:opacity-50"
                              title="Save Tier"
                            >
                              {rowTierSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5 font-bold" />}
                            </button>
                            <button
                              onClick={() => setEditingRowTierId(null)}
                              className="p-1 text-slate-400 hover:bg-slate-100 rounded cursor-pointer"
                              title="Cancel"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 group">
                            <span className="inline-flex items-center gap-1 font-bold text-slate-800 text-sm bg-amber-50/50 px-2 py-0.5 rounded border border-amber-200/60">
                              <Percent className="w-3.5 h-3.5 text-amber-600" /> {p.commissionPercentage}%
                            </span>
                            <button
                              onClick={() => {
                                setEditingRowTierId(p.id);
                                setRowTierInput(p.commissionPercentage || 10);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all cursor-pointer"
                              title="Quick Edit Commission Tier"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <button
                          onClick={() => handleOpenDetail(p.id)}
                          className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:text-amber-800 hover:underline cursor-pointer"
                        >
                          <Store className="w-3.5 h-3.5" />
                          <span>{p.totalRestaurants || 0} Outlets</span>
                        </button>
                      </td>
                      <td className="px-5 py-4 space-y-1">
                        <div className="font-bold text-emerald-700">
                          ₹{(p.totalEarned || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                        </div>
                        <div className="text-[11px] text-amber-700">
                          Pending: ₹{(p.totalPending || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        {p.status === "pending" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-800 border border-amber-300">
                            Pending Review
                          </span>
                        )}
                        {p.status === "active" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Active
                          </span>
                        )}
                        {p.status === "suspended" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-rose-50 text-rose-700 border border-rose-200">
                            Suspended
                          </span>
                        )}
                        {p.status === "rejected" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-300">
                            Rejected
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {p.status === "pending" && (
                            <>
                              <button
                                onClick={() => setApproveModal({ partner: p, commissionPercentage: p.commissionPercentage || 10 })}
                                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1 shadow-xs cursor-pointer transition-colors"
                                title="Approve Partner Application"
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                                <span>Approve</span>
                              </button>
                              <button
                                onClick={() => setRejectModal({ partner: p, reason: "" })}
                                className="px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold text-xs flex items-center gap-1 cursor-pointer transition-colors"
                                title="Reject Application"
                              >
                                <UserX className="w-3.5 h-3.5" />
                                <span>Reject</span>
                              </button>
                            </>
                          )}

                          <button
                            onClick={() => handleOpenDetail(p.id)}
                            className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] transition-colors cursor-pointer"
                            title="View Ledger & Outlets"
                          >
                            Inspect
                          </button>

                          {p.status !== "pending" && (
                            <>
                              <button
                                onClick={() => handleOpenEdit(p)}
                                className="p-1.5 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 cursor-pointer"
                                title="Edit Partner"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setCustomPassModal({ partner: p, customPassword: "", useRandom: true })}
                                disabled={resettingId === p.id}
                                className="p-1.5 rounded hover:bg-slate-100 text-amber-600 hover:text-amber-800 cursor-pointer"
                                title="Reset / Change Password"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>
                              {p.status === "rejected" ? (
                                <button
                                  onClick={() => setApproveModal({ partner: p, commissionPercentage: p.commissionPercentage || 10 })}
                                  className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold text-[11px] border border-emerald-200 cursor-pointer"
                                  title="Re-Approve Partner"
                                >
                                  Re-Approve
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleToggleStatus(p)}
                                  className={cn(
                                    "p-1.5 rounded hover:bg-slate-100 cursor-pointer",
                                    p.status === "active" ? "text-rose-500 hover:text-rose-700" : "text-emerald-600 hover:text-emerald-700"
                                  )}
                                  title={p.status === "active" ? "Suspend Partner" : "Activate Partner"}
                                >
                                  {p.status === "active" ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CREATE PARTNER MODAL ── */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                  <Handshake className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Create Channel Partner</h3>
                  <p className="text-xs text-slate-500">Sets up a login account and referral code</p>
                </div>
              </div>
              <button onClick={() => setCreateModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreatePartner} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1 col-span-2">
                  <label className="font-bold text-slate-700">Full Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Priya Sharma"
                    value={createForm.name}
                    onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Login Email *</label>
                  <input
                    type="email"
                    required
                    placeholder="partner@example.com"
                    value={createForm.email}
                    onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Password *</label>
                  <input
                    type="password"
                    required
                    placeholder="Min 6 chars"
                    value={createForm.password}
                    onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Phone Number *</label>
                  <input
                    type="tel"
                    required
                    placeholder="e.g. +91 9876543210"
                    value={createForm.phone}
                    onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">State</label>
                  <select
                    value={createForm.state}
                    onChange={(e) => {
                      const newState = e.target.value;
                      setCreateForm({ ...createForm, state: newState, city: "" });
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none bg-white cursor-pointer"
                  >
                    <option value="">Select State...</option>
                    {STATE_NAMES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">City / District</label>
                  <input
                    type="text"
                    list="admin-create-city-list"
                    placeholder={createForm.state ? "Enter or select city" : "Enter city"}
                    value={createForm.city}
                    onChange={(e) => setCreateForm({ ...createForm, city: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                  {createForm.state && (
                    <datalist id="admin-create-city-list">
                      {getDistricts(createForm.state).map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Commission % (Recurring)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={createForm.commissionPercentage}
                    onChange={(e) => setCreateForm({ ...createForm, commissionPercentage: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none font-bold"
                  />
                </div>

                <div className="space-y-1 col-span-2">
                  <label className="font-bold text-slate-700">Referral Code (Optional — Auto Generated if blank)</label>
                  <input
                    type="text"
                    placeholder="e.g. PRIYA2024"
                    value={createForm.referralCode}
                    onChange={(e) => setCreateForm({ ...createForm, referralCode: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none uppercase font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT PARTNER MODAL ── */}
      {editingPartner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">Edit Partner: {editingPartner.name}</h3>
                <p className="text-xs text-slate-500">{editingPartner.email}</p>
              </div>
              <button onClick={() => setEditingPartner(null)} className="text-slate-400 hover:text-slate-600">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Partner Name</label>
                  <input
                    type="text"
                    required
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Phone Number</label>
                  <input
                    type="tel"
                    required
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">State</label>
                  <select
                    value={editForm.state}
                    onChange={(e) => {
                      const newState = e.target.value;
                      setEditForm({ ...editForm, state: newState, city: "" });
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none bg-white cursor-pointer"
                  >
                    <option value="">Select State...</option>
                    {STATE_NAMES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">City / District</label>
                  <input
                    type="text"
                    list="admin-edit-city-list"
                    placeholder={editForm.state ? "Enter or select city" : "Enter city"}
                    value={editForm.city}
                    onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                  {editForm.state && (
                    <datalist id="admin-edit-city-list">
                      {getDistricts(editForm.state).map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Referral Code</label>
                  <input
                    type="text"
                    required
                    value={editForm.referralCode}
                    onChange={(e) => setEditForm({ ...editForm, referralCode: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none uppercase font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="font-bold text-slate-700">Commission % (Tier)</label>
                    <span className="text-[10px] text-amber-700 font-bold">{editForm.commissionPercentage}% Recurring</span>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={editForm.commissionPercentage}
                    onChange={(e) => setEditForm({ ...editForm, commissionPercentage: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none font-bold"
                  />
                  <div className="flex items-center gap-1 pt-1 flex-wrap">
                    {[5, 10, 12.5, 15, 20, 25].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setEditForm({ ...editForm, commissionPercentage: preset })}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer",
                          editForm.commissionPercentage === preset
                            ? "bg-amber-600 text-white border-amber-600"
                            : "bg-slate-50 text-slate-600 hover:bg-amber-50 hover:text-amber-800 border-slate-200"
                        )}
                      >
                        {preset}%
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1 col-span-2">
                  <label className="font-bold text-slate-700">Account Status</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none capitalize"
                  >
                    <option value="active">Active (Normal)</option>
                    <option value="suspended">Suspended (Cannot login or earn)</option>
                  </select>
                </div>

                <div className="col-span-2 pt-2 border-t border-slate-100">
                  <p className="font-bold text-slate-800 mb-2">Bank Payout Details</p>
                </div>

                <div className="space-y-1">
                  <label className="text-slate-600">Account Holder Name</label>
                  <input
                    type="text"
                    value={editForm.accountName}
                    onChange={(e) => setEditForm({ ...editForm, accountName: e.target.value })}
                    placeholder="Full name on bank passbook"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-600">Bank Name</label>
                  <input
                    type="text"
                    value={editForm.bankName}
                    onChange={(e) => setEditForm({ ...editForm, bankName: e.target.value })}
                    placeholder="e.g. HDFC Bank, SBI"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-600">Bank Account No.</label>
                  <input
                    type="text"
                    value={editForm.accountNumber}
                    onChange={(e) => setEditForm({ ...editForm, accountNumber: e.target.value })}
                    placeholder="Enter account number"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-600">IFSC Code</label>
                  <input
                    type="text"
                    value={editForm.ifsc}
                    onChange={(e) => setEditForm({ ...editForm, ifsc: e.target.value.toUpperCase() })}
                    placeholder="e.g. HDFC0001234"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono uppercase"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingPartner(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSaving}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold disabled:opacity-50"
                >
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── DETAIL INSPECTOR MODAL ── */}
      {selectedPartnerId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {detailData?.partner?.name || "Partner Details"}
                </h3>
                <p className="text-xs text-slate-500">
                  Ref Code: <span className="font-mono font-bold text-amber-700">{detailData?.partner?.referralCode}</span> • Tier: {detailData?.partner?.commissionPercentage}%
                  {(detailData?.partner?.city || detailData?.partner?.state) && (
                    <span> • 📍 {[detailData?.partner?.city, detailData?.partner?.state].filter(Boolean).join(", ")}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {detailData?.partner && (
                  <button
                    onClick={() => {
                      const p = detailData.partner;
                      setSelectedPartnerId(null);
                      handleOpenEdit({
                        id: p.id,
                        userId: p.userId,
                        name: p.name,
                        email: p.email,
                        phone: p.phone,
                        state: p.state,
                        city: p.city,
                        referralCode: p.referralCode,
                        commissionPercentage: p.commissionPercentage,
                        status: p.status,
                        payoutDetails: p.payoutDetails,
                        createdAt: p.createdAt,
                        updatedAt: p.updatedAt,
                      });
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-bold text-xs cursor-pointer transition-colors"
                    title="Edit Partner Profile & Commission"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    <span>Edit Partner</span>
                  </button>
                )}
                <button onClick={() => setSelectedPartnerId(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>

            {detailLoading ? (
              <div className="p-12 text-center text-slate-400 text-sm">Loading partner details...</div>
            ) : detailData ? (
              <div className="space-y-6 text-xs">
                {/* Financial Summary */}
                <div className="grid grid-cols-4 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                  <div>
                    <span className="text-slate-500">Total Earned</span>
                    <p className="text-base font-bold text-slate-900 mt-0.5">
                      ₹{(detailData.stats?.totalEarned || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div>
                    <span className="text-amber-700">Pending</span>
                    <p className="text-base font-bold text-amber-800 mt-0.5">
                      ₹{(detailData.stats?.totalPending || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div>
                    <span className="text-emerald-700">Approved</span>
                    <p className="text-base font-bold text-emerald-800 mt-0.5">
                      ₹{(detailData.stats?.totalApproved || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div>
                    <span className="text-blue-700">Paid Out</span>
                    <p className="text-base font-bold text-blue-900 mt-0.5">
                      ₹{(detailData.stats?.totalPaid || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>

                {/* ── EDITABLE COMMISSION TIER & INCENTIVE MANAGEMENT ── */}
                <div className="bg-gradient-to-br from-amber-50/70 via-orange-50/30 to-amber-50/50 p-4 rounded-xl border border-amber-200/80 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-amber-500 text-white flex items-center justify-center font-bold shadow-2xs">
                        <Percent className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 text-sm">Partner Commission Tier & Incentive Rate</h4>
                        <p className="text-[11px] text-slate-600">
                          Percentage of restaurant subscription transactions earned by this partner
                        </p>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 font-bold text-amber-900 bg-amber-100/90 px-3 py-1 rounded-md border border-amber-300 text-xs">
                      <Percent className="w-3.5 h-3.5 text-amber-700" /> Active Tier: {detailData.partner?.commissionPercentage}%
                    </span>
                  </div>

                  <div className="bg-white p-3.5 rounded-lg border border-amber-200/70 space-y-3 shadow-2xs">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="font-bold text-slate-700 text-xs">Commission Rate:</label>
                        <div className="relative">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            value={detailTierInput}
                            onChange={(e) => setDetailTierInput(Number(e.target.value))}
                            className="w-24 px-2.5 py-1.5 rounded-md border border-slate-300 text-xs font-bold text-slate-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
                            placeholder="10"
                          />
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400 pointer-events-none">
                            %
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-semibold text-slate-500">Quick Tiers:</span>
                        {[5, 10, 12.5, 15, 20, 25].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setDetailTierInput(preset)}
                            className={cn(
                              "px-2.5 py-1 rounded text-xs font-bold transition-all cursor-pointer",
                              detailTierInput === preset
                                ? "bg-amber-600 text-white shadow-2xs ring-2 ring-amber-400/50"
                                : "bg-slate-50 hover:bg-amber-50 text-slate-700 hover:text-amber-800 border border-slate-200"
                            )}
                          >
                            {preset}%
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        disabled={detailTierSaving || Number(detailTierInput) === Number(detailData.partner?.commissionPercentage)}
                        onClick={() => handleSaveDetailTier()}
                        className={cn(
                          "ml-auto px-4 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer",
                          Number(detailTierInput) !== Number(detailData.partner?.commissionPercentage)
                            ? "bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
                            : "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                        )}
                      >
                        {detailTierSaving ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Saving Tier...</span>
                          </>
                        ) : (
                          <>
                            <Save className="w-3.5 h-3.5" />
                            <span>Save Commission Tier</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Live Earning Impact Simulation */}
                    <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-slate-100 text-[11px]">
                      <div className="bg-slate-50/80 p-2.5 rounded-lg border border-slate-200/80">
                        <span className="text-slate-500 font-medium">Monthly Plan (₹999/mo)</span>
                        <p className="font-bold text-emerald-700 text-xs mt-0.5">
                          ₹{((999 * (Number(detailTierInput) || 0)) / 100).toFixed(2)}{" "}
                          <span className="text-[10px] text-slate-400 font-normal">/ transaction</span>
                        </p>
                      </div>
                      <div className="bg-slate-50/80 p-2.5 rounded-lg border border-slate-200/80">
                        <span className="text-slate-500 font-medium">Growth Plan (₹1,999/mo)</span>
                        <p className="font-bold text-emerald-700 text-xs mt-0.5">
                          ₹{((1999 * (Number(detailTierInput) || 0)) / 100).toFixed(2)}{" "}
                          <span className="text-[10px] text-slate-400 font-normal">/ transaction</span>
                        </p>
                      </div>
                      <div className="bg-slate-50/80 p-2.5 rounded-lg border border-slate-200/80">
                        <span className="text-slate-500 font-medium">Annual Pro (₹9,999/yr)</span>
                        <p className="font-bold text-emerald-700 text-xs mt-0.5">
                          ₹{((9999 * (Number(detailTierInput) || 0)) / 100).toFixed(2)}{" "}
                          <span className="text-[10px] text-slate-400 font-normal">/ transaction</span>
                        </p>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-600 flex items-start gap-1.5 leading-relaxed bg-amber-50/60 p-2.5 rounded-lg border border-amber-200/60">
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <strong className="text-slate-800">Dynamic Commission Calculation:</strong> Updating this tier rate immediately sets the earning multiplier for all future subscription payments and renewals from this partner's attributed outlets. Past ledger payouts retain their immutable transaction snapshot rates for accounting and tax integrity.
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── PARTNER PORTAL CREDENTIALS & ACCESS CARD ── */}
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-md bg-amber-100 text-amber-800 flex items-center justify-center font-bold">
                        <Lock className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 text-xs">Partner Account Login & Password Store</h4>
                        <p className="text-[10px] text-slate-500">Credentials required by the partner to log into the Bitebend Partner Portal</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCopyFullCredentials(detailData.partner)}
                      className="px-2.5 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-bold inline-flex items-center gap-1 cursor-pointer transition-colors"
                      title="Copy complete welcome message with credentials"
                    >
                      <Share2 className="w-3.5 h-3.5 text-amber-700" />
                      <span>{copiedKey === `full-cred-${detailData.partner.id}` ? "Copied!" : "Copy Full Invite"}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <span className="text-[10px] text-slate-500 font-bold uppercase">Login Email ID</span>
                      <div className="flex items-center justify-between mt-1">
                        <span className="font-mono text-xs font-bold text-slate-900 truncate max-w-[170px]" title={detailData.partner.email}>
                          {detailData.partner.email}
                        </span>
                        <button
                          onClick={() => handleCopy(detailData.partner.email, `det-em-${detailData.partner.id}`)}
                          className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          title="Copy Email"
                        >
                          {copiedKey === `det-em-${detailData.partner.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <span className="text-[10px] text-slate-500 font-bold uppercase">Portal Password</span>
                      <div className="flex items-center justify-between mt-1">
                        {detailData.partner.tempPassword ? (
                          <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-amber-900">
                            <span>{showPassMap[detailData.partner.id] ? detailData.partner.tempPassword : "••••••••••••"}</span>
                            <button
                              onClick={() => toggleShowPassword(detailData.partner.id)}
                              className="text-amber-700 hover:text-amber-900 cursor-pointer p-0.5"
                              title={showPassMap[detailData.partner.id] ? "Hide Password" : "Show Password"}
                            >
                              {showPassMap[detailData.partner.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                            <button
                              onClick={() => handleCopy(detailData.partner.tempPassword, `det-pass-${detailData.partner.id}`)}
                              className="text-amber-700 hover:text-amber-900 cursor-pointer p-0.5"
                              title="Copy Password"
                            >
                              {copiedKey === `det-pass-${detailData.partner.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-[11px] text-slate-500">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Encrypted Hash</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 flex items-center justify-between">
                      <div>
                        <span className="text-[10px] text-slate-500 font-bold uppercase">Password Action</span>
                        <div className="text-[11px] text-slate-600 mt-0.5">Change / Reset</div>
                      </div>
                      <button
                        onClick={() => setCustomPassModal({ partner: detailData.partner, customPassword: "", useRandom: true })}
                        className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-bold inline-flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                      >
                        <KeyRound className="w-3 h-3" />
                        <span>Reset / Set</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Attributed Outlets List */}
                <div>
                  <h4 className="font-bold text-slate-900 text-sm mb-2">
                    Attributed Restaurants ({detailData.restaurants?.length || 0})
                  </h4>
                  {detailData.restaurants?.length === 0 ? (
                    <p className="text-slate-400 italic">No restaurants onboarded yet.</p>
                  ) : (
                    <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                      <table className="w-full text-left">
                        <thead className="bg-slate-50 text-slate-500 font-semibold border-b">
                          <tr>
                            <th className="p-2.5">Name</th>
                            <th className="p-2.5">City</th>
                            <th className="p-2.5">Phone</th>
                            <th className="p-2.5">Status</th>
                            <th className="p-2.5">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {detailData.restaurants.map((r: any) => (
                            <tr key={r.id}>
                              <td className="p-2.5 font-bold text-slate-800">{r.name}</td>
                              <td className="p-2.5 text-slate-600">{r.city}</td>
                              <td className="p-2.5 text-slate-500">{r.phone}</td>
                              <td className="p-2.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold capitalize bg-slate-100">
                                  {r.subscriptionStatus}
                                </span>
                              </td>
                              <td className="p-2.5 text-slate-400">
                                {new Date(r.createdAt).toLocaleDateString("en-IN")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Recent Commissions List */}
                <div>
                  <h4 className="font-bold text-slate-900 text-sm mb-2">
                    Commission Ledger ({detailData.commissions?.length || 0})
                  </h4>
                  {detailData.commissions?.length === 0 ? (
                    <p className="text-slate-400 italic">No commission transactions recorded yet.</p>
                  ) : (
                    <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                      <table className="w-full text-left">
                        <thead className="bg-slate-50 text-slate-500 font-semibold border-b">
                          <tr>
                            <th className="p-2.5">Txn / Outlet</th>
                            <th className="p-2.5">Plan Amount</th>
                            <th className="p-2.5">Rate</th>
                            <th className="p-2.5">Commission</th>
                            <th className="p-2.5">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {detailData.commissions.map((c: any) => (
                            <tr key={c.id}>
                              <td className="p-2.5">
                                <span className="font-bold">{c.restaurantName || `Outlet #${c.restaurantId}`}</span>
                                <div className="text-[10px] text-slate-400">Txn #{c.subscriptionTransactionId}</div>
                              </td>
                              <td className="p-2.5 font-medium">₹{c.transactionAmount}</td>
                              <td className="p-2.5">{c.commissionRate}%</td>
                              <td className="p-2.5 font-bold text-emerald-700">+₹{c.commissionAmount}</td>
                              <td className="p-2.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold capitalize bg-slate-100">
                                  {c.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* ── CUSTOM / AUTO PASSWORD RESET & SET MODAL ── */}
      {customPassModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-amber-600">
                <KeyRound className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900">Partner Login & Password Setup</h3>
              </div>
              <button
                onClick={() => setCustomPassModal(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const pass = customPassModal.useRandom ? undefined : customPassModal.customPassword;
                handleResetPassword(customPassModal.partner, pass);
              }}
              className="space-y-4 text-xs"
            >
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <div className="text-slate-500 font-medium">Partner: <strong className="text-slate-900">{customPassModal.partner.name}</strong></div>
                <div className="text-slate-500 font-medium font-mono text-[11px]">Email ID: <strong className="text-slate-800">{customPassModal.partner.email}</strong></div>
              </div>

              {/* Password mode options */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Password Generation Mode
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCustomPassModal({ ...customPassModal, useRandom: true })}
                    className={cn(
                      "p-3 rounded-xl border text-left cursor-pointer transition-all",
                      customPassModal.useRandom
                        ? "bg-amber-50 border-amber-400 text-amber-900 font-bold shadow-xs"
                        : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <RefreshCw className="w-3.5 h-3.5 text-amber-600" />
                      <span className="text-xs">Auto Generate</span>
                    </div>
                    <p className="text-[10px] text-slate-500 font-normal">Creates a randomized secure temporary password.</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCustomPassModal({ ...customPassModal, useRandom: false })}
                    className={cn(
                      "p-3 rounded-xl border text-left cursor-pointer transition-all",
                      !customPassModal.useRandom
                        ? "bg-amber-50 border-amber-400 text-amber-900 font-bold shadow-xs"
                        : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Edit2 className="w-3.5 h-3.5 text-amber-600" />
                      <span className="text-xs">Custom Password</span>
                    </div>
                    <p className="text-[10px] text-slate-500 font-normal">Specify custom alphanumeric password manually.</p>
                  </button>
                </div>
              </div>

              {!customPassModal.useRandom && (
                <div className="space-y-1.5 pt-1">
                  <label className="block text-xs font-bold text-slate-700">
                    Enter New Password for Partner *
                  </label>
                  <input
                    type="text"
                    required
                    minLength={6}
                    placeholder="e.g. Partner@2026 or SecurePass99"
                    value={customPassModal.customPassword}
                    onChange={(e) => setCustomPassModal({ ...customPassModal, customPassword: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs focus:ring-2 focus:ring-amber-500 outline-none"
                  />
                  <span className="text-[10px] text-slate-400">Must be at least 6 characters.</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCustomPassModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resettingId === customPassModal.partner.id || (!customPassModal.useRandom && !customPassModal.customPassword.trim())}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold disabled:opacity-50 flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {resettingId === customPassModal.partner.id ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Save & Issue Password</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── RESET PASSWORD CONFIRMATION MODAL ── */}
      {resetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-emerald-600">
                <ShieldCheck className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900">Partner Credentials Ready</h3>
              </div>
              <button onClick={() => setResetModal(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-600">
              The login password for partner account <span className="font-bold text-slate-900">{resetModal.email}</span> has been set.
            </p>

            <div className="space-y-2">
              <div className="p-3.5 bg-amber-50/80 rounded-xl border border-amber-200 font-mono text-slate-900 text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500 font-sans font-bold uppercase">Login Email ID:</span>
                  <span className="font-bold select-all">{resetModal.email}</span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-amber-200/60">
                  <span className="text-[11px] text-slate-500 font-sans font-bold uppercase">Password:</span>
                  <span className="font-bold text-amber-900 text-sm select-all">{resetModal.tempPass}</span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-amber-200/60">
                  <span className="text-[11px] text-slate-500 font-sans font-bold uppercase">Portal Login URL:</span>
                  <span className="text-[11px] text-slate-700 font-sans truncate max-w-[180px]">{window.location.origin}/partner/auth</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  onClick={() => {
                    handleCopy(resetModal.tempPass, "tempPass");
                    toast({ title: "Password Copied", description: "Password copied to clipboard." });
                  }}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  {copiedKey === "tempPass" ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
                  <span>{copiedKey === "tempPass" ? "Copied Password" : "Copy Password"}</span>
                </button>

                <button
                  onClick={() => {
                    const text = `🎉 *Bitebend Partner Portal Credentials*\n\nLogin ID: ${resetModal.email}\nPassword: ${resetModal.tempPass}\n\nLogin Portal: ${window.location.origin}/partner/auth\n\nPlease keep your credentials secure.`;
                    handleCopy(text, "fullInvite");
                    toast({ title: "Invite Copied", description: "Formatted WhatsApp message copied to clipboard." });
                  }}
                  className="w-full py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>{copiedKey === "fullInvite" ? "Invite Copied!" : "Copy Full Invite"}</span>
                </button>
              </div>
            </div>

            <button
              onClick={() => setResetModal(null)}
              className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold cursor-pointer transition-colors"
            >
              Done & Close
            </button>
          </div>
        </div>
      )}

      {/* ── APPROVE APPLICATION MODAL ── */}
      {approveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-emerald-600">
                <UserCheck className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900">Approve Partner Application</h3>
              </div>
              <button
                onClick={() => setApproveModal(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleApprovePartner} className="space-y-4 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-slate-700">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 font-medium">Applicant Name:</span>
                  <span className="font-bold text-slate-900">{approveModal.partner.name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 font-medium">Email:</span>
                  <span className="font-mono text-slate-800">{approveModal.partner.email}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 font-medium">Phone:</span>
                  <span className="font-mono text-slate-800">{approveModal.partner.phone}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-800 flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-amber-600" />
                  <span>Recurring Commission Rate (%)</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  required
                  value={approveModal.commissionPercentage}
                  onChange={(e) =>
                    setApproveModal({
                      ...approveModal,
                      commissionPercentage: Number(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-amber-500 outline-none font-bold text-slate-900 bg-white"
                />
                <p className="text-[11px] text-slate-500">
                  Default is 10% lifetime recurring commission on all subscribed outlets.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] leading-relaxed">
                <span className="font-bold">Automated Referral Code:</span> Upon approval, Bitebend will generate a unique <span className="font-mono font-bold">BBP-XXXXXX</span> referral code, activate the partner&apos;s credentials, and enable restaurant onboarding tracking.
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setApproveModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={approving}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50 flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {approving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                  <span>{approving ? "Approving..." : "Confirm & Activate Partner"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── REJECT APPLICATION MODAL ── */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-rose-600">
                <UserX className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900">Reject Application</h3>
              </div>
              <button
                onClick={() => setRejectModal(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRejectPartner} className="space-y-4 text-xs">
              <p className="text-slate-600 leading-relaxed">
                Are you sure you want to reject the partner application for <span className="font-bold text-slate-900">{rejectModal.partner.name}</span> ({rejectModal.partner.email})?
              </p>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-800">Rejection Reason (Internal Note / Log)</label>
                <textarea
                  rows={3}
                  placeholder="e.g. Duplicate profile, unverified credentials, location unsupported..."
                  value={rejectModal.reason}
                  onChange={(e) =>
                    setRejectModal({
                      ...rejectModal,
                      reason: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-amber-500 outline-none bg-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setRejectModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={rejecting}
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50 flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {rejecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />}
                  <span>{rejecting ? "Rejecting..." : "Confirm Rejection"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
