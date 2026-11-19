export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB ciphertext limit
const MAX_PLAINTEXT_BYTES = 14.9 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024; // 1 MB AES-GCM chunks

export interface EncryptedAttachmentMeta {
  v: 1;
  attachmentId?: string;
  keyBase64: string;
  ivPrefixBase64: string;
  chunkSize: number;
  originalSize: number;
  ciphertextSha256: string;
  plaintextSha256: string;
  plaintextName: string;
  mimeType: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildChunkIv(ivPrefix: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(ivPrefix.subarray(0, 8), 0);
  const view = new DataView(iv.buffer);
  view.setUint32(8, chunkIndex, false);
  return iv;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * Compresses large camera/gallery photos client-side before encryption so photos fit cleanly
 * inside the 15 MB ciphertext limit without consuming unnecessary mobile bandwidth.
 */
export async function prepareFileForEncryption(file: File): Promise<{
  bytes: Uint8Array;
  plaintextName: string;
  mimeType: string;
}> {
  if (
    typeof document !== "undefined" &&
    file.type.startsWith("image/") &&
    !file.type.includes("svg") &&
    !file.type.includes("gif") &&
    file.size > 1.2 * 1024 * 1024
  ) {
    try {
      const bitmap = await createImageBitmap(file);
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const targetW = Math.max(1, Math.round(bitmap.width * scale));
      const targetH = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        const compressedBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.84),
        );
        bitmap.close();
        if (compressedBlob && compressedBlob.size < file.size) {
          const buf = new Uint8Array(await compressedBlob.arrayBuffer());
          const safeName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          return { bytes: buf, plaintextName: safeName, mimeType: "image/jpeg" };
        }
      } else {
        bitmap.close();
      }
    } catch {
      // Fall back to raw file bytes if image decoding fails
    }
  }

  const rawBytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes: rawBytes,
    plaintextName: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
  };
}

export async function encryptAttachmentBytes(
  plaintextBytes: Uint8Array,
  plaintextName: string,
  mimeType: string,
): Promise<{
  encryptedBytes: Uint8Array;
  meta: EncryptedAttachmentMeta;
}> {
  if (plaintextBytes.byteLength === 0) {
    throw new Error("Cannot encrypt an empty file.");
  }
  if (plaintextBytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("File exceeds maximum 15 MB encrypted attachment limit.");
  }

  const plaintextSha256 = await sha256HexBytes(plaintextBytes);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const ivPrefix = crypto.getRandomValues(new Uint8Array(8));
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, ["encrypt"]);

  const chunks: Uint8Array[] = [];
  let totalEncryptedLen = 0;
  const numChunks = Math.ceil(plaintextBytes.byteLength / CHUNK_SIZE);

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(plaintextBytes.byteLength, start + CHUNK_SIZE);
    const slice = plaintextBytes.subarray(start, end);
    const iv = buildChunkIv(ivPrefix, i);
    const encryptedSlice = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, aesKey, toArrayBuffer(slice)),
    );
    chunks.push(encryptedSlice);
    totalEncryptedLen += encryptedSlice.byteLength;
  }

  if (totalEncryptedLen > MAX_ATTACHMENT_BYTES) {
    throw new Error("Encrypted file exceeds 15 MB limit.");
  }

  const encryptedBytes = new Uint8Array(totalEncryptedLen);
  let offset = 0;
  for (const c of chunks) {
    encryptedBytes.set(c, offset);
    offset += c.byteLength;
  }

  const ciphertextSha256 = await sha256HexBytes(encryptedBytes);

  return {
    encryptedBytes,
    meta: {
      v: 1,
      keyBase64: bytesToBase64(rawKey),
      ivPrefixBase64: bytesToBase64(ivPrefix),
      chunkSize: CHUNK_SIZE,
      originalSize: plaintextBytes.byteLength,
      ciphertextSha256,
      plaintextSha256,
      plaintextName,
      mimeType,
    },
  };
}

export async function decryptAttachmentBytes(
  encryptedBytes: Uint8Array,
  meta: EncryptedAttachmentMeta,
): Promise<Uint8Array> {
  const actualCipherSha = await sha256HexBytes(encryptedBytes);
  if (actualCipherSha !== meta.ciphertextSha256.toLowerCase()) {
    throw new Error("Encrypted attachment integrity check failed (ciphertext mismatch).");
  }

  const rawKey = base64ToBytes(meta.keyBase64);
  const ivPrefix = base64ToBytes(meta.ivPrefixBase64);
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, ["decrypt"]);

  const out = new Uint8Array(meta.originalSize);
  let cipherOffset = 0;
  let plainOffset = 0;
  let chunkIndex = 0;

  while (plainOffset < meta.originalSize) {
    const expectedPlainLen = Math.min(meta.chunkSize, meta.originalSize - plainOffset);
    const expectedCipherLen = expectedPlainLen + 16; // 128-bit GCM auth tag
    const cipherSlice = encryptedBytes.subarray(cipherOffset, cipherOffset + expectedCipherLen);
    if (cipherSlice.byteLength !== expectedCipherLen) {
      throw new Error("Truncated encrypted attachment stream.");
    }
    const iv = buildChunkIv(ivPrefix, chunkIndex);
    const plainChunk = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, aesKey, toArrayBuffer(cipherSlice)),
    );
    out.set(plainChunk, plainOffset);
    cipherOffset += expectedCipherLen;
    plainOffset += plainChunk.byteLength;
    chunkIndex += 1;
  }

  const actualPlainSha = await sha256HexBytes(out);
  if (actualPlainSha !== meta.plaintextSha256.toLowerCase()) {
    throw new Error("Decrypted file failed SHA-256 verification.");
  }

  return out;
}
