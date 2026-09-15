import { useState } from "react";
import {
  DollarSign,
  Search,
  Filter,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Calendar,
  Receipt,
} from "lucide-react";
import type { PartnerCommission } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PartnerCommissionsTabProps {
  commissions?: PartnerCommission[];
  loading?: boolean;
  onRefresh?: () => void;
}

export function PartnerCommissionsTab({
  commissions = [],
  loading = false,
}: PartnerCommissionsTabProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const safeList = Array.isArray(commissions) ? commissions : [];

  const filtered = safeList.filter((c) => {
    const matchesSearch =
      (c.restaurantName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.payoutReference || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      String(c.subscriptionTransactionId || "").includes(searchTerm);

    const matchesStatus = statusFilter === "all" ? true : c.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const totalEarned = safeList.reduce((sum, c) => sum + (c.status !== "cancelled" ? Number(c.commissionAmount || 0) : 0), 0);
  const pendingAmount = safeList.reduce((sum, c) => sum + (c.status === "pending" ? Number(c.commissionAmount || 0) : 0), 0);
  const approvedAmount = safeList.reduce((sum, c) => sum + (c.status === "approved" ? Number(c.commissionAmount || 0) : 0), 0);
  const paidAmount = safeList.reduce((sum, c) => sum + (c.status === "paid" ? Number(c.commissionAmount || 0) : 0), 0);

  return (
    <div className="space-y-6">
      {/* Commission Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Total Recorded</span>
          <p className="text-xl font-bold text-slate-900 mt-1">
            ₹{totalEarned.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-amber-200 bg-amber-50/30 shadow-2xs">
          <span className="text-[11px] font-medium text-amber-700 uppercase tracking-wider">Pending Review</span>
          <p className="text-xl font-bold text-amber-800 mt-1">
            ₹{pendingAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-emerald-200 bg-emerald-50/30 shadow-2xs">
          <span className="text-[11px] font-medium text-emerald-700 uppercase tracking-wider">Approved for Payout</span>
          <p className="text-xl font-bold text-emerald-800 mt-1">
            ₹{approvedAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-blue-200 bg-blue-50/30 shadow-2xs">
          <span className="text-[11px] font-medium text-blue-700 uppercase tracking-wider">Paid / Disbursed</span>
          <p className="text-xl font-bold text-blue-900 mt-1">
            ₹{paidAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* Filter Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Commission Ledger</h2>
          <p className="text-sm text-slate-500">
            Immutable log of all commission earnings generated from your attributed restaurant subscriptions.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search restaurant, txn, ref..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white shadow-2xs"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-2xs"
          >
            <option value="all">All Statuses ({safeList.length})</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Ledger Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm">Loading commission ledger...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Receipt className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="text-base font-bold text-slate-700">No commission records found</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Commissions are automatically recorded here every time an attributed restaurant purchases or renews a subscription.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3">ID / Date</th>
                  <th className="px-5 py-3">Attributed Outlet</th>
                  <th className="px-5 py-3">Transaction Amount</th>
                  <th className="px-5 py-3">Commission Rate</th>
                  <th className="px-5 py-3">Commission Amount</th>
                  <th className="px-5 py-3">Payout Status</th>
                  <th className="px-5 py-3">Disbursement Info</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-4 whitespace-nowrap">
                      <span className="font-mono font-bold text-slate-900">#{c.id}</span>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {new Date(c.createdAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="font-bold text-slate-900 text-sm">
                        {c.restaurantName || `Restaurant #${c.restaurantId}`}
                      </div>
                      {c.restaurantCity && (
                        <div className="text-[11px] text-slate-500">{c.restaurantCity}</div>
                      )}
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        Txn #{c.subscriptionTransactionId}
                      </div>
                    </td>
                    <td className="px-5 py-4 font-semibold text-slate-800">
                      ₹{c.transactionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200/80 font-bold text-[11px]">
                        {c.commissionRate}%
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="font-bold text-emerald-700 text-sm">
                        +₹{c.commissionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={cn(
                          "inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold capitalize",
                          c.status === "paid"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : c.status === "approved"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : c.status === "pending"
                            ? "bg-amber-50 text-amber-700 border border-amber-200"
                            : "bg-red-50 text-red-700 border border-red-200"
                        )}
                      >
                        {c.status}
                      </span>
                      {c.notes && (
                        <p className="text-[10px] text-slate-500 mt-1 max-w-[140px] truncate" title={c.notes}>
                          {c.notes}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-4 space-y-1">
                      {c.status === "paid" ? (
                        <div>
                          {c.payoutReference ? (
                            <div className="font-mono text-[11px] font-semibold text-slate-800">
                              Ref: {c.payoutReference}
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-500">Processed</span>
                          )}
                          {c.paidAt && (
                            <div className="text-[10px] text-slate-400">
                              Paid {new Date(c.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">
                          {c.status === "approved" ? "Scheduled for next payout batch" : "Pending approval"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
