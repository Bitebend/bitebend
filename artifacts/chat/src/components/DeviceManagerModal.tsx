import { useEffect, useRef, useState } from "react";
import {
  X,
  Laptop,
  Smartphone,
  QrCode,
  ShieldCheck,
  Trash2,
  Loader2,
  AlertTriangle,
  HardDrive,
  CheckCircle2,
} from "lucide-react";
import {
  ChatCryptoSession,
  establishDevice1EciesChannel,
} from "../crypto/e2eeClient";
import { getStorageHealthSnapshot, type StorageHealthSnapshot } from "../crypto/storageHealth";
import { chatApi, type LinkedDeviceItem } from "../lib/api";
import { QrCameraScanner } from "./QrCameraScanner";

interface Props {
  cryptoSession: ChatCryptoSession;
  onClose: () => void;
  onSyncNeeded: () => Promise<void>;
}

export function DeviceManagerModal({ cryptoSession, onClose, onSyncNeeded }: Props) {
  const [devices, setDevices] = useState<LinkedDeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageHealth, setStorageHealth] = useState<StorageHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Device 1 responder state
  const [linkMode, setLinkMode] = useState<"list" | "scan" | "code" | "waiting_keys" | "sas_confirm" | "done">("list");
  const [shortCodeInput, setShortCodeInput] = useState("");
  const [sasCode, setSasCode] = useState("");
  const [pendingDeviceInfo, setPendingDeviceInfo] = useState<{
    linkId: string;
    deviceLabel: string;
    matrixDeviceId: string;
    device2Ed25519?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const eciesChannelRef = useRef<Awaited<ReturnType<typeof establishDevice1EciesChannel>>["channel"] | null>(null);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const [devRes, health] = await Promise.all([chatApi.devices(), getStorageHealthSnapshot()]);
      setDevices(devRes.devices);
      setStorageHealth(health);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDevices();
    return () => {
      try {
        eciesChannelRef.current?.free();
      } catch {
        // Ignore WASM handle free
      }
    };
  }, []);

  const beginLookup = async (params: { qrPayload?: string; shortCode?: string }) => {
    setError(null);
    setBusy(true);
    try {
      const found = await chatApi.lookupLinkRequest(params);
      const established = await establishDevice1EciesChannel(
        found.device2EciesPub,
        {
          accountId: found.accountId,
          matrixUserId: found.matrixUserId,
          username: found.username,
          displayName: found.displayName,
          approvingMatrixDeviceId: cryptoSession.matrixDeviceId,
          approvingEd25519: cryptoSession.ed25519Key,
        },
        { linkId: found.linkId },
      );

      eciesChannelRef.current = established.channel;
      setSasCode(established.sasCode);
      setPendingDeviceInfo({
        linkId: found.linkId,
        deviceLabel: found.deviceLabel,
        matrixDeviceId: found.matrixDeviceId,
      });

      await chatApi.respondToLinkRequest({
        linkId: found.linkId,
        device1EciesOutMsg: established.initialMessage,
      });

      setLinkMode("waiting_keys");
    } catch (err) {
      setError((err as Error).message || "Invalid QR code or link code");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (linkMode !== "waiting_keys" || !pendingDeviceInfo?.linkId) return;
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const pending = await chatApi.getPendingLinkApproval(pendingDeviceInfo.linkId);
        if (cancelled) return;
        if (pending.status === "awaiting_approval" && pending.device2KeyProofCiphertext && eciesChannelRef.current) {
          const decryptedRaw = eciesChannelRef.current.decrypt(pending.device2KeyProofCiphertext);
          const proof = JSON.parse(decryptedRaw) as { matrixDeviceId: string; ed25519: string };
          if (proof.matrixDeviceId !== pending.matrixDeviceId || proof.ed25519 !== pending.device2Ed25519) {
            throw new Error("Key verification mismatch on ECIES link channel!");
          }
          setPendingDeviceInfo((prev) => (prev ? { ...prev, device2Ed25519: pending.device2Ed25519 } : prev));
          setLinkMode("sas_confirm");
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLinkMode("list");
          return;
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 1400);
    };

    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [linkMode, pendingDeviceInfo?.linkId]);

  const handleApproveSas = async () => {
    if (!pendingDeviceInfo?.device2Ed25519) return;
    setBusy(true);
    setError(null);
    try {
      const endorsementSig = await cryptoSession.endorseLinkedDevice(
        pendingDeviceInfo.matrixDeviceId,
        pendingDeviceInfo.device2Ed25519,
      );
      await chatApi.approveLinkRequest({
        linkId: pendingDeviceInfo.linkId,
        device1EndorsementSig: endorsementSig,
      });
      await loadDevices();
      await onSyncNeeded();
      setLinkMode("done");
    } catch (err) {
      setError((err as Error).message || "Failed to approve device");
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (deviceId: string) => {
    setError(null);
    setBusy(true);
    try {
      await chatApi.revokeDevice(deviceId);
      await loadDevices();
      await onSyncNeeded();
    } catch (err) {
      setError((err as Error).message || "Unable to revoke device");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border border-[#ede8e3] bg-white shadow-xl">
        <div className="sticky top-0 bg-white border-b border-[#ede8e3] px-5 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-extrabold text-[#1a0a00]">Linked Devices & Key Storage</h2>
            <p className="text-xs text-[#6b7280]">Manage encrypted browsers & rotate room keys</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg bg-[#f5f0eb] flex items-center justify-center text-[#1a0a00] hover:bg-[#ede8e3]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {linkMode === "list" && (
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setLinkMode("scan");
                  }}
                  className="flex-1 rounded-xl bg-[#059669] py-2.5 px-3 text-xs font-bold text-white hover:bg-[#047857] flex items-center justify-center gap-1.5"
                >
                  <QrCode className="w-4 h-4" /> Scan New Device QR
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setLinkMode("code");
                  }}
                  className="flex-1 rounded-xl border border-[#ede8e3] bg-[#faf9f6] py-2.5 px-3 text-xs font-bold text-[#1a0a00] hover:bg-[#f5f0eb]"
                >
                  Enter 8-Char Code
                </button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider text-[#6b7280]">
                  Active & Revoked Browsers
                </div>
                {loading ? (
                  <div className="py-6 text-center text-xs text-[#6b7280]">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Loading devices…
                  </div>
                ) : (
                  <div className="divide-y divide-[#ede8e3] rounded-xl border border-[#ede8e3]">
                    {devices.map((d) => {
                      const isMobile = /iPhone|Android|Mobile/i.test(d.deviceLabel);
                      const Icon = isMobile ? Smartphone : Laptop;
                      return (
                        <div key={d.id} className="p-3.5 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-lg bg-[#ecfdf5] flex items-center justify-center shrink-0">
                              <Icon className="w-4 h-4 text-[#059669]" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-bold text-[#1a0a00] flex items-center gap-2 truncate">
                                <span>{d.deviceLabel}</span>
                                {d.isCurrent && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#ecfdf5] text-[#047857] border border-[#a7f3d0]">
                                    This Browser
                                  </span>
                                )}
                                {d.status === "revoked" && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]">
                                    Revoked
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] font-mono text-[#6b7280] truncate">
                                Key: {d.identityKeyEd25519.slice(0, 14)}…
                              </div>
                            </div>
                          </div>

                          {d.status === "active" && !d.isCurrent && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRevoke(d.id)}
                              className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-2.5 py-1.5 text-xs font-bold text-[#b91c1c] hover:bg-[#fee2e2] flex items-center gap-1 shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Revoke
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Mandatory Key Persistence & Recovery Guidance */}
              <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-[#9a3412]">
                  <HardDrive className="w-4 h-4 shrink-0" />
                  <span>Browser Key Persistence & Storage Health</span>
                </div>
                <p className="text-xs text-[#9a3412] leading-relaxed">
                  Private encryption keys remain inside this browser&apos;s IndexedDB and are never stored on Bitebend servers. Clearing site data, using Private Browsing, or Safari&apos;s 7-day script-writable storage eviction on unused sites can erase local keys.
                </p>
                <div className="text-[11px] font-semibold text-[#7c2d12]">
                  Persistent Storage: {storageHealth?.persistentGranted ? "Granted by browser" : "Best-effort (recommended: link a second device)"}
                </div>
              </div>
            </>
          )}

          {linkMode === "scan" && (
            <div className="space-y-3">
              <QrCameraScanner
                onScan={(payload) => void beginLookup({ qrPayload: payload })}
                onCancel={() => setLinkMode("list")}
              />
            </div>
          )}

          {linkMode === "code" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void beginLookup({ shortCode: shortCodeInput });
              }}
              className="space-y-3"
            >
              <label className="block text-xs font-semibold text-[#1a0a00]">
                Enter the 8-character code displayed on your new browser
              </label>
              <input
                type="text"
                required
                value={shortCodeInput}
                onChange={(e) => setShortCodeInput(e.target.value.toUpperCase())}
                placeholder="ABCD2345"
                maxLength={12}
                className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-4 py-3 font-mono text-lg font-bold tracking-[0.2em] text-center uppercase focus:border-[#059669] focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLinkMode("list")}
                  className="flex-1 rounded-xl border border-[#ede8e3] py-2.5 text-xs font-bold text-[#6b7280]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || shortCodeInput.trim().length < 6}
                  className="flex-1 rounded-xl bg-[#059669] py-2.5 text-xs font-bold text-white hover:bg-[#047857] disabled:opacity-50"
                >
                  {busy ? "Verifying…" : "Continue"}
                </button>
              </div>
            </form>
          )}

          {linkMode === "waiting_keys" && (
            <div className="py-6 text-center space-y-2">
              <Loader2 className="w-7 h-7 animate-spin text-[#059669] mx-auto" />
              <div className="text-sm font-bold text-[#1a0a00]">Establishing Encrypted Pairing Channel…</div>
              <p className="text-xs text-[#6b7280]">Waiting for {pendingDeviceInfo?.deviceLabel} to send its public device keys.</p>
            </div>
          )}

          {linkMode === "sas_confirm" && (
            <div className="rounded-2xl border border-[#a7f3d0] bg-[#ecfdf5] p-5 text-center space-y-4">
              <ShieldCheck className="w-9 h-9 text-[#059669] mx-auto" />
              <div>
                <div className="text-sm font-extrabold text-[#1a0a00]">
                  Confirm Code on {pendingDeviceInfo?.deviceLabel}
                </div>
                <p className="text-xs text-[#065f46] mt-1">
                  Ensure both browsers display this exact verification code before approving:
                </p>
              </div>
              <div className="inline-block rounded-xl bg-white border border-[#d1fae5] px-4 py-3 font-mono text-xl sm:text-2xl font-black tracking-[0.12em] whitespace-nowrap text-[#047857]">
                {sasCode}
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setLinkMode("list")}
                  className="flex-1 rounded-xl border border-[#ede8e3] bg-white py-2.5 text-xs font-bold text-[#6b7280]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleApproveSas()}
                  className="flex-1 rounded-xl bg-[#059669] py-2.5 text-xs font-bold text-white hover:bg-[#047857] disabled:opacity-50"
                >
                  {busy ? "Approving…" : "Codes Match — Approve Device"}
                </button>
              </div>
            </div>
          )}

          {linkMode === "done" && (
            <div className="rounded-2xl border border-[#a7f3d0] bg-[#ecfdf5] p-5 text-center space-y-3">
              <CheckCircle2 className="w-8 h-8 text-[#059669] mx-auto" />
              <div className="text-sm font-bold text-[#047857]">New Device Linked & Endorsed</div>
              <p className="text-xs text-[#065f46]">
                Room keys have rotated for future messages. Your newly linked browser is now active.
              </p>
              <button
                type="button"
                onClick={() => setLinkMode("list")}
                className="rounded-xl bg-[#059669] px-5 py-2 text-xs font-bold text-white"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
