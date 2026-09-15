import { useState } from "react";
import {
  DollarSign,
  Store,
  Clock,
  CheckCircle2,
  TrendingUp,
  Copy,
  Check,
  ExternalLink,
  ArrowUpRight,
  ShieldCheck,
  Percent,
  AlertCircle,
} from "lucide-react";
import type { PartnerDashboardData } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PartnerDashboardTabProps {
  data: PartnerDashboardData;
  onNavigateToRestaurants: () => void;
  onNavigateToCommissions: () => void;
  onNavigateToProfile: () => void;
}

export function PartnerDashboardTab({
  data,
  onNavigateToRestaurants,
  onNavigateToCommissions,
  onNavigateToProfile,
}: PartnerDashboardTabProps) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const { partner, metrics, recentRestaurants, recentCommissions } = data;

  const referralUrl = partner?.referralCode
    ? `${window.location.origin}/partner/${partner.referralCode}`
    : "";

  const handleCopyLink = () => {
    if (!referralUrl) return;
    navigator.clipboard.writeText(referralUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyCode = () => {
    if (!partner?.referralCode) return;
    navigator.clipboard.writeText(partner.referralCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Referral Link Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700 p-6 sm:p-8 text-white shadow-lg">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/20 text-xs font-semibold backdrop-blur-xs">
              <Percent className="w-3.5 h-3.5" />
              <span>{partner.commissionPercentage}% Recurring Commission on Every Subscription</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
              Onboard Restaurants with Your Partner Link
            </h2>
            <p className="text-sm text-amber-100/90 leading-relaxed">
              Share your referral link with restaurant owners. Every time an attributed restaurant subscribes or renews their plan, your commission is automatically credited.
            </p>
          </div>

          <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shrink-0 space-y-2.5">
            <span className="text-xs font-medium text-amber-200">Your Dedicated Referral Link:</span>
            <div className="flex items-center gap-2 bg-black/30 p-1.5 rounded-lg border border-white/15">
              <input
                type="text"
                readOnly
                value={referralUrl}
                className="bg-transparent text-xs text-white px-2 py-1 outline-none w-48 sm:w-64 font-mono truncate"
              />
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs transition-colors shadow-xs cursor-pointer shrink-0"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-900 stroke-[3]" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedLink ? "Link Copied" : "Copy Link"}</span>
              </button>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-white/15">
              <div className="flex items-center gap-2">
                <span className="text-xs text-amber-200/90 font-medium">Code:</span>
                <span className="font-mono text-xl font-extrabold text-white bg-black/40 px-3 py-1 rounded-lg border border-white/20 tracking-wider shadow-inner">
                  {partner.referralCode}
                </span>
              </div>
              <button
                onClick={handleCopyCode}
                className="text-xs text-amber-300 hover:text-white underline cursor-pointer font-semibold flex items-center gap-1.5 self-start sm:self-auto"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCode ? "Code Copied!" : "Copy Code Only"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Earned */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Earned</span>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">
            ₹{metrics.totalEarned.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-500">All-time commissions</p>
        </div>

        {/* Pending Payout */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Pending Payout</span>
            <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-amber-700">
            ₹{metrics.pendingPayout.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-amber-600 font-medium">Awaiting admin review</p>
        </div>

        {/* Paid Commissions */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Paid Payouts</span>
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">
            ₹{metrics.paidPayout.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-500">Disbursed to your account</p>
        </div>

        {/* Total Attributed Restaurants */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Attributed Outlets</span>
            <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
              <Store className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{metrics.totalRestaurants}</p>
          <p className="text-xs text-purple-600 font-medium">{metrics.activeRestaurants} currently active</p>
        </div>
      </div>

      {/* Payout Details Notice Banner if missing */}
      {!partner.payoutDetails?.accountNumber && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-bold text-amber-900">Add Your Bank Payout Details</h4>
              <p className="text-xs text-amber-700 mt-0.5">
                Set up your Bank Account details so the Bitebend Admin team can process your commission payouts directly.
              </p>
            </div>
          </div>
          <button
            onClick={onNavigateToProfile}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shrink-0 transition-colors"
          >
            Configure Payout
          </button>
        </div>
      )}

      {/* Two column grid: Recent Restaurants & Recent Commissions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Restaurants */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Recent Attributed Restaurants</h3>
              <p className="text-xs text-slate-500">Latest outlets onboarded via your link</p>
            </div>
            <button
              onClick={onNavigateToRestaurants}
              className="text-xs font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
            >
              <span>View all ({metrics.totalRestaurants})</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-5 flex-1">
            {recentRestaurants.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <Store className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm font-medium text-slate-600">No restaurants onboarded yet</p>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  Share your referral link with restaurant owners to start earning commissions.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentRestaurants.map((r) => (
                  <div key={r.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">{r.name}</h4>
                      <p className="text-xs text-slate-500">
                        {r.city} • Onboarded {new Date(r.createdAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold capitalize",
                          r.subscriptionStatus === "active"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-slate-100 text-slate-600 border border-slate-200"
                        )}
                      >
                        {r.subscriptionStatus}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Commissions */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Recent Commissions</h3>
              <p className="text-xs text-slate-500">Latest earnings from plan purchases</p>
            </div>
            <button
              onClick={onNavigateToCommissions}
              className="text-xs font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
            >
              <span>View all ledger</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-5 flex-1">
            {recentCommissions.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <DollarSign className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm font-medium text-slate-600">No commissions recorded yet</p>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  Commissions appear automatically when an attributed restaurant subscribes to a paid plan.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentCommissions.map((c) => (
                  <div key={c.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-800">
                          +₹{c.commissionAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                        </span>
                        <span className="text-xs text-slate-400 font-normal">
                          ({c.commissionRate}% of ₹{c.transactionAmount})
                        </span>
                      </div>
                      <p className="text-xs text-slate-500">
                        {c.restaurantName || "Restaurant"} • {new Date(c.createdAt).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}
                      </p>
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold capitalize",
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
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
