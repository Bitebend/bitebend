import { useState } from "react";
import { Store, Search, Filter, Phone, Mail, Calendar, CheckCircle2, XCircle, QrCode, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

interface RestaurantRow {
  id: number;
  name: string;
  slug: string;
  phone: string;
  email: string;
  city: string;
  address?: string;
  cuisineType?: string;
  subscriptionStatus: string;
  customerLimit?: number;
  customersUsed?: number;
  isActive: boolean;
  planId: number | null;
  planName?: string | null;
  qrStandsCount?: number;
  hardwareOrderId?: number | null;
  hardwareQuantity?: number;
  hardwareUnitPrice?: number;
  hardwareTotalAmount?: number;
  hardwareCollectionStatus?: string;
  hardwareCollectedAt?: string | null;
  createdAt: string;
}

interface PartnerRestaurantsTabProps {
  restaurants?: RestaurantRow[];
  loading?: boolean;
  onRefresh?: () => void;
}

export function PartnerRestaurantsTab({
  restaurants = [],
  loading = false,
  onRefresh,
}: PartnerRestaurantsTabProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [collectingId, setCollectingId] = useState<number | null>(null);
  const [collectSuccessMsg, setCollectSuccessMsg] = useState<string | null>(null);

  const safeList = Array.isArray(restaurants) ? restaurants : [];

  const handleCollectHardware = async (orderId: number, amount: number) => {
    if (!window.confirm(`Confirm offline collection of ₹${amount} for physical QR display stands?`)) {
      return;
    }
    setCollectingId(orderId);
    try {
      await apiFetch(`/partner/hardware-orders/${orderId}/collect`, {
        method: "POST",
        body: JSON.stringify({ notes: "Collected offline by partner during restaurant visit." }),
      });
      setCollectSuccessMsg(`Successfully recorded offline collection of ₹${amount}.`);
      setTimeout(() => setCollectSuccessMsg(null), 4000);
      onRefresh?.();
    } catch (err: any) {
      alert(err.message || "Failed to mark hardware order collected");
    } finally {
      setCollectingId(null);
    }
  };

  const filtered = safeList.filter((r) => {
    const matchesSearch =
      (r.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.city || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.phone || "").includes(searchTerm) ||
      (r.email || "").toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === "all"
        ? true
        : statusFilter === "active"
        ? r.subscriptionStatus === "active" && r.isActive
        : r.subscriptionStatus !== "active" || !r.isActive;

    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Success banner */}
      {collectSuccessMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-4 py-2.5 rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{collectSuccessMsg}</span>
        </div>
      )}

      {/* Header & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Attributed Restaurants</h2>
          <p className="text-sm text-slate-500">
            Outlets onboarded using your partner referral code. You earn recurring commissions on software subscriptions, and collect physical QR stand fees offline.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by name, city, phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white shadow-2xs"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-2xs"
          >
            <option value="all">All Statuses ({safeList.length})</option>
            <option value="active">Active Plan</option>
            <option value="inactive">Inactive / Expired</option>
          </select>
        </div>
      </div>

      {/* Table Container */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm">Loading attributed restaurants...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Store className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="text-base font-bold text-slate-700">No restaurants match your search</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              {searchTerm || statusFilter !== "all"
                ? "Try adjusting your search criteria or filter options."
                : "No restaurants have registered with your referral link yet. Share your link to start onboarding."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3">Restaurant</th>
                  <th className="px-5 py-3">Location</th>
                  <th className="px-5 py-3">Contact Details</th>
                  <th className="px-5 py-3">Subscription</th>
                  <th className="px-5 py-3">QR Stands & Hardware</th>
                  <th className="px-5 py-3">Customer Usage</th>
                  <th className="px-5 py-3">Onboarded Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filtered.map((r) => {
                  const hasHardware = (r.hardwareQuantity ?? (r.qrStandsCount ?? 0)) > 0;
                  const qty = r.hardwareQuantity ?? (r.qrStandsCount ?? 0);
                  const total = r.hardwareTotalAmount ?? (qty * 30);
                  const status = r.hardwareCollectionStatus ?? (hasHardware ? "pending" : "none");

                  return (
                    <tr key={r.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-4">
                        <div>
                          <div className="font-bold text-slate-900 text-sm">{r.name}</div>
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5">slug: {r.slug}</div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="font-medium text-slate-800">{r.city}</span>
                        {r.address && <p className="text-[11px] text-slate-400 truncate max-w-[160px]">{r.address}</p>}
                      </td>
                      <td className="px-5 py-4 space-y-1">
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <Phone className="w-3 h-3 text-slate-400" />
                          <span>{r.phone}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                          <Mail className="w-3 h-3 text-slate-400" />
                          <span className="truncate max-w-[150px]">{r.email}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="space-y-1">
                          <span
                            className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold capitalize",
                              r.subscriptionStatus === "active"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : r.subscriptionStatus === "exhausted"
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-slate-100 text-slate-600 border border-slate-200"
                            )}
                          >
                            {r.subscriptionStatus}
                          </span>
                          {r.planName && <p className="text-[11px] font-medium text-slate-600">{r.planName}</p>}
                        </div>
                      </td>
                      {/* QR Stands & Hardware column */}
                      <td className="px-5 py-4">
                        {hasHardware ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <QrCode className="w-3.5 h-3.5 text-orange-500" />
                              <span className="font-bold text-slate-800">
                                {qty} stands
                              </span>
                              <span className="text-slate-500 font-semibold">(₹{total})</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {status === "collected" ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                  <Check className="w-3 h-3" /> Collected Offline
                                </span>
                              ) : status === "waived" ? (
                                <span className="text-[10px] font-medium text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                                  Waived
                                </span>
                              ) : (
                                <div className="space-y-1">
                                  <span className="inline-flex items-center text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                                    Pending Collection
                                  </span>
                                  {r.hardwareOrderId && (
                                    <button
                                      disabled={collectingId === r.hardwareOrderId}
                                      onClick={() => handleCollectHardware(r.hardwareOrderId!, total)}
                                      className="block text-[10px] font-bold text-orange-600 hover:text-orange-700 hover:underline disabled:opacity-50"
                                    >
                                      {collectingId === r.hardwareOrderId ? (
                                        <span className="inline-flex items-center gap-1">
                                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Recording...
                                        </span>
                                      ) : (
                                        `Mark ₹${total} Collected`
                                      )}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[11px]">None</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="text-slate-800 font-medium">
                          {(r.customersUsed || 0).toLocaleString()} / {(r.customerLimit || 0).toLocaleString()}
                        </div>
                        <p className="text-[10px] text-slate-400">customers served</p>
                      </td>
                      <td className="px-5 py-4 text-slate-500 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
