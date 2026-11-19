import type { ChatApiTransport } from "../crypto/e2eeClient";

export interface BootstrapResponse {
  state:
    | "AUTHENTICATED"
    | "AUTHENTICATED_WITH_PENDING_HANDOFF"
    | "HANDOFF_READY"
    | "DRAFT_PENDING"
    | "NO_HANDOFF"
    | "COOKIE_COLLISION";
  pendingHandoffDetected?: boolean;
  account?: {
    id: string;
    username: string;
    displayName: string;
    matrixUserId: string;
  };
  currentDevice?: {
    id: string;
    matrixDeviceId: string;
  };
  draft?: {
    id: string;
    restaurantId: number;
    maskedName: string;
    maskedPhone: string;
    expiresAt: string;
  };
  error?: string;
}

export interface ConversationItem {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  keyEpoch: number;
  nextSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  myRole: string;
  members: Array<{
    accountId: string;
    matrixUserId: string;
    username: string;
    displayName: string;
    role: string;
  }>;
  lastMessage: {
    id: string;
    senderAccountId: string;
    senderMatrixUserId: string;
    serverSeq: number;
    keyEpoch: number;
    payloadJson: Record<string, unknown>;
    createdAt: string;
  } | null;
  createdAt: string;
}

export interface ServerMessageItem {
  id: string;
  conversationId: string;
  senderAccountId: string;
  senderDeviceId: string;
  senderMatrixUserId: string;
  senderMatrixDeviceId: string | null;
  clientMsgId: string;
  serverSeq: number;
  eventType: string;
  keyEpoch: number;
  payloadJson: Record<string, unknown>;
  attachmentIdsJson: string[];
  createdAt: string;
}

export interface LinkedDeviceItem {
  id: string;
  deviceLabel: string;
  matrixDeviceId: string;
  identityKeyEd25519: string;
  status: "active" | "revoked" | "pending_link";
  isCurrent: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const CHAT_API_BASE = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_CHAT_API_URL ?? ""
).replace(/\/+$/, "");

function apiUrl(path: string): string {
  return CHAT_API_BASE ? `${CHAT_API_BASE}${path}` : path;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
      status: res.status,
      code: data.code,
    });
  }
  return data as T;
}

