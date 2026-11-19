import { useEffect, useState } from "react";
import {
  ShieldCheck,
  MessageSquare,
  Check,
  AlertTriangle,
  Loader2,
  Link2,
  UserPlus,
  KeyRound,
  LogOut,
} from "lucide-react";
import { ChatCryptoSession, randomDeviceId } from "../crypto/e2eeClient";
import { chatApi, type BootstrapResponse } from "../lib/api";
import { DeviceLinkInitiator } from "./DeviceLinkInitiator";

interface Props {
  bootstrap: BootstrapResponse;
  keyEvictionReason?: string | null;
  onAuthenticated: (
    account: NonNullable<BootstrapResponse["account"]>,
    session: ChatCryptoSession,
  ) => void;
  onRefreshBootstrap: () => Promise<void>;
}

export function ActivationFlow({
  bootstrap,
  keyEvictionReason,
  onAuthenticated,
  onRefreshBootstrap,
}: Props) {
  const [tab, setTab] = useState<"create" | "link">("create");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<{
    checking: boolean;
    available?: boolean;
    error?: string;
  }>({ checking: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKeyRecoveryLink, setShowKeyRecoveryLink] = useState(false);

  const isDraft = bootstrap.state === "DRAFT_PENDING" && Boolean(bootstrap.draft);
  const isConflict = bootstrap.state === "AUTHENTICATED_WITH_PENDING_HANDOFF" && Boolean(bootstrap.account);

  useEffect(() => {
    const clean = username.trim().replace(/^@/, "");
    if (clean.length < 3) {
      setUsernameStatus({ checking: false });
      return;
    }
    let cancelled = false;
    setUsernameStatus({ checking: true });
    const t = window.setTimeout(async () => {
      try {
        const res = await chatApi.checkUsername(clean);
        if (!cancelled) {
          setUsernameStatus({
            checking: false,
            available: res.available && res.valid,
            error: res.error,
          });
        }
      } catch {
        if (!cancelled) setUsernameStatus({ checking: false });
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [username]);

  // Pre-fill display name suggestion cleanly from draft only after masked preview
  useEffect(() => {
    if (isDraft && bootstrap.draft && !displayName) {
      setDisplayName("");
    }
  }, [isDraft, bootstrap.draft, displayName]);

  const handleCreateOrActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanUser = username.trim().replace(/^@/, "");
    if (cleanUser.length < 3) {
      setError("Choose a @username with at least 3 characters.");
      return;
    }

    if (!isDraft && !displayName.trim()) {
      setError("Enter your display name.");
      return;
    }

    setSubmitting(true);
    try {
      const proposedAccountId = crypto.randomUUID();
      const matrixDeviceId = randomDeviceId();
      const prep = await ChatCryptoSession.prepareNewDeviceForRegistration({
        proposedAccountId,
        matrixDeviceId,
      });

      const devicePayload = {
        deviceLabel: /iPhone|iPad/i.test(navigator.userAgent)
          ? "iPhone Safari"
          : /Android/i.test(navigator.userAgent)
            ? "Android Browser"
            : "Web Browser",
        matrixDeviceId,
        deviceKeysJson: prep.uploadPayload.deviceKeysJson,
        oneTimeKeys: prep.uploadPayload.oneTimeKeys,
        fallbackKey: prep.uploadPayload.fallbackKey,
      };

      const resp = isDraft
        ? await chatApi.activateFromDraft({
            proposedAccountId,
            username: cleanUser,
            displayName: displayName.trim() || undefined,
            device: devicePayload,
          })
        : await chatApi.register({
            proposedAccountId,
            username: cleanUser,
            displayName: displayName.trim(),
            contactPhone: contactPhone.trim() || undefined,
            device: devicePayload,
          });

      const otpkCount = Object.keys(prep.uploadPayload.oneTimeKeys ?? {}).length;
      await prep.markRegistered({ signed_curve25519: otpkCount });
      onAuthenticated(resp.account, prep.session);
    } catch (err) {
      setError((err as Error).message || "Unable to complete setup");
    } finally {
      setSubmitting(false);
    }
  };

  if (keyEvictionReason) {
    return (
      <div className="min-h-dvh bg-[#faf9f6] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-[#ede8e3] bg-white p-6 space-y-5 shadow-xs">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#fef2f2] border border-[#fecaca] flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5 text-[#dc2626]" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-[#1a0a00] leading-snug">
                Browser Encryption Keys Missing
              </h1>
              <p className="text-xs text-[#6b7280] mt-1 leading-relaxed">
                You are signed in as <strong className="text-[#1a0a00]">@{bootstrap.account?.username}</strong>, but {keyEvictionReason}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] p-3.5 text-xs text-[#9a3412] leading-relaxed">
            Bitebend never stores private decryption keys on its servers. To protect your privacy, this browser will not silently generate unverified replacement keys.
          </div>

          {showKeyRecoveryLink ? (
            <DeviceLinkInitiator
              onLinked={(acc, sess) => onAuthenticated(acc, sess)}
              onBack={() => setShowKeyRecoveryLink(false)}
            />
          ) : (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={async () => {
                  await chatApi.logout();
                  await ChatCryptoSession.clearLocalMetadata();
                  setShowKeyRecoveryLink(true);
                }}
                className="w-full rounded-xl bg-[#059669] py-3 px-4 text-sm font-bold text-white hover:bg-[#047857] flex items-center justify-center gap-2"
              >
                <Link2 className="w-4 h-4" />
                Re-link From Another Signed-In Device
              </button>

              <button
                type="button"
                onClick={async () => {
                  await chatApi.logout();
                  await ChatCryptoSession.clearLocalMetadata();
                  await onRefreshBootstrap();
                }}
                className="w-full rounded-xl border border-[#ede8e3] bg-white py-3 px-4 text-sm font-semibold text-[#1a0a00] hover:bg-[#f5f0eb] flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4 text-[#6b7280]" />
                Log Out & Start a Fresh Account
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isConflict && bootstrap.account) {
    return (
      <div className="min-h-dvh bg-[#faf9f6] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-[#ede8e3] bg-white p-6 space-y-5 shadow-xs">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-[#059669]" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-[#1a0a00]">Already Signed In</h1>
              <p className="text-xs text-[#6b7280] mt-1 leading-relaxed">
                This browser already has an active encrypted messaging account{" "}
                <strong className="text-[#1a0a00]">@{bootstrap.account.username}</strong>, and a recent QR restaurant order handoff is waiting.
              </p>
            </div>
          </div>

          <div className="space-y-2.5">
            <button
              type="button"
              onClick={async () => {
                await chatApi.dismissPendingHandoff();
                await onRefreshBootstrap();
              }}
              className="w-full rounded-xl bg-[#059669] py-3 px-4 text-sm font-bold text-white hover:bg-[#047857]"
            >
              Continue as @{bootstrap.account.username}
            </button>
            <button
              type="button"
              onClick={async () => {
                await chatApi.logout();
                await ChatCryptoSession.clearLocalMetadata();
                await onRefreshBootstrap();
              }}
              className="w-full rounded-xl border border-[#ede8e3] bg-white py-3 px-4 text-sm font-semibold text-[#6b7280] hover:text-[#1a0a00]"
            >
              Sign Out & Activate New Order Account Instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#faf9f6] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#ede8e3] bg-white p-6 space-y-5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] flex items-center justify-center shrink-0">
            <MessageSquare className="w-5 h-5 text-[#059669]" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-[#1a0a00] tracking-tight">Bitebend Chat</h1>
            <p className="text-xs text-[#6b7280]">
              End-to-end encrypted messaging with `@username` privacy
            </p>
          </div>
        </div>

        {isDraft && bootstrap.draft ? (
          <form onSubmit={handleCreateOrActivate} className="space-y-4">
            <div className="rounded-xl border border-[#a7f3d0] bg-[#ecfdf5] p-3.5 space-y-1">
              <div className="text-xs font-bold text-[#047857]">
                QR Restaurant Order Handoff Ready
              </div>
              <div className="text-xs text-[#065f46]">
                Order contact preview: <span className="font-semibold">{bootstrap.draft.maskedName}</span> ·{" "}
                <span className="font-mono">{bootstrap.draft.maskedPhone}</span>
              </div>
              <div className="text-[11px] text-[#059669]">
                Your unverified order phone is stored only as an unlinked contact claim and never shown to other users.
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                Choose your @username
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-[#6b7280]">@</span>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="your.handle"
                  className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] pl-8 pr-9 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                />
                {usernameStatus.checking && (
                  <Loader2 className="w-4 h-4 animate-spin text-[#6b7280] absolute right-3 top-1/2 -translate-y-1/2" />
                )}
                {!usernameStatus.checking && usernameStatus.available && (
                  <Check className="w-4 h-4 text-[#059669] absolute right-3 top-1/2 -translate-y-1/2" />
                )}
              </div>
              {usernameStatus.error && (
                <p className="mt-1 text-[11px] text-[#dc2626]">{usernameStatus.error}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                Display Name (optional override)
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={bootstrap.draft.maskedName}
                maxLength={60}
                className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-xl bg-[#fef2f2] border border-[#fecaca] p-3 text-xs text-[#991b1b]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || usernameStatus.available === false}
              className="w-full rounded-xl bg-[#059669] py-3 text-sm font-bold text-white hover:bg-[#047857] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Activate Messaging Account
            </button>

            <button
              type="button"
              onClick={async () => {
                await chatApi.dismissPendingHandoff();
                await onRefreshBootstrap();
              }}
              className="w-full text-center text-xs font-semibold text-[#6b7280] hover:text-[#1a0a00] py-1"
            >
              Skip handoff & create or link another account
            </button>
          </form>
        ) : (
          <>
            <div className="grid grid-cols-2 rounded-xl bg-[#f5f0eb] p-1 gap-1">
              <button
                type="button"
                onClick={() => {
                  setTab("create");
                  setError(null);
                }}
                className={`rounded-lg py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                  tab === "create"
                    ? "bg-white text-[#1a0a00] shadow-xs"
                    : "text-[#6b7280] hover:text-[#1a0a00]"
                }`}
              >
                <UserPlus className="w-3.5 h-3.5" /> New Account
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab("link");
                  setError(null);
                }}
                className={`rounded-lg py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                  tab === "link"
                    ? "bg-white text-[#1a0a00] shadow-xs"
                    : "text-[#6b7280] hover:text-[#1a0a00]"
                }`}
              >
                <Link2 className="w-3.5 h-3.5" /> Link Existing
              </button>
            </div>

            {tab === "create" ? (
              <form onSubmit={handleCreateOrActivate} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Aarav Sharma"
                    maxLength={60}
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                    Username
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-[#6b7280]">@</span>
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="aarav.sharma"
                      className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] pl-8 pr-9 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                    />
                    {usernameStatus.checking && (
                      <Loader2 className="w-4 h-4 animate-spin text-[#6b7280] absolute right-3 top-1/2 -translate-y-1/2" />
                    )}
                    {!usernameStatus.checking && usernameStatus.available && (
                      <Check className="w-4 h-4 text-[#059669] absolute right-3 top-1/2 -translate-y-1/2" />
                    )}
                  </div>
                  {usernameStatus.error && (
                    <p className="mt-1 text-[11px] text-[#dc2626]">{usernameStatus.error}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                    Mobile Number (optional, kept private)
                  </label>
                  <input
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="Optional 10-digit number"
                    maxLength={20}
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-xl bg-[#fef2f2] border border-[#fecaca] p-3 text-xs text-[#991b1b]">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting || usernameStatus.available === false}
                  className="w-full rounded-xl bg-[#059669] py-3 text-sm font-bold text-white hover:bg-[#047857] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Create Encrypted Account
                </button>
              </form>
            ) : (
              <DeviceLinkInitiator onLinked={onAuthenticated} />
            )}
          </>
        )}

        <div className="border-t border-[#ede8e3] pt-3 text-[11px] text-[#6b7280] leading-relaxed">
          Keys stay in this browser&apos;s IndexedDB. After signing in, avoid Private Browsing and link a second device for backup access.
        </div>
      </div>
    </div>
  );
}
