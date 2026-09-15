import React, { useState } from "react";
import { useLocation } from "wouter";
import {
  Clock,
  AlertTriangle,
  XCircle,
  RefreshCw,
  LogOut,
  Mail,
  Phone,
  User,
  Calendar,
  Sparkles,
  ShieldCheck,
  Percent,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { PartnerProfile } from "@/lib/types";

interface PartnerStatusScreenProps {
  partner: Partial<PartnerProfile>;
  onRefresh?: () => void;
}

export function PartnerStatusScreen({ partner, onRefresh }: PartnerStatusScreenProps) {
  const { logout } = useAuth();
  const [, setLocation] = useLocation();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (onRefresh) {
      setRefreshing(true);
      await onRefresh();
      setTimeout(() => setRefreshing(false), 600);
    }
  };

  const handleLogout = async () => {
    await logout();
    setLocation("/partner/login");
  };

  const status = partner.status || "pending";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between font-sans selection:bg-amber-500 selection:text-slate-950">
      {/* Top Bar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center font-bold text-slate-950">
              B
            </div>
            <span className="font-bold text-sm sm:text-base text-white tracking-tight">
              Bitebend <span className="text-amber-400">Partner Channel</span>
            </span>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-900 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Center Status Card */}
      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="max-w-xl w-full bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6 text-center backdrop-blur-xl">
          {status === "pending" && (
            <>
              <div className="w-16 h-16 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center justify-center mx-auto shadow-lg shadow-amber-500/10">
                <Clock className="w-8 h-8 animate-pulse" />
              </div>

              <div className="space-y-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-amber-400/10 border border-amber-400/20 text-amber-400 text-xs font-bold uppercase tracking-wider">
                  <span>Application Under Review</span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  Welcome, {partner.name || "Partner"}!
                </h1>
                <p className="text-sm text-slate-300 leading-relaxed max-w-md mx-auto">
                  Your Bitebend Channel Partner application has been received. Our operations team is currently reviewing your profile.
                </p>
              </div>

              {/* Status details card */}
              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-left space-y-2.5 text-xs text-slate-300">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-slate-500" />
                    <span>Applicant Name:</span>
                  </span>
                  <span className="font-semibold text-white">{partner.name || "N/A"}</span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-slate-500" />
                    <span>Registered Email:</span>
                  </span>
                  <span className="font-mono text-white">{partner.email || "N/A"}</span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-slate-500" />
                    <span>Contact Phone:</span>
                  </span>
                  <span className="font-mono text-white">{partner.phone || "N/A"}</span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <Percent className="w-3.5 h-3.5 text-slate-500" />
                    <span>Commission Rate:</span>
                  </span>
                  <span className="font-semibold text-amber-400">
                    {partner.commissionPercentage ? `${partner.commissionPercentage}% Recurring` : "Recurring Lifetime"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-slate-500" />
                    <span>Referral Code:</span>
                  </span>
                  <span className="text-slate-400 italic">Generated upon Super Admin approval (BBP-XXXXXX)</span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300/90 leading-relaxed text-left flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  Once approved by Bitebend Super Admin, your account will activate instantly and you will receive your official referral link to start onboarding restaurants.
                </span>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-center gap-3 justify-center">
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-bold text-xs transition-all shadow-lg shadow-amber-500/20 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
                  <span>Check Application Status</span>
                </button>
              </div>
            </>
          )}

          {status === "suspended" && (
            <>
              <div className="w-16 h-16 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30 flex items-center justify-center mx-auto shadow-lg shadow-rose-500/10">
                <AlertTriangle className="w-8 h-8" />
              </div>

              <div className="space-y-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-rose-400/10 border border-rose-400/20 text-rose-400 text-xs font-bold uppercase tracking-wider">
                  <span>Account Suspended</span>
                </div>
                <h1 className="text-2xl font-bold text-white tracking-tight">
                  Partner Access Suspended
                </h1>
                <p className="text-sm text-slate-300 leading-relaxed max-w-md mx-auto">
                  Your Bitebend partner account has been suspended by the Super Administrator. Existing attributed restaurants remain recorded, but new commissions and dashboard features are disabled.
                </p>
              </div>

              <p className="text-xs text-slate-400">
                If you believe this is an error or need assistance, please contact{" "}
                <span className="text-amber-400 font-mono">support@bitebend.in</span>.
              </p>
            </>
          )}

          {status === "rejected" && (
            <>
              <div className="w-16 h-16 rounded-full bg-slate-800 text-slate-400 border border-slate-700 flex items-center justify-center mx-auto">
                <XCircle className="w-8 h-8" />
              </div>

              <div className="space-y-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-slate-800 text-slate-400 text-xs font-bold uppercase tracking-wider border border-slate-700">
                  <span>Application Not Approved</span>
                </div>
                <h1 className="text-2xl font-bold text-white tracking-tight">
                  Application Not Approved
                </h1>
                <p className="text-sm text-slate-300 leading-relaxed max-w-md mx-auto">
                  Thank you for your interest in the Bitebend Partner Program. Unfortunately, your application could not be approved at this time.
                </p>
              </div>

              <p className="text-xs text-slate-400">
                For further inquiries, you may email us at{" "}
                <span className="text-amber-400 font-mono">partners@bitebend.in</span>.
              </p>
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950 py-4 text-center text-xs text-slate-500">
        &copy; {new Date().getFullYear()} Bitebend Inc. All rights reserved.
      </footer>
    </div>
  );
}
