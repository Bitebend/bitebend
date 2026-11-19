import type { Request, Response } from "express";

export const COOKIE_NAMES = {
  SESSION_PROD: "__Host-bb_chat_sess",
  SESSION_DEV: "bb_chat_sess",
  DRAFT_PROD: "__Host-bb_chat_draft",
  DRAFT_DEV: "bb_chat_draft",
  LINK_CLAIM_PROD: "__Host-bb_link_claim",
  LINK_CLAIM_DEV: "bb_link_claim",
  HANDOFF_PROD: "__Secure-bb_msg_handoff",
  HANDOFF_DEV: "bb_msg_handoff",
  HANDOFF_BIND_PROD: "__Host-bb_handoff_src",
  HANDOFF_BIND_DEV: "bb_handoff_src",
} as const;

export function parseRawCookies(cookieHeader: string | undefined): {
  values: Map<string, string>;
  duplicates: Set<string>;
} {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  if (!cookieHeader) return { values, duplicates };

  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const rawVal = part.slice(eqIdx + 1).trim();
    if (!name) continue;
    if (values.has(name)) {
      duplicates.add(name);
    } else {
      try {
        values.set(name, decodeURIComponent(rawVal));
      } catch {
        values.set(name, rawVal);
      }
    }
  }
  return { values, duplicates };
}

export function isHttpsRequest(req: Pick<Request, "secure" | "headers">): boolean {
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
  return Boolean((req as { secure?: boolean }).secure) || xfProto === "https";
}

export function getHostname(req: Pick<Request, "headers">): string {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return host.split(",")[0].trim().split(":")[0].toLowerCase();
}

export function hasDuplicateCookie(
  duplicates: Set<string>,
  names: string[],
): boolean {
  return names.some((n) => duplicates.has(n));
}

export function pickCookieValue(
  values: Map<string, string>,
  prodName: string,
  devName: string,
): string | null {
  return values.get(prodName) ?? values.get(devName) ?? null;
}

export function setHostCookie(
  req: Request,
  res: Response,
  prodName: string,
  devName: string,
  value: string,
  maxAgeMs: number,
): void {
  const https = isHttpsRequest(req);
  const name = https ? prodName : devName;
  // __Host- cookies MUST NEVER set Domain, always Path=/, Secure=true
  res.cookie(name, value, {
    httpOnly: true,
    secure: https,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeMs,
  });
}

export function clearHostCookie(
  res: Response,
  prodName: string,
  devName: string,
): void {
  res.clearCookie(prodName, { path: "/" });
  res.clearCookie(devName, { path: "/" });
}

export function clearHandoffSourceCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const hostname = getHostname(req);
  const useParentDomain = https && (hostname === "bitebend.in" || hostname.endsWith(".bitebend.in"));

  res.clearCookie(COOKIE_NAMES.HANDOFF_PROD, {
    path: "/",
    ...(useParentDomain ? { domain: ".bitebend.in" } : {}),
  });
  res.clearCookie(COOKIE_NAMES.HANDOFF_DEV, {
    path: "/",
    ...(useParentDomain ? { domain: ".bitebend.in" } : {}),
  });
}
