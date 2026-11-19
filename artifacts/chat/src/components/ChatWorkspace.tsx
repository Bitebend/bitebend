import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send,
  Paperclip,
  Users,
  Plus,
  Search,
  Laptop,
  LogOut,
  Lock,
  ArrowLeft,
  Loader2,
  CheckCheck,
  AlertTriangle,
  UserPlus,
  UserMinus,
  ShieldAlert,
  X,
} from "lucide-react";
import { ChatCryptoSession, type DecryptedMessageContent } from "../crypto/e2eeClient";
import {
  encryptAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  prepareFileForEncryption,
} from "../crypto/attachments";
import { broadcastTabSync, subscribeTabSync } from "../crypto/lock";
import { getStorageHealthSnapshot } from "../crypto/storageHealth";
import {
  chatApi,
  type BootstrapResponse,
  type ConversationItem,
  type ServerMessageItem,
} from "../lib/api";
import { AttachmentMessageBubble } from "./AttachmentMessageBubble";
import { DeviceManagerModal } from "./DeviceManagerModal";

interface Props {
  account: NonNullable<BootstrapResponse["account"]>;
  cryptoSession: ChatCryptoSession;
  onLoggedOut: () => Promise<void>;
}

interface DecryptedTimelineRow {
  server: ServerMessageItem;
  content: DecryptedMessageContent;
}

