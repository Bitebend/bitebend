import { useState, useEffect, useRef, useCallback } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { apiFetch, ApiError, resolveImageUrl } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type {
  ProfilePinForgotOtpResponse,
  ProfilePinStatus,
  ProfilePinTokenResponse,
  RestaurantProfile,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Save,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Smartphone,
  Zap,
  Upload,
  ScanLine,
  ShieldCheck,
  Lock,
  LockOpen,
  ShieldAlert,
  Clock,
  MessageSquareCode,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import jsQR from "jsqr";
import { RestaurantLocationSection } from "@/components/location/RestaurantLocationSection";

// ── UPI QR parser ─────────────────────────────────────────────────────────────
// UPI QR codes encode a URL in the form:
//   upi://pay?pa=merchant@okaxis&pn=Merchant%20Name&mc=0000&am=0.00&cu=INR&...
// We extract only pa (VPA) and pn (merchant name); everything else is ignored.

interface UpiQrData {
  pa: string;   // payee VPA  e.g. "merchant@okaxis"
  pn: string;   // payee name e.g. "Olive Garden"
}

// ── VPA validator ──────────────────────────────────────────────────────────────
function validatePa(pa: string): string {
  const v = pa.trim().toLowerCase();
  if (!v.includes("@"))    throw new Error("UPI ID must contain @");
  if (v.includes(" "))     throw new Error("UPI ID must not contain spaces");
  if (v.length >= 100)     throw new Error("UPI ID is too long (max 100 characters)");
  return v;
}

function decodePn(raw: string | null): string {
  if (!raw) return "";
  try { return decodeURIComponent(raw).trim(); } catch { return raw.trim(); }
}

// ── Multi-strategy UPI QR parser ──────────────────────────────────────────────
// Handles: upi://pay?..., BHIM://pay?..., merchant://...,
//          BharatPe / PhonePe / Paytm merchant URLs, plain VPAs, JSON blobs.
function parseUpiQr(raw: string): UpiQrData {
  const s = raw.trim();

  // Strategy 1 — URL with a query string (covers 95% of real-world UPI QRs).
  // Works for: upi://pay?, bhim://pay?, merchant://pay?,
  //   https://pay.bharatpe.com/...?pa=..., https://upipay.sbi/?pa=...
  const qIdx = s.indexOf("?");
  if (qIdx !== -1) {
    try {
      const params = new URLSearchParams(s.slice(qIdx));
      const pa = params.get("pa")?.trim() ?? "";
      if (pa.includes("@")) {
        return { pa: validatePa(pa), pn: decodePn(params.get("pn")) };
      }
    } catch { /* malformed query string — fall through */ }
  }

  // Strategy 2 — regex extraction of pa= / pn= from anywhere in the string.
  // Covers BharatQR payloads and wrapped merchant QRs that embed UPI params
  // inside a larger string (e.g. BharatPe app-link with extra context).
  const paMatch = /[?&;|,\s]pa=([^\s&;|,\n]+)/i.exec(s)
    ?? /^pa=([^\s&;|,\n]+)/i.exec(s);
  if (paMatch) {
    const pa = decodeURIComponent(paMatch[1]).trim();
    if (pa.includes("@")) {
      const pnMatch = /[?&;|,\s]pn=([^\s&;|,\n]+)/i.exec(s)
        ?? /^pn=([^\s&;|,\n]+)/i.exec(s);
      return {
        pa: validatePa(pa),
        pn: pnMatch ? decodePn(pnMatch[1]) : "",
      };
    }
  }

  // Strategy 3 — raw VPA (QR encodes only the UPI address, no scheme).
  // Some POS-printed QRs and PhonePe collect QRs do this.
  if (/^[\w.\-]+@[\w]+$/.test(s) && s.length < 100) {
    return { pa: validatePa(s), pn: "" };
  }

  // Strategy 4 — JSON blob: {"pa":"merchant@okaxis","pn":"Name",...}
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    if (obj && typeof obj["pa"] === "string" && (obj["pa"] as string).includes("@")) {
      return {
        pa: validatePa(obj["pa"] as string),
        pn: typeof obj["pn"] === "string" ? (obj["pn"] as string).trim() : "",
      };
    }
  } catch { /* not JSON */ }

  throw new Error(
    `Could not find a UPI ID in this QR. Raw content: "${s.slice(0, 80)}"`,
  );
}

// ── Image preprocessing helpers ───────────────────────────────────────────────

