import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  ConciergeBell,
  LogOut,
  Clock,
  Store,
  RefreshCw,
  UtensilsCrossed,
  ShoppingBag,
  User,
  CheckCircle2,
  AlertCircle,
  FileText,
  AlertTriangle,
  Loader2,
  ChefHat,
  Flame,
  ShieldAlert,
  Check,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ── Types & Interfaces ────────────────────────────────────────────────────────

interface StaffData {
  id: number;
  name: string;
  role: "waiter" | "chef";
  restaurantId: number;
  restaurantName: string;
  restaurantSlug?: string;
}

interface WaiterOrderItem {
  id: number;
  orderId: number;
  menuItemId: number | null;
  name: string;
  quantity: number;
  isVeg: boolean | null;
  notes: string | null;
}

interface WaiterOrder {
  id: number;
  sessionId: number | null;
  tableId: number | null;
  tableNumber: string | null;
  sessionTableNumber: string | null;
  effectiveTableNumber: string | null;
  sessionType: "dine_in" | "takeaway" | null;
  customerName: string | null;
  status: "ordered" | "preparing" | "ready";
  notes: string | null;
  assignmentSource: "inherited" | "manual_override" | null;
  assignedWaiterId: number;
  createdAt: string;
  updatedAt: string;
  items: WaiterOrderItem[];
}

