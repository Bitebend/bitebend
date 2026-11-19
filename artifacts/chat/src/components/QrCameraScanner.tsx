import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, AlertCircle } from "lucide-react";

interface Props {
  onScan: (payload: string) => void;
  onCancel: () => void;
}

export function QrCameraScanner({ onScan, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scannedRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId = 0;
    let active = true;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Camera access is not supported in this browser. Enter the 8-character code instead.");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const tick = () => {
          if (!active || scannedRef.current) return;
          const v = videoRef.current;
          const c = canvasRef.current;
          if (v && c && v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0, c.width, c.height);
              const imgData = ctx.getImageData(0, 0, c.width, c.height);
              const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: "dontInvert",
              });
              if (code?.data) {
                scannedRef.current = true;
                onScan(code.data);
                return;
              }
            }
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } catch (err) {
        setError(
          err instanceof Error
            ? "Camera permission denied or unavailable. Enter the 8-character code below."
            : "Unable to start camera.",
        );
      }
    }

    void startCamera();

    return () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [onScan]);

  return (
    <div className="rounded-xl border border-[#ede8e3] bg-[#faf9f6] p-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-[#fff7ed] border border-[#fed7aa] p-3 text-xs text-[#9a3412]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-lg bg-black aspect-square max-h-64 mx-auto">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <div className="pointer-events-none absolute inset-6 border-2 border-[#059669] rounded-xl opacity-80" />
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-center gap-1.5 rounded-md bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
            <Camera className="w-3.5 h-3.5 text-[#34d399]" />
            Point camera at QR code on your new device
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />
      <button
        type="button"
        onClick={onCancel}
        className="mt-2.5 w-full rounded-lg border border-[#ede8e3] bg-white py-2 text-xs font-semibold text-[#1a0a00] hover:bg-[#f5f0eb]"
      >
        Close Camera
      </button>
    </div>
  );
}