// Convert pixels to grayscale + sharpen contrast (BT.601 coefficients, S-curve).
function applyGrayscaleContrast(imageData: ImageData, factor = 1.6): void {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.min(255, Math.max(0, (gray - 128) * factor + 128));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

// Draw img onto a new off-screen canvas with scale + rotation, optionally
// center-cropped. Returns the canvas (never attached to the DOM).
function prepareCanvas(
  img: HTMLImageElement,
  scale: number,
  rotation: number,   // 0 | 90 | 180 | 270
  crop: boolean,
): HTMLCanvasElement {
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const m = 0.15;   // 15% margin each side when cropping

  const sx = crop ? srcW * m : 0;
  const sy = crop ? srcH * m : 0;
  const sw = crop ? srcW * (1 - 2 * m) : srcW;
  const sh = crop ? srcH * (1 - 2 * m) : srcH;
  const dw = sw * scale;
  const dh = sh * scale;

  const c = document.createElement("canvas");
  const swapped = rotation === 90 || rotation === 270;
  c.width  = swapped ? dh : dw;
  c.height = swapped ? dw : dh;

  const ctx = c.getContext("2d")!;
  ctx.save();
  switch (rotation) {
    case 90:  ctx.translate(c.width, 0);           ctx.rotate( Math.PI / 2); break;
    case 180: ctx.translate(c.width, c.height);    ctx.rotate( Math.PI);     break;
    case 270: ctx.translate(0, c.height);          ctx.rotate(-Math.PI / 2); break;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  ctx.restore();

  // Apply grayscale + contrast in place
  const px = ctx.getImageData(0, 0, c.width, c.height);
  applyGrayscaleContrast(px);
  ctx.putImageData(px, 0, 0);

  return c;
}

// Try jsQR with both inversion modes on a prepared canvas.
function scanCanvas(c: HTMLCanvasElement): string | null {
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const px = ctx.getImageData(0, 0, c.width, c.height);
  return (
    jsQR(px.data, px.width, px.height, { inversionAttempts: "dontInvert" })?.data ??
    jsQR(px.data, px.width, px.height, { inversionAttempts: "onlyInvert" })?.data ??
    null
  );
}

// Multi-pass QR decoder: tries scales × rotations × crop variants.
// Returns the first decoded string, or null if all attempts fail.
function attemptQrDecode(img: HTMLImageElement): string | null {
  const attempts: Array<[number, number, boolean]> = [
    [1,   0,   false],
    [1.5, 0,   false],
    [2,   0,   false],
    [1,   90,  false],
    [1,   180, false],
    [1,   270, false],
    [1.5, 90,  false],
    [1.5, 270, false],
    [1,   0,   true ],   // center-crop
    [2,   0,   true ],   // center-crop upscaled
    [1,   90,  true ],
    [1,   270, true ],
  ];

  for (const [scale, rot, crop] of attempts) {
    const c = prepareCanvas(img, scale, rot, crop);
    const raw = scanCanvas(c);
    if (raw) {
      console.log(`[QR] success  scale=${scale}x  rot=${rot}°  crop=${crop}`);
      return raw;
    }
  }
  console.log("[QR] all attempts exhausted");
  return null;
}

// ── ₹1 test link ─────────────────────────────────────────────────────────────
// Builds a minimal ₹1 UPI test link — same format as the customer checkout.
// Only mandatory fields (pa, pn, am, cu) so no optional field can be the cause
// of a payment-app rejection during diagnosis.
function buildTestUpiLink(upiId: string, name: string): string {
  const pa = upiId.trim();
  const pn = encodeURIComponent(
    name.replace(/[#?&=%:;/\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 50),
  );
  return `upi://pay?pa=${pa}&pn=${pn}&am=1.00&cu=INR`;
}

const CUISINE_TYPES = [
  { value: "north_indian", label: "North Indian" },
  { value: "south_indian", label: "South Indian" },
  { value: "chinese", label: "Chinese" },
  { value: "continental", label: "Continental" },
  { value: "italian", label: "Italian" },
  { value: "mughlai", label: "Mughlai" },
  { value: "seafood", label: "Seafood" },
  { value: "street_food", label: "Street Food" },
  { value: "multi_cuisine", label: "Multi Cuisine" },
  { value: "other", label: "Other" },
];

export default function Profile() {
  const { user, refresh: refreshAuth } = useAuth();
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const [form, setForm] = useState({
    name: "",
    description: "",
    cuisineType: "multi_cuisine",
    address: "",
    locality: "",
    city: "",
    latitude: null as number | null,
    longitude: null as number | null,
    phone: "",
    email: "",
    upiId: "",
    upiName: "",
    personalUpiEnabled: false,
    upiVerified: false,
    verifiedAt: null as string | null,
    qrImageData: null as string | null,
    qrDecodedPayload: null as string | null,
    qrMerchantName: "",
    qrExtractedUpiId: "",
    paymentQrEnabled: false,
    whatsappNumber: "",
    taxPercent: "5",
  });

  // Login credentials state
  const [credForm, setCredForm] = useState({
    currentPassword: "",
    newEmail: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [showCredPasswords, setShowCredPasswords] = useState({ current: false, new: false, confirm: false });
  const [credSaving, setCredSaving] = useState(false);
  const [credSaved, setCredSaved] = useState(false);
  const [credError, setCredError] = useState("");

  const [pinStatus, setPinStatus] = useState<ProfilePinStatus | null>(null);
  const [, setPinUnlockToken] = useState<string | null>(null);
  const pinUnlockTokenRef = useRef<string | null>(null);
  const setMemoryUnlockToken = useCallback((token: string | null) => {
    pinUnlockTokenRef.current = token;
    setPinUnlockToken(token);
  }, []);

  const [pinMode, setPinMode] = useState<"pin" | "forgot">("pin");
  const [pinInput, setPinInput] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [setupConfirmPin, setSetupConfirmPin] = useState("");
  const [showPinDigits, setShowPinDigits] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [pinError, setPinError] = useState("");
  const [pinNotice, setPinNotice] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Forgot PIN via Messaging OTP state
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null);
  const [otpRequestedPhone, setOtpRequestedPhone] = useState<string | null>(null);
  const [otpDeliveryInfo, setOtpDeliveryInfo] = useState<string>("");
  const [otpCooldownEndsAtMs, setOtpCooldownEndsAtMs] = useState<number>(0);
  const [otpSending, setOtpSending] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [resetNewPin, setResetNewPin] = useState("");
  const [resetConfirmPin, setResetConfirmPin] = useState("");
  const [otpResetting, setOtpResetting] = useState(false);

  // Change PIN panel state (when Profile is unlocked)
  const [showChangePin, setShowChangePin] = useState(false);
  const [changePinForm, setChangePinForm] = useState({ currentPin: "", newPin: "", confirmPin: "" });
  const [changePinSaving, setChangePinSaving] = useState(false);
  const [changePinSaved, setChangePinSaved] = useState(false);
  const [changePinError, setChangePinError] = useState("");

  // QR upload / decode state
  const [qrStatus, setQrStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
  const [qrMessage, setQrMessage] = useState("");
  const [qrExtracted, setQrExtracted] = useState<UpiQrData | null>(null);
  const [qrVerifyState, setQrVerifyState] = useState<"idle" | "launched" | "verified">("idle");
  const [showAdvancedUpi, setShowAdvancedUpi] = useState(false);
  const qrFileInputRef = useRef<HTMLInputElement>(null);

  const applyProfileData = useCallback((r: RestaurantProfile) => {
    setRestaurant(r);
    setForm({
      name: r.name ?? "",
      description: r.description ?? "",
      cuisineType: r.cuisineType ?? "multi_cuisine",
      address: r.address ?? "",
      locality: r.locality ?? "",
      city: r.city ?? "",
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      phone: r.phone ?? "",
      email: r.email ?? "",
      upiId: r.upiId ?? "",
      upiName: r.upiName ?? "",
      personalUpiEnabled: r.personalUpiEnabled ?? false,
      upiVerified: r.upiVerified ?? false,
      verifiedAt: r.verifiedAt ?? null,
      qrImageData: r.qrImageData ?? null,
      qrDecodedPayload: r.qrDecodedPayload ?? null,
      qrMerchantName: r.qrMerchantName ?? "",
      qrExtractedUpiId: r.qrExtractedUpiId ?? "",
      paymentQrEnabled: r.paymentQrEnabled ?? false,
      whatsappNumber: r.whatsappNumber ?? "",
      taxPercent: String(r.taxPercent ?? 5),
    });
  }, []);

  const refreshPinStatusAndMaybeProfile = useCallback(
    async (explicitToken?: string | null) => {
      setLoading(true);
      setError("");
      try {
        const status = await apiFetch<ProfilePinStatus>("/owner/profile/pin/status");
        setPinStatus(status);
        if (status.activeChallenge) {
          setOtpChallengeId(status.activeChallenge.challengeId);
          setOtpCooldownEndsAtMs(Date.parse(status.activeChallenge.cooldownEndsAt) || 0);
        }

        const activeToken = explicitToken !== undefined ? explicitToken : pinUnlockTokenRef.current;
        if (status.configured && !status.locked && (status.unlocked || activeToken)) {
          try {
            const headers: Record<string, string> = activeToken
              ? { "X-Profile-Pin-Token": activeToken }
              : {};
            const r = await apiFetch<RestaurantProfile>("/owner/profile", { headers });
            applyProfileData(r);
          } catch (profileErr) {
            if (
              profileErr instanceof ApiError &&
              profileErr.status === 403 &&
              profileErr.code?.startsWith("PIN_")
            ) {
              setMemoryUnlockToken(null);
              setRestaurant(null);
              const refreshed = await apiFetch<ProfilePinStatus>("/owner/profile/pin/status").catch(() => status);
              setPinStatus(refreshed);
            } else {
              throw profileErr;
            }
          }
        } else {
          setRestaurant(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load profile status");
      } finally {
        setLoading(false);
      }
    },
    [applyProfileData, setMemoryUnlockToken],
  );

  // Clear in-memory PIN token on unmount & whenever user logs out
  useEffect(() => {
    return () => {
      pinUnlockTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setMemoryUnlockToken(null);
      setRestaurant(null);
    }
  }, [user, setMemoryUnlockToken]);

  useEffect(() => {
    void refreshPinStatusAndMaybeProfile();
  }, [refreshPinStatusAndMaybeProfile]);

  // Live 1s clock tick while lockout or OTP cooldown is active
  useEffect(() => {
    const hasLockout = Boolean(pinStatus?.lockedUntil && Date.parse(pinStatus.lockedUntil) > nowMs);
    const hasCooldown = otpCooldownEndsAtMs > nowMs;
    if (!hasLockout && !hasCooldown) return;

    const timer = window.setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (pinStatus?.lockedUntil && Date.parse(pinStatus.lockedUntil) <= next && pinStatus.locked) {
        void apiFetch<ProfilePinStatus>("/owner/profile/pin/status")
          .then((s) => setPinStatus(s))
          .catch(() => undefined);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pinStatus?.lockedUntil, pinStatus?.locked, otpCooldownEndsAtMs, nowMs]);

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  // ── QR upload handler (FileReader → persistent base64 + optional decode) ──
  const handleQrUpload = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setQrStatus("error");
      setQrMessage("Please upload an image file (PNG, JPG, or JPEG).");
      setQrExtracted(null);
      return;
    }

    setQrStatus("scanning");
    setQrMessage("");
    setQrExtracted(null);
    setQrVerifyState("idle");

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUri = ev.target?.result as string;
      // Store the image immediately — persists even if QR decode fails
      setForm((f) => ({ ...f, qrImageData: dataUri }));

      const img = new Image();
      img.onload = () => {
        const raw = attemptQrDecode(img);

        if (!raw) {
          setQrStatus("success");
          setQrMessage("QR image saved. UPI details couldn't be auto-extracted — enter them in Advanced settings if needed.");
          return;
        }

        console.log("[QR DECODED]", raw);

        try {
          const extracted = parseUpiQr(raw);
          console.log("[EXTRACTED PA]", extracted.pa);
          console.log("[EXTRACTED PN]", extracted.pn);
          setForm((f) => ({
            ...f,
            qrDecodedPayload: raw,
            qrMerchantName: extracted.pn || f.qrMerchantName,
            qrExtractedUpiId: extracted.pa,
          }));
          setQrExtracted(extracted);
          setQrStatus("success");
          setQrMessage("");
        } catch {
          setQrStatus("success");
          setQrMessage("QR image saved. Could not extract UPI details — enter them in Advanced settings if needed.");
        }
      };

      img.onerror = () => {
        setQrStatus("error");
        setQrMessage("Could not load the image. Please try a different file.");
      };

      img.src = dataUri;
    };

    reader.onerror = () => {
      setQrStatus("error");
      setQrMessage("Could not read file. Please try a different file.");
    };

    reader.readAsDataURL(file);
  };

  const setCred = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCredForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        description: form.description || null,
        upiId: form.upiId || null,
        upiName: form.upiName || null,
        personalUpiEnabled: form.personalUpiEnabled,
        paymentQrEnabled: form.paymentQrEnabled,
        qrMerchantName: form.qrMerchantName || null,
        qrExtractedUpiId: form.qrExtractedUpiId || null,
        whatsappNumber: form.whatsappNumber || null,
        taxPercent: parseInt(form.taxPercent),
      };
      console.log("[SAVE PAYMENT QR]", {
        paymentQrEnabled: payload.paymentQrEnabled,
        qrImageDataLength: payload.qrImageData ? payload.qrImageData.length : null,
        qrExtractedUpiId: payload.qrExtractedUpiId,
        qrMerchantName: payload.qrMerchantName,
      });
      const headers: Record<string, string> = pinUnlockTokenRef.current
        ? { "X-Profile-Pin-Token": pinUnlockTokenRef.current }
        : {};
      const updated = await apiFetch<RestaurantProfile>("/owner/profile", {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      setRestaurant(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code?.startsWith("PIN_")) {
        setMemoryUnlockToken(null);
        setRestaurant(null);
        setPinError(err.message);
        await refreshPinStatusAndMaybeProfile(null);
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSetupPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError("");
    if (!/^\d{4}$/.test(setupPin)) {
      setPinError("Profile PIN must be exactly 4 digits.");
      return;
    }
    if (setupPin !== setupConfirmPin) {
      setPinError("PIN and confirmation PIN do not match.");
      return;
    }
    setPinSubmitting(true);
    try {
      const res = await apiFetch<ProfilePinTokenResponse>("/owner/profile/pin/setup", {
        method: "POST",
        body: JSON.stringify({ pin: setupPin, confirmPin: setupConfirmPin }),
      });
      setMemoryUnlockToken(res.unlockToken);
      setSetupPin("");
      setSetupConfirmPin("");
      await refreshPinStatusAndMaybeProfile(res.unlockToken);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Failed to set Profile PIN");
    } finally {
      setPinSubmitting(false);
    }
  };

  const handleVerifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError("");
    setPinNotice("");
    if (!/^\d{4}$/.test(pinInput)) {
      setPinError("Enter your 4-digit Profile PIN.");
      return;
    }
    setPinSubmitting(true);
    try {
      const res = await apiFetch<ProfilePinTokenResponse>("/owner/profile/pin/verify", {
        method: "POST",
        skipAuthResetOn401: true,
        body: JSON.stringify({ pin: pinInput }),
      });
      setMemoryUnlockToken(res.unlockToken);
      setPinInput("");
      await refreshPinStatusAndMaybeProfile(res.unlockToken);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429 && err.code === "PIN_LOCKED") {
          const lockedUntil =
            typeof err.data?.["lockedUntil"] === "string" ? err.data["lockedUntil"] : null;
          const lockoutLevel =
            typeof err.data?.["lockoutLevel"] === "number" ? err.data["lockoutLevel"] : 1;
          setPinStatus((prev) =>
            prev
              ? { ...prev, locked: true, lockedUntil, lockoutLevel, unlocked: false }
              : prev,
          );
        }
        setPinError(err.message);
      } else {
        setPinError("Unable to verify Profile PIN");
      }
    } finally {
      setPinSubmitting(false);
    }
  };

  const handleRequestForgotOtp = async () => {
    setPinError("");
    setOtpDeliveryInfo("");
    setOtpSending(true);
    try {
      const res = await apiFetch<ProfilePinForgotOtpResponse>("/owner/profile/pin/forgot-otp", {
        method: "POST",
        skipAuthResetOn401: true,
        timeoutMs: 15_000,
      });
      setOtpChallengeId(res.challengeId);
      setOtpRequestedPhone(res.maskedPhone);
      setOtpCooldownEndsAtMs(Date.now() + res.cooldownSeconds * 1000);
      setNowMs(Date.now());
      setOtpDeliveryInfo(
        res.deliveryStatus === "delivered"
          ? `6-digit OTP sent to Bitebend Messaging (${res.maskedPhone}). Open Bitebend Chat and select "Bitebend Security".`
          : `OTP request submitted (${res.deliveryStatus}). Check Bitebend Chat under "Bitebend Security".`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && typeof err.data?.["retryAfterSeconds"] === "number") {
        setOtpCooldownEndsAtMs(Date.now() + err.data["retryAfterSeconds"] * 1000);
        setNowMs(Date.now());
      }
      setPinError(err instanceof Error ? err.message : "Unable to request recovery OTP");
    } finally {
      setOtpSending(false);
    }
  };

  const handleResetWithOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError("");
    if (!/^\d{6}$/.test(otpCode)) {
      setPinError("Enter the 6-digit OTP from Bitebend Messaging.");
      return;
    }
    if (!/^\d{4}$/.test(resetNewPin)) {
      setPinError("New PIN must be exactly 4 digits.");
      return;
    }
    if (resetNewPin !== resetConfirmPin) {
      setPinError("New PIN and confirmation PIN do not match.");
      return;
    }
    setOtpResetting(true);
    try {
      const res = await apiFetch<ProfilePinTokenResponse>("/owner/profile/pin/reset-with-otp", {
        method: "POST",
        skipAuthResetOn401: true,
        body: JSON.stringify({
          ...(otpChallengeId ? { challengeId: otpChallengeId } : {}),
          otp: otpCode,
          newPin: resetNewPin,
          confirmPin: resetConfirmPin,
        }),
      });
      setMemoryUnlockToken(res.unlockToken);
      setOtpCode("");
      setResetNewPin("");
      setResetConfirmPin("");
      setOtpDeliveryInfo("");
      setPinMode("pin");
      await refreshPinStatusAndMaybeProfile(res.unlockToken);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "OTP reset failed");
    } finally {
      setOtpResetting(false);
    }
  };

  const handleLockProfileNow = async () => {
    try {
      await apiFetch<{ ok: boolean }>("/owner/profile/pin/lock", { method: "POST" });
    } catch {
      // Clear local state regardless
    }
    setMemoryUnlockToken(null);
    setRestaurant(null);
    setShowChangePin(false);
    setPinMode("pin");
    setPinError("");
    setPinNotice("Profile locked. Enter your 4-digit PIN to view or edit settings.");
    await refreshPinStatusAndMaybeProfile(null);
  };

  const handleChangePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePinError("");
    setChangePinSaved(false);
    if (!/^\d{4}$/.test(changePinForm.currentPin) || !/^\d{4}$/.test(changePinForm.newPin)) {
      setChangePinError("All PIN fields must be exactly 4 digits.");
      return;
    }
    if (changePinForm.newPin !== changePinForm.confirmPin) {
      setChangePinError("New PIN and confirmation PIN do not match.");
      return;
    }
    if (changePinForm.currentPin === changePinForm.newPin) {
      setChangePinError("New PIN must differ from your current PIN.");
      return;
    }
    setChangePinSaving(true);
    try {
      const res = await apiFetch<ProfilePinTokenResponse>("/owner/profile/pin/change", {
        method: "POST",
        skipAuthResetOn401: true,
        body: JSON.stringify(changePinForm),
      });
      setMemoryUnlockToken(res.unlockToken);
      setChangePinForm({ currentPin: "", newPin: "", confirmPin: "" });
      setChangePinSaved(true);
      window.setTimeout(() => setChangePinSaved(false), 3500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && err.code === "PIN_LOCKED") {
        setMemoryUnlockToken(null);
        setRestaurant(null);
        setPinError(err.message);
        await refreshPinStatusAndMaybeProfile(null);
      } else {
        setChangePinError(err instanceof Error ? err.message : "Failed to change PIN");
      }
    } finally {
      setChangePinSaving(false);
    }
  };

  const handleCredSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredError("");

    const hasEmailChange = credForm.newEmail.trim() !== "" && credForm.newEmail.trim() !== user?.email;
    const hasPasswordChange = credForm.newPassword !== "";

    if (!hasEmailChange && !hasPasswordChange) {
      setCredError("Enter a new email or new password to update.");
      return;
    }
    if (hasPasswordChange && credForm.newPassword !== credForm.confirmPassword) {
      setCredError("New passwords do not match.");
      return;
    }
    if (hasPasswordChange && credForm.newPassword.length < 6) {
      setCredError("New password must be at least 6 characters.");
      return;
    }

    setCredSaving(true);
    try {
      const body: Record<string, string> = { currentPassword: credForm.currentPassword };
      if (hasEmailChange) body.newEmail = credForm.newEmail.trim();
      if (hasPasswordChange) body.newPassword = credForm.newPassword;

      const result = await apiFetch<{ ok: boolean; emailChanged: boolean; passwordChanged: boolean }>(
        "/owner/account",
        { method: "PUT", body: JSON.stringify(body) }
      );

      setCredSaved(true);
      setCredForm({ currentPassword: "", newEmail: "", newPassword: "", confirmPassword: "" });
      setTimeout(() => setCredSaved(false), 4000);

      if (result.emailChanged) {
        await refreshAuth();
      }
    } catch (err) {
      setCredError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setCredSaving(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  if (!restaurant && error) {
    return (
      <AppShell>
        <div className="p-4 md:p-6 lg:p-8 max-w-2xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-red-700 font-medium">{error}</p>
            <p className="text-sm text-red-500 mt-1">
              Your restaurant account could not be found. Please contact support.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  // Stage 2: Profile PIN Setup Gate (when PIN not configured yet)
  if (!restaurant && pinStatus && !pinStatus.configured) {
    return (
      <AppShell>
        <div className="p-4 md:p-6 lg:p-8 max-w-md mx-auto">
          <div className="bg-card border border-border rounded-2xl p-6 space-y-5 shadow-xs">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold">Set Up Profile 4-Digit PIN</h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Create a 4-digit security PIN to protect your restaurant profile and payout settings.
                </p>
              </div>
            </div>

            <form onSubmit={handleSetupPin} className="space-y-4">
              <div className="space-y-1.5">
                <Label>4-Digit Profile PIN</Label>
                <div className="relative">
                  <Input
                    type={showPinDigits ? "text" : "password"}
                    inputMode="numeric"
                    maxLength={4}
                    value={setupPin}
                    onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="••••"
                    className="pr-10 font-mono tracking-[0.35em] text-center text-lg"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPinDigits((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPinDigits ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Confirm 4-Digit PIN</Label>
                <Input
                  type={showPinDigits ? "text" : "password"}
                  inputMode="numeric"
                  maxLength={4}
                  value={setupConfirmPin}
                  onChange={(e) => setSetupConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="••••"
                  className="font-mono tracking-[0.35em] text-center text-lg"
                  required
                />
              </div>

              {pinError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">
                  {pinError}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-orange-500 hover:bg-orange-600 text-white h-11"
                disabled={pinSubmitting}
              >
                {pinSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                Set Profile PIN &amp; Continue
              </Button>
            </form>
          </div>
        </div>
      </AppShell>
    );
  }

  // Stage 2: Profile PIN Unlock & Forgot-PIN OTP Recovery Gate
  if (!restaurant && pinStatus && pinStatus.configured) {
    const lockedUntilMs = pinStatus.lockedUntil ? Date.parse(pinStatus.lockedUntil) : 0;
    const lockRemainingSec = Math.max(0, Math.ceil((lockedUntilMs - nowMs) / 1000));
    const isLockedOut = Boolean(pinStatus.locked && lockRemainingSec > 0);
    const lockMins = Math.floor(lockRemainingSec / 60);
    const lockSecs = lockRemainingSec % 60;
    const cooldownSec = Math.max(0, Math.ceil((otpCooldownEndsAtMs - nowMs) / 1000));

    return (
      <AppShell>
        <div className="p-4 md:p-6 lg:p-8 max-w-md mx-auto">
          <div className="bg-card border border-border rounded-2xl p-6 space-y-5 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center shrink-0">
                  {pinMode === "pin" ? <Lock className="w-5 h-5" /> : <MessageSquareCode className="w-5 h-5" />}
                </div>
                <div>
                  <h1 className="text-lg font-bold">
                    {pinMode === "pin" ? "Profile Protected by PIN" : "Recover Profile PIN"}
                  </h1>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pinMode === "pin"
                      ? "Enter your 4-digit PIN to view or edit Restaurant Profile."
                      : "Reset your Profile PIN with a 6-digit Bitebend Messaging OTP."}
                  </p>
                </div>
              </div>
            </div>

            {pinNotice && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs">
                {pinNotice}
              </div>
            )}

            {isLockedOut && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-bold text-red-800">
                  <Clock className="w-4 h-4 shrink-0" />
                  <span>
                    PIN temporarily locked ({String(lockMins).padStart(2, "0")}:{String(lockSecs).padStart(2, "0")} remaining)
                  </span>
                </div>
                <p className="text-xs text-red-700">
                  Too many incorrect attempts. Wait for the cooldown or reset using Forgot PIN via Bitebend Messaging.
                </p>
              </div>
            )}

            {pinMode === "pin" ? (
              <form onSubmit={handleVerifyPin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>4-Digit Profile PIN</Label>
                  <div className="relative">
                    <Input
                      type={showPinDigits ? "text" : "password"}
                      inputMode="numeric"
                      maxLength={4}
                      disabled={isLockedOut}
                      value={pinInput}
                      onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      placeholder="••••"
                      className="pr-10 font-mono tracking-[0.35em] text-center text-lg"
                      autoFocus
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPinDigits((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPinDigits ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {pinError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">
                    {pinError}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white h-11"
                  disabled={pinSubmitting || isLockedOut}
                >
                  {pinSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <LockOpen className="w-4 h-4 mr-2" />}
                  Unlock Profile
                </Button>

                <div className="pt-1 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setPinError("");
                      setPinMode("forgot");
                    }}
                    className="text-xs font-medium text-orange-600 hover:text-orange-700 underline"
                  >
                    Forgot Profile PIN? Recover via Bitebend Messaging OTP
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                {!pinStatus.recoveryEligible ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2 text-xs text-amber-900">
                    <div className="flex items-center gap-2 font-bold">
                      <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>Verified Owner Phone Required</span>
                    </div>
                    <p className="leading-relaxed">
                      {pinStatus.recoveryIneligibleReason ||
                        "OTP recovery requires a verified owner mobile number. Please contact Bitebend Support to rebind your recovery phone or reset your Profile PIN."}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="bg-muted/50 border border-border rounded-xl p-3.5 space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Recovery Messaging Phone:</span>
                        <span className="font-mono font-bold">
                          {otpRequestedPhone ?? pinStatus.maskedRecoveryPhone}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full h-9 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                        disabled={otpSending || cooldownSec > 0}
                        onClick={handleRequestForgotOtp}
                      >
                        {otpSending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                        ) : (
                          <Smartphone className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        {cooldownSec > 0
                          ? `Resend OTP in ${cooldownSec}s`
                          : otpChallengeId
                            ? "Resend 6-Digit OTP"
                            : "Send 6-Digit OTP to Bitebend Messaging"}
                      </Button>
                    </div>

                    {otpDeliveryInfo && (
                      <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 text-xs leading-relaxed">
                        {otpDeliveryInfo}
                      </div>
                    )}

                    <form onSubmit={handleResetWithOtp} className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>6-Digit Recovery OTP</Label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          placeholder="000000"
                          className="font-mono tracking-[0.35em] text-center text-base"
                          required
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>New 4-Digit PIN</Label>
                          <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={4}
                            value={resetNewPin}
                            onChange={(e) => setResetNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                            placeholder="••••"
                            className="font-mono tracking-[0.3em] text-center"
                            required
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Confirm PIN</Label>
                          <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={4}
                            value={resetConfirmPin}
                            onChange={(e) => setResetConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                            placeholder="••••"
                            className="font-mono tracking-[0.3em] text-center"
                            required
                          />
                        </div>
                      </div>

                      {pinError && (
                        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">
                          {pinError}
                        </div>
                      )}

                      <Button
                        type="submit"
                        className="w-full bg-orange-500 hover:bg-orange-600 text-white h-11"
                        disabled={otpResetting}
                      >
                        {otpResetting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                        Verify OTP &amp; Set New PIN
                      </Button>
                    </form>
                  </>
                )}

                <div className="pt-1 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setPinError("");
                      setPinMode("pin");
                    }}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground underline"
                  >
                    Back to PIN Unlock
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-4 md:p-6 lg:p-8 max-w-2xl mx-auto">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Restaurant Profile</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Update your restaurant information and payment settings
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setShowChangePin((v) => !v);
                setChangePinError("");
              }}
            >
              <KeyRound className="w-3.5 h-3.5 mr-1.5" />
              Change PIN
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs border-orange-300 text-orange-700 hover:bg-orange-50"
              onClick={() => void handleLockProfileNow()}
            >
              <Lock className="w-3.5 h-3.5 mr-1.5" />
              Lock Profile
            </Button>
          </div>
        </div>

        {showChangePin && (
          <form
            onSubmit={handleChangePinSubmit}
            className="mb-6 bg-card border border-orange-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-sm flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-orange-500" />
                  Change 4-Digit Profile PIN
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Changing your PIN immediately revokes any active unlock sessions across other devices.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Current PIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={changePinForm.currentPin}
                  onChange={(e) =>
                    setChangePinForm((f) => ({ ...f, currentPin: e.target.value.replace(/\D/g, "").slice(0, 4) }))
                  }
                  placeholder="••••"
                  className="font-mono tracking-[0.3em] text-center"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>New PIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={changePinForm.newPin}
                  onChange={(e) =>
                    setChangePinForm((f) => ({ ...f, newPin: e.target.value.replace(/\D/g, "").slice(0, 4) }))
                  }
                  placeholder="••••"
                  className="font-mono tracking-[0.3em] text-center"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Confirm New PIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={changePinForm.confirmPin}
                  onChange={(e) =>
                    setChangePinForm((f) => ({ ...f, confirmPin: e.target.value.replace(/\D/g, "").slice(0, 4) }))
                  }
                  placeholder="••••"
                  className="font-mono tracking-[0.3em] text-center"
                  required
                />
              </div>
            </div>
            {changePinError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">
                {changePinError}
              </div>
            )}
            {changePinSaved && (
              <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-3 py-2 text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Profile PIN updated successfully.
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowChangePin(false)}>
                Close
              </Button>
              <Button
                type="submit"
                size="sm"
                className="bg-orange-500 hover:bg-orange-600 text-white"
                disabled={changePinSaving}
              >
                {changePinSaving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                Update Profile PIN
              </Button>
            </div>
          </form>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Basic Information</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1.5">
                <Label>Restaurant Name</Label>
                <Input value={form.name} onChange={set("name")} required />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Description</Label>
                <textarea
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                  value={form.description}
                  onChange={set("description")}
                  placeholder="Describe your restaurant..."
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cuisine Type</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={form.cuisineType}
                  onChange={set("cuisineType")}
                >
                  {CUISINE_TYPES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input type="tel" value={form.phone} onChange={set("phone")} required />
              </div>
              <div className="space-y-1.5">
                <Label>Restaurant Contact Email</Label>
                <Input
                  type="email"
                  value={user?.email ?? form.email}
                  readOnly
                  className="bg-muted/50 cursor-default"
                />
                <p className="text-xs text-muted-foreground">
                  This is your account login email. To change it, use the <strong>Login Credentials</strong> section below.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={form.city} onChange={set("city")} required />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Address <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Input value={form.address} onChange={set("address")} placeholder="Street, area, landmark…" />
              </div>

              {/* Restaurant Location & Locality */}
              <div className="col-span-2 pt-1">
                <RestaurantLocationSection
                  locality={form.locality}
                  latitude={form.latitude}
                  longitude={form.longitude}
                  onLocalityChange={(loc) => setForm((f) => ({ ...f, locality: loc }))}
                  onCoordinatesChange={({ latitude, longitude }) => setForm((f) => ({ ...f, latitude, longitude }))}
                  isSaved={Boolean(restaurant?.latitude && restaurant?.longitude && form.latitude === restaurant.latitude && form.longitude === restaurant.longitude)}
                />
              </div>
            </div>
          </div>

          {/* Payment & Communication */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div>
              <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Payment & Communication</h2>
              <p className="text-xs text-muted-foreground mt-0.5">UPI, WhatsApp billing, and online payment gateway</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>WhatsApp Number</Label>
                <Input value={form.whatsappNumber} onChange={set("whatsappNumber")} placeholder="919876543210" />
                <p className="text-xs text-muted-foreground">Bills sent to customer or this number</p>
              </div>
              <div className="space-y-1.5">
                <Label>Tax Percentage (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="30"
                  value={form.taxPercent}
                  onChange={set("taxPercent")}
                  placeholder="5"
                />
                <p className="text-xs text-muted-foreground">Applied to all orders (GST etc.)</p>
              </div>
            </div>

            {/* Payment QR */}
            <div className="border-t border-border pt-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ScanLine className="w-4 h-4 text-amber-500" />
                    <p className="text-sm font-semibold">Payment QR</p>
                    {form.paymentQrEnabled && form.qrExtractedUpiId && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Upload your PhonePe / GPay / Paytm / BharatPe QR to verify your UPI — customers pay via their payment app at checkout
                  </p>
                </div>
                <Switch
                  checked={form.paymentQrEnabled}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, paymentQrEnabled: v }))}
                  className="shrink-0 mt-0.5"
                />
              </div>

              {/* Persistent QR image preview */}
              {form.qrImageData && (
                <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-lg p-3">
                  <img
                    src={resolveImageUrl(form.qrImageData)!}
                    alt="Payment QR"
                    className="w-28 h-28 object-contain rounded border border-green-200 bg-white shrink-0"
                  />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                      <p className="text-xs font-semibold text-green-700">QR Preview</p>
                    </div>
                    {form.qrExtractedUpiId ? (
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="w-3 h-3 text-green-600 shrink-0" />
                        <p className="text-xs text-green-700 font-medium">Payment source: QR verified</p>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-600">UPI not extracted — enter manually in Advanced settings</p>
                    )}
                    {(form.qrMerchantName || form.name) && (
                      <p className="text-xs text-green-700">
                        Merchant: <span className="font-medium">{form.qrMerchantName || form.name}</span>
                      </p>
                    )}
                    <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                      <button
                        type="button"
                        className="text-[11px] text-amber-600 hover:text-amber-800 underline"
                        onClick={() => qrFileInputRef.current?.click()}
                      >
                        Replace QR
                      </button>
                      <span className="text-muted-foreground text-[10px]">·</span>
                      <button
                        type="button"
                        className="text-[11px] text-red-500 hover:text-red-700 underline"
                        onClick={() => {
                          setForm((f) => ({ ...f, qrImageData: null, qrDecodedPayload: null, qrMerchantName: "", qrExtractedUpiId: "" }));
                          setQrStatus("idle");
                          setQrExtracted(null);
                        }}
                      >
                        Remove QR
                      </button>
                      {form.qrExtractedUpiId && (
                        <>
                          <span className="text-muted-foreground text-[10px]">·</span>
                          <button
                            type="button"
                            className="text-[11px] text-blue-600 hover:text-blue-800 underline"
                            onClick={() => {
                              const name = form.qrMerchantName || form.name || "Test";
                              window.location.href = buildTestUpiLink(form.qrExtractedUpiId, name);
                            }}
                          >
                            Test ₹1
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Upload zone */}
              <div
                className="border border-dashed border-amber-300 rounded-lg p-3 space-y-2 cursor-pointer hover:bg-amber-50/60 transition-colors"
                onClick={() => qrFileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file) handleQrUpload(file);
                }}
              >
                <div className="flex items-center gap-2">
                  <ScanLine className="w-4 h-4 text-amber-500 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-amber-800">
                      {form.qrImageData ? "Replace QR image" : "Upload Payment QR"}
                    </p>
                    <p className="text-[11px] text-amber-600">
                      Drag & drop or click — PhonePe, GPay, Paytm, BharatPe all supported
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ml-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors"
                    onClick={(e) => { e.stopPropagation(); qrFileInputRef.current?.click(); }}
                  >
                    <Upload className="w-3 h-3" />
                    {form.qrImageData ? "Replace" : "Choose image"}
                  </button>
                </div>

                {qrStatus === "scanning" && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 py-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Processing QR image…
                  </div>
                )}
                {qrStatus === "success" && qrMessage && (
                  <p className="text-xs text-amber-700">{qrMessage}</p>
                )}
                {qrStatus === "error" && (
                  <p className="text-xs text-red-600">{qrMessage}</p>
                )}

                <input
                  ref={qrFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleQrUpload(file);
                    e.target.value = "";
                  }}
                />
              </div>

              {/* Advanced settings: UPI ID for deep-link fallback */}
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAdvancedUpi((v) => !v)}
              >
                <span style={{ fontSize: "10px" }}>{showAdvancedUpi ? "▾" : "▸"}</span>
                Advanced settings (UPI ID, deep-link fallback)
              </button>

              {showAdvancedUpi && (
                <div className="space-y-3 pl-3 border-l-2 border-border">
                  <p className="text-[11px] text-muted-foreground">
                    Optional: manually enter a UPI ID as a fallback for customers using legacy payment methods.
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium">Deep-link fallback</p>
                      <p className="text-[11px] text-muted-foreground">Show "Open in payment app" alongside QR</p>
                    </div>
                    <Switch
                      checked={form.personalUpiEnabled}
                      onCheckedChange={(v) => setForm((f) => ({ ...f, personalUpiEnabled: v }))}
                      className="shrink-0"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>UPI ID</Label>
                      <Input
                        value={form.upiId}
                        onChange={set("upiId")}
                        placeholder="restaurant@okaxis"
                      />
                      <p className="text-xs text-muted-foreground">e.g. name@okaxis, number@paytm</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Merchant Name <span className="text-muted-foreground font-normal text-xs">(shown in UPI app)</span></Label>
                      <Input
                        value={form.upiName}
                        onChange={set("upiName")}
                        placeholder={form.name || "Your Restaurant Name"}
                      />
                      <p className="text-xs text-muted-foreground">Defaults to restaurant name if blank</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Status cards */}
              {form.paymentQrEnabled && !form.qrImageData && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <p className="text-xs text-amber-700">
                    Upload a payment QR above — customers will scan it at checkout.
                  </p>
                </div>
              )}

              {form.paymentQrEnabled && form.qrExtractedUpiId && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-xs font-semibold text-green-700">QR Payment is active</p>
                  <p className="text-xs text-green-600">
                    Customers tap "Pay via UPI" at checkout — your payment app opens directly with the amount pre-filled.
                  </p>
                </div>
              )}

              {!form.paymentQrEnabled && form.personalUpiEnabled && form.upiId && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-xs text-amber-700 font-semibold">UPI deep-link active (no QR)</p>
                  <p className="text-xs text-amber-600">
                    Enable and upload a QR above for a more reliable payment experience.
                  </p>
                </div>
              )}
            </div>

          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">{error}</div>
          )}

          <Button
            type="submit"
            className="w-full bg-orange-500 hover:bg-orange-600 text-white h-11"
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : saved ? (
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-300" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {saved ? "Saved!" : "Save Changes"}
          </Button>
        </form>

        {/* Login Credentials */}
        <div className="mt-8">
          <div className="mb-4">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-muted-foreground" />
              Login Credentials
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Change your sign-in email or password. Current password is always required.
            </p>
          </div>

          <form onSubmit={handleCredSubmit} className="bg-card border border-border rounded-xl p-5 space-y-4">
            {/* Account login email display */}
            <div className="bg-muted/50 rounded-lg px-3 py-2.5 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Account Login Email:</span>
                <span className="text-sm font-mono font-medium">{user?.email}</span>
              </div>
              <p className="text-xs text-muted-foreground">Use this email when signing in.</p>
            </div>

            {/* Current password */}
            <div className="space-y-1.5">
              <Label>Current Password <span className="text-red-500">*</span></Label>
              <div className="relative">
                <Input
                  type={showCredPasswords.current ? "text" : "password"}
                  value={credForm.currentPassword}
                  onChange={setCred("currentPassword")}
                  placeholder="Your current password"
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowCredPasswords((v) => ({ ...v, current: !v.current }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showCredPasswords.current ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="border-t border-border pt-4 grid grid-cols-1 gap-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Change email</p>
              <div className="space-y-1.5">
                <Label>New Login Email</Label>
                <Input
                  type="email"
                  value={credForm.newEmail}
                  onChange={setCred("newEmail")}
                  placeholder="new@email.com"
                />
                <p className="text-xs text-muted-foreground">Leave blank to keep your current email</p>
              </div>
            </div>

            <div className="border-t border-border pt-4 grid grid-cols-1 gap-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Change password</p>
              <div className="space-y-1.5">
                <Label>New Password</Label>
                <div className="relative">
                  <Input
                    type={showCredPasswords.new ? "text" : "password"}
                    value={credForm.newPassword}
                    onChange={setCred("newPassword")}
                    placeholder="Min 6 characters"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCredPasswords((v) => ({ ...v, new: !v.new }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showCredPasswords.new ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Confirm New Password</Label>
                <div className="relative">
                  <Input
                    type={showCredPasswords.confirm ? "text" : "password"}
                    value={credForm.confirmPassword}
                    onChange={setCred("confirmPassword")}
                    placeholder="Repeat new password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCredPasswords((v) => ({ ...v, confirm: !v.confirm }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showCredPasswords.confirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">Leave both password fields blank to keep your current password</p>
              </div>
            </div>

            {credError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">{credError}</div>
            )}
            {credSaved && (
              <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-2.5 text-sm flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> Credentials updated successfully
              </div>
            )}

            <Button
              type="submit"
              variant="outline"
              className="w-full h-11 border-orange-300 text-orange-700 hover:bg-orange-50"
              disabled={credSaving || !credForm.currentPassword}
            >
              {credSaving ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <KeyRound className="w-4 h-4 mr-2" />
              )}
              Update Login Credentials
            </Button>
          </form>
        </div>

        {restaurant && (
          <div className="mt-4 text-center">
            <p className="text-xs text-muted-foreground">
              Restaurant slug: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{restaurant.slug}</code>
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
