import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import {
  Users,
  UserPlus,
  KeyRound,
  Unlink,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RotateCcw,
  Copy,
  ChefHat,
  ConciergeBell,
  Loader2,
  ShieldAlert,
  Check,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface StaffMember {
  id: number;
  restaurantId: number;
  name: string;
  phone: string | null;
  role: "waiter" | "chef";
  isActive: boolean;
  hasActivePin: boolean;
  pinExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GeneratedPinData {
  pin: string;
  expiresAt: string;
  staffId: number;
  name: string;
  role: string;
}

export default function StaffManagement() {
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Chef Mode State
  const [chefMode, setChefMode] = useState<boolean>(false);
  const [loadingChefMode, setLoadingChefMode] = useState<boolean>(true);
  const [updatingChefMode, setUpdatingChefMode] = useState<boolean>(false);
  const [chefModeLoadError, setChefModeLoadError] = useState<string | null>(null);
  const [chefModeError, setChefModeError] = useState<string | null>(null);

  // Create Staff Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"waiter" | "chef">("waiter");
  const [newPhone, setNewPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Generated PIN Modal & Partial-Failure Recovery
  const [pinModalData, setPinModalData] = useState<GeneratedPinData | null>(null);
  const [generatingPinId, setGeneratingPinId] = useState<number | null>(null);
  const [copiedPin, setCopiedPin] = useState(false);
  const [pinRecoveryState, setPinRecoveryState] = useState<{
    staff: StaffMember;
    error: string;
  } | null>(null);

  // Disconnect Confirmation Modal
  const [disconnectTarget, setDisconnectTarget] = useState<StaffMember | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStaff = useCallback(async () => {
    try {
      const data = await apiFetch<{ staff: StaffMember[] }>("/owner/staff");
      setStaffList(data.staff || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load staff list");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchChefMode = useCallback(async () => {
    try {
      setLoadingChefMode(true);
      setChefModeLoadError(null);
      const data = await apiFetch<{ chefDashboardEnabled: boolean }>("/owner/chef-mode");
      setChefMode(Boolean(data.chefDashboardEnabled));
    } catch (err: any) {
      const msg = err?.message || "Failed to load Chef Mode status";
      setChefModeLoadError(msg);
      toast.error(msg);
    } finally {
      setLoadingChefMode(false);
    }
  }, []);

  useEffect(() => {
    fetchStaff();
    fetchChefMode();
  }, [fetchStaff, fetchChefMode]);

  const handleToggleChefMode = async (checked: boolean) => {
    if (loadingChefMode || updatingChefMode || chefModeLoadError) return;
    const previousState = chefMode;
    setChefModeError(null);
    setChefMode(checked);
    setUpdatingChefMode(true);
    try {
      const data = await apiFetch<{ chefDashboardEnabled: boolean }>("/owner/chef-mode", {
        method: "PATCH",
        body: JSON.stringify({ chefDashboardEnabled: checked }),
      });
      const confirmed = Boolean(data.chefDashboardEnabled);
      setChefMode(confirmed);
      if (confirmed) {
        toast.success("Chef Mode enabled. Kitchen display active for chefs.");
      } else {
        toast.success("Chef Mode disabled. Waiters will handle complete preparation workflow.");
      }
    } catch (err: any) {
      const msg = err?.message || "Failed to update Chef Mode";
      setChefMode(previousState);
      setChefModeError(msg);
      toast.error(msg);
      // Re-verify persisted server state so UI stays accurate
      try {
        const refreshed = await apiFetch<{ chefDashboardEnabled: boolean }>("/owner/chef-mode");
        setChefMode(Boolean(refreshed.chefDashboardEnabled));
      } catch {
        // Keep previousState if server is unreachable
      }
    } finally {
      setUpdatingChefMode(false);
    }
  };

  const openPinModal = useCallback((data: GeneratedPinData) => {
    setCopiedPin(false);
    setPinRecoveryState(null);
    setPinModalData(data);
  }, []);

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    if (!newName.trim()) {
      setCreateError("Please enter staff member name");
      toast.error("Please enter staff member name");
      return;
    }

    setCreateError(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ staff: StaffMember }>("/owner/staff", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          role: newRole,
          phone: newPhone.trim() || undefined,
        }),
      });
      toast.success(`${res.staff.name} created as ${res.staff.role}`);

      // Staff profile created — reset & close Create dialog so retries never create duplicates
      setNewName("");
      setNewPhone("");
      setNewRole("waiter");

      // Generate PIN immediately before displaying PIN modal
      try {
        setGeneratingPinId(res.staff.id);
        const pinData = await apiFetch<GeneratedPinData>(`/owner/staff/${res.staff.id}/pin`, {
          method: "POST",
        });
        setCreateOpen(false);
        requestAnimationFrame(() => {
          openPinModal(pinData);
        });
      } catch (pinErr: any) {
        const pinErrMsg = pinErr?.message || "Failed to generate connection PIN";
        setCreateOpen(false);
        setPinRecoveryState({ staff: res.staff, error: pinErrMsg });
        toast.error(
          `${res.staff.name} was created, but PIN generation failed: ${pinErrMsg}`,
        );
      } finally {
        setGeneratingPinId(null);
      }

      await fetchStaff();
    } catch (err: any) {
      const msg = err?.message || "Failed to create staff member";
      setCreateError(msg);
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleGeneratePin = async (staffId: number) => {
    if (generatingPinId !== null) return;
    setGeneratingPinId(staffId);
    try {
      const data = await apiFetch<GeneratedPinData>(`/owner/staff/${staffId}/pin`, {
        method: "POST",
      });
      openPinModal(data);
      await fetchStaff();
    } catch (err: any) {
      const msg = err?.message || "Failed to generate connection PIN";
      if (pinRecoveryState && pinRecoveryState.staff.id === staffId) {
        setPinRecoveryState({ ...pinRecoveryState, error: msg });
      }
      toast.error(msg);
    } finally {
      setGeneratingPinId(null);
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      await apiFetch(`/owner/staff/${disconnectTarget.id}/disconnect`, {
        method: "POST",
      });
      toast.success(`${disconnectTarget.name} disconnected. All active sessions invalidated.`);
      setDisconnectTarget(null);
      await fetchStaff();
    } catch (err: any) {
      toast.error(err.message || "Failed to disconnect staff member");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleReconnect = async (staff: StaffMember) => {
    try {
      await apiFetch(`/owner/staff/${staff.id}/reconnect`, {
        method: "POST",
      });
      toast.success(`${staff.name} re-enabled.`);
      await fetchStaff();
      // Generate fresh connection PIN
      await handleGeneratePin(staff.id);
    } catch (err: any) {
      toast.error(err.message || "Failed to re-enable staff member");
    }
  };

  const copyPinToClipboard = async (pin: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(pin);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = pin;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) throw new Error("Copy command rejected");
      }
      setCopiedPin(true);
      toast.success("Connection PIN copied to clipboard");
      setTimeout(() => setCopiedPin(false), 2000);
    } catch {
      toast.error("Could not copy automatically. Please select and copy the 6-digit PIN manually.");
    }
  };

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border pb-5">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-orange-100 flex items-center justify-center text-orange-600">
                <Users className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Staff Management</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Add floor waiters and kitchen chefs. Generate a 6-digit PIN for staff to connect instantly without passwords.
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className="bg-orange-600 hover:bg-orange-700 text-white flex items-center gap-2 self-start sm:self-auto"
          >
            <UserPlus className="h-4 w-4" />
            Add Staff Member
          </Button>
        </div>

        {/* Chef Mode Setting Card */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <label
              htmlFor="chef-mode-switch"
              className="flex items-start sm:items-center gap-3 cursor-pointer select-none flex-1"
            >
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 shrink-0 mt-0.5 sm:mt-0">
                <ChefHat className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-base font-semibold text-foreground">Chef Mode (Kitchen Display System)</h2>
                  {loadingChefMode ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground border border-border">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </span>
                  ) : chefModeLoadError ? (
                    <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-red-50 text-red-700 border border-red-200">
                      Status Unavailable
                    </span>
                  ) : chefMode ? (
                    <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Chef Mode ON
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-muted text-muted-foreground border border-border">
                      Chef Mode OFF
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Controls whether the kitchen display system (KDS) is active for chefs or orders are handled exclusively by floor waiters.
                </p>
              </div>
            </label>

            <div className="flex items-center gap-3 self-end sm:self-auto">
              {updatingChefMode && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-600" />
                  Saving...
                </span>
              )}
              {chefModeLoadError && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchChefMode()}
                  className="h-8 text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Retry
                </Button>
              )}
              <Switch
                id="chef-mode-switch"
                checked={chefMode}
                disabled={loadingChefMode || updatingChefMode || Boolean(chefModeLoadError)}
                onCheckedChange={handleToggleChefMode}
                aria-label="Toggle Chef Mode"
              />
            </div>
          </div>

          {(chefModeLoadError || chefModeError) && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
                <span>{chefModeLoadError || chefModeError}</span>
              </div>
              {chefModeLoadError && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchChefMode()}
                  className="h-7 text-xs border-red-200 bg-white text-red-700 hover:bg-red-100"
                >
                  Retry
                </Button>
              )}
            </div>
          )}

          {/* Workflow Comparison / Explanatory Text */}
          <div className="grid gap-3 sm:grid-cols-2 pt-2 border-t border-border/60">
            <div
              className={cn(
                "p-3 rounded-lg border text-xs space-y-1 transition-colors",
                !chefMode
                  ? "bg-amber-50/60 border-amber-200 text-amber-950 dark:bg-amber-950/20 dark:border-amber-900/50 dark:text-amber-200"
                  : "bg-muted/30 border-border text-muted-foreground",
              )}
            >
              <div className="font-semibold text-foreground flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full",
                    !chefMode ? "bg-amber-500" : "bg-muted-foreground/40",
                  )}
                />
                Chef Mode OFF
              </div>
              <p className="leading-relaxed">
                Waiters handle the complete preparation workflow, including marking orders ready.
              </p>
            </div>

            <div
              className={cn(
                "p-3 rounded-lg border text-xs space-y-1 transition-colors",
                chefMode
                  ? "bg-emerald-50/60 border-emerald-200 text-emerald-950 dark:bg-emerald-950/20 dark:border-emerald-900/50 dark:text-emerald-200"
                  : "bg-muted/30 border-border text-muted-foreground",
              )}
            >
              <div className="font-semibold text-foreground flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full",
                    chefMode ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
                Chef Mode ON
              </div>
              <p className="leading-relaxed">
                Waiters start preparation, chefs mark orders ready, and assigned waiters handle order completion. An assigned waiter can use Emergency Ready when the chef is unavailable, with a mandatory reason.
              </p>
            </div>
          </div>
        </div>

        {/* Staff Table / Cards */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading staff...
          </div>
        ) : staffList.length === 0 ? (
          <div className="bg-card border border-dashed border-border rounded-xl p-12 text-center space-y-4">
            <div className="h-12 w-12 rounded-full bg-orange-50 flex items-center justify-center mx-auto text-orange-600">
              <Users className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">No staff profiles yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Create a Waiter or Chef profile, then generate a 6-digit connection PIN so they can access their dashboard.
              </p>
            </div>
            <Button
              onClick={() => setCreateOpen(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Add First Staff Member
            </Button>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wider border-b border-border">
                  <tr>
                    <th className="px-6 py-3.5 font-semibold">Staff Member</th>
                    <th className="px-6 py-3.5 font-semibold">Role</th>
                    <th className="px-6 py-3.5 font-semibold">Status</th>
                    <th className="px-6 py-3.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {staffList.map((staff) => {
                    const isWaiter = staff.role === "waiter";
                    const isGenerating = generatingPinId === staff.id;

                    return (
                      <tr key={staff.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0",
                                isWaiter
                                  ? "bg-blue-100 text-blue-700 border border-blue-200"
                                  : "bg-amber-100 text-amber-700 border border-amber-200",
                              )}
                            >
                              {isWaiter ? <ConciergeBell className="h-4 w-4" /> : <ChefHat className="h-4 w-4" />}
                            </div>
                            <div>
                              <div className="font-semibold text-foreground">{staff.name}</div>
                              {staff.phone && (
                                <div className="text-xs text-muted-foreground">{staff.phone}</div>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="px-6 py-4">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium uppercase tracking-wide",
                              isWaiter
                                ? "bg-blue-50 text-blue-700 border border-blue-200"
                                : "bg-amber-50 text-amber-700 border border-amber-200",
                            )}
                          >
                            {isWaiter ? "Waiter (Floor)" : "Chef (Kitchen)"}
                          </span>
                        </td>

                        <td className="px-6 py-4">
                          {!staff.isActive ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-200">
                              <ShieldAlert className="h-3.5 w-3.5" />
                              Disconnected
                            </span>
                          ) : staff.hasActivePin ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-yellow-50 text-yellow-800 border border-yellow-200">
                              <Clock className="h-3.5 w-3.5 text-yellow-600 animate-pulse" />
                              PIN Active (Waiting for staff connection)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              Ready / Connected
                            </span>
                          )}
                        </td>

                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {staff.isActive ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={isGenerating}
                                  onClick={() => handleGeneratePin(staff.id)}
                                  className="text-orange-700 border-orange-200 hover:bg-orange-50 text-xs font-medium h-8"
                                >
                                  {isGenerating ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                                  ) : (
                                    <KeyRound className="h-3.5 w-3.5 mr-1 text-orange-600" />
                                  )}
                                  {staff.hasActivePin ? "Regenerate PIN" : "Generate PIN"}
                                </Button>

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDisconnectTarget(staff)}
                                  className="text-red-600 hover:bg-red-50 hover:text-red-700 text-xs h-8"
                                >
                                  <Unlink className="h-3.5 w-3.5 mr-1" />
                                  Disconnect
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleReconnect(staff)}
                                className="text-emerald-700 border-emerald-200 hover:bg-emerald-50 text-xs font-medium h-8"
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                Re-enable & Connect
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Partial Failure PIN Recovery Banner (staff created, PIN gen failed) */}
        {pinRecoveryState && (
          <div
            role="alert"
            className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-semibold text-amber-950">
                  {pinRecoveryState.staff.name} ({pinRecoveryState.staff.role}) was created, but PIN generation failed.
                </div>
                <p className="text-xs text-amber-900 mt-0.5">
                  {pinRecoveryState.error}. Retry PIN generation below without creating a duplicate staff profile.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPinRecoveryState(null)}
                className="h-8 text-xs"
              >
                Dismiss
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={generatingPinId === pinRecoveryState.staff.id}
                onClick={() => void handleGeneratePin(pinRecoveryState.staff.id)}
                className="bg-orange-600 hover:bg-orange-700 text-white h-8 text-xs"
              >
                {generatingPinId === pinRecoveryState.staff.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5 mr-1" />
                )}
                Retry Generate PIN
              </Button>
            </div>
          </div>
        )}

        {/* Create Staff Dialog */}
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            if (!creating) {
              setCreateOpen(open);
              if (!open) setCreateError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add New Staff Member</DialogTitle>
              <DialogDescription>
                Create a profile for a waiter or kitchen chef. You will receive a connection PIN to share with them.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleCreateStaff} className="space-y-4 py-2">
              {createError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-muted-foreground">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  disabled={creating}
                  placeholder="e.g. Ramesh Kumar"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-muted-foreground">
                  Role <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => setNewRole("waiter")}
                    className={cn(
                      "flex flex-col items-center justify-center p-3 rounded-lg border text-sm font-medium transition-all text-center disabled:opacity-60",
                      newRole === "waiter"
                        ? "border-orange-500 bg-orange-50/50 text-orange-950 ring-1 ring-orange-500"
                        : "border-border hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <ConciergeBell className="h-5 w-5 mb-1 text-orange-600" />
                    Waiter
                    <span className="text-[11px] text-muted-foreground font-normal">Floor service & delivery</span>
                  </button>

                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => setNewRole("chef")}
                    className={cn(
                      "flex flex-col items-center justify-center p-3 rounded-lg border text-sm font-medium transition-all text-center disabled:opacity-60",
                      newRole === "chef"
                        ? "border-orange-500 bg-orange-50/50 text-orange-950 ring-1 ring-orange-500"
                        : "border-border hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <ChefHat className="h-5 w-5 mb-1 text-orange-600" />
                    Chef
                    <span className="text-[11px] text-muted-foreground font-normal">Kitchen Display System</span>
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-muted-foreground">
                  Phone Number <span className="text-muted-foreground/60 lowercase font-normal">(optional)</span>
                </label>
                <input
                  type="tel"
                  disabled={creating}
                  placeholder="e.g. +91 98765 43210"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60"
                />
              </div>

              <DialogFooter className="pt-2">
                <Button type="button" variant="outline" disabled={creating} onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={creating}
                  className="bg-orange-600 hover:bg-orange-700 text-white"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  {creating ? "Creating & Generating PIN..." : "Create & Generate PIN"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Generated PIN Modal */}
        <Dialog open={!!pinModalData} onOpenChange={(open) => !open && setPinModalData(null)}>
          <DialogContent className="sm:max-w-md text-center">
            <DialogHeader className="text-center sm:text-center">
              <div className="h-12 w-12 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center mx-auto mb-2">
                <KeyRound className="h-6 w-6" />
              </div>
              <DialogTitle className="text-xl">Connection PIN Generated</DialogTitle>
              <DialogDescription>
                Share this one-time 6-digit PIN with{" "}
                <span className="font-semibold text-foreground">{pinModalData?.name}</span> (
                <span className="capitalize font-medium text-foreground">{pinModalData?.role}</span>).
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              <div className="bg-muted/60 border border-border rounded-xl p-6 flex flex-col items-center justify-center space-y-2">
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                  Staff Connection PIN · {pinModalData?.name} ({pinModalData?.role === "chef" ? "Chef" : "Waiter"})
                </div>
                <div
                  data-testid="generated-staff-pin"
                  className="text-4xl font-extrabold tracking-widest text-orange-600 font-mono select-all"
                >
                  {pinModalData?.pin}
                </div>
                <div className="text-xs text-muted-foreground flex flex-col items-center gap-0.5 mt-1">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5 text-orange-500" />
                    Expires in 10 minutes (one-time use)
                  </span>
                  {pinModalData?.expiresAt && (
                    <span className="text-[11px] text-muted-foreground/80">
                      Valid until{" "}
                      {new Date(pinModalData.expiresAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              </div>

              <div className="text-xs text-muted-foreground text-left bg-orange-50/60 border border-orange-200/60 rounded-lg p-3 space-y-1">
                <div className="font-semibold text-orange-950 flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-orange-600 shrink-0" />
                  How staff connects:
                </div>
                <p className="text-orange-900/80 pl-5">
                  1. Staff opens <strong>/staff/connect</strong> on their phone or tablet browser.
                </p>
                <p className="text-orange-900/80 pl-5">
                  2. They enter this 6-digit PIN. No email, password, or phone number required.
                </p>
                <p className="text-orange-900/80 pl-5">
                  3. They are instantly signed in to their station dashboard ({pinModalData?.role === "chef" ? "Chef KDS" : "Waiter Dashboard"}).
                </p>
              </div>
            </div>

            <DialogFooter className="flex flex-col sm:flex-row gap-2">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto flex items-center justify-center gap-1.5"
                onClick={() => pinModalData && void copyPinToClipboard(pinModalData.pin)}
              >
                {copiedPin ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy PIN
                  </>
                )}
              </Button>
              <Button
                type="button"
                className="w-full sm:w-auto bg-orange-600 hover:bg-orange-700 text-white"
                onClick={() => setPinModalData(null)}
              >
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Disconnect Confirmation Dialog */}
        <Dialog open={!!disconnectTarget} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="h-10 w-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-2">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <DialogTitle>Disconnect {disconnectTarget?.name}?</DialogTitle>
              <DialogDescription>
                This will immediately revoke their access and terminate any active sessions. Order history and activity
                logs are preserved.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="pt-3">
              <Button variant="outline" onClick={() => setDisconnectTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={disconnecting}
                onClick={handleDisconnect}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {disconnecting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Disconnect Staff Member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
