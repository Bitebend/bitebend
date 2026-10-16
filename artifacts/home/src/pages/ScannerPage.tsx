import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  QrCode,
  ArrowLeft,
  Camera,
  Sparkles,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ScanLine,
  ShieldAlert,
  Loader2,
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
  mutedBg: "#f5f0eb",
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
      setErrorMessage("Camera access is not supported by your current browser. You can still enter your restaurant code manually below.");
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
    <div style={{ minHeight: "100dvh", backgroundColor: C.bg }}>
      {/* Hidden processing canvas for jsQR analysis */}
      <canvas ref={canvasRef} style={{ display: "none" }} aria-hidden="true" />

      {/* Embedded CSS for the scanner laser animation */}
      <style>{`
        @keyframes bb-scan-sweep {
          0% { top: 8%; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { top: 92%; opacity: 0; }
        }
        .bb-laser-beam {
          animation: bb-scan-sweep 2.2s ease-in-out infinite;
        }
      `}</style>

      <BitebendHeader showBack={true} backTo="/" showScanner={false} title="QR Scanner" />

      <main
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "32px 16px 64px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        {/* Title Section */}
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "26px",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: C.ink,
            }}
          >
            Universal QR Scanner
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.5,
              color: C.muted,
            }}
          >
            Scan any physical Bitebend table or counter QR code to instantly launch the digital menu.
          </p>
        </section>

        {/* Viewfinder Shell */}
        <section
          style={{
            backgroundColor: "#0d0907",
            borderRadius: "24px",
            padding: "24px 20px 28px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "20px",
            position: "relative",
            overflow: "hidden",
            boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
            minHeight: "360px",
          }}
        >
          {/* Main Camera Viewport Frame */}
          <div
            style={{
              width: "100%",
              maxWidth: "320px",
              height: "280px",
              borderRadius: "20px",
              position: "relative",
              overflow: "hidden",
              backgroundColor: "#17120e",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Live Video Preview */}
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: cameraState === "active" ? "block" : "none",
              }}
            />

            {/* Viewfinder Overlay: Active Scanning State */}
            {cameraState === "active" && (
              <div
                style={{
                  position: "absolute",
                  inset: "16px",
                  borderRadius: "16px",
                  border: `2px dashed rgba(234, 88, 12, 0.6)`,
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {/* 4 Corner Markers */}
                <div
                  style={{
                    position: "absolute",
                    top: "-2px",
                    left: "-2px",
                    width: "24px",
                    height: "24px",
                    borderTop: `4px solid ${C.orange}`,
                    borderLeft: `4px solid ${C.orange}`,
                    borderTopLeftRadius: "12px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "-2px",
                    right: "-2px",
                    width: "24px",
                    height: "24px",
                    borderTop: `4px solid ${C.orange}`,
                    borderRight: `4px solid ${C.orange}`,
                    borderTopRightRadius: "12px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: "-2px",
                    left: "-2px",
                    width: "24px",
                    height: "24px",
                    borderBottom: `4px solid ${C.orange}`,
                    borderLeft: `4px solid ${C.orange}`,
                    borderBottomLeftRadius: "12px",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: "-2px",
                    right: "-2px",
                    width: "24px",
                    height: "24px",
                    borderBottom: `4px solid ${C.orange}`,
                    borderRight: `4px solid ${C.orange}`,
                    borderBottomRightRadius: "12px",
                  }}
                />

                {/* Sweeping Laser Beam */}
                <div
                  className="bb-laser-beam"
                  style={{
                    position: "absolute",
                    left: "8px",
                    right: "8px",
                    height: "2px",
                    backgroundColor: C.orange,
                    boxShadow: `0 0 10px 2px ${C.orange}, 0 0 20px 4px rgba(234, 88, 12, 0.4)`,
                  }}
                />
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
                  gap: "12px",
                  color: "#ffffff",
                  padding: "20px",
                  textAlign: "center",
                }}
              >
                <Loader2 style={{ width: "36px", height: "36px", color: C.orange }} className="animate-spin" />
                <div style={{ fontSize: "14px", fontWeight: 700 }}>Starting camera...</div>
                <div style={{ fontSize: "12px", color: "#9ca3af", maxWidth: "220px", lineHeight: 1.4 }}>
                  Please allow camera access when prompted by your browser
                </div>
              </div>
            )}

            {/* State: QR Detected Card inside Viewfinder */}
            {cameraState === "detected" && detectedResult && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  backgroundColor: "rgba(13, 9, 7, 0.94)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "20px",
                  gap: "14px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    backgroundColor: C.emeraldBg,
                    border: "1px solid #a7f3d0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <CheckCircle2 style={{ width: "26px", height: "26px", color: C.emerald }} />
                </div>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 800, color: "#ffffff" }}>
                    QR Code Detected!
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#9ca3af",
                      marginTop: "4px",
                      wordBreak: "break-all",
                      maxHeight: "36px",
                      overflow: "hidden",
                    }}
                  >
                    {detectedResult.url.replace(/^https?:\/\//, "")}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", width: "100%", maxWidth: "240px", marginTop: "4px" }}>
                  <button
                    onClick={handleOpenDetected}
                    style={{
                      flex: 1,
                      height: "40px",
                      borderRadius: "10px",
                      backgroundColor: C.orange,
                      color: "#ffffff",
                      border: "none",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                    }}
                  >
                    <span>Open</span>
                    <ExternalLink style={{ width: "14px", height: "14px" }} />
                  </button>
                  <button
                    onClick={handleScanAgain}
                    style={{
                      height: "40px",
                      padding: "0 12px",
                      borderRadius: "10px",
                      backgroundColor: "rgba(255,255,255,0.12)",
                      color: "#ffffff",
                      border: "none",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                    }}
                  >
                    <RefreshCw style={{ width: "13px", height: "13px" }} />
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
                  gap: "10px",
                  color: "#ffffff",
                  padding: "20px",
                  textAlign: "center",
                }}
              >
                <ShieldAlert style={{ width: "36px", height: "36px", color: "#f87171" }} />
                <div style={{ fontSize: "14px", fontWeight: 700 }}>Camera access is blocked</div>
                <div style={{ fontSize: "12px", color: "#9ca3af", maxWidth: "240px", lineHeight: 1.4 }}>
                  Please enable camera permission in your browser settings and try again.
                </div>
                <button
                  onClick={() => void startCamera()}
                  style={{
                    marginTop: "6px",
                    padding: "8px 16px",
                    borderRadius: "10px",
                    backgroundColor: C.orange,
                    color: "#ffffff",
                    border: "none",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <RefreshCw style={{ width: "13px", height: "13px" }} />
                  <span>Try Again</span>
                </button>
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
                  gap: "10px",
                  color: "#ffffff",
                  padding: "20px",
                  textAlign: "center",
                }}
              >
                <AlertCircle style={{ width: "36px", height: "36px", color: "#fbbf24" }} />
                <div style={{ fontSize: "14px", fontWeight: 700 }}>
                  {cameraState === "unsupported" ? "Camera Not Supported" : "Camera Error"}
                </div>
                <div style={{ fontSize: "12px", color: "#9ca3af", maxWidth: "240px", lineHeight: 1.4 }}>
                  {errorMessage || "Camera could not be started on this device."}
                </div>
                <button
                  onClick={() => void startCamera()}
                  style={{
                    marginTop: "6px",
                    padding: "8px 16px",
                    borderRadius: "10px",
                    backgroundColor: "rgba(255,255,255,0.15)",
                    color: "#ffffff",
                    border: "none",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <RefreshCw style={{ width: "13px", height: "13px" }} />
                  <span>Retry</span>
                </button>
              </div>
            )}
          </div>

          {/* Viewfinder Subtext Instruction */}
          <div style={{ color: "#d1d5db", fontSize: "13px", textAlign: "center", maxWidth: "300px" }}>
            {cameraState === "active" && "Point your camera at a Bitebend QR code to automatically detect and open the menu."}
            {cameraState === "initializing" && "Initializing camera access..."}
            {cameraState === "detected" && "QR code captured successfully!"}
            {cameraState === "permission_denied" && "Camera permission is required for live QR detection."}
            {(cameraState === "error" || cameraState === "unsupported") && "You can still open any menu by typing the code below."}
          </div>
        </section>

        {/* Quick Test Demo QRs */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Sparkles style={{ width: "18px", height: "18px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Quick Demo QRs
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px" }}>
            <button
              onClick={() => handleLaunchCode("the-grand-bistro")}
              style={{
                padding: "14px 16px",
                borderRadius: "12px",
                backgroundColor: C.bg,
                border: `1px solid ${C.border}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                cursor: "pointer",
              }}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: "14px", fontWeight: 700, color: C.ink }}>
                  The Grand Bistro — Table #4
                </div>
                <div style={{ fontSize: "12px", color: C.muted, marginTop: "2px" }}>
                  menu.bitebend.in/the-grand-bistro/table/4
                </div>
              </div>
              <ExternalLink style={{ width: "16px", height: "16px", color: C.orange }} />
            </button>
          </div>
        </section>

        {/* Manual Code Input */}
        <section
          style={{
            backgroundColor: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: "20px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <QrCode style={{ width: "18px", height: "18px", color: C.orange }} />
            <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C.ink }}>
              Manual Code Entry
            </h2>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLaunchCode(manualCode);
            }}
            style={{ display: "flex", gap: "10px" }}
          >
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="e.g. the-grand-bistro or table-id"
              style={{
                flex: 1,
                height: "44px",
                borderRadius: "12px",
                border: `1px solid ${C.border}`,
                padding: "0 14px",
                fontSize: "14px",
                outline: "none",
                backgroundColor: C.bg,
              }}
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              style={{
                height: "44px",
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
              <ArrowRight style={{ width: "14px", height: "14px" }} />
            </button>
          </form>
        </section>

        {/* Back Button */}
        <div style={{ textAlign: "center" }}>
          <button
            onClick={() => {
              stopCameraTracks();
              navigate("/");
            }}
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <ArrowLeft style={{ width: "16px", height: "16px" }} />
            <span>Return to Bitebend Home</span>
          </button>
        </div>
      </main>
    </div>
  );
}
