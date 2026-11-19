import { useEffect, useRef, useState } from "react";
import { Download, FileLock2, Loader2, Eye } from "lucide-react";
import { decryptAttachmentBytes, type EncryptedAttachmentMeta } from "../crypto/attachments";
import { chatApi } from "../lib/api";

interface Props {
  attachment: EncryptedAttachmentMeta & { attachmentId: string };
  isOwn: boolean;
}

export function AttachmentMessageBubble({ attachment, isOwn }: Props) {
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const isImage = attachment.mimeType.startsWith("image/");

  const fetchAndDecrypt = async (): Promise<Blob> => {
    const encryptedBytes = await chatApi.downloadEncryptedAttachment(attachment.attachmentId);
    const plainBytes = await decryptAttachmentBytes(encryptedBytes, attachment);
    const ab = new ArrayBuffer(plainBytes.byteLength);
    new Uint8Array(ab).set(plainBytes);
    return new Blob([ab], { type: attachment.mimeType || "application/octet-stream" });
  };

  const handlePreviewOrDownload = async () => {
    setError(null);
    setLoading(true);
    try {
      const blob = await fetchAndDecrypt();
      if (isImage && !previewUrl) {
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setPreviewUrl(url);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = attachment.plaintextName || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      setError((err as Error).message || "Failed to decrypt attachment");
    } finally {
      setLoading(false);
    }
  };

  const sizeKb = Math.max(1, Math.round(attachment.originalSize / 1024));

  return (
    <div className="mt-1.5 space-y-2">
      {previewUrl && isImage && (
        <div className="overflow-hidden rounded-lg border border-black/10 bg-black/5">
          <img
            src={previewUrl}
            alt={attachment.plaintextName}
            className="max-h-60 w-full object-contain"
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => void handlePreviewOrDownload()}
        disabled={loading}
        className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold transition-colors ${
          isOwn
            ? "bg-white/15 text-white hover:bg-white/25"
            : "bg-[#faf9f6] border border-[#ede8e3] text-[#1a0a00] hover:bg-[#f5f0eb]"
        }`}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        ) : isImage && !previewUrl ? (
          <Eye className="w-4 h-4 shrink-0" />
        ) : (
          <Download className="w-4 h-4 shrink-0" />
        )}
        <div className="min-w-0 text-left">
          <div className="truncate max-w-[180px]">{attachment.plaintextName}</div>
          <div className={`text-[10px] ${isOwn ? "text-emerald-100" : "text-[#6b7280]"}`}>
            <FileLock2 className="inline w-3 h-3 mr-1" />
            E2EE · {sizeKb} KB
          </div>
        </div>
      </button>

      {error && (
        <div className={`text-[11px] ${isOwn ? "text-red-100" : "text-[#dc2626]"}`}>{error}</div>
      )}
    </div>
  );
}
