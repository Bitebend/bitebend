export function isAllowedChatOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) {
    return true;
  }

  const extraOrigins = (process.env["CHAT_APP_ORIGIN"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedOrigins = new Set<string>([
    "https://chat.bitebend.in",
    "https://chat-api.bitebend.in",
    "https://bitebend.in",
    "https://www.bitebend.in",
    ...extraOrigins,
  ]);

  try {
    const parsed = new URL(originHeader);
    const normalized = `${parsed.protocol}//${parsed.host}`;
    if (allowedOrigins.has(normalized)) {
      return true;
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname.endsWith(".run.app") ||
        parsed.hostname.endsWith(".up.railway.app") ||
        parsed.hostname.endsWith(".netlify.app"))
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
