import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  ChatCryptoSession,
  createDevice2EciesOffer,
  establishDevice2EciesChannel,
  randomDeviceId,
  type Device2EciesOffer,
} from "../crypto/e2eeClient";
import { chatApi, type BootstrapResponse } from "../lib/api";

interface Props {
  onLinked: (account: NonNullable<BootstrapResponse["account"]>, session: ChatCryptoSession) => void;
  onBack?: () => void;
}

export function DeviceLinkInitiator({ onLinked, onBack }: Props) {
  const [deviceLabel, setDeviceLabel] = useState(() => {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (/iPhone|iPad/i.test(ua)) return "iPhone Safari";
    if (/Android/i.test(ua)) return "Android Browser";
    return "Desktop Browser";
  });

  const [step, setStep] = useState<"idle" | "qr_ready" | "sas_waiting" | "done" | "error">("idle");
  const [qrPayload, setQrPayload] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [sasCode, setSasCode] = useState("");
  const [accountPreview, setAccountPreview] = useState<{ username: string; displayName: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const linkIdRef = useRef<string>("");
  const matrixDeviceIdRef = useRef<string>(randomDeviceId());
  const offerRef = useRef<Device2EciesOffer | null>(null);
  const preparedDeviceRef = useRef<Awaited<ReturnType<typeof ChatCryptoSession.prepareLinkedDevice>> | null>(null);

  const startIntent = async () => {
    setErrorMsg(null);
    setStep("idle");
    try {
      const mDevId = randomDeviceId();
      matrixDeviceIdRef.current = mDevId;
      const offer = await createDevice2EciesOffer();
      offerRef.current = offer;

      const intent = await chatApi.createLinkIntent({
        deviceLabel: deviceLabel.trim() || "Linked Browser",
        matrixDeviceId: mDevId,
        device2EciesPub: offer.publicKeyBase64,
      });

      linkIdRef.current = intent.linkId;
      setQrPayload(intent.qrPayload);
      setShortCode(intent.shortCode);
      setSasCode("");
      setAccountPreview(null);
      setStep("qr_ready");
    } catch (err) {
      setErrorMsg((err as Error).message || "Unable to create device linking request");
      setStep("error");
    }
  };

  useEffect(() => {
    void startIntent();
    return () => {
      try {
        offerRef.current?.ecies.free();
      } catch {
        // Ignore WASM handle free on unmount
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step !== "qr_ready" && step !== "sas_waiting") return;
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      if (cancelled || !linkIdRef.current) return;
      try {
        if (step === "qr_ready") {
          const ch = await chatApi.pollLinkChallenge(linkIdRef.current);
          if (cancelled) return;
          if (ch.status === "challenge_issued" && ch.device1EciesOutMsg && ch.accountId && offerRef.current) {
            const inbound = await establishDevice2EciesChannel(offerRef.current, ch.device1EciesOutMsg, {
              linkId: linkIdRef.current,
            });
            if (inbound.welcomePayload.accountId !== ch.accountId) {
              throw new Error("Identity mismatch during ECIES device pairing");
            }

            const prep = await ChatCryptoSession.prepareLinkedDevice({
              accountId: ch.accountId,
              matrixDeviceId: matrixDeviceIdRef.current,
              approvingDevice: {
                matrixDeviceId: inbound.welcomePayload.approvingMatrixDeviceId,
                ed25519: inbound.welcomePayload.approvingEd25519,
              },
            });
            preparedDeviceRef.current = prep;

            const proofCiphertext = inbound.channel.encrypt(
              JSON.stringify({
                matrixDeviceId: matrixDeviceIdRef.current,
                ed25519: prep.ed25519Key,
                curve25519: prep.curve25519Key,
              }),
            );
            inbound.channel.free();

            await chatApi.submitLinkKeys(linkIdRef.current, {
              deviceKeysJson: prep.uploadPayload.deviceKeysJson,
              oneTimeKeys: prep.uploadPayload.oneTimeKeys,
              fallbackKey: prep.uploadPayload.fallbackKey,
              device2KeyProofCiphertext: proofCiphertext,
            });

            if (cancelled) return;
            setSasCode(inbound.sasCode);
            setAccountPreview({
              username: inbound.welcomePayload.username,
              displayName: inbound.welcomePayload.displayName,
            });
            setStep("sas_waiting");
            return;
          }
        } else if (step === "sas_waiting") {
          const st = await chatApi.pollLinkStatus(linkIdRef.current);
          if (cancelled) return;
          if (st.approved && st.account && preparedDeviceRef.current) {
            await preparedDeviceRef.current.commitLinked();
            await chatApi.ackLinkStatus(linkIdRef.current).catch(() => undefined);
            setStep("done");
            onLinked(st.account, preparedDeviceRef.current.session);
            return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = (err as Error).message;
          if (msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("not found")) {
            setErrorMsg("Link request expired. Generate a fresh QR or code.");
            setStep("error");
            return;
          }
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(poll, 1600);
      }
    };

    timer = window.setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, onLinked]);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-[#1a0a00] mb-1.5">
          Name for this browser
        </label>
        <input
          type="text"
          value={deviceLabel}
          onChange={(e) => setDeviceLabel(e.target.value)}
          disabled={step === "sas_waiting" || step === "done"}
          maxLength={60}
          className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
        />
      </div>

      {step === "qr_ready" && (
        <div className="rounded-2xl border border-[#ede8e3] bg-[#faf9f6] p-5 text-center space-y-4">
          <div className="inline-flex rounded-2xl bg-white p-3.5 border border-[#ede8e3]">
            <QRCodeSVG value={qrPayload} size={184} level="M" bgColor="#ffffff" fgColor="#1a0a00" />
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">
              Or enter this 8-character code on your existing device
            </div>
            <div className="mt-1.5 inline-block rounded-xl border border-[#d1fae5] bg-[#ecfdf5] px-4 py-2 font-mono text-xl font-extrabold tracking-[0.22em] text-[#047857]">
              {shortCode}
            </div>
          </div>

          <p className="text-xs text-[#6b7280] leading-relaxed">
            Open <strong className="text-[#1a0a00]">Bitebend Chat</strong> on an already signed-in device, tap{" "}
            <strong className="text-[#1a0a00]">Devices → Link Another Device</strong>, and scan this QR code or type the 8-character code.
          </p>

          <button
            type="button"
            onClick={() => void startIntent()}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#059669] hover:text-[#047857]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Generate fresh code
          </button>
        </div>
      )}

      {step === "sas_waiting" && (
        <div className="rounded-2xl border border-[#a7f3d0] bg-[#ecfdf5] p-5 text-center space-y-3">
          <ShieldCheck className="w-9 h-9 text-[#059669] mx-auto" />
          <div className="text-sm font-bold text-[#1a0a00]">
            Confirm pairing code on @{accountPreview?.username}
          </div>
          <div className="rounded-xl bg-white border border-[#d1fae5] px-4 py-3 inline-block font-mono text-xl sm:text-2xl font-black tracking-[0.12em] whitespace-nowrap text-[#047857]">
            {sasCode}
          </div>
          <p className="text-xs text-[#065f46] leading-relaxed">
            Verify this code matches the code shown on your existing device, then tap{" "}
            <strong>Approve Device</strong> there. Linked devices receive encrypted messages sent from this moment forward.
          </p>
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#059669]">
            <Loader2 className="w-4 h-4 animate-spin" /> Waiting for approval…
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="rounded-2xl border border-[#a7f3d0] bg-[#ecfdf5] p-5 text-center space-y-2">
          <CheckCircle2 className="w-8 h-8 text-[#059669] mx-auto" />
          <div className="text-sm font-bold text-[#047857]">Device Linked Successfully</div>
        </div>
      )}

      {step === "error" && (
        <div className="rounded-2xl border border-[#fecaca] bg-[#fef2f2] p-4 space-y-3">
          <div className="flex items-start gap-2 text-xs font-medium text-[#991b1b]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => void startIntent()}
            className="w-full rounded-xl bg-[#059669] py-2.5 text-sm font-bold text-white hover:bg-[#047857]"
          >
            Try Again
          </button>
        </div>
      )}

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="w-full rounded-xl border border-[#ede8e3] bg-white py-2.5 text-xs font-semibold text-[#6b7280] hover:text-[#1a0a00]"
        >
          Back
        </button>
      )}
    </div>
  );
}
