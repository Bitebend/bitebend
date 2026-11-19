export interface CryptoMetaRecord {
  key: "active_device";
  accountId: string;
  matrixDeviceId: string;
  storeName: string;
  initializedAt: string;
}

export interface KnownDeviceRecord {
  accountId: string;
  matrixDeviceId: string;
  storeName: string;
  initializedAt: string;
}

interface KnownDevicesEnvelope {
  key: "known_devices";
  devices: KnownDeviceRecord[];
}

export interface RoomEpochRecord {
  key: string;
  accountId: string;
  matrixDeviceId: string;
  conversationId: string;
  keyEpoch: number;
  updatedAt: string;
}

export interface TrustedRootRecord {
  key: string;
  ownerAccountId: string;
  ownerMatrixDeviceId: string;
  subjectMatrixUserId: string;
  rootMatrixDeviceId: string;
  rootEd25519: string;
  pinnedAt: string;
}

export interface StorageHealthSnapshot {
  indexedDbAvailable: boolean;
  persistentGranted: boolean | null;
  quotaBytes: number | null;
  usageBytes: number | null;
}

export type KeyStoreCheckResult =
  | { status: "OK"; meta: CryptoMetaRecord }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "KEY_EVICTED_OR_MISSING"; reason: string };

const META_DB_NAME = "bitebend_chat_meta_v1";
const META_DB_VERSION = 2;
const META_STORE_NAME = "meta";
const KNOWN_DEVICES_KEY = "known_devices";
const ROOM_EPOCHS_STORE_NAME = "room_epochs";
const TRUSTED_ROOTS_STORE_NAME = "trusted_roots";

function openMetaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const req = indexedDB.open(META_DB_NAME, META_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(ROOM_EPOCHS_STORE_NAME)) {
        db.createObjectStore(ROOM_EPOCHS_STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(TRUSTED_ROOTS_STORE_NAME)) {
        db.createObjectStore(TRUSTED_ROOTS_STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

function makeRoomEpochKey(accountId: string, matrixDeviceId: string, conversationId: string): string {
  return `${accountId.toLowerCase()}:${matrixDeviceId}:${conversationId}`;
}

function makeTrustedRootKey(
  ownerAccountId: string,
  ownerMatrixDeviceId: string,
  subjectMatrixUserId: string,
): string {
  return `${ownerAccountId.toLowerCase()}:${ownerMatrixDeviceId}:${subjectMatrixUserId.toLowerCase()}`;
}

export async function readCryptoMeta(): Promise<CryptoMetaRecord | null> {
  try {
    const db = await openMetaDb();
    try {
      return await new Promise<CryptoMetaRecord | null>((resolve, reject) => {
        const tx = db.transaction(META_STORE_NAME, "readonly");
        const store = tx.objectStore(META_STORE_NAME);
        const req = store.get("active_device");
        req.onsuccess = () => resolve((req.result as CryptoMetaRecord | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function writeCryptoMeta(record: Omit<CryptoMetaRecord, "key">): Promise<void> {
  const db = await openMetaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE_NAME, "readwrite");
      const store = tx.objectStore(META_STORE_NAME);
      const req = store.put({ key: "active_device", ...record });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function readKnownDevices(): Promise<KnownDeviceRecord[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const db = await openMetaDb();
    try {
      const env = await new Promise<KnownDevicesEnvelope | undefined>((resolve, reject) => {
        const tx = db.transaction(META_STORE_NAME, "readonly");
        const req = tx.objectStore(META_STORE_NAME).get(KNOWN_DEVICES_KEY);
        req.onsuccess = () => resolve((req.result as KnownDevicesEnvelope | undefined) ?? undefined);
        req.onerror = () => reject(req.error);
      });
      const list = Array.isArray(env?.devices) ? env.devices : [];
      if (list.length > 0) return list;

      // Fallback to active_device if created before known_devices list existed
      const active = await readCryptoMeta();
      if (active?.accountId && active?.matrixDeviceId && active?.storeName) {
        return [
          {
            accountId: active.accountId.toLowerCase(),
            matrixDeviceId: active.matrixDeviceId,
            storeName: active.storeName,
            initializedAt: active.initializedAt,
          },
        ];
      }
      return [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function upsertKnownDevice(record: KnownDeviceRecord): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openMetaDb();
  try {
    const existing = await new Promise<KnownDeviceRecord[]>((resolve) => {
      const tx = db.transaction(META_STORE_NAME, "readonly");
      const req = tx.objectStore(META_STORE_NAME).get(KNOWN_DEVICES_KEY);
      req.onsuccess = () => {
        const env = req.result as KnownDevicesEnvelope | undefined;
        resolve(Array.isArray(env?.devices) ? env.devices : []);
      };
      req.onerror = () => resolve([]);
    });

    const normAccount = record.accountId.toLowerCase();
    const filtered = existing.filter(
      (d) => !(d.accountId.toLowerCase() === normAccount && d.matrixDeviceId === record.matrixDeviceId),
    );
    const updated: KnownDeviceRecord[] = [
      {
        accountId: normAccount,
        matrixDeviceId: record.matrixDeviceId,
        storeName: record.storeName,
        initializedAt: record.initializedAt,
      },
      ...filtered,
    ].slice(0, 25);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE_NAME, "readwrite");
      const req = tx.objectStore(META_STORE_NAME).put({
        key: KNOWN_DEVICES_KEY,
        devices: updated,
      } satisfies KnownDevicesEnvelope);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function removeKnownDevice(accountId: string, matrixDeviceId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openMetaDb();
    try {
      const existing = await new Promise<KnownDeviceRecord[]>((resolve) => {
        const tx = db.transaction(META_STORE_NAME, "readonly");
        const req = tx.objectStore(META_STORE_NAME).get(KNOWN_DEVICES_KEY);
        req.onsuccess = () => {
          const env = req.result as KnownDevicesEnvelope | undefined;
          resolve(Array.isArray(env?.devices) ? env.devices : []);
        };
        req.onerror = () => resolve([]);
      });
      const normAccount = accountId.toLowerCase();
      const filtered = existing.filter(
        (d) => !(d.accountId.toLowerCase() === normAccount && d.matrixDeviceId === matrixDeviceId),
      );
      await new Promise<void>((resolve) => {
        const tx = db.transaction(META_STORE_NAME, "readwrite");
        tx.objectStore(META_STORE_NAME).put({
          key: KNOWN_DEVICES_KEY,
          devices: filtered,
        } satisfies KnownDevicesEnvelope);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    // Ignore storage error
  }
}

export async function readRoomEpoch(
  accountId: string,
  matrixDeviceId: string,
  conversationId: string,
): Promise<number | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    const db = await openMetaDb();
    try {
      const rec = await new Promise<RoomEpochRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(ROOM_EPOCHS_STORE_NAME, "readonly");
        const req = tx.objectStore(ROOM_EPOCHS_STORE_NAME).get(
          makeRoomEpochKey(accountId, matrixDeviceId, conversationId),
        );
        req.onsuccess = () => resolve((req.result as RoomEpochRecord | undefined) ?? undefined);
        req.onerror = () => reject(req.error);
      });
      return rec && typeof rec.keyEpoch === "number" ? rec.keyEpoch : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function readAllRoomEpochs(
  accountId: string,
  matrixDeviceId: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (typeof indexedDB === "undefined") return map;
  try {
    const db = await openMetaDb();
    try {
      const records = await new Promise<RoomEpochRecord[]>((resolve, reject) => {
        const tx = db.transaction(ROOM_EPOCHS_STORE_NAME, "readonly");
        const store = tx.objectStore(ROOM_EPOCHS_STORE_NAME);
        if (typeof store.getAll === "function") {
          const req = store.getAll();
          req.onsuccess = () => resolve((req.result as RoomEpochRecord[] | undefined) ?? []);
          req.onerror = () => reject(req.error);
          return;
        }
        const out: RoomEpochRecord[] = [];
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            out.push(cursor.value as RoomEpochRecord);
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      const normAccount = accountId.toLowerCase();
      for (const rec of records) {
        if (
          rec &&
          rec.accountId?.toLowerCase() === normAccount &&
          rec.matrixDeviceId === matrixDeviceId &&
          typeof rec.keyEpoch === "number"
        ) {
          map.set(rec.conversationId, rec.keyEpoch);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // Best-effort read; caller handles missing cache
  }
  return map;
}

export async function writeRoomEpoch(
  accountId: string,
  matrixDeviceId: string,
  conversationId: string,
  keyEpoch: number,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openMetaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROOM_EPOCHS_STORE_NAME, "readwrite");
      const record: RoomEpochRecord = {
        key: makeRoomEpochKey(accountId, matrixDeviceId, conversationId),
        accountId: accountId.toLowerCase(),
        matrixDeviceId,
        conversationId,
        keyEpoch,
        updatedAt: new Date().toISOString(),
      };
      const req = tx.objectStore(ROOM_EPOCHS_STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function readTrustedRoot(
  ownerAccountId: string,
  ownerMatrixDeviceId: string,
  subjectMatrixUserId: string,
): Promise<{ rootMatrixDeviceId: string; rootEd25519: string } | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openMetaDb();
    try {
      const rec = await new Promise<TrustedRootRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(TRUSTED_ROOTS_STORE_NAME, "readonly");
        const req = tx.objectStore(TRUSTED_ROOTS_STORE_NAME).get(
          makeTrustedRootKey(ownerAccountId, ownerMatrixDeviceId, subjectMatrixUserId),
        );
        req.onsuccess = () => resolve((req.result as TrustedRootRecord | undefined) ?? undefined);
        req.onerror = () => reject(req.error);
      });
      if (!rec?.rootMatrixDeviceId || !rec?.rootEd25519) return null;
      return { rootMatrixDeviceId: rec.rootMatrixDeviceId, rootEd25519: rec.rootEd25519 };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function writeTrustedRoot(
  ownerAccountId: string,
  ownerMatrixDeviceId: string,
  subjectMatrixUserId: string,
  rootMatrixDeviceId: string,
  rootEd25519: string,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openMetaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TRUSTED_ROOTS_STORE_NAME, "readwrite");
      const record: TrustedRootRecord = {
        key: makeTrustedRootKey(ownerAccountId, ownerMatrixDeviceId, subjectMatrixUserId),
        ownerAccountId: ownerAccountId.toLowerCase(),
        ownerMatrixDeviceId,
        subjectMatrixUserId: subjectMatrixUserId.toLowerCase(),
        rootMatrixDeviceId,
        rootEd25519,
        pinnedAt: new Date().toISOString(),
      };
      const req = tx.objectStore(TRUSTED_ROOTS_STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function deactivateActiveCryptoMeta(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openMetaDb();
    try {
      await new Promise<void>((resolve) => {
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          resolve();
          return;
        }
        const tx = db.transaction([META_STORE_NAME], "readwrite");
        tx.objectStore(META_STORE_NAME).delete("active_device");
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    // Ignore cleanup errors when storage disabled
  }
}

export async function clearCryptoMeta(): Promise<void> {
  try {
    const db = await openMetaDb();
    try {
      await new Promise<void>((resolve) => {
        const stores = [META_STORE_NAME, ROOM_EPOCHS_STORE_NAME, TRUSTED_ROOTS_STORE_NAME].filter((s) =>
          db.objectStoreNames.contains(s),
        );
        const tx = db.transaction(stores, "readwrite");
        if (db.objectStoreNames.contains(META_STORE_NAME)) {
          tx.objectStore(META_STORE_NAME).delete("active_device");
          tx.objectStore(META_STORE_NAME).delete(KNOWN_DEVICES_KEY);
        }
        if (db.objectStoreNames.contains(ROOM_EPOCHS_STORE_NAME)) {
          tx.objectStore(ROOM_EPOCHS_STORE_NAME).clear();
        }
        if (db.objectStoreNames.contains(TRUSTED_ROOTS_STORE_NAME)) {
          tx.objectStore(TRUSTED_ROOTS_STORE_NAME).clear();
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    // Ignore cleanup errors when storage disabled
  }
}

export async function deleteOlmStoreDatabase(storeName: string): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.deleteDatabase !== "function" || !storeName) {
    return;
  }

  const targetNames = new Set<string>([storeName]);
  if (typeof indexedDB.databases === "function") {
    try {
      const dbs = await indexedDB.databases();
      for (const d of dbs) {
        if (d.name && d.name.includes(storeName)) {
          targetNames.add(d.name);
        }
      }
    } catch {
      // Ignore enumeration errors
    }
  }

  await Promise.all(
    Array.from(targetNames).map(
      (dbName) =>
        new Promise<void>((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(dbName);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

export async function getStorageHealthSnapshot(): Promise<StorageHealthSnapshot> {
  const indexedDbAvailable = typeof indexedDB !== "undefined";
  let persistentGranted: boolean | null = null;
  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;

  try {
    if (typeof navigator !== "undefined" && navigator.storage) {
      if (typeof navigator.storage.persisted === "function") {
        persistentGranted = await navigator.storage.persisted();
        if (!persistentGranted && typeof navigator.storage.persist === "function") {
          persistentGranted = await navigator.storage.persist();
        }
      }
      if (typeof navigator.storage.estimate === "function") {
        const est = await navigator.storage.estimate();
        quotaBytes = est.quota ?? null;
        usageBytes = est.usage ?? null;
      }
    }
  } catch {
    // Best-effort storage estimate
  }

  return {
    indexedDbAvailable,
    persistentGranted,
    quotaBytes,
    usageBytes,
  };
}

/**
 * Verifies that when the server recognizes an active `bb_chat_sess`, local IndexedDB
 * actually holds the corresponding E2EE encryption keys. Never allows silent regeneration
 * of fake replacement keys when browser storage has been evicted or cleared.
 */
export async function checkKeyStoreHealth(
  expectedAccountId: string,
  expectedMatrixDeviceId: string,
): Promise<KeyStoreCheckResult> {
  if (typeof indexedDB === "undefined") {
    return {
      status: "UNAVAILABLE",
      reason: "IndexedDB key storage is unavailable in this browser mode (e.g. strict Private Browsing).",
    };
  }

  const meta = await readCryptoMeta();
  if (!meta) {
    return {
      status: "KEY_EVICTED_OR_MISSING",
      reason: "Encryption keys for this session are missing from browser storage (browser storage may have been cleared or evicted).",
    };
  }

  if (
    meta.accountId.toLowerCase() !== expectedAccountId.toLowerCase() ||
    meta.matrixDeviceId !== expectedMatrixDeviceId
  ) {
    return {
      status: "KEY_EVICTED_OR_MISSING",
      reason: "Local device keys belong to a different device or were replaced.",
    };
  }

  // If browser exposes indexedDB.databases(), verify vodozemac store DB still exists
  if (typeof indexedDB.databases === "function") {
    try {
      const dbs = await indexedDB.databases();
      const found = dbs.some((d) => d.name && d.name.includes(meta.storeName));
      if (!found) {
        return {
          status: "KEY_EVICTED_OR_MISSING",
          reason: "Browser evicted the IndexedDB cryptographic key store.",
        };
      }
    } catch {
      // Fallback: OlmMachine initialization check will confirm store integrity
    }
  }

  return { status: "OK", meta };
}

export async function checkKnownDeviceStoreHealth(
  expectedAccountId: string,
  expectedMatrixDeviceId: string,
): Promise<KeyStoreCheckResult> {
  if (typeof indexedDB === "undefined") {
    return {
      status: "UNAVAILABLE",
      reason: "IndexedDB key storage is unavailable in this browser mode.",
    };
  }

  const normAccount = expectedAccountId.toLowerCase();
  const knownDevices = await readKnownDevices();
  const matched = knownDevices.find(
    (d) => d.accountId.toLowerCase() === normAccount && d.matrixDeviceId === expectedMatrixDeviceId,
  );
  const activeMeta = await readCryptoMeta();
  const resolved =
    matched ??
    (activeMeta &&
    activeMeta.accountId.toLowerCase() === normAccount &&
    activeMeta.matrixDeviceId === expectedMatrixDeviceId
      ? {
          accountId: activeMeta.accountId,
          matrixDeviceId: activeMeta.matrixDeviceId,
          storeName: activeMeta.storeName,
          initializedAt: activeMeta.initializedAt,
        }
      : null);

  if (!resolved) {
    return {
      status: "KEY_EVICTED_OR_MISSING",
      reason: "Local encryption keys for this browser could not be found.",
    };
  }

  if (typeof indexedDB.databases === "function") {
    try {
      const dbs = await indexedDB.databases();
      const found = dbs.some((d) => d.name && d.name.includes(resolved.storeName));
      if (!found) {
        return {
          status: "KEY_EVICTED_OR_MISSING",
          reason: "Browser evicted the IndexedDB cryptographic key store.",
        };
      }
    } catch {
      // Fallback: OlmMachine initialization confirms store integrity
    }
  }

  return {
    status: "OK",
    meta: {
      key: "active_device",
      accountId: resolved.accountId,
      matrixDeviceId: resolved.matrixDeviceId,
      storeName: resolved.storeName,
      initializedAt: resolved.initializedAt,
    },
  };
}