export const chatApi = {
  bootstrap: () => jsonFetch<BootstrapResponse>("/api/chat/session/bootstrap"),
  exchangeHandoff: () => jsonFetch<BootstrapResponse>("/api/chat/handoff/exchange", { method: "POST" }),
  dismissPendingHandoff: () => jsonFetch<{ ok: boolean }>("/api/chat/handoff/pending", { method: "DELETE" }),
  checkUsername: (username: string) =>
    jsonFetch<{ available: boolean; valid: boolean; normalized?: string; error?: string }>(
      `/api/chat/username/check?username=${encodeURIComponent(username)}`,
    ),
  register: (body: {
    proposedAccountId: string;
    username: string;
    displayName: string;
    contactPhone?: string;
    device: {
      deviceLabel: string;
      matrixDeviceId: string;
      deviceKeysJson: Record<string, unknown>;
      oneTimeKeys: Record<string, unknown>;
      fallbackKey?: Record<string, unknown>;
    };
  }) => jsonFetch<{ account: NonNullable<BootstrapResponse["account"]>; device: NonNullable<BootstrapResponse["currentDevice"]> }>("/api/chat/register", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  activateFromDraft: (body: {
    proposedAccountId: string;
    username: string;
    displayName?: string;
    device: {
      deviceLabel: string;
      matrixDeviceId: string;
      deviceKeysJson: Record<string, unknown>;
      oneTimeKeys: Record<string, unknown>;
      fallbackKey?: Record<string, unknown>;
    };
  }) => jsonFetch<{ account: NonNullable<BootstrapResponse["account"]>; device: NonNullable<BootstrapResponse["currentDevice"]> }>("/api/chat/activate-from-draft", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  logout: () => jsonFetch<{ ok: boolean }>("/api/chat/logout", { method: "POST" }),
  logoutAll: () => jsonFetch<{ ok: boolean }>("/api/chat/logout-all", { method: "POST" }),
  lookupUser: (username: string) =>
    jsonFetch<{ user: { accountId: string; username: string; displayName: string; matrixUserId: string } }>(
      `/api/chat/users/lookup?username=${encodeURIComponent(username)}`,
    ),
  searchUsers: (q: string) =>
    jsonFetch<{ users: Array<{ accountId: string; username: string; displayName: string; matrixUserId: string }> }>(
      `/api/chat/users/lookup?q=${encodeURIComponent(q)}`,
    ),

  conversations: () => jsonFetch<{ conversations: ConversationItem[] }>("/api/chat/conversations"),
  createDirect: (targetUsername: string) =>
    jsonFetch<{ conversationId: string; existing: boolean }>("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "direct", targetUsername }),
    }),
  createGroup: (title: string, memberUsernames: string[]) =>
    jsonFetch<{ conversationId: string }>("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "group", title, memberUsernames }),
    }),
  addGroupMember: (conversationId: string, username: string) =>
    jsonFetch<{ ok: boolean }>(`/api/chat/conversations/${conversationId}/members`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
  removeGroupMember: (conversationId: string, accountId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/chat/conversations/${conversationId}/members/${accountId}`, {
      method: "DELETE",
    }),
  fetchMessages: (conversationId: string, afterSeq = 0) =>
    jsonFetch<{ messages: ServerMessageItem[] }>(
      `/api/chat/conversations/${conversationId}/messages?afterSeq=${afterSeq}`,
    ),
  sendMessage: (
    conversationId: string,
    body: {
      clientMsgId: string;
      eventType: "m.room.encrypted";
      keyEpoch: number;
      payload: Record<string, unknown>;
      attachmentIds: string[];
    },
  ) =>
    jsonFetch<{ duplicate: boolean; message: ServerMessageItem }>(
      `/api/chat/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  ackRead: (conversationId: string, lastReadSeq: number) =>
    jsonFetch<{ ok: boolean }>(`/api/chat/conversations/${conversationId}/ack`, {
      method: "POST",
      body: JSON.stringify({ lastReadSeq }),
    }),

  uploadEncryptedAttachment: async (
    conversationId: string,
    encryptedBytes: Uint8Array,
    ciphertextSha256: string,
  ): Promise<{ attachmentId: string; byteSize: number; ciphertextSha256: string }> => {
    const ab = new ArrayBuffer(encryptedBytes.byteLength);
    new Uint8Array(ab).set(encryptedBytes);
    const res = await fetch(apiUrl("/api/chat/attachments"), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-conversation-id": conversationId,
        "x-ciphertext-sha256": ciphertextSha256,
      },
      body: ab,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || "Encrypted attachment upload failed");
    return data as { attachmentId: string; byteSize: number; ciphertextSha256: string };
  },
  downloadEncryptedAttachment: async (attachmentId: string): Promise<Uint8Array> => {
    const res = await fetch(apiUrl(`/api/chat/attachments/${attachmentId}`), { credentials: "include" });
    if (!res.ok) throw new Error("Failed to download encrypted attachment");
    return new Uint8Array(await res.arrayBuffer());
  },

  devices: () => jsonFetch<{ devices: LinkedDeviceItem[] }>("/api/chat/devices"),
  revokeDevice: (deviceId: string) => jsonFetch<{ ok: boolean }>(`/api/chat/devices/${deviceId}`, { method: "DELETE" }),

  createLinkIntent: (body: { deviceLabel: string; matrixDeviceId: string; device2EciesPub: string }) =>
    jsonFetch<{
      linkId: string;
      qrPayload: string;
      shortCode: string;
      shortCodeExpiresAt: string;
      expiresAt: string;
    }>("/api/chat/devices/link-intent", { method: "POST", body: JSON.stringify(body) }),
  lookupLinkRequest: (body: { qrPayload?: string; shortCode?: string }) =>
    jsonFetch<{
      linkId: string;
      deviceLabel: string;
      matrixDeviceId: string;
      device2EciesPub: string;
      accountId: string;
      matrixUserId: string;
      username: string;
      displayName: string;
    }>("/api/chat/devices/link-lookup", { method: "POST", body: JSON.stringify(body) }),
  respondToLinkRequest: (body: { linkId: string; device1EciesOutMsg: string }) =>
    jsonFetch<{ ok: boolean; linkId: string }>("/api/chat/devices/link-respond", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pollLinkChallenge: (linkId: string) =>
    jsonFetch<{
      status: string;
      accountId?: string;
      matrixUserId?: string;
      username?: string;
      displayName?: string;
      device1EciesOutMsg?: string;
    }>(`/api/chat/devices/link-challenge/${linkId}`),
  submitLinkKeys: (
    linkId: string,
    body: {
      deviceKeysJson: Record<string, unknown>;
      oneTimeKeys: Record<string, unknown>;
      fallbackKey?: Record<string, unknown>;
      device2KeyProofCiphertext: string;
    },
  ) =>
    jsonFetch<{ ok: boolean; status: string }>(`/api/chat/devices/link-submit-keys/${linkId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getPendingLinkApproval: (linkId: string) =>
    jsonFetch<{
      linkId: string;
      status: string;
      deviceLabel: string;
      matrixDeviceId: string;
      device2Ed25519: string;
      device2KeyProofCiphertext: string | null;
    }>(`/api/chat/devices/link-pending/${linkId}`),
  approveLinkRequest: (body: { linkId: string; device1EndorsementSig: string }) =>
    jsonFetch<{ ok: boolean }>("/api/chat/devices/link-approve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pollLinkStatus: (linkId: string) =>
    jsonFetch<{
      status: string;
      approved: boolean;
      account?: NonNullable<BootstrapResponse["account"]>;
      device?: { id: string; matrixDeviceId: string; deviceLabel: string };
    }>(`/api/chat/devices/link-status/${linkId}`),
  ackLinkStatus: (linkId: string) =>
    jsonFetch<{ ok: boolean; status: string }>(`/api/chat/devices/link-ack/${linkId}`, {
      method: "POST",
    }),

  cryptoTransport: {
    uploadKeys: (body) => jsonFetch("/api/chat/keys/upload", { method: "POST", body: JSON.stringify(body) }),
    queryKeys: (body) => jsonFetch("/api/chat/keys/query", { method: "POST", body: JSON.stringify(body) }),
    claimKeys: (body) => jsonFetch("/api/chat/keys/claim", { method: "POST", body: JSON.stringify(body) }),
    sendToDevice: (eventType, txnId, body) =>
      jsonFetch(`/api/chat/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    sync: (since) => jsonFetch(`/api/chat/sync${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  } satisfies ChatApiTransport,
};