type ChefModeState = "on" | "off" | "unknown";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatElapsed(dateString: string): string {
  const diffSec = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (diffSec < 60) return "< 1m ago";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ${diffMin % 60}m ago`;
}

function formatClockTime(dateString: string): string {
  try {
    const d = new Date(dateString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  } catch {
    return "";
  }
}

// ── Main Waiter Dashboard Component ──────────────────────────────────────────

export default function WaiterHome() {
  const [, setLocation] = useLocation();
  const [staff, setStaff] = useState<StaffData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<WaiterOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  // Chef Mode state machine: "on" | "off" | "unknown"
  const [chefModeState, setChefModeState] = useState<ChefModeState>("unknown");
  const [, setLastChefModeVerified] = useState<Date | null>(null);

  // Individual order in-flight action state (prevents duplicate submissions per order)
  const [submittingOrderIds, setSubmittingOrderIds] = useState<Set<number>>(new Set());

  // Operational section filter tab: "all" | "ordered" | "preparing" | "ready"
  const [activeTab, setActiveTab] = useState<"all" | "ordered" | "preparing" | "ready">("all");

  // Emergency Ready Dialog state
  const [emergencyOrder, setEmergencyOrder] = useState<WaiterOrder | null>(null);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [emergencySubmitting, setEmergencySubmitting] = useState(false);

  // Concurrency and unmount guards
  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  // 1. Initial Authentication & Role Verification
  useEffect(() => {
    isMountedRef.current = true;
    const raw = localStorage.getItem("bitebend_staff_auth");
    if (!raw) {
      setLocation("/staff/connect");
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed.token || !parsed.staff) {
        localStorage.removeItem("bitebend_staff_auth");
        setLocation("/staff/connect");
        return;
      }
      if (parsed.staff.role === "chef") {
        setLocation("/staff/chef");
        return;
      }
      if (parsed.staff.role !== "waiter") {
        localStorage.removeItem("bitebend_staff_auth");
        setLocation("/staff/connect");
        return;
      }

      setStaff(parsed.staff);
      setToken(parsed.token);
    } catch {
      localStorage.removeItem("bitebend_staff_auth");
      setLocation("/staff/connect");
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [setLocation]);

  // 2. Authoritative Data Synchronization (/api/staff/me + /api/staff/waiter/orders)
  const fetchDashboardData = useCallback(
    async (isManualRefresh = false) => {
      if (!token || isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (isManualRefresh) setRefreshing(true);

      try {
        // A. Authoritative Session & Chef Mode verification via GET /api/staff/me
        let verifiedChefMode: ChefModeState = "unknown";
        try {
          const meRes = await fetch("/api/staff/me", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (meRes.status === 401) {
            localStorage.removeItem("bitebend_staff_auth");
            toast.error("Staff session expired or revoked by manager.");
            setLocation("/staff/connect");
            return;
          }

          if (meRes.ok) {
            const meData = await meRes.json();
            if (typeof meData.chefDashboardEnabled === "boolean") {
              verifiedChefMode = meData.chefDashboardEnabled ? "on" : "off";
              if (isMountedRef.current) {
                setChefModeState(verifiedChefMode);
                setLastChefModeVerified(new Date());
                if (meData.staff) {
                  setStaff((prev) => (prev ? { ...prev, ...meData.staff } : meData.staff));
                }
              }
            } else {
              // Unknown contract - fail safe
              verifiedChefMode = "unknown";
              if (isMountedRef.current) setChefModeState("unknown");
            }
          } else {
            verifiedChefMode = "unknown";
            if (isMountedRef.current) setChefModeState("unknown");
          }
        } catch {
          verifiedChefMode = "unknown";
          if (isMountedRef.current) setChefModeState("unknown");
        }

        // B. Fetch Assigned Orders via GET /api/staff/waiter/orders
        try {
          const ordersRes = await fetch("/api/staff/waiter/orders", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (ordersRes.status === 401) {
            localStorage.removeItem("bitebend_staff_auth");
            toast.error("Staff session expired or revoked by manager.");
            setLocation("/staff/connect");
            return;
          }

          if (!ordersRes.ok) {
            if (isMountedRef.current) setNetworkError(true);
            if (isManualRefresh) {
              toast.error("Could not load floor orders. Showing cached data.");
            }
            return;
          }

          const ordersData: WaiterOrder[] = await ordersRes.json();
          if (isMountedRef.current) {
            setOrders(ordersData);
            setNetworkError(false);
            setLastSynced(new Date());
            if (isManualRefresh) {
              toast.success("Floor station synchronized");
            }
          }
        } catch {
          if (isMountedRef.current) setNetworkError(true);
          if (isManualRefresh) {
            toast.error("Network error. Showing cached orders.");
          }
        }
      } finally {
        isFetchingRef.current = false;
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [token, setLocation],
  );

  // 3. Reliable 7.5s Polling Lifecycle with unmount safety
  useEffect(() => {
    if (!token) return;
    void fetchDashboardData(false);

    const interval = setInterval(() => {
      void fetchDashboardData(false);
    }, 7500);

    return () => clearInterval(interval);
  }, [token, fetchDashboardData]);

  // 4. Logout / Disconnect Action
  const handleLogout = () => {
    localStorage.removeItem("bitebend_staff_auth");
    toast.info("Floor station disconnected");
    setLocation("/staff/connect");
  };

  // 5. Action: Start Preparing (POST /api/staff/waiter/orders/:id/start-prep)
  const handleStartPrep = async (orderId: number) => {
    if (submittingOrderIds.has(orderId) || !token) return;

    setSubmittingOrderIds((prev) => new Set(prev).add(orderId));
    try {
      const res = await fetch(`/api/staff/waiter/orders/${orderId}/start-prep`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 401) {
          localStorage.removeItem("bitebend_staff_auth");
          setLocation("/staff/connect");
          return;
        }
        if (res.status === 403) {
          toast.error(errorData.error || "Order is no longer assigned to you.");
          void fetchDashboardData(false);
          return;
        }
        toast.error(errorData.error || "Failed to start preparation");
        void fetchDashboardData(false);
        return;
      }

      toast.success(`Order #${orderId} marked preparing`);
      void fetchDashboardData(false);
    } catch {
      toast.error("Network error while starting preparation");
      void fetchDashboardData(false);
    } finally {
      if (isMountedRef.current) {
        setSubmittingOrderIds((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    }
  };

  // 6. Action: Standard Ready (POST /api/staff/waiter/orders/:id/ready)
  const handleStandardReady = async (orderId: number) => {
    if (submittingOrderIds.has(orderId) || !token) return;

    if (chefModeState === "unknown") {
      toast.error("Chef Mode status is unavailable. Action disabled until verified.");
      return;
    }

    if (chefModeState === "on") {
      // Direct to emergency ready dialog if clicked
      const target = orders.find((o) => o.id === orderId);
      if (target) {
        setEmergencyOrder(target);
        setEmergencyReason("");
      }
      return;
    }

    setSubmittingOrderIds((prev) => new Set(prev).add(orderId));
    try {
      const res = await fetch(`/api/staff/waiter/orders/${orderId}/ready`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 401) {
          localStorage.removeItem("bitebend_staff_auth");
          setLocation("/staff/connect");
          return;
        }
        if (res.status === 403) {
          // If Chef Mode was just turned ON by owner in the background:
          if (errorData.error && errorData.error.includes("Chef mode is enabled")) {
            setChefModeState("on");
            toast.info("Chef Mode was enabled by owner. Please provide an emergency reason.");
            const target = orders.find((o) => o.id === orderId);
            if (target) {
              setEmergencyOrder(target);
              setEmergencyReason("");
            }
            return;
          }
          toast.error(errorData.error || "Order is no longer assigned to you.");
          void fetchDashboardData(false);
          return;
        }
        toast.error(errorData.error || "Failed to mark order ready");
        void fetchDashboardData(false);
        return;
      }

      toast.success(`Order #${orderId} is ready for pickup`);
      void fetchDashboardData(false);
    } catch {
      toast.error("Network error while marking order ready");
      void fetchDashboardData(false);
    } finally {
      if (isMountedRef.current) {
        setSubmittingOrderIds((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    }
  };

  // 7. Action: Emergency Ready (POST /api/staff/waiter/orders/:id/emergency-ready)
  const handleEmergencyReadySubmit = async () => {
    if (!emergencyOrder || !token || emergencySubmitting) return;

    const trimmedReason = emergencyReason.trim();
    if (trimmedReason.length < 5) {
      toast.error("Please enter at least 5 characters explaining the emergency reason.");
      return;
    }

    const orderId = emergencyOrder.id;
    setEmergencySubmitting(true);
    setSubmittingOrderIds((prev) => new Set(prev).add(orderId));

    try {
      const res = await fetch(`/api/staff/waiter/orders/${orderId}/emergency-ready`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: trimmedReason }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 401) {
          localStorage.removeItem("bitebend_staff_auth");
          setLocation("/staff/connect");
          return;
        }
        if (res.status === 400 && errorData.error && errorData.error.includes("Chef mode is disabled")) {
          setChefModeState("off");
          toast.info("Chef Mode was disabled by owner. Using standard ready.");
          setEmergencyOrder(null);
          void handleStandardReady(orderId);
          return;
        }
        toast.error(errorData.error || "Emergency ready override failed.");
        return;
      }

      toast.success(`Order #${orderId} marked ready via Emergency Override`);
      setEmergencyOrder(null);
      setEmergencyReason("");
      void fetchDashboardData(false);
    } catch {
      toast.error("Network error during emergency ready submission");
    } finally {
      if (isMountedRef.current) {
        setEmergencySubmitting(false);
        setSubmittingOrderIds((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    }
  };

  // 8. Action: Complete Order (POST /api/staff/waiter/orders/:id/complete)
  const handleCompleteOrder = async (orderId: number) => {
    if (submittingOrderIds.has(orderId) || !token) return;

    setSubmittingOrderIds((prev) => new Set(prev).add(orderId));
    try {
      const res = await fetch(`/api/staff/waiter/orders/${orderId}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 401) {
          localStorage.removeItem("bitebend_staff_auth");
          setLocation("/staff/connect");
          return;
        }
        toast.error(errorData.error || "Failed to complete order");
        void fetchDashboardData(false);
        return;
      }

      toast.success(`Order #${orderId} completed`);
      void fetchDashboardData(false);
    } catch {
      toast.error("Network error while completing order");
      void fetchDashboardData(false);
    } finally {
      if (isMountedRef.current) {
        setSubmittingOrderIds((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    }
  };

  // ── Loading Skeleton Screen ──────────────────────────────────────────────────
  if (loading || !staff) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-12 w-12 rounded-2xl bg-blue-500/10 border border-blue-500/30 text-blue-400 flex items-center justify-center shadow-lg shadow-blue-500/5">
            <ConciergeBell className="w-6 h-6 animate-pulse" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-bold text-white">Loading Floor Station</h2>
            <p className="text-xs text-slate-400">Verifying staff credentials and floor assignments...</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Order Filtering & Summary Counters ───────────────────────────────────────
  const activeOrders = orders.filter((o) => ["ordered", "preparing", "ready"].includes(o.status));
  const newOrders = activeOrders.filter((o) => o.status === "ordered");
  const prepOrders = activeOrders.filter((o) => o.status === "preparing");
  const readyOrders = activeOrders.filter((o) => o.status === "ready");

  const trimmedEmergencyReason = emergencyReason.trim();
  const isEmergencyReasonValid = trimmedEmergencyReason.length >= 5;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-500/30 selection:text-blue-200">
      {/* ── Top Header Bar ────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Brand & Floor Staff Info */}
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-400 flex items-center justify-center shrink-0 shadow-inner">
              <ConciergeBell className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black tracking-widest uppercase text-blue-400 font-mono">
                  BITEBEND
                </span>
                <span className="text-slate-600">/</span>
                <span className="text-sm font-bold text-white truncate flex items-center gap-1.5">
                  <Store className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  {staff.restaurantName}
                </span>
              </div>
              <div className="text-xs text-slate-400 flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="font-semibold text-slate-200 flex items-center gap-1">
                  <User className="h-3 w-3 text-blue-400" />
                  {staff.name}
                </span>
                <span className="text-slate-700">·</span>
                <span className="text-[11px] bg-blue-500/10 text-blue-300 border border-blue-500/20 px-2 py-0.2 rounded-full font-medium">
                  Floor Waiter Station
                </span>
              </div>
            </div>
          </div>

          {/* Indicators & Actions */}
          <div className="flex items-center gap-2.5 flex-wrap justify-between md:justify-end">
            {/* Chef Mode Badge Indicator */}
            {chefModeState === "on" && (
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30"
                title="Chef Mode is ON: Kitchen marks ready; Waiter emergency ready available"
              >
                <ChefHat className="h-3.5 w-3.5 text-purple-400" />
                <span>Chef Mode: ON</span>
              </div>
            )}
            {chefModeState === "off" && (
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                title="Chef Mode is OFF: Waiter marks ready directly"
              >
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>Chef Mode: OFF</span>
              </div>
            )}
            {chefModeState === "unknown" && (
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
                title="Chef Mode status unavailable. Ready actions disabled until verified."
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span>Chef Mode: Unavailable</span>
              </div>
            )}

            {/* Live Sync Status */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-lg font-mono">
              <span
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  networkError
                    ? "bg-red-400"
                    : refreshing
                      ? "bg-amber-400 animate-pulse"
                      : "bg-emerald-400",
                )}
              />
              <span>{lastSynced ? `Synced ${formatElapsed(lastSynced.toISOString())}` : "Connecting..."}</span>
            </div>

            {/* Manual Refresh Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchDashboardData(true)}
              disabled={refreshing}
              className="h-8 text-xs bg-slate-900 border-slate-800 text-slate-200 hover:text-white hover:bg-slate-800 hover:border-slate-700 shadow-sm"
              title="Refresh floor assignments and Chef Mode status"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", refreshing && "animate-spin text-blue-400")} />
              <span>Refresh</span>
            </Button>

            {/* Logout Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="h-8 text-xs text-slate-400 hover:text-red-400 hover:bg-slate-900 px-2.5"
              title="Disconnect from floor station"
            >
              <LogOut className="h-3.5 w-3.5 mr-1" />
              <span>Exit</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Warning Banners (Chef Mode Unavailable / Network Error) ───────────── */}
      {chefModeState === "unknown" && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-xs text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 max-w-4xl mx-auto w-full">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              <strong>Chef Mode verification unavailable:</strong> Ready-related actions are temporarily disabled
              until the restaurant's kitchen workflow status is verified. Floor orders remain visible.
            </span>
          </div>
        </div>
      )}

      {networkError && (
        <div className="bg-red-500/15 border-b border-red-500/30 px-4 py-2.5 text-xs text-red-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 max-w-4xl mx-auto w-full">
            <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
            <span>
              <strong>Connection warning:</strong> Unable to reach server. Showing cached assigned floor orders.
              Automatic reconnection in progress...
            </span>
          </div>
        </div>
      )}

      {/* ── Main Operations Board Container ───────────────────────────────────── */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Summary Counters Header */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {/* Card: Total Active */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Assigned Floor Tickets
              </span>
              <div className="text-2xl font-black text-white font-mono tabular-nums">
                {activeOrders.length}
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center">
              <ConciergeBell className="h-5 w-5" />
            </div>
          </div>

          {/* Card: New Orders */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
                New (Ordered)
              </span>
              <div className="text-2xl font-black text-amber-300 font-mono tabular-nums">
                {newOrders.length}
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
              <Clock className="h-5 w-5" />
            </div>
          </div>

          {/* Card: Preparing */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-purple-400 uppercase tracking-wider">
                Cooking / Prep
              </span>
              <div className="text-2xl font-black text-purple-300 font-mono tabular-nums">
                {prepOrders.length}
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center">
              <Flame className="h-5 w-5" />
            </div>
          </div>

          {/* Card: Ready to Serve */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                Ready for Pickup
              </span>
              <div className="text-2xl font-black text-emerald-300 font-mono tabular-nums">
                {readyOrders.length}
              </div>
            </div>
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </div>
        </section>

        {/* View / Filter Tabs (Mobile & Touch Friendly Navigation) */}
        <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 p-1.5 rounded-xl overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1.5",
              activeTab === "all"
                ? "bg-blue-600 text-white shadow-md"
                : "text-slate-400 hover:text-white hover:bg-slate-800/60",
            )}
          >
            <span>All Columns</span>
            <span className="bg-slate-950/40 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {activeOrders.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("ordered")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1.5",
              activeTab === "ordered"
                ? "bg-amber-600 text-white shadow-md"
                : "text-slate-400 hover:text-white hover:bg-slate-800/60",
            )}
          >
            <span>1. New Orders</span>
            <span className="bg-slate-950/40 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {newOrders.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("preparing")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1.5",
              activeTab === "preparing"
                ? "bg-purple-600 text-white shadow-md"
                : "text-slate-400 hover:text-white hover:bg-slate-800/60",
            )}
          >
            <span>2. Cooking</span>
            <span className="bg-slate-950/40 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {prepOrders.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("ready")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1.5",
              activeTab === "ready"
                ? "bg-emerald-600 text-white shadow-md"
                : "text-slate-400 hover:text-white hover:bg-slate-800/60",
            )}
          >
            <span>3. Ready for Service</span>
            <span className="bg-slate-950/40 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {readyOrders.length}
            </span>
          </button>
        </div>

        {/* ── Operational Columns Board ────────────────────────────────────────── */}
        {activeOrders.length === 0 ? (
          /* Empty State */
          <div className="bg-slate-900/40 border border-dashed border-slate-800/80 rounded-3xl p-12 text-center space-y-4">
            <div className="h-16 w-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto shadow-inner">
              <UtensilsCrossed className="h-8 w-8 text-blue-400/80" />
            </div>
            <div className="space-y-1.5 max-w-md mx-auto">
              <h3 className="text-lg font-bold text-white">No active assigned orders</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                When customers place orders at tables assigned to you, or when management assigns tables to your
                station, tickets will arrive here in real time.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchDashboardData(true)}
              disabled={refreshing}
              className="text-xs border-slate-700 bg-slate-800 text-slate-200 hover:text-white"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", refreshing && "animate-spin text-blue-400")} />
              <span>Check for New Floor Tickets</span>
            </Button>
          </div>
        ) : (
          /* 3-Column Board (Responsive Desktop & Mobile View) */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {/* COLUMN 1: NEW ORDERS (ordered) */}
            {(activeTab === "all" || activeTab === "ordered") && (
              <section className="space-y-4">
                <div className="flex items-center justify-between border-b-2 border-amber-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center text-xs font-bold font-mono">
                      1
                    </div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                      New Orders
                    </h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                    {newOrders.length}
                  </span>
                </div>

                {newOrders.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-2xl bg-slate-900/20">
                    No newly placed orders
                  </div>
                ) : (
                  <div className="space-y-4">
                    {newOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="ordered"
                        chefModeState={chefModeState}
                        isSubmitting={submittingOrderIds.has(order.id)}
                        onStartPrep={handleStartPrep}
                        onStandardReady={handleStandardReady}
                        onOpenEmergencyReady={(ord) => {
                          setEmergencyOrder(ord);
                          setEmergencyReason("");
                        }}
                        onCompleteOrder={handleCompleteOrder}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* COLUMN 2: PREPARING ORDERS (preparing) */}
            {(activeTab === "all" || activeTab === "preparing") && (
              <section className="space-y-4">
                <div className="flex items-center justify-between border-b-2 border-purple-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center text-xs font-bold font-mono">
                      2
                    </div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                      Cooking / Prep
                    </h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full">
                    {prepOrders.length}
                  </span>
                </div>

                {prepOrders.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-2xl bg-slate-900/20">
                    No orders currently in preparation
                  </div>
                ) : (
                  <div className="space-y-4">
                    {prepOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="preparing"
                        chefModeState={chefModeState}
                        isSubmitting={submittingOrderIds.has(order.id)}
                        onStartPrep={handleStartPrep}
                        onStandardReady={handleStandardReady}
                        onOpenEmergencyReady={(ord) => {
                          setEmergencyOrder(ord);
                          setEmergencyReason("");
                        }}
                        onCompleteOrder={handleCompleteOrder}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* COLUMN 3: READY TO SERVE (ready) */}
            {(activeTab === "all" || activeTab === "ready") && (
              <section className="space-y-4">
                <div className="flex items-center justify-between border-b-2 border-emerald-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-xs font-bold font-mono">
                      3
                    </div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                      Ready for Pickup
                    </h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    {readyOrders.length}
                  </span>
                </div>

                {readyOrders.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-2xl bg-slate-900/20">
                    No orders awaiting pickup
                  </div>
                ) : (
                  <div className="space-y-4">
                    {readyOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="ready"
                        chefModeState={chefModeState}
                        isSubmitting={submittingOrderIds.has(order.id)}
                        onStartPrep={handleStartPrep}
                        onStandardReady={handleStandardReady}
                        onOpenEmergencyReady={(ord) => {
                          setEmergencyOrder(ord);
                          setEmergencyReason("");
                        }}
                        onCompleteOrder={handleCompleteOrder}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>

      {/* ── Emergency Ready Reason Dialog ─────────────────────────────────────── */}
      <Dialog
        open={Boolean(emergencyOrder)}
        onOpenChange={(open) => {
          if (!open && !emergencySubmitting) {
            setEmergencyOrder(null);
            setEmergencyReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md bg-slate-900 text-slate-100 border-slate-800 shadow-2xl p-6">
          <DialogHeader className="space-y-2">
            <div className="flex items-center gap-2 text-amber-400">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              <DialogTitle className="text-base font-bold text-white">
                Emergency Ready Override
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-slate-400 leading-relaxed">
              Chef Mode is active for this restaurant. Kitchen staff is normally responsible for marking dishes ready.
              Use this emergency action only if kitchen display staff is unavailable or floor urgency requires an override.
            </DialogDescription>
          </DialogHeader>

          {emergencyOrder && (
            <div className="space-y-4 py-2">
              {/* Order Target Badge */}
              <div className="flex items-center justify-between p-3 bg-slate-950/80 border border-slate-800 rounded-xl">
                <div>
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Target Ticket
                  </span>
                  <span className="text-sm font-bold text-white">
                    Order #{emergencyOrder.id}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Location
                  </span>
                  <span className="text-sm font-bold text-blue-400">
                    {emergencyOrder.sessionType === "takeaway"
                      ? "Takeaway"
                      : `Table ${emergencyOrder.effectiveTableNumber || emergencyOrder.tableNumber || "—"}`}
                  </span>
                </div>
              </div>

              {/* Textarea for Reason */}
              <div className="space-y-1.5">
                <label
                  htmlFor="emergency-reason"
                  className="text-xs font-semibold text-slate-300 flex items-center justify-between"
                >
                  <span>Override Reason (Required)</span>
                  <span
                    className={cn(
                      "font-mono tabular-nums text-[11px]",
                      isEmergencyReasonValid ? "text-emerald-400" : "text-amber-400",
                    )}
                  >
                    {trimmedEmergencyReason.length} / 5 chars min
                  </span>
                </label>
                <Textarea
                  id="emergency-reason"
                  rows={3}
                  value={emergencyReason}
                  onChange={(e) => setEmergencyReason(e.target.value)}
                  placeholder="e.g. Kitchen display unresponsive, food physically verified with chef on pass."
                  disabled={emergencySubmitting}
                  className="bg-slate-950 border-slate-700 text-slate-100 placeholder:text-slate-500 text-xs focus-visible:ring-amber-500"
                />
                {!isEmergencyReasonValid && emergencyReason.length > 0 && (
                  <p className="text-[11px] text-red-400">
                    Reason must contain at least 5 trimmed characters.
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={emergencySubmitting}
              onClick={() => {
                setEmergencyOrder(null);
                setEmergencyReason("");
              }}
              className="border-slate-700 bg-slate-800/80 text-slate-300 hover:text-white text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!isEmergencyReasonValid || emergencySubmitting}
              onClick={handleEmergencyReadySubmit}
              className="bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs"
            >
              {emergencySubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Submitting Override...
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                  Confirm Emergency Ready
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Independent Order Card Component ──────────────────────────────────────────

interface OrderCardProps {
  order: WaiterOrder;
  stage: "ordered" | "preparing" | "ready";
  chefModeState: ChefModeState;
  isSubmitting: boolean;
  onStartPrep: (id: number) => void;
  onStandardReady: (id: number) => void;
  onOpenEmergencyReady: (order: WaiterOrder) => void;
  onCompleteOrder: (id: number) => void;
}

function OrderCard({
  order,
  stage,
  chefModeState,
  isSubmitting,
  onStartPrep,
  onStandardReady,
  onOpenEmergencyReady,
  onCompleteOrder,
}: OrderCardProps) {
  const isTakeaway = order.sessionType === "takeaway";
  const tableLabel = isTakeaway
    ? "Takeaway"
    : `Table ${order.effectiveTableNumber || order.tableNumber || "—"}`;

  const styles = {
    ordered: {
      border: "border-slate-800 hover:border-amber-500/40",
      tableBg: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    },
    preparing: {
      border: "border-slate-800 hover:border-purple-500/40 shadow-lg",
      tableBg: "bg-purple-500/10 text-purple-300 border-purple-500/30",
    },
    ready: {
      border: "border-slate-800 hover:border-emerald-500/40 opacity-95",
      tableBg: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    },
  }[stage];

  return (
    <div
      className={cn(
        "bg-slate-900/90 rounded-2xl border transition-all duration-200 overflow-hidden flex flex-col shadow-sm",
        styles.border,
      )}
    >
      {/* Card Header */}
      <div className="p-3.5 sm:p-4 bg-slate-900/60 border-b border-slate-800/80 flex items-start justify-between gap-3">
        <div className="space-y-1">
          {/* Table / Takeaway Prominent Label */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "px-2.5 py-0.5 rounded-lg text-sm sm:text-base font-black tracking-tight border font-mono tabular-nums flex items-center gap-1.5",
                styles.tableBg,
              )}
            >
              {isTakeaway ? (
                <>
                  <ShoppingBag className="h-4 w-4 shrink-0" />
                  Takeaway
                </>
              ) : (
                <>
                  <UtensilsCrossed className="h-4 w-4 shrink-0" />
                  {tableLabel}
                </>
              )}
            </span>

            {order.assignmentSource === "manual_override" && (
              <span className="text-[10px] bg-purple-500/10 text-purple-300 border border-purple-500/20 px-1.5 py-0.2 rounded font-medium">
                Manager Assigned
              </span>
            )}
          </div>

          {/* Order ID & Customer Name (Privacy Compliant — NO phone number) */}
          <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
            <span className="font-mono tabular-nums font-bold text-slate-300">
              #{order.id}
            </span>
            {order.customerName && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-slate-300 flex items-center gap-1 max-w-[140px] truncate">
                  <User className="h-3 w-3 text-slate-500 shrink-0" />
                  {order.customerName}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Timestamp */}
        <div className="text-right space-y-0.5 shrink-0">
          <div className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums font-bold text-slate-200 bg-slate-800/80 px-2 py-0.5 rounded-md border border-slate-700/60">
            <Clock className="h-3 w-3 text-slate-400" />
            {formatElapsed(order.createdAt)}
          </div>
          <div className="text-[10px] font-mono text-slate-500">
            {formatClockTime(order.createdAt)}
          </div>
        </div>
      </div>

      {/* Card Body: Items List & Order Notes */}
      <div className="p-3.5 sm:p-4 flex-1 space-y-3">
        {/* Items */}
        <div className="space-y-2">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-2.5 bg-slate-950/50 p-2 sm:p-2.5 rounded-xl border border-slate-800/60 text-xs"
            >
              <div className="h-7 w-7 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 font-black text-xs flex items-center justify-center shrink-0 font-mono tabular-nums">
                {item.quantity}×
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white leading-snug">
                    {item.name}
                  </span>
                  {item.isVeg !== null && (
                    <span
                      className={cn(
                        "inline-flex items-center text-[9px] font-bold px-1.5 py-0.2 rounded border",
                        item.isVeg
                          ? "bg-emerald-950/40 text-emerald-400 border-emerald-500/30"
                          : "bg-red-950/40 text-red-400 border-red-500/30",
                      )}
                    >
                      {item.isVeg ? "VEG" : "NON-VEG"}
                    </span>
                  )}
                </div>
                {item.notes && (
                  <p className="text-[11px] text-amber-300/90 italic mt-0.5 bg-amber-950/20 px-1.5 py-0.5 rounded border border-amber-800/20">
                    Note: {item.notes}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Order-level Customer Note */}
        {order.notes && (
          <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-2.5 text-xs text-amber-200 flex items-start gap-2">
            <FileText className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-semibold text-amber-300 text-[11px]">Special Instructions:</span>
              <p className="leading-relaxed">{order.notes}</p>
            </div>
          </div>
        )}
      </div>

      {/* Card Action Footer */}
      <div className="p-3 bg-slate-900/90 border-t border-slate-800/80">
        {/* Stage 1: New (ordered) -> Start Prep */}
        {stage === "ordered" && (
          <Button
            type="button"
            onClick={() => onStartPrep(order.id)}
            disabled={isSubmitting}
            className="w-full h-10 text-xs sm:text-sm font-bold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl shadow-md transition-all"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Starting Prep...
              </>
            ) : (
              <>
                <Flame className="h-4 w-4 mr-1.5" />
                START PREPARING
              </>
            )}
          </Button>
        )}

        {/* Stage 2: Preparing -> Ready depends exclusively on Chef Mode */}
        {stage === "preparing" && (
          <div className="space-y-1.5">
            {chefModeState === "off" && (
              <Button
                type="button"
                onClick={() => onStandardReady(order.id)}
                disabled={isSubmitting}
                className="w-full h-10 text-xs sm:text-sm font-bold bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-xl shadow-md transition-all"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Marking Ready...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    MARK READY
                  </>
                )}
              </Button>
            )}

            {chefModeState === "on" && (
              <Button
                type="button"
                onClick={() => onOpenEmergencyReady(order)}
                disabled={isSubmitting}
                className="w-full h-10 text-xs sm:text-sm font-bold bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white rounded-xl shadow-md transition-all"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 mr-1.5" />
                    EMERGENCY READY
                  </>
                )}
              </Button>
            )}

            {chefModeState === "unknown" && (
              <Button
                type="button"
                disabled
                className="w-full h-10 text-xs font-semibold bg-slate-800 text-slate-500 border border-slate-700/60 rounded-xl cursor-not-allowed"
                title="Chef Mode status unavailable. Ready actions disabled until verified."
              >
                <Lock className="h-3.5 w-3.5 mr-1.5" />
                Ready Actions Disabled (Chef Mode Unknown)
              </Button>
            )}
          </div>
        )}

        {/* Stage 3: Ready -> Mark Completed */}
        {stage === "ready" && (
          <Button
            type="button"
            onClick={() => onCompleteOrder(order.id)}
            disabled={isSubmitting}
            className="w-full h-10 text-xs sm:text-sm font-bold bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-xl shadow-md transition-all"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Completing Order...
              </>
            ) : (
              <>
                <Check className="h-4 w-4 mr-1.5" />
                MARK COMPLETED
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

