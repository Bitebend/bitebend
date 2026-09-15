import {
  LayoutDashboard,
  Store,
  DollarSign,
  User,
  LogOut,
  Menu,
  X,
  Copy,
  Check,
  ChevronRight,
  Percent,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useState } from "react";
import { useLocation } from "wouter";
import logo from "@/assets/logo.png";
import type { PartnerProfile } from "@/lib/types";

export type PartnerSection = "dashboard" | "restaurants" | "commissions" | "profile";

interface PartnerShellProps {
  children: React.ReactNode;
  activeSection?: PartnerSection;
  onSectionChange?: (s: PartnerSection) => void;
  partner?: PartnerProfile | null;
}

export function PartnerShell({
  children,
  activeSection: propActiveSection,
  onSectionChange,
  partner,
}: PartnerShellProps) {
  const { user, logout } = useAuth();
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Derive active section from location if not explicitly provided as prop
  const activeSection: PartnerSection =
    propActiveSection ||
    (location.includes("/restaurants")
      ? "restaurants"
      : location.includes("/commissions")
      ? "commissions"
      : location.includes("/profile")
      ? "profile"
      : "dashboard");

  const referralUrl = partner?.referralCode
    ? `${window.location.origin}/partner/${partner.referralCode}/register`
    : "";

  const handleCopyLink = () => {
    if (!referralUrl) return;
    navigator.clipboard.writeText(referralUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const navItems = [
    {
      key: "dashboard" as PartnerSection,
      path: "/partner/dashboard",
      label: "Dashboard",
      icon: LayoutDashboard,
    },
    {
      key: "restaurants" as PartnerSection,
      path: "/partner/restaurants",
      label: "My Restaurants",
      icon: Store,
      badge: partner?.totalRestaurants,
    },
    {
      key: "commissions" as PartnerSection,
      path: "/partner/commissions",
      label: "Commissions",
      icon: DollarSign,
    },
    {
      key: "profile" as PartnerSection,
      path: "/partner/profile",
      label: "Payout & Profile",
      icon: User,
    },
  ];

  const handleNav = (item: (typeof navItems)[0]) => {
    if (onSectionChange) {
      onSectionChange(item.key);
    } else {
      navigate(item.path);
    }
    setMobileOpen(false);
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate("/partner/login");
    }
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-gradient-to-b from-[#FF6F00] via-[#FF7700] to-[#E65100] text-white shadow-2xl border-r border-[#FF9933]/30">
      {/* Logo Header */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-white/20 shrink-0">
        <div className="flex items-center gap-2">
          <img
            src={logo}
            alt="Bitebend"
            className="w-32 h-auto object-contain brightness-0 invert"
            style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.3))" }}
          />
        </div>
        <span className="text-[10px] uppercase font-extrabold tracking-wider bg-yellow-400/30 text-white border border-yellow-200/50 px-2.5 py-0.5 rounded-full shadow-xs">
          Partner
        </span>
      </div>

      {/* Partner Mini Card */}
      {partner && (
        <div className="p-3 mx-3 mt-3 bg-black/15 rounded-xl border border-white/20 backdrop-blur-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white truncate max-w-[140px]">
              {partner.name}
            </span>
            <span
              className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded capitalize",
                partner.status === "active"
                  ? "bg-emerald-600 text-white border border-emerald-400/40"
                  : "bg-red-600 text-white border border-red-400/40"
              )}
            >
              {partner.status}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-white/95">
            <span className="flex items-center gap-1 text-[11px] text-white font-bold">
              <Percent className="w-3 h-3 text-white" /> {partner.commissionPercentage}% Commission
            </span>
          </div>
          <div className="mt-2 pt-2 border-t border-white/20">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-white/80 uppercase font-bold tracking-wider">
                  Partner Code
                </span>
                <button
                  onClick={handleCopyLink}
                  title="Copy registration link"
                  className="text-[10px] flex items-center gap-1 bg-[#B43800] hover:bg-[#992E00] text-white font-bold px-2 py-0.5 rounded-md shadow-xs border border-[#FF8A3D]/40 cursor-pointer transition-colors"
                >
                  {copied ? <Check className="w-3 h-3 text-white" /> : <Copy className="w-3 h-3 text-white" />}
                  <span>{copied ? "Copied" : "Copy Link"}</span>
                </button>
              </div>
              <div className="text-[20px] text-white font-mono font-extrabold tracking-widest bg-black/25 px-2.5 py-1 rounded-lg border border-white/20 text-center select-all">
                {partner.referralCode}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-2">
        <p className="text-[10px] font-extrabold text-white uppercase tracking-wider px-3 pt-3 pb-1">
          Partner Workspace
        </p>
        {navItems.map((item) => {
          const active = activeSection === item.key;
          return (
            <button
              key={item.key}
              onClick={() => handleNav(item)}
              className={cn(
                "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-bold transition-all text-left cursor-pointer shadow-sm border",
                active
                  ? "bg-[#7C2400] text-white font-extrabold shadow-md ring-2 ring-white/80 border-white/40"
                  : "bg-[#B43800] hover:bg-[#992E00] text-white border-[#FF8A3D]/30"
              )}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0 text-white" />
              <span className="flex-1 text-white">{item.label}</span>
              {item.badge != null && item.badge > 0 && (
                <span
                  className={cn(
                    "text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center",
                    active ? "bg-white/30 text-white" : "bg-[#5C1B00] text-white border border-white/30"
                  )}
                >
                  {item.badge}
                </span>
              )}
              {active && <ChevronRight className="w-3.5 h-3.5 text-white opacity-95" />}
            </button>
          );
        })}
      </nav>

      {/* Footer / Logout */}
      <div className="p-3 border-t border-white/20 shrink-0">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-bold bg-[#B43800] hover:bg-[#992E00] text-white shadow-sm border border-[#FF8A3D]/30 transition-colors text-left cursor-pointer"
        >
          <LogOut className="w-[18px] h-[18px] text-white" />
          <span className="text-white">Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col fixed inset-y-0 z-30 shadow-xl">
        <SidebarContent />
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 w-72 z-10 shadow-2xl">
            <SidebarContent />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200/80 sticky top-0 z-20 flex items-center justify-between px-4 sm:px-6 shadow-xs">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-base sm:text-lg font-bold text-slate-900 capitalize">
                {activeSection === "dashboard" && "Channel Partner Dashboard"}
                {activeSection === "restaurants" && "Attributed Restaurants"}
                {activeSection === "commissions" && "Commission Ledger"}
                {activeSection === "profile" && "Payout Settings & Profile"}
              </h1>
              <p className="text-xs text-slate-500 hidden sm:block">
                Bitebend Channel Partner Program
              </p>
            </div>
          </div>

          {/* Top Quick Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {partner?.referralCode && (
              <button
                onClick={handleCopyLink}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200/70 hover:bg-amber-100 transition-colors shadow-2xs cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-amber-600" />}
                <span>{copied ? "Link Copied!" : `Ref: ${partner.referralCode}`}</span>
              </button>
            )}

            <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center text-white text-xs font-bold shadow-xs">
                {(partner?.name || user?.name || "P").charAt(0).toUpperCase()}
              </div>
              <div className="hidden md:block text-left">
                <p className="text-xs font-bold text-slate-800 leading-tight">
                  {partner?.name || user?.name}
                </p>
                <p className="text-[11px] text-slate-500 leading-tight">
                  {partner?.commissionPercentage ?? 10}% Commission
                </p>
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
