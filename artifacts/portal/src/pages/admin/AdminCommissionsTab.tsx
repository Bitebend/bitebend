import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  DollarSign,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileSpreadsheet,
  Check,
  XCircle,
  CreditCard,
  Percent,
  Receipt,
  Building2,
  Calendar,
  User,
  ArrowRight,
  Filter,
  Ban,
  History,
  Inbox,
  Sparkles,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";

interface AdminCommissionItem {
  id: number;
  partnerId: number;
  partnerName: string;
  partnerEmail: string;
  partnerPhone?: string;
  partnerReferralCode: string;
  partnerPayoutDetails?: {
    accountNumber?: string;
    ifsc?: string;
    accountName?: string;
    bankName?: string;
    upiId?: string;
  };
  restaurantId: number;
  restaurantName: string;
  restaurantCity?: string;
  subscriptionTransactionId: number;
  transactionAmount: number;
  commissionRate: number;
  commissionAmount: number;
  status: "pending" | "approved" | "paid" | "cancelled";
  payoutReference?: string;
  paidAt?: string;
  notes?: string;
  createdAt: string;
}

type WorkflowTab = "needs_action" | "paid_settled" | "all_records" | "cancelled";
type ActionSubFilter = "all_action" | "pending" | "approved";

export function AdminCommissionsTab() {
  const { toast } = useToast();
  const [commissions, setCommissions] = useState<AdminCommissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  // Workflow sub-tabs
  const [activeTab, setActiveTab] = useState<WorkflowTab>("needs_action");
  // Sub-filter inside Needs Action ("all_action" | "pending" | "approved")
  const [actionFilter, setActionFilter] = useState<ActionSubFilter>("all_action");
  // Sub-filter for All Records tab ("all" | "pending" | "approved" | "paid" | "cancelled")
  const [allRecordsStatusFilter, setAllRecordsStatusFilter] = useState<string>("all");

  // Payout Modal
  const [payoutModalItem, setPayoutModalItem] = useState<AdminCommissionItem | null>(null);
  const [payoutRef, setPayoutRef] = useState("");
  const [payoutNotes, setPayoutNotes] = useState("");
  const [processingPayout, setProcessingPayout] = useState(false);

  // Status Action state
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);

  const fetchCommissions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<AdminCommissionItem[]>("/admin/commissions");
      setCommissions(data);
    } catch (err: any) {
      toast({
        title: "Failed to fetch commissions",
        description: err.message || "Error loading ledger",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchCommissions();
  }, [fetchCommissions]);

  const handleUpdateStatus = async (
    id: number,
    status: "approved" | "cancelled",
    notes?: string
  ) => {
    setActionLoadingId(id);
    try {
      await apiFetch(`/admin/commissions/${id}/status`, {
        method: "PUT",
        body: JSON.stringify({ status, notes }),
      });
      toast({
        title: `Commission ${status === "approved" ? "Approved" : "Cancelled"}`,
        description: `Commission #${id} status updated to ${status}.`,
      });
      fetchCommissions();
    } catch (err: any) {
      toast({
        title: "Action Failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDisbursePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payoutModalItem) return;
    setProcessingPayout(true);
    try {
      await apiFetch(`/admin/commissions/${payoutModalItem.id}/payout`, {
        method: "POST",
        body: JSON.stringify({
          payoutReference: payoutRef,
          notes: payoutNotes,
        }),
      });
      toast({
        title: "Payout Recorded",
        description: `Commission #${payoutModalItem.id} marked as PAID with ref ${payoutRef}.`,
      });
      setPayoutModalItem(null);
      setPayoutRef("");
      setPayoutNotes("");
      fetchCommissions();
    } catch (err: any) {
      toast({
        title: "Payout Recording Failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setProcessingPayout(false);
    }
  };

  // Aggregated totals & counts for metric cards and tab badges
  const pendingItems = useMemo(() => commissions.filter((c) => c.status === "pending"), [commissions]);
  const approvedItems = useMemo(() => commissions.filter((c) => c.status === "approved"), [commissions]);
  const paidItems = useMemo(() => commissions.filter((c) => c.status === "paid"), [commissions]);
  const cancelledItems = useMemo(() => commissions.filter((c) => c.status === "cancelled"), [commissions]);
  const actionItems = useMemo(() => commissions.filter((c) => c.status === "pending" || c.status === "approved"), [commissions]);

  const totalCommissions = useMemo(
    () => commissions.reduce((sum, c) => sum + (c.status !== "cancelled" ? c.commissionAmount : 0), 0),
    [commissions]
  );
  const pendingAmount = useMemo(() => pendingItems.reduce((sum, c) => sum + c.commissionAmount, 0), [pendingItems]);
  const approvedAmount = useMemo(() => approvedItems.reduce((sum, c) => sum + c.commissionAmount, 0), [approvedItems]);
  const paidAmount = useMemo(() => paidItems.reduce((sum, c) => sum + c.commissionAmount, 0), [paidItems]);

  // Tab switching via Interactive Metric Cards
  const handleCardClick = (targetTab: WorkflowTab, targetSubFilter?: ActionSubFilter) => {
    setActiveTab(targetTab);
    if (targetTab === "needs_action" && targetSubFilter) {
      setActionFilter(targetSubFilter);
    }
  };

  // Filtered view by active workflow tab, sub-filter, and search term
  const displayedCommissions = useMemo(() => {
    let list: AdminCommissionItem[] = [];

    if (activeTab === "needs_action") {
      if (actionFilter === "pending") {
        list = pendingItems;
      } else if (actionFilter === "approved") {
        list = approvedItems;
      } else {
        list = actionItems;
      }
    } else if (activeTab === "paid_settled") {
      list = paidItems;
    } else if (activeTab === "cancelled") {
      list = cancelledItems;
    } else {
      // all_records
      if (allRecordsStatusFilter === "all") {
        list = commissions;
      } else {
        list = commissions.filter((c) => c.status === allRecordsStatusFilter);
      }
    }

    if (!searchTerm.trim()) return list;

    const term = searchTerm.toLowerCase();
    return list.filter(
      (c) =>
        c.partnerName.toLowerCase().includes(term) ||
        c.partnerEmail.toLowerCase().includes(term) ||
        c.partnerReferralCode.toLowerCase().includes(term) ||
        c.restaurantName.toLowerCase().includes(term) ||
        (c.payoutReference || "").toLowerCase().includes(term) ||
        String(c.subscriptionTransactionId).includes(term) ||
        String(c.id).includes(term)
    );
  }, [
    activeTab,
    actionFilter,
    allRecordsStatusFilter,
    commissions,
    pendingItems,
    approvedItems,
    paidItems,
    cancelledItems,
    actionItems,
    searchTerm,
  ]);

  const exportToExcel = () => {
    const rows = displayedCommissions.map((c) => ({
      "Commission ID": c.id,
      "Date": new Date(c.createdAt).toLocaleDateString("en-IN"),
      "Partner Name": c.partnerName,
      "Partner Email": c.partnerEmail,
      "Partner Ref Code": c.partnerReferralCode,
      "Bank Account": c.partnerPayoutDetails?.accountNumber || "",
      "Bank IFSC": c.partnerPayoutDetails?.ifsc || "",
      "Account Holder": c.partnerPayoutDetails?.accountName || "",
      "Bank Name": c.partnerPayoutDetails?.bankName || "",
      "UPI ID": c.partnerPayoutDetails?.upiId || "",
      "Restaurant ID": c.restaurantId,
      "Restaurant Name": c.restaurantName,
      "Restaurant City": c.restaurantCity || "",
      "Subscription Txn ID": c.subscriptionTransactionId,
      "Plan Transaction Amount (INR)": c.transactionAmount,
      "Commission Rate (%)": c.commissionRate,
      "Commission Earned (INR)": c.commissionAmount,
      "Payout Status": c.status,
      "Payout Reference / UTR": c.payoutReference || "",
      "Paid At": c.paidAt ? new Date(c.paidAt).toLocaleDateString("en-IN") : "",
      "Notes": c.notes || "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Commissions Ledger");
    const activeLabel =
      activeTab === "needs_action"
        ? "Action_Queue"
        : activeTab === "paid_settled"
        ? "Paid_History"
        : activeTab === "cancelled"
        ? "Cancelled"
        : "All_Ledger";
    XLSX.writeFile(wb, `Bitebend_Partner_Commissions_${activeLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="space-y-6" id="admin-commissions-section">
      {/* ── INTERACTIVE SUMMARY CARDS (Quick Filters) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" id="commission-summary-cards">
        {/* Card 1: All / Total Volume */}
        <button
          type="button"
          onClick={() => handleCardClick("all_records")}
          className={cn(
            "text-left p-5 rounded-xl border transition-all shadow-2xs group relative cursor-pointer",
            activeTab === "all_records"
              ? "bg-white border-slate-900 ring-2 ring-slate-900/10 shadow-md"
              : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-xs"
          )}
          id="metric-card-total"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Volume</span>
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
              {commissions.length}
            </span>
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-1.5">
            ₹{totalCommissions.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <div className="flex items-center justify-between text-xs text-slate-400 mt-1">
            <span>Complete ledger</span>
            <span className="text-[11px] font-semibold text-slate-600 group-hover:text-slate-900 flex items-center gap-0.5">
              View All <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </button>

        {/* Card 2: Pending Approval */}
        <button
          type="button"
          onClick={() => handleCardClick("needs_action", "pending")}
          className={cn(
            "text-left p-5 rounded-xl border transition-all shadow-2xs group relative cursor-pointer",
            activeTab === "needs_action" && actionFilter === "pending"
              ? "bg-amber-50/50 border-amber-500 ring-2 ring-amber-500/20 shadow-md"
              : "bg-white border-amber-200 hover:border-amber-400 hover:bg-amber-50/20 hover:shadow-xs"
          )}
          id="metric-card-pending"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-600" />
              Pending Review
            </span>
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
              {pendingItems.length}
            </span>
          </div>
          <p className="text-2xl font-bold text-amber-950 mt-1.5">
            ₹{pendingAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <div className="flex items-center justify-between text-xs text-amber-700 mt-1">
            <span>Awaiting admin review</span>
            <span className="text-[11px] font-bold text-amber-800 group-hover:text-amber-950 flex items-center gap-0.5">
              Filter <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </button>

        {/* Card 3: Ready for Payout */}
        <button
          type="button"
          onClick={() => handleCardClick("needs_action", "approved")}
          className={cn(
            "text-left p-5 rounded-xl border transition-all shadow-2xs group relative cursor-pointer",
            activeTab === "needs_action" && actionFilter === "approved"
              ? "bg-blue-50/50 border-blue-500 ring-2 ring-blue-500/20 shadow-md"
              : "bg-white border-blue-200 hover:border-blue-400 hover:bg-blue-50/20 hover:shadow-xs"
          )}
          id="metric-card-approved"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-blue-800 uppercase tracking-wider flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5 text-blue-600" />
              Ready for Payout
            </span>
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-900">
              {approvedItems.length}
            </span>
          </div>
          <p className="text-2xl font-bold text-blue-950 mt-1.5">
            ₹{approvedAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <div className="flex items-center justify-between text-xs text-blue-700 mt-1">
            <span>Approved for transfer</span>
            <span className="text-[11px] font-bold text-blue-800 group-hover:text-blue-950 flex items-center gap-0.5">
              Filter <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </button>

        {/* Card 4: Paid & Settled */}
        <button
          type="button"
          onClick={() => handleCardClick("paid_settled")}
          className={cn(
            "text-left p-5 rounded-xl border transition-all shadow-2xs group relative cursor-pointer",
            activeTab === "paid_settled"
              ? "bg-emerald-50/50 border-emerald-500 ring-2 ring-emerald-500/20 shadow-md"
              : "bg-white border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50/20 hover:shadow-xs"
          )}
          id="metric-card-paid"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-emerald-800 uppercase tracking-wider flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              Paid & Settled
            </span>
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900">
              {paidItems.length}
            </span>
          </div>
          <p className="text-2xl font-bold text-emerald-950 mt-1.5">
            ₹{paidAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <div className="flex items-center justify-between text-xs text-emerald-700 mt-1">
            <span>Permanent settlement history</span>
            <span className="text-[11px] font-bold text-emerald-800 group-hover:text-emerald-950 flex items-center gap-0.5">
              View History <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </button>
      </div>

      {/* ── WORKFLOW SUB-TABS NAVIGATION BAR ── */}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-1">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          {/* Sub Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto" id="commissions-workflow-tabs">
            {/* 1. Needs Action Tab */}
            <button
              type="button"
              onClick={() => {
                setActiveTab("needs_action");
                setActionFilter("all_action");
              }}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer",
                activeTab === "needs_action"
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900"
              )}
              id="tab-needs-action"
            >
              <Inbox className="w-4 h-4" />
              <span>Needs Action</span>
              {actionItems.length > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                    activeTab === "needs_action"
                      ? "bg-amber-400 text-slate-950"
                      : "bg-amber-100 text-amber-900"
                  )}
                >
                  {actionItems.length}
                </span>
              )}
            </button>

            {/* 2. Paid & Settled Tab */}
            <button
              type="button"
              onClick={() => setActiveTab("paid_settled")}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer",
                activeTab === "paid_settled"
                  ? "bg-emerald-800 text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900"
              )}
              id="tab-paid-settled"
            >
              <History className="w-4 h-4" />
              <span>Paid & Settled</span>
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                  activeTab === "paid_settled"
                    ? "bg-emerald-950/40 text-emerald-100"
                    : "bg-emerald-100 text-emerald-900"
                )}
              >
                {paidItems.length}
              </span>
            </button>

            {/* 3. All Records Tab */}
            <button
              type="button"
              onClick={() => setActiveTab("all_records")}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer",
                activeTab === "all_records"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900"
              )}
              id="tab-all-records"
            >
              <Receipt className="w-4 h-4" />
              <span>All Records</span>
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                  activeTab === "all_records"
                    ? "bg-slate-950/50 text-slate-100"
                    : "bg-slate-200 text-slate-700"
                )}
              >
                {commissions.length}
              </span>
            </button>

            {/* 4. Cancelled Tab */}
            <button
              type="button"
              onClick={() => setActiveTab("cancelled")}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer",
                activeTab === "cancelled"
                  ? "bg-rose-800 text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900"
              )}
              id="tab-cancelled"
            >
              <Ban className="w-4 h-4" />
              <span>Cancelled / Disputed</span>
              {cancelledItems.length > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                    activeTab === "cancelled"
                      ? "bg-rose-950/40 text-rose-100"
                      : "bg-rose-100 text-rose-900"
                  )}
                >
                  {cancelledItems.length}
                </span>
              )}
            </button>
          </div>

          {/* Search Bar & Export Button */}
          <div className="flex items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search partner, restaurant, UTR..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white shadow-2xs"
                id="commissions-search-input"
              />
            </div>

            <button
              onClick={exportToExcel}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold transition-colors shadow-2xs cursor-pointer whitespace-nowrap"
              id="commissions-export-btn"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Export View</span>
            </button>
          </div>
        </div>

        {/* Sub-Filters per Tab */}
        {activeTab === "needs_action" && (
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 font-medium">Filter Action Queue:</span>
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                <button
                  type="button"
                  onClick={() => setActionFilter("all_action")}
                  className={cn(
                    "px-3 py-1 rounded-md font-semibold text-xs transition-colors cursor-pointer",
                    actionFilter === "all_action"
                      ? "bg-white text-slate-900 shadow-2xs font-bold"
                      : "text-slate-600 hover:text-slate-900"
                  )}
                  id="subfilter-all-action"
                >
                  All Needs Action ({actionItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActionFilter("pending")}
                  className={cn(
                    "px-3 py-1 rounded-md font-semibold text-xs transition-colors flex items-center gap-1.5 cursor-pointer",
                    actionFilter === "pending"
                      ? "bg-amber-500 text-white shadow-2xs font-bold"
                      : "text-amber-800 hover:text-amber-950"
                  )}
                  id="subfilter-pending"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Pending Review ({pendingItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActionFilter("approved")}
                  className={cn(
                    "px-3 py-1 rounded-md font-semibold text-xs transition-colors flex items-center gap-1.5 cursor-pointer",
                    actionFilter === "approved"
                      ? "bg-blue-600 text-white shadow-2xs font-bold"
                      : "text-blue-800 hover:text-blue-950"
                  )}
                  id="subfilter-approved"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                  Ready for Payout ({approvedItems.length})
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500 hidden sm:block">
              {actionFilter === "pending"
                ? "Review and approve new commissions generated from subscription payments."
                : actionFilter === "approved"
                ? "Record manual bank transfers / UTR numbers to settle approved commissions."
                : "Operational queue requiring Super Admin review or disbursement."}
            </p>
          </div>
        )}

        {activeTab === "all_records" && (
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 font-medium">Filter Status:</span>
              <select
                value={allRecordsStatusFilter}
                onChange={(e) => setAllRecordsStatusFilter(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-2xs font-medium cursor-pointer"
                id="all-records-status-dropdown"
              >
                <option value="all">All Statuses ({commissions.length})</option>
                <option value="pending">Pending Review ({pendingItems.length})</option>
                <option value="approved">Approved / Ready to Pay ({approvedItems.length})</option>
                <option value="paid">Paid & Settled ({paidItems.length})</option>
                <option value="cancelled">Cancelled / Disputed ({cancelledItems.length})</option>
              </select>
            </div>
            <p className="text-xs text-slate-500 hidden sm:block">
              Full unsegmented commission ledger for financial audits and tracking.
            </p>
          </div>
        )}

        {activeTab === "paid_settled" && (
          <div className="pt-2 flex items-center justify-between">
            <p className="text-xs text-emerald-800 font-medium flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              Settlement history contains all permanently disbursed commissions with recorded UTR references.
            </p>
            <span className="text-xs font-bold text-emerald-900 bg-emerald-100/70 px-2.5 py-1 rounded-full">
              Total Disbursed: ₹{paidAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {activeTab === "cancelled" && (
          <div className="pt-2 flex items-center justify-between">
            <p className="text-xs text-rose-800 font-medium flex items-center gap-1.5">
              <Ban className="w-4 h-4 text-rose-600" />
              Voided, refunded, or cancelled commissions excluded from partner payout calculations.
            </p>
          </div>
        )}
      </div>

      {/* ── MAIN WORKFLOW LEDGER TABLE ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden" id="commissions-table-container">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span>Loading commission records...</span>
          </div>
        ) : displayedCommissions.length === 0 ? (
          <div className="p-12 text-center space-y-3" id="commissions-empty-state">
            <Receipt className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="text-base font-bold text-slate-700">
              {searchTerm
                ? "No matching commissions found"
                : activeTab === "needs_action"
                ? "No commissions currently requiring action"
                : activeTab === "paid_settled"
                ? "No paid settlement history recorded yet"
                : activeTab === "cancelled"
                ? "No cancelled or disputed commissions"
                : "No commission records found"}
            </h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {activeTab === "needs_action"
                ? "All partner commissions have been approved or disbursed. New commissions will appear here automatically when attributed restaurants pay for subscriptions."
                : "Commissions are generated automatically when restaurants subscribe using a valid Partner referral code."}
            </p>
            {searchTerm && (
              <button
                onClick={() => setSearchTerm("")}
                className="text-xs font-bold text-amber-600 hover:underline cursor-pointer"
              >
                Clear Search Filter
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" id="commissions-table">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3.5">ID / Date</th>
                  <th className="px-4 py-3.5">Partner Details</th>
                  <th className="px-4 py-3.5">Attributed Restaurant</th>
                  <th className="px-4 py-3.5">Plan Amount</th>
                  <th className="px-4 py-3.5">Rate (%)</th>
                  <th className="px-4 py-3.5">Commission Earned</th>
                  <th className="px-4 py-3.5">Status</th>
                  <th className="px-4 py-3.5">Payout / Bank Details</th>
                  <th className="px-4 py-3.5 text-right">Workflow Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {displayedCommissions.map((c) => (
                  <tr
                    key={c.id}
                    className={cn(
                      "hover:bg-slate-50/80 transition-colors",
                      c.status === "pending" && "bg-amber-50/15",
                      c.status === "approved" && "bg-blue-50/15"
                    )}
                    id={`commission-row-${c.id}`}
                  >
                    {/* ID & Date */}
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className="font-mono font-bold text-slate-900">#{c.id}</span>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {new Date(c.createdAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    </td>

                    {/* Partner Details */}
                    <td className="px-4 py-4">
                      <div className="font-bold text-slate-900">{c.partnerName}</div>
                      <div className="text-[11px] text-slate-500">{c.partnerEmail}</div>
                      <span className="inline-block mt-0.5 font-mono text-[10px] bg-amber-50 text-amber-800 px-1.5 py-0.2 rounded border border-amber-200 font-bold">
                        {c.partnerReferralCode}
                      </span>
                    </td>

                    {/* Restaurant Details */}
                    <td className="px-4 py-4">
                      <div className="font-bold text-slate-900">{c.restaurantName}</div>
                      {c.restaurantCity && <div className="text-[11px] text-slate-500">{c.restaurantCity}</div>}
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        Txn #{c.subscriptionTransactionId}
                      </div>
                    </td>

                    {/* Plan Transaction Amount */}
                    <td className="px-4 py-4 font-semibold text-slate-800">
                      ₹{c.transactionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </td>

                    {/* Rate */}
                    <td className="px-4 py-4">
                      <span className="font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                        {c.commissionRate}%
                      </span>
                    </td>

                    {/* Commission Amount */}
                    <td className="px-4 py-4">
                      <span className="font-bold text-emerald-700 text-sm">
                        +₹{c.commissionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </span>
                    </td>

                    {/* Status Badge */}
                    <td className="px-4 py-4">
                      <span
                        className={cn(
                          "inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold capitalize",
                          c.status === "paid"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : c.status === "approved"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : c.status === "pending"
                            ? "bg-amber-50 text-amber-700 border border-amber-200"
                            : "bg-rose-50 text-rose-700 border border-rose-200"
                        )}
                        id={`commission-status-badge-${c.id}`}
                      >
                        {c.status === "pending" && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5 animate-pulse" />}
                        {c.status === "approved" && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5" />}
                        {c.status === "paid" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5" />}
                        {c.status}
                      </span>
                      {c.notes && (
                        <p className="text-[10px] text-slate-500 mt-1 max-w-[140px] truncate" title={c.notes}>
                          Note: {c.notes}
                        </p>
                      )}
                    </td>

                    {/* Payout / Bank Details */}
                    <td className="px-4 py-4 space-y-1">
                      {c.status === "paid" ? (
                        <div>
                          <div className="font-mono text-[11px] font-bold text-slate-900 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200 inline-block">
                            UTR: {c.payoutReference || "N/A"}
                          </div>
                          {c.paidAt && (
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              Settled on {new Date(c.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-[11px] text-slate-600">
                          {c.partnerPayoutDetails?.accountNumber ? (
                            <div>
                              <div className="font-mono font-medium text-slate-800">
                                A/C: {c.partnerPayoutDetails.accountNumber}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                IFSC: <span className="font-mono font-semibold">{c.partnerPayoutDetails.ifsc}</span>
                                {c.partnerPayoutDetails.bankName ? ` • ${c.partnerPayoutDetails.bankName}` : ""}
                              </div>
                              {c.partnerPayoutDetails.upiId && (
                                <div className="text-[10px] text-slate-400">
                                  UPI: {c.partnerPayoutDetails.upiId}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-400 italic">No bank details provided</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {c.status === "pending" && (
                          <>
                            <button
                              onClick={() => handleUpdateStatus(c.id, "approved")}
                              disabled={actionLoadingId === c.id}
                              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] transition-colors cursor-pointer shadow-2xs inline-flex items-center gap-1"
                              id={`btn-approve-commission-${c.id}`}
                            >
                              <Check className="w-3 h-3" />
                              <span>Approve</span>
                            </button>
                            <button
                              onClick={() => {
                                const notes = prompt("Enter cancellation reason (optional):");
                                handleUpdateStatus(c.id, "cancelled", notes || undefined);
                              }}
                              disabled={actionLoadingId === c.id}
                              className="px-2 py-1 rounded bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-bold text-[11px] transition-colors cursor-pointer"
                              id={`btn-cancel-commission-${c.id}`}
                            >
                              Cancel
                            </button>
                          </>
                        )}

                        {c.status === "approved" && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => {
                                setPayoutModalItem(c);
                                setPayoutRef("");
                                setPayoutNotes("");
                              }}
                              className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-bold text-[11px] transition-colors shadow-2xs flex items-center gap-1 cursor-pointer"
                              id={`btn-record-payout-${c.id}`}
                            >
                              <CreditCard className="w-3 h-3" />
                              <span>Record Payout</span>
                            </button>
                            <button
                              onClick={() => {
                                const notes = prompt("Enter cancellation reason (optional):");
                                handleUpdateStatus(c.id, "cancelled", notes || undefined);
                              }}
                              disabled={actionLoadingId === c.id}
                              className="px-2 py-1 rounded bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-bold text-[11px] transition-colors cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {c.status === "paid" && (
                          <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded border border-emerald-200 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            Settled
                          </span>
                        )}

                        {c.status === "cancelled" && (
                          <span className="text-[11px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                            Cancelled
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── MARK PAID / DISBURSEMENT MODAL ── */}
      {payoutModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs" id="record-payout-modal">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Record Commission Disbursement</h3>
                  <p className="text-xs text-slate-500">Commission #{payoutModalItem.id}</p>
                </div>
              </div>
              <button
                onClick={() => setPayoutModalItem(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
                id="btn-close-payout-modal"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* Payout Recipient Bank Overview */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500 font-medium">Partner:</span>
                <span className="font-bold text-slate-900">{payoutModalItem.partnerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-medium">Commission Amount:</span>
                <span className="font-bold text-emerald-700 text-sm">
                  ₹{payoutModalItem.commissionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </span>
              </div>
              {payoutModalItem.partnerPayoutDetails?.accountNumber && (
                <div className="space-y-1 pt-1 border-t border-slate-200">
                  {payoutModalItem.partnerPayoutDetails.accountName && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 font-medium">Account Holder:</span>
                      <span className="font-medium text-slate-900">
                        {payoutModalItem.partnerPayoutDetails.accountName}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">Bank A/C:</span>
                    <span className="font-mono font-bold text-slate-800">
                      {payoutModalItem.partnerPayoutDetails.accountNumber}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">IFSC:</span>
                    <span className="font-mono font-bold text-slate-800">
                      {payoutModalItem.partnerPayoutDetails.ifsc}
                    </span>
                  </div>
                  {payoutModalItem.partnerPayoutDetails.bankName && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 font-medium">Bank:</span>
                      <span className="font-medium text-slate-800">
                        {payoutModalItem.partnerPayoutDetails.bankName}
                      </span>
                    </div>
                  )}
                  {payoutModalItem.partnerPayoutDetails.upiId && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 font-medium">UPI ID:</span>
                      <span className="font-mono font-medium text-slate-800">
                        {payoutModalItem.partnerPayoutDetails.upiId}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={handleDisbursePayout} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-slate-700 uppercase tracking-wider">
                  Payment Reference / UTR / Txn ID *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. UTR123456789 or BANK-REF-987"
                  value={payoutRef}
                  onChange={(e) => setPayoutRef(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-blue-500 outline-none font-mono"
                  id="payout-ref-input"
                />
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-700 uppercase tracking-wider">
                  Admin Notes / Remarks (Optional)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Disbursed via Corporate Netbanking"
                  value={payoutNotes}
                  onChange={(e) => setPayoutNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  id="payout-notes-input"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setPayoutModalItem(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={processingPayout}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50 cursor-pointer"
                  id="btn-confirm-payout"
                >
                  {processingPayout ? "Recording..." : "Confirm Payout"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