export function ChatWorkspace({ account, cryptoSession, onLoggedOut }: Props) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [lastPreviewMap, setLastPreviewMap] = useState<Record<string, string>>({});
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<DecryptedTimelineRow[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);
  const [persistenceMissing, setPersistenceMissing] = useState(false);

  // Modals
  const [showDevices, setShowDevices] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatTab, setNewChatTab] = useState<"direct" | "group">("direct");
  const [lookupInput, setLookupInput] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ accountId: string; username: string; displayName: string }>
  >([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembersInput, setGroupMembersInput] = useState("");
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [addMemberInput, setAddMemberInput] = useState("");

  const activeConvIdRef = useRef<string | null>(null);
  activeConvIdRef.current = activeConvId;
  const maxSeqByConvRef = useRef<Map<string, number>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConvId) ?? null,
    [conversations, activeConvId],
  );

  const formatConversationTitle = (conv: ConversationItem): string => {
    if (conv.kind === "group") return conv.title || "Group Chat";
    const peer = conv.members.find((m) => m.accountId !== account.id) ?? conv.members[0];
    return peer ? `${peer.displayName} (@${peer.username})` : "Direct Chat";
  };

  const refreshConversationsAndSync = useCallback(async () => {
    try {
      await cryptoSession.syncOnce(chatApi.cryptoTransport);
      const { conversations: list } = await chatApi.conversations();
      setConversations(list);

      // Update keyEpochs & decrypt last preview messages
      const previews: Record<string, string> = {};
      for (const conv of list) {
        await cryptoSession.ensureRoomKeyEpoch(conv.id, conv.keyEpoch);
        if (conv.lastMessage) {
          const dec = await cryptoSession.decryptRoomEvent(conv.id, conv.lastMessage);
          if (dec.decrypted) {
            previews[conv.id] = dec.attachment
              ? `Encrypted file: ${dec.attachment.plaintextName}`
              : dec.body || "Encrypted message";
          } else {
            previews[conv.id] = "Encrypted message (awaiting keys)";
          }
        }
      }
      setLastPreviewMap(previews);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) {
        await onLoggedOut();
      } else {
        setErrorBanner(e.message || "Sync interrupted");
      }
    }
  }, [cryptoSession, onLoggedOut]);

  const loadConversationMessages = useCallback(
    async (convId: string, deltaOnly = false) => {
      const afterSeq = deltaOnly ? (maxSeqByConvRef.current.get(convId) ?? 0) : 0;
      if (!deltaOnly) setLoadingThread(true);
      try {
        const { messages } = await chatApi.fetchMessages(convId, afterSeq);
        const decoded: DecryptedTimelineRow[] = [];
        let maxSeq = afterSeq;
        for (const m of messages) {
          maxSeq = Math.max(maxSeq, m.serverSeq);
          const content = await cryptoSession.decryptRoomEvent(convId, m);
          decoded.push({ server: m, content });
        }
        maxSeqByConvRef.current.set(convId, maxSeq);

        if (deltaOnly) {
          if (decoded.length > 0) {
            setTimeline((prev) => {
              const seenIds = new Set(prev.map((x) => x.server.id));
              const appended = decoded.filter((x) => !seenIds.has(x.server.id));
              return [...prev, ...appended];
            });
          }
        } else {
          setTimeline(decoded);
        }

        if (maxSeq > 0) {
          await chatApi.ackRead(convId, maxSeq);
        }
      } catch (err) {
        setErrorBanner((err as Error).message || "Unable to fetch messages");
      } finally {
        if (!deltaOnly) setLoadingThread(false);
      }
    },
    [cryptoSession],
  );

  // Initial sync & storage health check
  useEffect(() => {
    void refreshConversationsAndSync();
    void getStorageHealthSnapshot().then((h) => {
      if (!h.persistentGranted) setPersistenceMissing(true);
    });
  }, [refreshConversationsAndSync]);

  // Open thread messages when activeConvId changes
  useEffect(() => {
    if (!activeConvId) {
      setTimeline([]);
      return;
    }
    void loadConversationMessages(activeConvId, false);
  }, [activeConvId, loadConversationMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  // WebSocket real-time sync_hint listener with exponential backoff, delta catch-up & HTTP fallback polling
  useEffect(() => {
    let closedByUnmount = false;
    let ws: WebSocket | null = null;
    let reconnectTimer = 0;
    let attempt = 0;
    let wsOpen = false;

    const resolveChatWsUrl = (): string => {
      const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
      const explicitWs = env?.VITE_CHAT_WS_URL?.trim();
      if (explicitWs) {
        const clean = explicitWs.replace(/\/+$/, "");
        return clean.endsWith("/api/chat/ws") ? clean : `${clean}/api/chat/ws`;
      }
      const apiOrigin = env?.VITE_CHAT_API_URL?.trim();
      if (apiOrigin) {
        const wsOrigin = apiOrigin
          .replace(/^https:\/\//i, "wss://")
          .replace(/^http:\/\//i, "ws://")
          .replace(/\/+$/, "");
        return `${wsOrigin}/api/chat/ws`;
      }
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/api/chat/ws`;
    };

    const connect = () => {
      if (closedByUnmount) return;
      const wsUrl = resolveChatWsUrl();
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        attempt = 0;
        wsOpen = true;
        setWsConnected(true);
        void refreshConversationsAndSync().then(() => {
          if (activeConvIdRef.current) {
            void loadConversationMessages(activeConvIdRef.current, true);
          }
        });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string; conversationId?: string };
          if (msg.type === "device_revoked") {
            void onLoggedOut();
            return;
          }
          if (msg.type === "sync_hint") {
            void refreshConversationsAndSync().then(() => {
              if (activeConvIdRef.current) {
                void loadConversationMessages(activeConvIdRef.current, true);
              }
            });
          }
        } catch {
          // Ignore invalid WS frames
        }
      };

      ws.onclose = () => {
        wsOpen = false;
        setWsConnected(false);
        if (closedByUnmount) return;
        const delay = Math.min(15000, 1000 * Math.pow(2, attempt));
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    // Resilient HTTP polling fallback whenever WebSocket is unavailable/disconnected
    const fallbackPollTimer = window.setInterval(() => {
      if (closedByUnmount || wsOpen) return;
      void refreshConversationsAndSync().then(() => {
        if (activeConvIdRef.current) {
          void loadConversationMessages(activeConvIdRef.current, true);
        }
      });
    }, 4000);

    const unsubTab = subscribeTabSync((ev) => {
      if (ev.type === "logout") {
        void onLoggedOut();
      } else if (ev.type === "sync") {
        void refreshConversationsAndSync().then(() => {
          if (activeConvIdRef.current) {
            void loadConversationMessages(activeConvIdRef.current, true);
          }
        });
      }
    });

    return () => {
      closedByUnmount = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(fallbackPollTimer);
      unsubTab();
      ws?.close();
    };
  }, [loadConversationMessages, onLoggedOut, refreshConversationsAndSync]);

  // Live @username search for starting DM
  useEffect(() => {
    const q = lookupInput.trim().replace(/^@/, "");
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await chatApi.searchUsers(q);
        if (!cancelled) setSearchResults(res.users);
      } catch {
        if (!cancelled) setSearchResults([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [lookupInput]);

  const sendEncryptedPayload = async (
    payloadObj: Record<string, unknown>,
    attachmentIds: string[] = [],
  ) => {
    if (!activeConversation) return;
    setSending(true);
    setErrorBanner(null);
    try {
      const { conversations: latestConvs } = await chatApi.conversations().catch(() => ({
        conversations: [activeConversation],
      }));
      const freshConv = latestConvs.find((c) => c.id === activeConversation.id) ?? activeConversation;
      const memberIds = freshConv.members.map((m) => m.accountId);
      const encryptedEnvelope = await cryptoSession.encryptMessageForConversation(
        chatApi.cryptoTransport,
        freshConv.id,
        memberIds,
        freshConv.keyEpoch,
        payloadObj,
      );

      const clientMsgId = crypto.randomUUID();
      await chatApi.sendMessage(freshConv.id, {
        clientMsgId,
        eventType: "m.room.encrypted",
        keyEpoch: freshConv.keyEpoch,
        payload: encryptedEnvelope,
        attachmentIds,
      });

      await refreshConversationsAndSync();
      await loadConversationMessages(freshConv.id, true);
      broadcastTabSync({ type: "sync", conversationId: freshConv.id });
    } catch (err) {
      setErrorBanner((err as Error).message || "Failed to encrypt and send message");
    } finally {
      setSending(false);
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = messageText.trim();
    if (!trimmed || sending || !activeConversation) return;
    setMessageText("");
    await sendEncryptedPayload({
      msgtype: "m.text",
      body: trimmed,
    });
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeConversation) return;

    if (file.size > MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024) {
      setErrorBanner("Selected file exceeds the 15 MB encrypted attachment cap.");
      return;
    }

    setErrorBanner(null);
    setUploadNotice(`Encrypting ${file.name}…`);
    try {
      const prepared = await prepareFileForEncryption(file);
      if (prepared.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error("File exceeds the 15 MB encrypted attachment limit.");
      }

      const { encryptedBytes, meta } = await encryptAttachmentBytes(
        prepared.bytes,
        prepared.plaintextName,
        prepared.mimeType,
      );

      setUploadNotice("Uploading encrypted ciphertext…");
      const uploaded = await chatApi.uploadEncryptedAttachment(
        activeConversation.id,
        encryptedBytes,
        meta.ciphertextSha256,
      );

      setUploadNotice(null);
      await sendEncryptedPayload(
        {
          msgtype: meta.mimeType.startsWith("image/") ? "m.image" : "m.file",
          body: meta.plaintextName,
          attachment: {
            ...meta,
            attachmentId: uploaded.attachmentId,
          },
        },
        [uploaded.attachmentId],
      );
    } catch (err) {
      setUploadNotice(null);
      setErrorBanner((err as Error).message || "Encrypted attachment failed");
    }
  };

  const handleStartDirect = async (targetUsername: string) => {
    setErrorBanner(null);
    try {
      const res = await chatApi.createDirect(targetUsername);
      setShowNewChat(false);
      setLookupInput("");
      await refreshConversationsAndSync();
      setActiveConvId(res.conversationId);
    } catch (err) {
      setErrorBanner((err as Error).message || "Unable to open conversation");
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupTitle.trim()) return;
    const usernames = groupMembersInput
      .split(",")
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    try {
      const res = await chatApi.createGroup(groupTitle.trim(), usernames);
      setShowNewChat(false);
      setGroupTitle("");
      setGroupMembersInput("");
      await refreshConversationsAndSync();
      setActiveConvId(res.conversationId);
    } catch (err) {
      setErrorBanner((err as Error).message || "Unable to create group");
    }
  };

  const handleLogout = async () => {
    await chatApi.logout();
    await ChatCryptoSession.clearLocalMetadata();
    broadcastTabSync({ type: "logout" });
    await onLoggedOut();
  };

  return (
    <div className="h-dvh w-full bg-[#faf9f6] flex flex-col overflow-hidden">
      {/* Storage Persistence Warning Banner */}
      {persistenceMissing && !storageWarningDismissed && (
        <div className="bg-[#fff7ed] border-b border-[#fed7aa] px-4 py-2 flex items-center justify-between gap-3 text-xs text-[#9a3412]">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldAlert className="w-4 h-4 shrink-0 text-[#ea580c]" />
            <span className="truncate">
              Keep your keys safe: avoid clearing site data or Private Browsing, and link a second device for backup.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowDevices(true)}
              className="font-bold underline hover:text-[#7c2d12]"
            >
              Link Device
            </button>
            <button
              type="button"
              onClick={() => setStorageWarningDismissed(true)}
              aria-label="Dismiss warning"
              className="p-0.5 hover:bg-[#fed7aa]/50 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left Sidebar — Conversation Inbox */}
        <aside
          className={`w-full md:w-80 lg:w-96 border-r border-[#ede8e3] bg-white flex flex-col min-h-0 ${
            activeConvId ? "hidden md:flex" : "flex"
          }`}
        >
          <div className="px-4 py-3.5 bg-[#047857] text-white flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-extrabold truncate">Bitebend Chat</div>
              <div className="text-[11px] text-emerald-100 truncate">
                @{account.username} · {wsConnected ? "Live Sync" : "Reconnecting…"}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setShowNewChat(true)}
                title="New Chat or Group"
                className="w-8 h-8 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowDevices(true)}
                title="Devices & Key Storage"
                className="w-8 h-8 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center"
              >
                <Laptop className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                title="Sign Out"
                className="w-8 h-8 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[#ede8e3]">
            {conversations.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <Lock className="w-8 h-8 text-[#059669] mx-auto opacity-80" />
                <div className="text-sm font-bold text-[#1a0a00]">No Conversations Yet</div>
                <p className="text-xs text-[#6b7280] leading-relaxed">
                  Start an end-to-end encrypted direct message or group using someone&apos;s <span className="font-mono">@username</span>.
                </p>
                <button
                  type="button"
                  onClick={() => setShowNewChat(true)}
                  className="rounded-xl bg-[#059669] px-4 py-2 text-xs font-bold text-white hover:bg-[#047857]"
                >
                  Start Encrypted Chat
                </button>
              </div>
            ) : (
              conversations.map((conv) => {
                const isSelected = conv.id === activeConvId;
                const title = formatConversationTitle(conv);
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => setActiveConvId(conv.id)}
                    className={`w-full text-left px-4 py-3.5 flex items-center gap-3 transition-colors ${
                      isSelected ? "bg-[#ecfdf5]" : "hover:bg-[#faf9f6]"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-[#ecfdf5] border border-[#a7f3d0] text-[#047857] font-extrabold text-sm flex items-center justify-center shrink-0">
                      {conv.kind === "group" ? (
                        <Users className="w-4 h-4" />
                      ) : (
                        title.slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-[#1a0a00] truncate">{title}</span>
                        {conv.unreadCount > 0 && (
                          <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#059669] text-white text-[10px] font-extrabold flex items-center justify-center shrink-0">
                            {conv.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[#6b7280] truncate mt-0.5">
                        {lastPreviewMap[conv.id] || (conv.kind === "group" ? `${conv.members.length} members` : "Encrypted chat ready")}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Main Thread View */}
        <main className={`flex-1 flex flex-col min-w-0 min-h-0 ${!activeConvId ? "hidden md:flex" : "flex"}`}>
          {!activeConversation ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-[#ecfdf5] border border-[#a7f3d0] flex items-center justify-center">
                <Lock className="w-7 h-7 text-[#059669]" />
              </div>
              <h2 className="text-lg font-extrabold text-[#1a0a00]">End-to-End Encrypted Workspace</h2>
              <p className="text-xs text-[#6b7280] max-w-xs leading-relaxed">
                Select a conversation on the left or click <strong className="text-[#1a0a00]">+</strong> to message another Bitebend user via <span className="font-mono">@username</span>.
              </p>
            </div>
          ) : (
            <>
              {/* Conversation Header */}
              <div className="bg-white border-b border-[#ede8e3] px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => setActiveConvId(null)}
                    className="md:hidden w-8 h-8 rounded-lg bg-[#f5f0eb] flex items-center justify-center"
                    aria-label="Back to inbox"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="text-sm font-extrabold text-[#1a0a00] truncate">
                      {formatConversationTitle(activeConversation)}
                    </div>
                    <div className="text-[11px] text-[#059669] flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      <span>Megolm E2EE · Epoch {activeConversation.keyEpoch}</span>
                    </div>
                  </div>
                </div>

                {activeConversation.kind === "group" && (
                  <button
                    type="button"
                    onClick={() => setShowGroupPanel((v) => !v)}
                    className="rounded-lg border border-[#ede8e3] bg-[#faf9f6] px-2.5 py-1.5 text-xs font-bold text-[#1a0a00] flex items-center gap-1.5"
                  >
                    <Users className="w-3.5 h-3.5 text-[#059669]" />
                    <span>{activeConversation.members.length}</span>
                  </button>
                )}
              </div>

              {/* Group Member Manager Drawer */}
              {showGroupPanel && activeConversation.kind === "group" && (
                <div className="bg-[#faf9f6] border-b border-[#ede8e3] px-4 py-3 space-y-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {activeConversation.members.map((m) => (
                      <span
                        key={m.accountId}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#ede8e3] bg-white px-2.5 py-1 text-xs font-semibold text-[#1a0a00]"
                      >
                        @{m.username}
                        {activeConversation.myRole === "owner" && m.accountId !== account.id && (
                          <button
                            type="button"
                            onClick={async () => {
                              await chatApi.removeGroupMember(activeConversation.id, m.accountId);
                              await refreshConversationsAndSync();
                            }}
                            title="Remove member & rotate room key"
                            className="text-[#dc2626] hover:bg-[#fef2f2] rounded p-0.5"
                          >
                            <UserMinus className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  {activeConversation.myRole === "owner" && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!addMemberInput.trim()) return;
                        try {
                          await chatApi.addGroupMember(activeConversation.id, addMemberInput.trim());
                          setAddMemberInput("");
                          await refreshConversationsAndSync();
                        } catch (err) {
                          setErrorBanner((err as Error).message);
                        }
                      }}
                      className="flex gap-2"
                    >
                      <input
                        type="text"
                        value={addMemberInput}
                        onChange={(e) => setAddMemberInput(e.target.value)}
                        placeholder="Add @username to group…"
                        className="flex-1 rounded-lg border border-[#ede8e3] bg-white px-3 py-1.5 text-xs focus:border-[#059669] focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-lg bg-[#059669] px-3 py-1.5 text-xs font-bold text-white flex items-center gap-1"
                      >
                        <UserPlus className="w-3.5 h-3.5" /> Add
                      </button>
                    </form>
                  )}
                </div>
              )}

              {errorBanner && (
                <div className="bg-[#fef2f2] border-b border-[#fecaca] px-4 py-2 text-xs text-[#991b1b] flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {errorBanner}
                  </span>
                  <button type="button" onClick={() => setErrorBanner(null)} className="font-bold">
                    Dismiss
                  </button>
                </div>
              )}

              {/* Messages Timeline */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
                {loadingThread ? (
                  <div className="py-12 text-center text-xs text-[#6b7280]">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-[#059669]" />
                    Decrypting messages…
                  </div>
                ) : timeline.length === 0 ? (
                  <div className="py-12 text-center text-xs text-[#6b7280]">
                    Send the first encrypted message in this thread.
                  </div>
                ) : (
                  timeline.map((row) => {
                    const isOwn = row.server.senderAccountId === account.id;
                    const senderProfile = activeConversation.members.find(
                      (m) => m.accountId === row.server.senderAccountId,
                    );
                    const timeStr = new Date(row.server.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    });

                    return (
                      <div key={row.server.id} className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-xs ${
                            isOwn
                              ? "bg-[#059669] text-white rounded-br-sm"
                              : "bg-white border border-[#ede8e3] text-[#1a0a00] rounded-bl-sm"
                          }`}
                        >
                          {!isOwn && activeConversation.kind === "group" && senderProfile && (
                            <div className="text-[11px] font-bold text-[#059669] mb-0.5">
                              @{senderProfile.username}
                            </div>
                          )}

                          {row.content.decrypted ? (
                            <>
                              {row.content.body && (!row.content.attachment || row.content.body !== row.content.attachment.plaintextName) && (
                                <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                                  {row.content.body}
                                </p>
                              )}
                              {row.content.attachment && (
                                <AttachmentMessageBubble
                                  attachment={row.content.attachment}
                                  isOwn={isOwn}
                                />
                              )}
                            </>
                          ) : (
                            <div className="text-xs italic opacity-80">
                              Unable to decrypt this message on this device (sent before this browser was linked or missing session key).
                            </div>
                          )}

                          <div
                            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
                              isOwn ? "text-emerald-100" : "text-[#6b7280]"
                            }`}
                          >
                            <span>#{row.server.serverSeq}</span>
                            <span>·</span>
                            <span>{timeStr}</span>
                            {isOwn && <CheckCheck className="w-3 h-3" />}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {uploadNotice && (
                <div className="bg-[#ecfdf5] border-t border-[#a7f3d0] px-4 py-1.5 text-xs font-semibold text-[#047857] flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {uploadNotice}
                </div>
              )}

              {/* Message Composer */}
              <form
                onSubmit={handleSendText}
                className="bg-white border-t border-[#ede8e3] px-3 py-2.5 flex items-center gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf,text/plain,.doc,.docx"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={sending || Boolean(uploadNotice)}
                  onClick={() => fileInputRef.current?.click()}
                  title="Send Encrypted File (up to 15 MB)"
                  className="w-10 h-10 rounded-xl border border-[#ede8e3] bg-[#faf9f6] text-[#1a0a00] hover:bg-[#f5f0eb] flex items-center justify-center shrink-0"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="Write an encrypted message…"
                  className="flex-1 rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3.5 py-2.5 text-sm text-[#1a0a00] focus:border-[#059669] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || !messageText.trim()}
                  className="w-10 h-10 rounded-xl bg-[#059669] text-white hover:bg-[#047857] disabled:opacity-50 flex items-center justify-center shrink-0"
                  aria-label="Send message"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </form>
            </>
          )}
        </main>
      </div>

      {/* New Chat / Group Modal */}
      {showNewChat && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#ede8e3] bg-white p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold text-[#1a0a00]">New Encrypted Conversation</h3>
              <button
                type="button"
                onClick={() => setShowNewChat(false)}
                className="w-8 h-8 rounded-lg bg-[#f5f0eb] flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 rounded-xl bg-[#f5f0eb] p-1 gap-1">
              <button
                type="button"
                onClick={() => setNewChatTab("direct")}
                className={`rounded-lg py-1.5 text-xs font-bold ${
                  newChatTab === "direct" ? "bg-white text-[#1a0a00] shadow-xs" : "text-[#6b7280]"
                }`}
              >
                Direct (@username)
              </button>
              <button
                type="button"
                onClick={() => setNewChatTab("group")}
                className={`rounded-lg py-1.5 text-xs font-bold ${
                  newChatTab === "group" ? "bg-white text-[#1a0a00] shadow-xs" : "text-[#6b7280]"
                }`}
              >
                Encrypted Group
              </button>
            </div>

            {newChatTab === "direct" ? (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-[#6b7280] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={lookupInput}
                    onChange={(e) => setLookupInput(e.target.value)}
                    placeholder="Search @username…"
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] pl-9 pr-3 py-2.5 text-sm focus:border-[#059669] focus:outline-none"
                  />
                </div>
                {searchResults.length > 0 && (
                  <div className="divide-y divide-[#ede8e3] rounded-xl border border-[#ede8e3] max-h-48 overflow-y-auto">
                    {searchResults.map((u) => (
                      <button
                        key={u.accountId}
                        type="button"
                        onClick={() => void handleStartDirect(u.username)}
                        className="w-full text-left px-3.5 py-2.5 hover:bg-[#ecfdf5] flex items-center justify-between"
                      >
                        <div>
                          <div className="text-sm font-bold text-[#1a0a00]">{u.displayName}</div>
                          <div className="text-xs text-[#059669]">@{u.username}</div>
                        </div>
                        <span className="text-xs font-bold text-[#059669]">Message</span>
                      </button>
                    ))}
                  </div>
                )}
                {lookupInput.trim().length >= 3 && (
                  <button
                    type="button"
                    onClick={() => void handleStartDirect(lookupInput)}
                    className="w-full rounded-xl bg-[#059669] py-2.5 text-xs font-bold text-white hover:bg-[#047857]"
                  >
                    Message @{lookupInput.trim().replace(/^@/, "")}
                  </button>
                )}
              </div>
            ) : (
              <form onSubmit={handleCreateGroup} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">Group Name</label>
                  <input
                    type="text"
                    required
                    value={groupTitle}
                    onChange={(e) => setGroupTitle(e.target.value)}
                    placeholder="e.g. Table 4 Dinner Group"
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3 py-2 text-sm focus:border-[#059669] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    Member @usernames (comma separated)
                  </label>
                  <input
                    type="text"
                    value={groupMembersInput}
                    onChange={(e) => setGroupMembersInput(e.target.value)}
                    placeholder="@friend1, @friend2"
                    className="w-full rounded-xl border border-[#ede8e3] bg-[#faf9f6] px-3 py-2 text-sm focus:border-[#059669] focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-[#059669] py-2.5 text-xs font-bold text-white hover:bg-[#047857]"
                >
                  Create Encrypted Group
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {showDevices && (
        <DeviceManagerModal
          cryptoSession={cryptoSession}
          onClose={() => setShowDevices(false)}
          onSyncNeeded={refreshConversationsAndSync}
        />
      )}
    </div>
  );
}
