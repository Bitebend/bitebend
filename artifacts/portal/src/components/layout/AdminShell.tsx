import {
  LayoutDashboard,
  Store,
  CreditCard,
  ShoppingBag,
  Users,
  Bell,
  BarChart3,
  LogOut,
  Menu,
  X,
  Shield,
  ChevronRight,
  FileText,
  Receipt,
  BookOpen,
  LineChart,
  Handshake,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useState } from "react";
import logo from "@/assets/logo.png";

export type AdminSection =
  | "overview"
  | "restaurants"
  | "plans"
  | "payments"
  | "customers"
  | "notifications"
  | "legal"
  | "bills"
  | "resources"
  | "security"
  | "analytics"
  | "partners"
  | "commissions";

interface NavItem {
  key: AdminSection;
  label: string;
  icon: React.ElementType;
  badge?: number;
}

interface AdminShellProps {
  children: React.ReactNode;
  activeSection: AdminSection;
  onSectionChange: (s: AdminSection) => void;
  navItems: NavItem[];
}

export function AdminShell({ children, activeSection, onSectionChange, navItems }: AdminShellProps) {
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNav = (key: AdminSection) => {
    onSectionChange(key);
    setMobileOpen(false);
  };

  const Sidebar = () => (
    <div className="flex flex-col h-full bg-gradient-to-b from-[#FFA733] via-[#FF921F] to-[#E67700] text-white shadow-xl border-r border-white/20">
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-white/20 shrink-0">
        <img
          src={logo}
          alt="Bitebend"
          className="w-36 h-auto object-contain brightness-0 invert"
          style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.3))" }}
        />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <p className="text-[10px] font-extrabold text-white uppercase tracking-wider px-3 pt-2 pb-1.5 opacity-90">
          Platform
        </p>
        {navItems.map((item) => {
          const active = activeSection === item.key;
          return (
            <button
              key={item.key}
              onClick={() => handleNav(item.key)}
              className={cn(
                "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm transition-all text-left cursor-pointer",
                active
                  ? "bg-white/25 text-white font-bold shadow-sm backdrop-blur-xs ring-1 ring-white/60"
                  : "text-white hover:bg-white/15 hover:text-white font-medium"
              )}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0 text-white" />
              <span className="flex-1 text-white">{item.label}</span>
              {item.badge != null && item.badge > 0 && (
                <span className={cn(
                  "text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center",
                  active ? "bg-white/30 text-white" : "bg-red-600 text-white border border-white/30"
                )}>
                  {item.badge}
                </span>
              )}
              {active && <ChevronRight className="w-3.5 h-3.5 text-white opacity-90" />}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/20 space-y-1.5 shrink-0">
        <div className="px-3 py-2.5 rounded-lg bg-black/15 border border-white/20">
          <p className="text-xs font-bold text-white truncate">{user?.name}</p>
          <p className="text-[11px] text-white/90 truncate">{user?.email}</p>
          <span className="inline-block mt-1 text-[10px] font-extrabold uppercase tracking-wider text-white bg-white/20 px-2 py-0.5 rounded border border-white/30">
            Super Admin
          </span>
        </div>
        <button
          onClick={logout}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white hover:bg-white/15 transition-colors cursor-pointer font-medium"
        >
          <LogOut className="w-4 h-4 text-white" />
          <span className="text-white">Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-amber-50/50 flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col fixed h-full z-20">
        <Sidebar />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-60 z-40 flex-col transition-transform duration-200 md:hidden flex",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <Sidebar />
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:ml-60 min-h-screen">
        {/* Mobile topbar */}
        <div className="md:hidden h-14 border-b border-white/20 bg-gradient-to-r from-[#FFA733] to-[#E67700] text-white flex items-center px-4 gap-3 sticky top-0 z-10">
          <button
            className="text-white hover:opacity-80 cursor-pointer"
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? <X className="w-5 h-5 text-white" /> : <Menu className="w-5 h-5 text-white" />}
          </button>
          <div className="flex items-center gap-2">
            <img
              src={logo}
              alt="Bitebend"
              className="h-8 w-auto object-contain brightness-0 invert"
              style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.3))" }}
            />
          </div>
        </div>

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export const ADMIN_NAV_ITEMS = (
  pendingPayments: number,
  exhaustedRestaurants: number,
  pendingCommissions: number = 0,
): NavItem[] => [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "restaurants", label: "Restaurants", icon: Store, badge: exhaustedRestaurants },
  { key: "partners", label: "Partners", icon: Handshake },
  { key: "commissions", label: "Commissions", icon: DollarSign, badge: pendingCommissions },
  { key: "plans", label: "Plans", icon: BarChart3 },
  { key: "payments", label: "Payments", icon: CreditCard, badge: pendingPayments },
  { key: "customers", label: "Customers", icon: Users },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "legal", label: "Legal Pages", icon: FileText },
  { key: "bills", label: "Bill Metrics", icon: Receipt },
  { key: "resources", label: "Tutorials", icon: BookOpen },
  { key: "analytics", label: "Visitor Analytics", icon: LineChart },
  { key: "security", label: "Security", icon: Shield },
];
