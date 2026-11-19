import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  MessageSquare,
  Check,
  Copy,
  AlertTriangle,
  Loader2,
  Link2,
  UserPlus,
  KeyRound,
  LogOut,
  Smartphone,
  ArrowRight,
} from "lucide-react";
import { ChatCryptoSession, randomDeviceId } from "../crypto/e2eeClient";
import { readKnownDevices, removeKnownDevice } from "../crypto/storageHealth";
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
  const [tab, setTab] = useState<"login" | "create" | "link">("create");
  const userPickedTabRef = useRef(false);

  // New account state
  const [displayName, setDisplayName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [existingAccountPrompt, setExistingAccountPrompt] = useState(false);

  // Existing account login state
  const [loginMobile, setLoginMobile] = useState("");
  const [linkRequiredMessage, setLinkRequiredMessage] = useState<string | null>(null);
  const [accountNotFoundPrompt, setAccountNotFoundPrompt] = useState(false);

  // Post-creation generated @username reveal state
  const [createdAccountSummary, setCreatedAccountSummary] = useState<{
    account: NonNullable<BootstrapResponse["account"]>;
    session: ChatCryptoSession;
  } | null>(null);
  const [copiedUsername, setCopiedUsername] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKeyRecoveryLink, setShowKeyRecoveryLink] = useState(false);

  const isDraft = bootstrap.state === "DRAFT_PENDING" && Boolean(bootstrap.draft);
  const isConflict = bootstrap.state === "AUTHENTICATED_WITH_PENDING_HANDOFF" && Boolean(bootstrap.account);

  // Default to "login" tab if this browser already holds preserved device keys
  useEffect(() => {
    if (isDraft || isConflict || keyEvictionReason) return;
    let cancelled = false;
    void readKnownDevices().then((devices) => {
      if (!cancelled && !userPickedTabRef.current && devices.length > 0) {
        setTab("login");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isDraft, isConflict, keyEvictionReason]);

  const selectTab = (nextTab: "login" | "create" | "link") => {
    userPickedTabRef.current = true;
    setTab(nextTab);
    setError(null);
    setExistingAccountPrompt(false);
    setLinkRequiredMessage(null);
    setAccountNotFoundPrompt(false);
  };

  const handleCopyUsername = async (handle: string) => {
    try {
      await navigator.clipboard.writeText(`@${handle}`);
      setCopiedUsername(true);
      window.setTimeout(() => setCopiedUsername(false), 2000);
    } catch {
      // Clipboard API unavailable
    }
  };

  const handleCreateOrActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setExistingAccountPrompt(false);

    if (!isDraft && !displayName.trim()) {
      setError("Enter your display name.");
      return;
    }

    if (!isDraft) {
      const digits = mobileNumber.replace(/\D/g, "");
      if (digits.length < 8) {
        setError("Enter a valid mobile number.");
        return;
      }
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
            displayName: displayName.trim() || undefined,
            device: devicePayload,
          })
        : await chatApi.register({
            proposedAccountId,
            displayName: displayName.trim(),
            mobileNumber: mobileNumber.trim(),
            device: devicePayload,
          });

      const otpkCount = Object.keys(prep.uploadPayload.oneTimeKeys ?? {}).length;
      await prep.markRegistered({ signed_curve25519: otpkCount });
      setCreatedAccountSummary({
        account: resp.account,
        session: prep.session,
      });
    } catch (err) {
      const e2 = err as { status?: number; code?: string; message?: string };
      if (e2.status === 409 && e2.code === "EXISTING_ACCOUNT_FOUND") {
        setExistingAccountPrompt(true);
        setError(e2.message || "An account with this mobile number already exists.");
      } else {
        setError(e2.message || "Unable to complete setup");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleExistingLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLinkRequiredMessage(null);
    setAccountNotFoundPrompt(false);

    const digits = loginMobile.replace(/\D/g, "");
    if (digits.length < 8) {
      setError("Enter a valid mobile number.");
      return;
    }

    setSubmitting(true);
    try {
      const knownDevices = await readKnownDevices();
      const challengeRes = await chatApi.loginChallenge({
        mobileNumber: loginMobile.trim(),
        knownDevices: knownDevices.map((d) => ({
          accountId: d.accountId,
          matrixDeviceId: d.matrixDeviceId,
        })),
      });

      if (challengeRes.status === "LINK_REQUIRED") {
        setLinkRequiredMessage(
          challengeRes.message ||
            "This browser does not hold your local encryption keys. Link this browser from an already signed-in device.",
        );
        return;
      }

      try {
        const prepared = await ChatCryptoSession.signLoginChallengeAndPrepareOpen({
          accountId: challengeRes.accountId,
          matrixDeviceId: challengeRes.matrixDeviceId,
          challengeId: challengeRes.challengeId,
          nonce: challengeRes.nonce,
        });

        const verified = await chatApi.loginVerify({
          challengeId: challengeRes.challengeId,
          accountId: challengeRes.accountId,
          matrixDeviceId: challengeRes.matrixDeviceId,
          signatureEnvelopeJson: prepared.signatureEnvelopeJson,
        });

        const openedSession = await prepared.activateSession();
        onAuthenticated(verified.account, openedSession);
      } catch (keyErr) {
        const ke = keyErr as { code?: string; message?: string };
        if (ke.code === "KEY_EVICTED_OR_MISSING" || ke.code === "UNAVAILABLE") {
          await removeKnownDevice(challengeRes.accountId, challengeRes.matrixDeviceId);
          setLinkRequiredMessage(
            "Local encryption keys on this browser were cleared or evicted. Please approve this browser from another signed-in device using Link Existing.",
          );
        } else {
          setError(ke.message || "Unable to sign in on this browser.");
        }
      }
    } catch (err) {
      const e2 = err as { status?: number; code?: string; message?: string };
      if (e2.status === 404 || e2.code === "ACCOUNT_NOT_FOUND") {
        setAccountNotFoundPrompt(true);
        setError(e2.message || "No account is registered with that mobile number.");
      } else {
        setError(e2.message || "Unable to sign in.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (createdAccountSummary) {
    const { account, session } = createdAccountSummary;
    return (
      <div className="min-h-dvh bg-[#faf9f6] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-[#ede8e3] bg-white p-6 space-y-5 shadow-xs">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-[#059669]" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-[#1a0a00] leading-snug">
                Your Encrypted Account Is Ready
              </h1>
              <p className="text-xs text-[#6b7280] mt-1 leading-relaxed">
                Share your auto-generated <span className="font-mono">@username</span> with contacts so they can message you without seeing your mobile number.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[#a7f3d0] bg-[#ecfdf5] p-4 space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#047857]">
              Your Generated Handle
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-lg font-extrabold text-[#1a0a00] truncate">
                @{account.username}
              </div>
              <button
                type="button"
                onClick={() => void handleCopyUsername(account.username)}
                className="rounded-lg border border-[#a7f3d0] bg-white px-2.5 py-1.5 text-xs font-bold text-[#047857] hover:bg-[#d1fae5] flex items-center gap-1 shrink-0"
              >
                {copiedUsername ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedUsername ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="text-xs text-[#065f46]">
              Display name: <span className="font-semibold">{account.displayName}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onAuthenticated(account, session)}
            className="w-full rounded-xl bg-[#059669] py-3 px-4 text-sm font-bold text-white hover:bg-[#047857] flex items-center justify-center gap-2"
          >
            Open Encrypted Chats
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

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
                await ChatCryptoSession.deactivateActiveSession();
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
                A unique, privacy-safe <span className="font-mono">@username</span> will be generated automatically and your mobile number is kept private.
              </div>
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
              disabled={submitting}
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
              Skip handoff & sign in or create another account
            </button>
          </form>
        ) : (
          <>
            <div className="grid grid-cols-3 rounded-xl bg-[#f5f0eb] p-1 gap-1">
              <button
                type="button"
                onClick={() => selectTab("login")}
                className={`rounded-lg py-2 px-1 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${
                  tab === "login"
                    ? "bg-white text-[#1a0a00] shadow-xs"
                    : "text-[#6b7280] hover:text-[#1a0a00]"
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" /> Existing
              </button>
              <button
                type="button"
                onClick={() => selectTab("create")}
                className={`rounded-lg py-2 px-1 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${
                  tab === "create"
                    ? "bg-white text-[#1a0a00] shadow-xs"
                    : "text-[#6b7280] hover:text-[#1a0a00]"
                }`}
              >
                <UserPlus className="w-3.5 h-3.5 shrink-0" /> New Account
              </button>
              <button
                type="button"
                onClick={() => selectTab("link")}
                className={`rounded-lg py-2 px-1 text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${
                  tab === "link"
                    ? "bg-white text-[#1a0a00] shadow-xs"
                    : "text-[#6b7280] hover:text-[#1a0a00]"
                }`}
              >
                <Link2 className="w-3.5 h-3.5 shrink-0" /> Link Existing
              </button>
            </div>

            {tab === "login" ? (
              <form onSubmit={handleExistingLogin} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-[#1a0a00] mb-1">
                    Mobile Number
                  </label>
                  <input
                    type="tel"
                    required
                    value={loginMobile}
                    onChange={(e) => {
                      setLoginMobile(e.target.value);
                      setLinkRequiredMessage(null);
                      setAccountNotFoundPrompt(false);
                    }}
                    placeholder="10-digit mobile number"
                    maxLength={20}
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                  />
                  <p className="mt-1.5 text-[11px] text-[#6b7280] leading-relaxed">
                    On the same browser where you kept local keys, this restores your chats instantly using your device cryptographic key.
                  </p>
                </div>

                {linkRequiredMessage && (
                  <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] p-3.5 space-y-2.5">
                    <div className="flex items-start gap-2 text-xs text-[#9a3412] leading-relaxed">
                      <KeyRound className="w-4 h-4 shrink-0 mt-0.5 text-[#ea580c]" />
                      <span>{linkRequiredMessage}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => selectTab("link")}
                      className="w-full rounded-xl bg-[#059669] py-2.5 px-3 text-xs font-bold text-white hover:bg-[#047857] flex items-center justify-center gap-1.5"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      Link This Browser (QR / 8-Char Code)
                    </button>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl bg-[#fef2f2] border border-[#fecaca] p-3 space-y-2 text-xs text-[#991b1b]">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                    {accountNotFoundPrompt && (
                      <button
                        type="button"
                        onClick={() => {
                          const num = loginMobile;
                          selectTab("create");
                          setMobileNumber(num);
                        }}
                        className="font-bold underline text-[#7f1d1d] hover:text-[#1a0a00]"
                      >
                        Create New Account with This Number →
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-xl bg-[#059669] py-3 text-sm font-bold text-white hover:bg-[#047857] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Continue With Mobile Number
                </button>
              </form>
            ) : tab === "create" ? (
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
                    Mobile Number
                  </label>
                  <input
                    type="tel"
                    required
                    value={mobileNumber}
                    onChange={(e) => {
                      setMobileNumber(e.target.value);
                      setExistingAccountPrompt(false);
                    }}
                    placeholder="10-digit mobile number"
                    maxLength={20}
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                  />
                  <p className="mt-1.5 text-[11px] text-[#6b7280] leading-relaxed">
                    A unique, privacy-safe <span className="font-mono">@username</span> is generated automatically. Your mobile number is never shown to other users.
                  </p>
                </div>

                {error && (
                  <div className="rounded-xl bg-[#fef2f2] border border-[#fecaca] p-3 space-y-2 text-xs text-[#991b1b]">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                    {existingAccountPrompt && (
                      <button
                        type="button"
                        onClick={() => {
                          const num = mobileNumber;
                          selectTab("login");
                          setLoginMobile(num);
                        }}
                        className="font-bold underline text-[#7f1d1d] hover:text-[#1a0a00]"
                      >
                        Sign In to Existing Account Instead →
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
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
