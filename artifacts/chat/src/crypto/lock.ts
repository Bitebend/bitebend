const inProcessQueues = new Map<string, Promise<unknown>>();

function runInMemoryQueue<T>(lockName: string, task: () => Promise<T>): Promise<T> {
  const previous = inProcessQueues.get(lockName) ?? Promise.resolve();
  const next = previous.then(task, task);
  const cleanup = next.then(
    () => {
      if (inProcessQueues.get(lockName) === cleanup) {
        inProcessQueues.delete(lockName);
      }
    },
    () => {
      if (inProcessQueues.get(lockName) === cleanup) {
        inProcessQueues.delete(lockName);
      }
    },
  );
  inProcessQueues.set(lockName, cleanup);
  return next;
}

/**
 * Serializes access to IndexedDB-backed Olm/Megolm ratchets across multiple open tabs
 * using Web Locks (`navigator.locks`) when available, with a per-tab FIFO queue fallback.
 */
export async function withCryptoLock<T>(scope: string, task: () => Promise<T>): Promise<T> {
  const lockName = `bb_crypto_${scope}`;
  if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
    return await navigator.locks.request(lockName, async () => {
      return await runInMemoryQueue(lockName, task);
    });
  }
  return await runInMemoryQueue(lockName, task);
}

const TAB_CHANNEL_NAME = "bitebend_chat_tab_sync";

export function broadcastTabSync(event: { type: "sync" | "logout"; conversationId?: string }): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(TAB_CHANNEL_NAME);
    ch.postMessage(event);
    ch.close();
  } catch {
    // Ignore unsupported context errors
  }
}

export function subscribeTabSync(
  onMessage: (event: { type: "sync" | "logout"; conversationId?: string }) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  try {
    const ch = new BroadcastChannel(TAB_CHANNEL_NAME);
    ch.onmessage = (ev) => {
      if (ev.data && typeof ev.data === "object") {
        onMessage(ev.data as { type: "sync" | "logout"; conversationId?: string });
      }
    };
    return () => ch.close();
  } catch {
    return () => {};
  }
}
