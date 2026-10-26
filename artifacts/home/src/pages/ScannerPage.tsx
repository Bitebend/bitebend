import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  QrCode,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
  Loader2,
  Keyboard,
  X,
} from "lucide-react";
import jsQR from "jsqr";
import { BitebendHeader } from "@/components/navigation/BitebendHeader";

const C = {
  bg: "#faf9f6",
  card: "#ffffff",
  border: "#ede8e3",
  ink: "#1a0a00",
  muted: "#6b7280",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  emerald: "#059669",
  emeraldBg: "#ecfdf5",
} as const;

type CameraState =
  | "initializing"
  | "active"
  | "detected"
  | "permission_denied"
  | "unsupported"
  | "error";

interface DetectedPayload {
  raw: string;
  url: string;
}

/**
 * Resolves any QR payload into a valid navigation destination.
 * Preserves Bitebend canonical URL structure (menu.bitebend.in) while
 * allowing full absolute URLs or raw restaurant slugs.
 */
function resolveQrDestination(rawCode: string): string {
  const clean = rawCode.trim();
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    return clean;
  }
  // Strip leading slash if user scanned a path like /the-grand-bistro
  const normalized = clean.replace(/^\/+/, "");
  return `https://menu.bitebend.in/${normalized}`;
}

export default function ScannerPage() {
  const [, navigate] = useLocation();
  const [manualCode, setManualCode] = useState("");
  const [showManualInput, setShowManualInput] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("initializing");
  const [errorMessage, setErrorMessage] = useState("");
  const [detectedResult, setDetectedResult] = useState<DetectedPayload | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const isScanningPausedRef = useRef<boolean>(false);

  // Stop active video tracks to release camera hardware
  const stopCameraTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Handle successful QR detection
  const handleQrDetected = useCallback(
    (raw: string) => {
      isScanningPausedRef.current = true;
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }

      // Haptic feedback if supported by device
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try {
          navigator.vibrate(80);
        } catch {
          /* ignore */
        }
      }

      const destUrl = resolveQrDestination(raw);
      setDetectedResult({ raw, url: destUrl });
      setCameraState("detected");

      // Stop camera hardware after capture
      stopCameraTracks();
    },
    [stopCameraTracks],
  );

  // Core scanning frame-loop
  const startScanningLoop = useCallback(() => {
    const scanFrame = () => {
      if (!isMountedRef.current || isScanningPausedRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });

          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const qr = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "dontInvert",
              });

              if (qr && qr.data && qr.data.trim()) {
                handleQrDetected(qr.data);
                return; // Stop animation loop once code is captured
              }
            } catch {
              /* Ignore temporary canvas read glitches */
            }
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(scanFrame);
    };

    animFrameRef.current = requestAnimationFrame(scanFrame);
  }, [handleQrDetected]);

  // Request camera and initialize video stream
  const startCamera = useCallback(async () => {
    if (!isMountedRef.current) return;

    // Check secure context and API availability
    if (typeof window !== "undefined" && window.isSecureContext === false && window.location.hostname !== "localhost") {
      setCameraState("unsupported");
      setErrorMessage("Camera access requires a secure connection (HTTPS). Please open this site over HTTPS.");
      return;
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      setErrorMessage("Camera access is not supported by your current browser. You can enter your restaurant code manually below.");
      return;
    }

    // Cancel any existing loop & tracks
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    stopCameraTracks();

    setCameraState("initializing");
    setErrorMessage("");
    setDetectedResult(null);
    isScanningPausedRef.current = false;

    let mediaStream: MediaStream;

    // Strategy 1: Prefer environment (rear) camera on mobile
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch {
      // Strategy 2: Graceful fallback to any available camera (desktop webcam, front cam, etc.)
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        const e = err as { name?: string; message?: string };
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
          setCameraState("permission_denied");
          setErrorMessage("Camera access is blocked. Please allow camera permission in your browser or device settings and try again.");
        } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
          setCameraState("error");
          setErrorMessage("No camera device was detected on your system.");
        } else if (e.name === "NotReadableError" || e.name === "TrackStartError") {
          setCameraState("error");
          setErrorMessage("Your camera is currently in use by another app or tab. Please close other camera apps and retry.");
        } else {
          setCameraState("error");
          setErrorMessage("Camera could not be started. Please check your camera permissions and try again.");
        }
        return;
      }
    }

    // If user navigated away while permission prompt was open, stop immediately
    if (!isMountedRef.current) {
      mediaStream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = mediaStream;

    if (videoRef.current) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.setAttribute("playsinline", "true"); // Critical for iOS Safari inline playback
      videoRef.current.setAttribute("autoplay", "true");
      videoRef.current.muted = true;

      try {
        await videoRef.current.play();
      } catch {
        /* play interrupted */
      }
    }

    if (isMountedRef.current) {
      setCameraState("active");
      startScanningLoop();
    }
  }, [startScanningLoop, stopCameraTracks]);

  // Lifecycle: Automatically start on mount, clean up on unmount
  useEffect(() => {
    isMountedRef.current = true;
    void startCamera();

    return () => {
      isMountedRef.current = false;
      isScanningPausedRef.current = true;
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      stopCameraTracks();
    };
  }, [startCamera, stopCameraTracks]);

  // Launch manual code or direct input
  const handleLaunchCode = (code: string) => {
    const clean = code.trim();
    if (!clean) return;
    const dest = resolveQrDestination(clean);
    stopCameraTracks();
    window.location.href = dest;
  };

  const handleOpenDetected = () => {
    if (!detectedResult) return;
    stopCameraTracks();
    window.location.href = detectedResult.url;
  };

  const handleScanAgain = () => {
    setDetectedResult(null);
    void startCamera();
  };

  return (
    <div
      style={{
        height: "100dvh",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#0d0907",
        overflow: "hidden",
      }}
    >
      {/* Hidden processing canvas for jsQR analysis */}
      <canvas ref={canvasRef} style={{ display: "none" }} aria-hidden="true" />

      {/* Embedded CSS for the scanner laser animation */}
      <style>{`
        @keyframes bb-scan-sweep {
          0% { top: 6%; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { top: 94%; opacity: 0; }
        }
        .bb-laser-beam {
          animation: bb-scan-sweep 2.2s ease-in-out infinite;
        }
      `}</style>

      {/* Header stays pinned at top with safe-area support */}
      <BitebendHeader showBack={true} backTo="/" showScanner={false} title="QR Scanner" />

      {/* Main Viewport Container: Edge-to-edge on mobile, max 640px centered on desktop */}
      <main
        style={{
          flex: 1,
          width: "100%",
          maxWidth: "640px",
          margin: "0 auto",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0d0907",
        }}
      >
        {/* Full-bleed Video Preview Container */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Live Video Feed */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: cameraState === "active" ? "block" : "none",
            }}
          />

          {/* Active Scanning Reticle with Dimmed Vignette Overlay */}
          {cameraState === "active" && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              {/* Responsive Reticle Box with 50% backdrop vignette shadow outside */}
              <div
                style={{
                  width: "min(72vw, min(290px, 38vh))",
                  height: "min(72vw, min(290px, 38vh))",
                  position: "relative",
                  borderRadius: "24px",
                  boxShadow: "0 0 0 9999px rgba(13, 9, 7, 0.52)",
                  border: "2px dashed rgba(234, 88, 12, 0.65)",
                }}
              >
                {/* 4 Corner Markers */}
                <div
                  style={{
                    position: "absolute",
                    top: "-2px",
                    left: "-2px",
                    width: "28px",
                    height: "28px",
                    borderTop: `4px solid ${C.orange}`,
                    borderLeft: `4px solid ${C.orange}`,
                    borderTopLeftRadius: "14px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "-2px",
                    right: "-2px",
                    width: "28px",
                    height: "28px",
                    borderTop: `4px solid ${C.orange}`,
                    borderRight: `4px solid ${C.orange}`,
                    borderTopRightRadius: "14px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: "-2px",
                    left: "-2px",
                    width: "28px",
                    height: "28px",
                    borderBottom: `4px solid ${C.orange}`,
                    borderLeft: `4px solid ${C.orange}`,
                    borderBottomLeftRadius: "14px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: "-2px",
                    right: "-2px",
                    width: "28px",
                    height: "28px",
                    borderBottom: `4px solid ${C.orange}`,
                    borderRight: `4px solid ${C.orange}`,
                    borderBottomRightRadius: "14px",
                  }}
                />

                {/* Sweeping Laser Beam */}
                <div
                  className="bb-laser-beam"
                  style={{
                    position: "absolute",
                    left: "10px",
                    right: "10px",
                    height: "2px",
                    backgroundColor: C.orange,
                    boxShadow: `0 0 12px 3px ${C.orange}, 0 0 24px 6px rgba(234, 88, 12, 0.45)`,
                  }}
                />
              </div>

              {/* Floating Instruction Pill directly below the reticle */}
              <div
                style={{
                  marginTop: "20px",
                  padding: "8px 16px",
                  borderRadius: "20px",
                  backgroundColor: "rgba(13, 9, 7, 0.75)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  textAlign: "center",
                  maxWidth: "85%",
                }}
              >
                Point camera at any Bitebend QR code
              </div>
            </div>
          )}

          {/* State: Initializing / Requesting Permission */}
          {cameraState === "initializing" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                color: "#ffffff",
                padding: "24px",
                textAlign: "center",
              }}
            >
              <Loader2 style={{ width: "42px", height: "42px", color: C.orange }} className="animate-spin" />
              <div style={{ fontSize: "16px", fontWeight: 700 }}>Starting camera...</div>
              <div style={{ fontSize: "13px", color: "#9ca3af", maxWidth: "260px", lineHeight: 1.4 }}>
                Please allow camera access when prompted by your browser
              </div>
            </div>
          )}

          {/* State: QR Detected Full-Screen Overlay Card */}
          {cameraState === "detected" && detectedResult && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "rgba(13, 9, 7, 0.95)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
                gap: "18px",
                textAlign: "center",
                zIndex: 30,
              }}
            >
              <div
                style={{
                  width: "60px",
                  height: "60px",
                  borderRadius: "50%",
                  backgroundColor: C.emeraldBg,
                  border: "2px solid #a7f3d0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CheckCircle2 style={{ width: "32px", height: "32px", color: C.emerald }} />
              </div>

              <div>
                <div style={{ fontSize: "20px", fontWeight: 800, color: "#ffffff", letterSpacing: "-0.02em" }}>
                  QR Code Detected!
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#d1d5db",
                    marginTop: "6px",
                    wordBreak: "break-all",
                    maxWidth: "340px",
                    padding: "8px 12px",
                    backgroundColor: "rgba(255, 255, 255, 0.08)",
                    borderRadius: "10px",
                    border: "1px solid rgba(255, 255, 255, 0.1)",
                  }}
                >
                  {detectedResult.url.replace(/^https?:\/\//, "")}
                </div>
              </div>

              <div style={{ display: "flex", gap: "10px", width: "100%", maxWidth: "280px", marginTop: "6px" }}>
                <button
                  onClick={handleOpenDetected}
                  style={{
                    flex: 1,
                    height: "46px",
                    borderRadius: "12px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "15px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    boxShadow: "0 2px 10px rgba(234, 88, 12, 0.35)",
                  }}
                >
                  <span>Open Menu</span>
                  <ExternalLink style={{ width: "16px", height: "16px" }} />
                </button>
                <button
                  onClick={handleScanAgain}
                  style={{
                    height: "46px",
                    padding: "0 16px",
                    borderRadius: "12px",
                    backgroundColor: "rgba(255, 255, 255, 0.12)",
                    color: "#ffffff",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                  }}
                >
                  <RefreshCw style={{ width: "14px", height: "14px" }} />
                  <span>Rescan</span>
                </button>
              </div>
            </div>
          )}

          {/* State: Permission Denied */}
          {cameraState === "permission_denied" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                color: "#ffffff",
                padding: "28px",
                textAlign: "center",
                zIndex: 25,
              }}
            >
              <ShieldAlert style={{ width: "46px", height: "46px", color: "#f87171" }} />
              <div style={{ fontSize: "17px", fontWeight: 700 }}>Camera access is blocked</div>
              <div style={{ fontSize: "13px", color: "#9ca3af", maxWidth: "280px", lineHeight: 1.5 }}>
                Please enable camera permission in your browser settings and try again.
              </div>
              <div style={{ display: "flex", gap: "10px", marginTop: "6px", flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  onClick={() => void startCamera()}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "12px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <RefreshCw style={{ width: "14px", height: "14px" }} />
                  <span>Try Again</span>
                </button>
                <button
                  onClick={() => setShowManualInput(true)}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "12px",
                    backgroundColor: "rgba(255, 255, 255, 0.12)",
                    color: "#ffffff",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <Keyboard style={{ width: "14px", height: "14px" }} />
                  <span>Enter Code</span>
                </button>
              </div>
            </div>
          )}

          {/* State: Unsupported or Error */}
          {(cameraState === "unsupported" || cameraState === "error") && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                color: "#ffffff",
                padding: "28px",
                textAlign: "center",
                zIndex: 25,
              }}
            >
              <AlertCircle style={{ width: "46px", height: "46px", color: "#fbbf24" }} />
              <div style={{ fontSize: "17px", fontWeight: 700 }}>
                {cameraState === "unsupported" ? "Camera Not Supported" : "Camera Error"}
              </div>
              <div style={{ fontSize: "13px", color: "#9ca3af", maxWidth: "280px", lineHeight: 1.5 }}>
                {errorMessage || "Camera could not be started on this device."}
              </div>
              <div style={{ display: "flex", gap: "10px", marginTop: "6px", flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  onClick={() => void startCamera()}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "12px",
                    backgroundColor: "rgba(255, 255, 255, 0.15)",
                    color: "#ffffff",
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <RefreshCw style={{ width: "14px", height: "14px" }} />
                  <span>Retry</span>
                </button>
                <button
                  onClick={() => setShowManualInput(true)}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "12px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <Keyboard style={{ width: "14px", height: "14px" }} />
                  <span>Enter Code Manually</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Docked Bottom Controls Bar */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "16px 20px",
            paddingBottom: "max(env(safe-area-inset-bottom, 16px), 20px)",
            background: "linear-gradient(to top, rgba(13, 9, 7, 0.9) 0%, rgba(13, 9, 7, 0.5) 60%, transparent 100%)",
          }}
        >
          {cameraState === "active" && (
            <button
              onClick={() => setShowManualInput(true)}
              style={{
                height: "38px",
                padding: "0 18px",
                borderRadius: "19px",
                backgroundColor: "rgba(255, 255, 255, 0.15)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                color: "#ffffff",
                border: "1px solid rgba(255, 255, 255, 0.25)",
                fontSize: "13px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
              }}
            >
              <Keyboard style={{ width: "15px", height: "15px" }} />
              <span>Enter code manually</span>
            </button>
          )}
        </div>

        {/* Expandable Manual Code Entry Bottom Sheet */}
        {showManualInput && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 50,
              backgroundColor: "rgba(0, 0, 0, 0.72)",
              backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            }}
            onClick={() => setShowManualInput(false)}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "520px",
                backgroundColor: C.card,
                borderTopLeftRadius: "24px",
                borderTopRightRadius: "24px",
                padding: "24px 20px",
                paddingBottom: "max(env(safe-area-inset-bottom, 20px), 24px)",
                boxShadow: "0 -8px 30px rgba(0, 0, 0, 0.35)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <QrCode style={{ width: "20px", height: "20px", color: C.orange }} />
                  <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: C.ink }}>
                    Manual Code Entry
                  </h2>
                </div>
                <button
                  onClick={() => setShowManualInput(false)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "4px",
                    cursor: "pointer",
                    color: C.muted,
                  }}
                  aria-label="Close"
                >
                  <X style={{ width: "20px", height: "20px" }} />
                </button>
              </div>

              <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: C.muted, lineHeight: 1.45 }}>
                Enter a restaurant code or slug (e.g. <code>the-grand-bistro</code>) to launch the digital menu.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLaunchCode(manualCode);
                }}
                style={{ display: "flex", gap: "8px" }}
              >
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="e.g. the-grand-bistro or table-id"
                  autoFocus
                  style={{
                    flex: 1,
                    height: "46px",
                    borderRadius: "12px",
                    border: `1px solid ${C.border}`,
                    padding: "0 14px",
                    fontSize: "14px",
                    outline: "none",
                    backgroundColor: C.bg,
                    color: C.ink,
                  }}
                />
                <button
                  type="submit"
                  disabled={!manualCode.trim()}
                  style={{
                    height: "46px",
                    padding: "0 18px",
                    borderRadius: "12px",
                    backgroundColor: manualCode.trim() ? C.orange : "#d1d5db",
                    color: "#ffffff",
                    border: "none",
                    fontSize: "14px",
                    fontWeight: 700,
                    cursor: manualCode.trim() ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span>Open</span>
                  <ArrowRight style={{ width: "15px", height: "15px" }} />
                </button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
