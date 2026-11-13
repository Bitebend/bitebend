import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  ChefHat,
  LogOut,
  RefreshCw,
  Store,
  Clock,
  CheckCircle2,
  AlertCircle,
  UtensilsCrossed,
  ShoppingBag,
  Flame,
  ShieldAlert,
  Loader2,
  FileText,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";
import { cn } from "@/lib/utils";

interface StaffData {
  id: number;
  name: string;
  role: "waiter" | "chef";
  restaurantId: number;
  restaurantName: string;
  restaurantSlug?: string;
}

interface ChefOrderItem {
  id: number;
  orderId: number;
  menuItemId: number | null;
  name: string;
  quantity: number;
  isVeg: boolean | null;
  notes: string | null;
}

interface ChefOrder {
  id: number;
  sessionId: number | null;
  tableId: number | null;
  tableNumber: string | null;
  effectiveTableNumber: string | null;
  sessionType: "dine_in" | "takeaway" | null;
  customerName: string | null;
  status: "ordered" | "preparing" | "ready";
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: ChefOrderItem[];
}

function formatElapsed(dateString: string): string {
  const diffSec = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (diffSec < 60) return "< 1m";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ${diffMin % 60}m`;
}

function formatClockTime(dateString: string): string {
  try {
    const d = new Date(dateString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  } catch {
    return "";
  }
}

export default function ChefHome() {
  const [, setLocation] = useLocation();
  const [staff, setStaff] = useState<StaffData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<ChefOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [chefModeDisabled, setChefModeDisabled] = useState(false);
  const [submittingIds, setSubmittingIds] = useState<Set<number>>(new Set());
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "ordered" | "preparing" | "ready">("all");

  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  // Authenticate Chef session on mount
  useEffect(() => {
    isMountedRef.current = true;
    const raw = localStorage.getItem("bitebend_staff_auth");
    if (!raw) {
      setLocation("/staff/connect");
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed.token || parsed.staff?.role !== "chef") {
        if (parsed.staff?.role === "waiter") {
          setLocation("/staff/waiter");
        } else {
          setLocation("/staff/connect");
        }
        return;
      }
      setStaff(parsed.staff);
      setToken(parsed.token);

      // Verify token validity with backend
      fetch(`${API_BASE}/staff/me`, {
        headers: { Authorization: `Bearer ${parsed.token}` },
      })
        .then((res) => {
          if (!res.ok) {
            localStorage.removeItem("bitebend_staff_auth");
            toast.error("Staff session expired or access was revoked by manager.");
            setLocation("/staff/connect");
          }
        })
        .catch(() => {
          // Allow offline/network grace
        });
    } catch {
      localStorage.removeItem("bitebend_staff_auth");
      setLocation("/staff/connect");
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [setLocation]);

  const fetchOrders = useCallback(
    async (isManualRefresh = false) => {
      if (!token) return;
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      if (isManualRefresh) setRefreshing(true);

      try {
        const res = await fetch(`${API_BASE}/staff/chef/orders`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!isMountedRef.current) return;

        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body?.code === "CHEF_MODE_DISABLED" || body?.error?.includes("Chef mode")) {
            setChefModeDisabled(true);
            setLoading(false);
            setRefreshing(false);
            isFetchingRef.current = false;
            return;
          }
        }

        if (res.status === 401) {
          localStorage.removeItem("bitebend_staff_auth");
          toast.error("Staff session revoked or expired.");
          setLocation("/staff/connect");
          return;
        }

        if (!res.ok) {
          throw new Error("Failed to fetch kitchen orders");
        }

        const data: ChefOrder[] = await res.json();
        if (!isMountedRef.current) return;

        setOrders(data);
        setChefModeDisabled(false);
        setNetworkError(false);
        setLastSynced(new Date());

        if (isManualRefresh) {
          toast.success("Kitchen feed updated");
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        setNetworkError(true);
        if (isManualRefresh) {
          toast.error("Could not refresh orders. Showing cached kitchen feed.");
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
        isFetchingRef.current = false;
      }
    },
    [token, setLocation],
  );

  // Polling hook: Fetch initially and repeat every 7 seconds
  useEffect(() => {
    if (!token) return;
    void fetchOrders(false);

    const interval = setInterval(() => {
      void fetchOrders(false);
    }, 7000);

    return () => clearInterval(interval);
  }, [token, fetchOrders]);

  // Mark Ready Action
  const handleMarkReady = async (orderId: number) => {
    if (!token) return;
    if (submittingIds.has(orderId)) return;

    setSubmittingIds((prev) => new Set(prev).add(orderId));

    try {
      const res = await fetch(`${API_BASE}/staff/chef/orders/${orderId}/ready`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 403 && body?.code === "CHEF_MODE_DISABLED") {
          setChefModeDisabled(true);
          toast.error("Chef Mode has been disabled by the restaurant owner.");
          return;
        }
        const errorMsg = body?.error || "Failed to mark order ready";
        toast.error(errorMsg);
        return;
      }

      toast.success(`Order #${orderId} marked ready for pickup!`);
      // Immediately refresh the feed to get updated server state
      await fetchOrders(false);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      if (isMountedRef.current) {
        setSubmittingIds((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("bitebend_staff_auth");
    toast.info("Logged out from kitchen display");
    setLocation("/staff/connect");
  };

  // Initial loading state
  if (loading && !orders.length && !chefModeDisabled) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="h-16 w-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 animate-pulse">
            <ChefHat className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight text-white">Bitebend Kitchen Display</h1>
            <p className="text-sm text-slate-400">Connecting to live order feed...</p>
          </div>
          <Loader2 className="h-5 w-5 text-amber-400 animate-spin" />
        </div>
      </div>
    );
  }

  // Chef Mode Disabled by Owner State
  if (chefModeDisabled) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
        {/* Header */}
        <header className="h-16 border-b border-slate-800 bg-slate-900/90 px-4 sm:px-6 flex items-center justify-between sticky top-0 z-10 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <ChefHat className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm font-bold text-white flex items-center gap-1.5">
                <Store className="h-3.5 w-3.5 text-slate-400" />
                {staff?.restaurantName || "Restaurant"}
              </div>
              <div className="text-xs text-amber-400 font-medium">Kitchen Display System</div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-slate-400 hover:text-red-400 hover:bg-slate-800 text-xs h-9 px-3"
          >
            <LogOut className="h-4 w-4 mr-1.5" />
            Disconnect
          </Button>
        </header>

        {/* Disabled State Content */}
        <main className="flex-1 max-w-xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-center">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6 shadow-2xl text-center">
            <div className="h-16 w-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto">
              <ShieldAlert className="h-8 w-8 text-amber-400" />
            </div>

            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                Workflow Paused by Manager
              </div>
              <h2 className="text-2xl font-bold text-white">Chef Mode is Currently Disabled</h2>
              <p className="text-sm text-slate-300 leading-relaxed max-w-md mx-auto">
                The restaurant owner has switched the kitchen display off. Orders are currently being managed
                directly by floor staff.
              </p>
            </div>

            <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4 text-left space-y-2 text-xs text-slate-400">
              <div className="font-semibold text-slate-200">What does this mean?</div>
              <p>
                When Chef Mode is disabled, the kitchen order feed and "Mark Ready" actions are locked. Waiters
                handle order status changes directly on the floor.
              </p>
            </div>

            <div className="pt-2 flex flex-col sm:flex-row gap-3 justify-center">
              <Button
                onClick={() => void fetchOrders(true)}
                disabled={refreshing}
                className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold h-11 px-6"
              >
                <RefreshCw className={cn("h-4 w-4 mr-2", refreshing && "animate-spin")} />
                Check Status Again
              </Button>
              <Button
                variant="outline"
                onClick={handleLogout}
                className="border-slate-800 text-slate-300 hover:bg-slate-800 h-11"
              >
                <LogOut className="h-4 w-4 mr-2 text-slate-400" />
                Sign Out
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Filter orders into FIFO groups
  // Backend returns orders ordered by createdAt asc
  const orderedOrders = orders.filter((o) => o.status === "ordered");
  const preparingOrders = orders.filter((o) => o.status === "preparing");
  const readyOrders = orders.filter((o) => o.status === "ready");

  const totalActive = orders.length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* ── TOP HEADER ────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 bg-slate-900/95 sticky top-0 z-20 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Brand & Station Info */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <ChefHat className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold text-white flex items-center gap-2 truncate">
                <span>{staff?.restaurantName || "Kitchen"}</span>
                <span className="text-slate-600 hidden sm:inline">|</span>
                <span className="text-amber-400 text-xs sm:text-sm font-semibold uppercase tracking-wider hidden sm:inline">
                  Kitchen Display (KDS)
                </span>
              </div>
              <div className="text-xs text-slate-400 flex items-center gap-2 truncate">
                <span className="text-slate-300 font-medium">Chef {staff?.name}</span>
                <span>·</span>
                <span className="font-mono tabular-nums text-[11px] text-slate-400">
                  {lastSynced ? `Synced ${lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Connecting..."}
                </span>
              </div>
            </div>
          </div>

          {/* Action Bar */}
          <div className="flex items-center gap-2 shrink-0">
            {networkError && (
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/60 px-2.5 py-1 rounded-lg">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                Offline (Cached)
              </span>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchOrders(true)}
              disabled={refreshing}
              className="border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800 hover:text-white h-9 px-3 text-xs"
              title="Refresh kitchen feed"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 sm:mr-1.5", refreshing && "animate-spin text-amber-400")} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-slate-400 hover:text-red-400 hover:bg-slate-800/70 h-9 px-3 text-xs"
              title="Disconnect station"
            >
              <LogOut className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Exit</span>
            </Button>
          </div>
        </div>

        {/* ── METRICS & MOBILE FILTER BAR ─────────────────────────────────────── */}
        <div className="border-t border-slate-800/80 bg-slate-900/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between flex-wrap gap-3">
            {/* Live Count Badges */}
            <div className="flex items-center gap-2 sm:gap-4 text-xs font-medium">
              <div className="flex items-center gap-1.5 text-slate-300">
                <span className="text-slate-500 uppercase tracking-wider text-[10px]">Total Active:</span>
                <span className="font-mono tabular-nums font-bold text-white bg-slate-800 px-2 py-0.5 rounded-md">
                  {totalActive}
                </span>
              </div>
              <span className="text-slate-700">·</span>
              <div className="flex items-center gap-1.5 text-amber-400">
                <span className="text-slate-400">New:</span>
                <span className="font-mono tabular-nums font-bold bg-amber-500/10 text-amber-300 border border-amber-500/20 px-2 py-0.5 rounded-md">
                  {orderedOrders.length}
                </span>
              </div>
              <span className="text-slate-700">·</span>
              <div className="flex items-center gap-1.5 text-purple-400">
                <span className="text-slate-400">Cooking:</span>
                <span className="font-mono tabular-nums font-bold bg-purple-500/10 text-purple-300 border border-purple-500/20 px-2 py-0.5 rounded-md">
                  {preparingOrders.length}
                </span>
              </div>
              <span className="text-slate-700">·</span>
              <div className="flex items-center gap-1.5 text-emerald-400">
                <span className="text-slate-400">Ready:</span>
                <span className="font-mono tabular-nums font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                  {readyOrders.length}
                </span>
              </div>
            </div>

            {/* Mobile / Tablet View Switcher */}
            <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800 lg:hidden text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors",
                  activeTab === "all" ? "bg-slate-800 text-white font-bold" : "text-slate-400 hover:text-white",
                )}
              >
                All ({totalActive})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("ordered")}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors",
                  activeTab === "ordered" ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "text-slate-400 hover:text-amber-300",
                )}
              >
                New ({orderedOrders.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("preparing")}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors",
                  activeTab === "preparing" ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" : "text-slate-400 hover:text-purple-300",
                )}
              >
                Cooking ({preparingOrders.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("ready")}
                className={cn(
                  "px-2.5 py-1 rounded-md font-medium transition-colors",
                  activeTab === "ready" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "text-slate-400 hover:text-emerald-300",
                )}
              >
                Ready ({readyOrders.length})
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ── MAIN KITCHEN VIEW ─────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {networkError && (
          <div className="md:hidden bg-amber-950/60 border border-amber-800/80 rounded-xl p-3 flex items-center gap-2 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>Connection unstable. Showing cached orders. Reconnecting...</span>
          </div>
        )}

        {totalActive === 0 ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-2xl bg-slate-900/30">
            <div className="h-16 w-16 rounded-2xl bg-slate-800/50 border border-slate-700/50 flex items-center justify-center text-slate-400 mb-4">
              <ChefHat className="h-8 w-8 text-slate-500" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">No Active Kitchen Orders</h3>
            <p className="text-sm text-slate-400 max-w-sm mb-6">
              New customer orders placed from table QR codes or floor staff will appear here in real time.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchOrders(true)}
              className="border-slate-800 bg-slate-900 text-slate-300 hover:text-white"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Check Kitchen Feed
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {/* ── SECTION 1: NEW ORDERS ───────────────────────────────────────── */}
            {(activeTab === "all" || activeTab === "ordered") && (
              <section className="space-y-4">
                {/* Section Header */}
                <div className="flex items-center justify-between border-b-2 border-amber-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center text-xs font-bold">
                      1
                    </div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider">New Orders</h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full">
                    {orderedOrders.length}
                  </span>
                </div>

                {orderedOrders.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-xl bg-slate-900/20">
                    No newly placed orders
                  </div>
                ) : (
                  <div className="space-y-4">
                    {orderedOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="ordered"
                        onMarkReady={handleMarkReady}
                        isSubmitting={submittingIds.has(order.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── SECTION 2: PREPARING (IN KITCHEN) ───────────────────────────── */}
            {(activeTab === "all" || activeTab === "preparing") && (
              <section className="space-y-4">
                {/* Section Header */}
                <div className="flex items-center justify-between border-b-2 border-purple-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center text-xs font-bold">
                      2
                    </div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider">Cooking / Prep</h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2.5 py-0.5 rounded-full">
                    {preparingOrders.length}
                  </span>
                </div>

                {preparingOrders.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-xl bg-slate-900/20">
                    No orders currently in preparation
                  </div>
                ) : (
                  <div className="space-y-4">
                    {preparingOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="preparing"
                        onMarkReady={handleMarkReady}
                        isSubmitting={submittingIds.has(order.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── SECTION 3: READY ORDERS ─────────────────────────────────────── */}
            {(activeTab === "all" || activeTab === "ready") && (
              <section className="space-y-4">
                {/* Section Header */}
                <div className="flex items-center justify-between border-b-2 border-emerald-500/50 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-xs font-bold">
                      3
                    </div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider">Ready for Pickup</h2>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full">
                    {readyOrders.length}
                  </span>
                </div>

                {readyOrders.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-xl bg-slate-900/20">
                    No orders awaiting pickup
                  </div>
                ) : (
                  <div className="space-y-4">
                    {readyOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        stage="ready"
                        onMarkReady={handleMarkReady}
                        isSubmitting={submittingIds.has(order.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── CHEF ORDER CARD COMPONENT ────────────────────────────────────────────────
interface OrderCardProps {
  order: ChefOrder;
  stage: "ordered" | "preparing" | "ready";
  onMarkReady: (orderId: number) => Promise<void>;
  isSubmitting: boolean;
}

function OrderCard({ order, stage, onMarkReady, isSubmitting }: OrderCardProps) {
  const isTakeaway = order.sessionType === "takeaway";
  const tableLabel = isTakeaway
    ? "Takeaway"
    : order.effectiveTableNumber || order.tableNumber || "Table";

  const stageTheme = {
    ordered: {
      border: "border-slate-800 hover:border-amber-500/30",
      topBanner: "bg-slate-900 text-amber-300",
      tableBg: "bg-amber-500/10 text-amber-300 border-amber-500/20",
    },
    preparing: {
      border: "border-slate-800 hover:border-purple-500/40 shadow-lg",
      topBanner: "bg-slate-900 text-purple-300",
      tableBg: "bg-purple-500/10 text-purple-300 border-purple-500/20",
    },
    ready: {
      border: "border-slate-800 hover:border-emerald-500/30 opacity-90",
      topBanner: "bg-slate-900 text-emerald-300",
      tableBg: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    },
  }[stage];

  return (
    <div
      className={cn(
        "bg-slate-900/90 rounded-2xl border transition-all duration-200 overflow-hidden flex flex-col",
        stageTheme.border,
      )}
    >
      {/* ── CARD HEADER ──────────────────────────────────────────────────────── */}
      <div className="p-4 bg-slate-900/60 border-b border-slate-800/80 flex items-start justify-between gap-3">
        {/* Table & Order Identification */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "px-2.5 py-1 rounded-lg text-lg sm:text-xl font-black tracking-tight border font-mono tabular-nums flex items-center gap-1.5",
                stageTheme.tableBg,
              )}
            >
              {isTakeaway ? (
                <>
                  <ShoppingBag className="h-4 w-4" />
                  Takeaway
                </>
              ) : (
                <>
                  <UtensilsCrossed className="h-4 w-4" />
                  {tableLabel}
                </>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums font-semibold text-slate-300">
              #{order.id}
            </span>
            {order.customerName && (
              <>
                <span>·</span>
                <span className="text-slate-300 flex items-center gap-1 max-w-[120px] truncate">
                  <User className="h-3 w-3 text-slate-500 shrink-0" />
                  {order.customerName}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Time Elapsed & Clock */}
        <div className="text-right space-y-0.5 shrink-0">
          <div className="inline-flex items-center gap-1 text-xs font-mono tabular-nums font-bold text-slate-200 bg-slate-800/80 px-2 py-0.5 rounded-md border border-slate-700/60">
            <Clock className="h-3 w-3 text-slate-400" />
            {formatElapsed(order.createdAt)}
          </div>
          <div className="text-[11px] font-mono text-slate-500">
            {formatClockTime(order.createdAt)}
          </div>
        </div>
      </div>

      {/* ── ITEMS LIST ────────────────────────────────────────────────────────── */}
      <div className="p-4 flex-1 space-y-3">
        <div className="space-y-2.5">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-3 bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60"
            >
              {/* Quantity badge */}
              <div className="h-8 w-8 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-black text-sm flex items-center justify-center shrink-0 font-mono tabular-nums">
                {item.quantity}×
              </div>

              {/* Item Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-white leading-snug">
                    {item.name}
                  </span>
                  {item.isVeg !== null && (
                    <span
                      className={cn(
                        "inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border",
                        item.isVeg
                          ? "bg-emerald-950/40 text-emerald-400 border-emerald-500/30"
                          : "bg-red-950/40 text-red-400 border-red-500/30",
                      )}
                    >
                      {item.isVeg ? "VEG" : "NON-VEG"}
                    </span>
                  )}
                </div>

                {/* Item-level notes / customization */}
                {item.notes && (
                  <p className="text-xs text-amber-300/90 italic mt-1 bg-amber-950/20 px-2 py-0.5 rounded border border-amber-800/30">
                    Note: {item.notes}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Order-level Kitchen Notes */}
        {order.notes && (
          <div className="bg-amber-950/30 border border-amber-800/50 rounded-xl p-2.5 text-xs text-amber-200 flex items-start gap-2">
            <FileText className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-semibold text-amber-300">Order Note:</span>
              <p className="leading-relaxed">{order.notes}</p>
            </div>
          </div>
        )}
      </div>

      {/* ── CARD FOOTER / ACTION ──────────────────────────────────────────────── */}
      <div className="p-3 bg-slate-900/90 border-t border-slate-800/80">
        {stage === "preparing" && (
          <Button
            onClick={() => void onMarkReady(order.id)}
            disabled={isSubmitting}
            className="w-full h-12 text-sm sm:text-base font-bold bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow-md transition-all rounded-xl"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Marking Ready...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-5 w-5 mr-2" />
                MARK READY
              </>
            )}
          </Button>
        )}

        {stage === "ordered" && (
          <div className="text-center py-2 px-3 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs text-slate-400 flex items-center justify-center gap-1.5">
            <Flame className="h-3.5 w-3.5 text-amber-400" />
            <span>Awaiting Waiter to start preparation</span>
          </div>
        )}

        {stage === "ready" && (
          <div className="text-center py-2 px-3 rounded-xl bg-emerald-950/30 border border-emerald-800/40 text-xs text-emerald-300 flex items-center justify-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            <span>Ready · Awaiting Waiter pickup</span>
          </div>
        )}
      </div>
    </div>
  );
}
