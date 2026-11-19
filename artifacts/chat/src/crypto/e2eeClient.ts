import * as cryptoWasm from "@matrix-org/matrix-sdk-crypto-wasm";
import * as ed25519 from "@noble/ed25519";
import { withCryptoLock } from "./lock";
import {
  checkKeyStoreHealth,
  checkKnownDeviceStoreHealth,
  clearCryptoMeta,
  deactivateActiveCryptoMeta,
  deleteOlmStoreDatabase,
  readAllRoomEpochs,
  readRoomEpoch,
  readTrustedRoot,
  removeKnownDevice,
  upsertKnownDevice,
  writeCryptoMeta,
  writeRoomEpoch,
  writeTrustedRoot,
} from "./storageHealth";

const MATRIX_DOMAIN = "chat.bitebend.in";
let wasmInitPromise: Promise<void> | null = null;

export async function ensureCryptoWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      if (typeof cryptoWasm.initAsync === "function") {
        await cryptoWasm.initAsync();
      }
    })();
  }
  await wasmInitPromise;
}

export function makeMatrixUserId(accountId: string): string {
  return `@${accountId.toLowerCase()}:${MATRIX_DOMAIN}`;
}

export function makeMatrixRoomId(conversationId: string): string {
  return `!${conversationId.toLowerCase()}:${MATRIX_DOMAIN}`;
}

function accountIdFromMatrixUserId(matrixUserId: string): string {
  const m = /^@([^:]+):/.exec(matrixUserId.trim());
  return m ? m[1].toLowerCase() : matrixUserId.toLowerCase();
}

export function randomDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `WEB_${hex}`;
}

export function getStoreName(accountId: string, matrixDeviceId: string): string {
  return `bb_chat_olm_${accountId.toLowerCase()}_${matrixDeviceId}`;
}

function decodeBase64Fixed(input: string, expectedBytes: number): Uint8Array | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const bin = atob(normalized + "=".repeat(padLen));
    if (bin.length !== expectedBytes) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const bin = atob(normalized + "=".repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function buildDeviceEndorsementPayload(params: {
  accountId: string;
  matrixDeviceId: string;
  ed25519: string;
}): string {
  return JSON.stringify({
    accountId: params.accountId.toLowerCase(),
    matrixDeviceId: params.matrixDeviceId,
    ed25519: params.ed25519,
  });
}

export function buildLoginChallengePayload(params: {
  challengeId: string;
  accountId: string;
  matrixDeviceId: string;
  nonce: string;
}): string {
  return JSON.stringify({
    type: "bitebend_device_login_v1",
    challengeId: params.challengeId,
    accountId: params.accountId.toLowerCase(),
    matrixDeviceId: params.matrixDeviceId,
    nonce: params.nonce,
  });
}

export async function verifyDeviceEndorsementSignature(params: {
  accountId: string;
  targetMatrixDeviceId: string;
  targetEd25519: string;
  signerMatrixDeviceId: string;
  signerEd25519: string;
  endorsementSigJson: string;
}): Promise<boolean> {
  try {
    const parsed = JSON.parse(params.endorsementSigJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    const expectedUid = makeMatrixUserId(params.accountId);
    const userEntry =
      parsed[expectedUid] ??
      Object.entries(parsed).find(([k]) => k.toLowerCase() === expectedUid.toLowerCase())?.[1];
    if (!userEntry || typeof userEntry !== "object") return false;
    const sigB64 = (userEntry as Record<string, unknown>)[`ed25519:${params.signerMatrixDeviceId}`];
    if (typeof sigB64 !== "string") return false;

    const sigBytes = decodeBase64Fixed(sigB64, 64);
    const pubBytes = decodeBase64Fixed(params.signerEd25519, 32);
    if (!sigBytes || !pubBytes) return false;

    const payload = buildDeviceEndorsementPayload({
      accountId: params.accountId,
      matrixDeviceId: params.targetMatrixDeviceId,
      ed25519: params.targetEd25519,
    });
    const payloadBytes = new TextEncoder().encode(payload);
    return await ed25519.verifyAsync(sigBytes, payloadBytes, pubBytes);
  } catch {
    return false;
  }
}

export function deriveMatrixSasDecimals(digestBytes: Uint8Array): string {
  const b0 = digestBytes[0] ?? 0;
  const b1 = digestBytes[1] ?? 0;
  const b2 = digestBytes[2] ?? 0;
  const b3 = digestBytes[3] ?? 0;
  const b4 = digestBytes[4] ?? 0;

  const n1 = (((b0 << 5) | (b1 >> 3)) & 0x1fff) + 1000;
  const n2 = ((((b1 & 0x07) << 10) | (b2 << 2) | (b3 >> 6)) & 0x1fff) + 1000;
  const n3 = ((((b3 & 0x3f) << 7) | (b4 >> 1)) & 0x1fff) + 1000;
  return `${n1} · ${n2} · ${n3}`;
}

export interface EndorsementNodeInfo {
  isRoot: boolean;
  ed25519: string;
  endorsedByMatrixDeviceId: string | null;
  endorsedByEd25519: string | null;
  endorsementSig: string | null;
  createdAt?: string;
  status?: string;
}

export interface ChatApiTransport {
  uploadKeys: (body: Record<string, unknown>) => Promise<{ one_time_key_counts: Record<string, number> }>;
  queryKeys: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  claimKeys: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendToDevice: (eventType: string, txnId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sync: (since?: string) => Promise<{
    next_batch: string;
    to_device: { events: unknown[] };
    device_lists: { changed: string[] };
    device_one_time_keys_count: Record<string, number>;
    device_unused_fallback_key_types: string[];
  }>;
}

export interface DecryptedMessageContent {
  decrypted: boolean;
  msgtype?: string;
  body?: string;
  attachment?: {
    v: 1;
    attachmentId: string;
    keyBase64: string;
    ivPrefixBase64: string;
    chunkSize: number;
    originalSize: number;
    ciphertextSha256: string;
    plaintextSha256: string;
    plaintextName: string;
    mimeType: string;
  };
  senderEd25519?: string;
  errorReason?: string;
}

export class ChatCryptoSession {
  public readonly accountId: string;
  public readonly matrixDeviceId: string;
  public readonly storeName: string;
  private readonly isInMemory: boolean;
  private machine: cryptoWasm.OlmMachine;
  private nextBatchToken = "";
  private knownRoomEpochs = new Map<string, number>();
  private endorsementMetaByUser = new Map<
    string,
    {
      endorsements: Record<string, EndorsementNodeInfo>;
      ancestors: Record<string, EndorsementNodeInfo>;
    }
  >();
  private verifiedDevicesByUser = new Map<string, Map<string, string>>();
  private inMemoryRoots = new Map<string, { rootMatrixDeviceId: string; rootEd25519: string }>();

  private constructor(
    accountId: string,
    matrixDeviceId: string,
    storeName: string,
    machine: cryptoWasm.OlmMachine,
    isInMemory: boolean,
  ) {
    this.accountId = accountId;
    this.matrixDeviceId = matrixDeviceId;
    this.storeName = storeName;
    this.machine = machine;
    this.isInMemory = isInMemory;
  }

  public get ed25519Key(): string {
    return this.machine.identityKeys.ed25519.toBase64();
  }

  public get curve25519Key(): string {
    return this.machine.identityKeys.curve25519.toBase64();
  }

  /**
   * Initializes a brand-new OlmMachine on IndexedDB for initial account registration
   * (Device 1) and extracts signed device keys + OTPKs without failing before HTTP POST.
   */
  public static async prepareNewDeviceForRegistration(opts: {
    proposedAccountId: string;
    matrixDeviceId: string;
    inMemory?: boolean;
  }): Promise<{
    session: ChatCryptoSession;
    uploadPayload: {
      deviceKeysJson: Record<string, unknown>;
      oneTimeKeys: Record<string, unknown>;
      fallbackKey?: Record<string, unknown>;
    };
    markRegistered: (oneTimeKeyCounts: Record<string, number>) => Promise<void>;
  }> {
    await ensureCryptoWasm();
    const isInMemory = Boolean(opts.inMemory);
    const storeName = isInMemory ? null : getStoreName(opts.proposedAccountId, opts.matrixDeviceId);
    const machine = await cryptoWasm.OlmMachine.initialize(
      new cryptoWasm.UserId(makeMatrixUserId(opts.proposedAccountId)),
      new cryptoWasm.DeviceId(opts.matrixDeviceId),
      storeName ?? undefined,
    );

    const reqs = await machine.outgoingRequests();
    const uploadReq = reqs.find((r) => r.type === cryptoWasm.RequestType.KeysUpload) as
      | cryptoWasm.KeysUploadRequest
      | undefined;

    if (!uploadReq) {
      throw new Error("OlmMachine did not generate initial KeysUploadRequest.");
    }

    const parsedBody = JSON.parse(uploadReq.body) as {
      device_keys?: Record<string, unknown>;
      one_time_keys?: Record<string, unknown>;
      fallback_keys?: Record<string, unknown>;
    };

    const session = new ChatCryptoSession(
      opts.proposedAccountId,
      opts.matrixDeviceId,
      storeName ?? "memory",
      machine,
      isInMemory,
    );

    const ownUid = makeMatrixUserId(opts.proposedAccountId);
    session.inMemoryRoots.set(ownUid, {
      rootMatrixDeviceId: opts.matrixDeviceId,
      rootEd25519: session.ed25519Key,
    });

    return {
      session,
      uploadPayload: {
        deviceKeysJson: parsedBody.device_keys ?? {},
        oneTimeKeys: parsedBody.one_time_keys ?? {},
        fallbackKey: parsedBody.fallback_keys,
      },
      markRegistered: async (counts: Record<string, number>) => {
        await withCryptoLock(session.storeName, async () => {
          await machine.markRequestAsSent(
            uploadReq.id,
            uploadReq.type,
            JSON.stringify({ one_time_key_counts: counts }),
          );
          if (!isInMemory && storeName) {
            const initializedAt = new Date().toISOString();
            await writeCryptoMeta({
              accountId: opts.proposedAccountId,
              matrixDeviceId: opts.matrixDeviceId,
              storeName,
              initializedAt,
            });
            await upsertKnownDevice({
              accountId: opts.proposedAccountId,
              matrixDeviceId: opts.matrixDeviceId,
              storeName,
              initializedAt,
            });
            await writeTrustedRoot(
              opts.proposedAccountId,
              opts.matrixDeviceId,
              ownUid,
              opts.matrixDeviceId,
              session.ed25519Key,
            );
          }
        });
      },
    };
  }

  public static async prepareLinkedDevice(opts: {
    accountId: string;
    matrixDeviceId: string;
    approvingDevice?: { matrixDeviceId: string; ed25519: string };
    inMemory?: boolean;
  }): Promise<{
    session: ChatCryptoSession;
    uploadPayload: {
      deviceKeysJson: Record<string, unknown>;
      oneTimeKeys: Record<string, unknown>;
      fallbackKey?: Record<string, unknown>;
    };
    ed25519Key: string;
    curve25519Key: string;
    commitLinked: () => Promise<void>;
  }> {
    const prep = await ChatCryptoSession.prepareNewDeviceForRegistration({
      proposedAccountId: opts.accountId,
      matrixDeviceId: opts.matrixDeviceId,
      inMemory: opts.inMemory,
    });
    const ownUid = makeMatrixUserId(opts.accountId);
    if (opts.approvingDevice) {
      prep.session.inMemoryRoots.set(ownUid, {
        rootMatrixDeviceId: opts.approvingDevice.matrixDeviceId,
        rootEd25519: opts.approvingDevice.ed25519,
      });
    }
    return {
      session: prep.session,
      uploadPayload: prep.uploadPayload,
      ed25519Key: prep.session.ed25519Key,
      curve25519Key: prep.session.curve25519Key,
      commitLinked: async () => {
        const otpkCount = Object.keys(prep.uploadPayload.oneTimeKeys ?? {}).length;
        await prep.markRegistered({ signed_curve25519: otpkCount });
        if (!opts.inMemory && opts.approvingDevice) {
          await writeTrustedRoot(
            opts.accountId,
            opts.matrixDeviceId,
            ownUid,
            opts.approvingDevice.matrixDeviceId,
            opts.approvingDevice.ed25519,
          );
        }
      },
    };
  }

  /**
   * Opens an already-registered OlmMachine from IndexedDB after verifying storage integrity
   * and hydrating persisted room keyEpochs.
   */
  public static async openExisting(accountId: string, matrixDeviceId: string): Promise<ChatCryptoSession> {
    await ensureCryptoWasm();
    const health = await checkKeyStoreHealth(accountId, matrixDeviceId);
    if (health.status !== "OK") {
      throw Object.assign(new Error(health.reason), { code: health.status });
    }

    const storeName = health.meta.storeName;
    const machine = await withCryptoLock(storeName, async () => {
      return await cryptoWasm.OlmMachine.initialize(
        new cryptoWasm.UserId(makeMatrixUserId(accountId)),
        new cryptoWasm.DeviceId(matrixDeviceId),
        storeName,
      );
    });

    const session = new ChatCryptoSession(accountId, matrixDeviceId, storeName, machine, false);
    session.knownRoomEpochs = await readAllRoomEpochs(accountId, matrixDeviceId);
    await upsertKnownDevice({
      accountId,
      matrixDeviceId,
      storeName,
      initializedAt: health.meta.initializedAt,
    });
    return session;
  }

  /**
   * Re-opens an existing local OlmMachine for passwordless challenge-response login
   * without touching `"active_device"` until the server verifies the signature.
   */
  public static async signLoginChallengeAndPrepareOpen(opts: {
    accountId: string;
    matrixDeviceId: string;
    challengeId: string;
    nonce: string;
  }): Promise<{
    signatureEnvelopeJson: string;
    activateSession: () => Promise<ChatCryptoSession>;
  }> {
    await ensureCryptoWasm();
    const health = await checkKnownDeviceStoreHealth(opts.accountId, opts.matrixDeviceId);
    if (health.status !== "OK") {
      throw Object.assign(new Error(health.reason), { code: health.status });
    }

    const storeName = health.meta.storeName;
    const { machine, signatureEnvelopeJson } = await withCryptoLock(storeName, async () => {
      const m = await cryptoWasm.OlmMachine.initialize(
        new cryptoWasm.UserId(makeMatrixUserId(opts.accountId)),
        new cryptoWasm.DeviceId(opts.matrixDeviceId),
        storeName,
      );
      const payload = buildLoginChallengePayload({
        challengeId: opts.challengeId,
        accountId: opts.accountId,
        matrixDeviceId: opts.matrixDeviceId,
        nonce: opts.nonce,
      });
      const sigs = await m.sign(payload);
      return { machine: m, signatureEnvelopeJson: sigs.asJSON() };
    });

    const session = new ChatCryptoSession(opts.accountId, opts.matrixDeviceId, storeName, machine, false);
    session.knownRoomEpochs = await readAllRoomEpochs(opts.accountId, opts.matrixDeviceId);

    return {
      signatureEnvelopeJson,
      activateSession: async () => {
        const initializedAt = health.meta.initializedAt || new Date().toISOString();
        await writeCryptoMeta({
          accountId: opts.accountId,
          matrixDeviceId: opts.matrixDeviceId,
          storeName,
          initializedAt,
        });
        await upsertKnownDevice({
          accountId: opts.accountId,
          matrixDeviceId: opts.matrixDeviceId,
          storeName,
          initializedAt,
        });
        return session;
      },
    };
  }

  public async signLoginChallenge(params: { challengeId: string; nonce: string }): Promise<string> {
    return await withCryptoLock(this.storeName, async () => {
      const payload = buildLoginChallengePayload({
        challengeId: params.challengeId,
        accountId: this.accountId,
        matrixDeviceId: this.matrixDeviceId,
        nonce: params.nonce,
      });
      const sigs = await this.machine.sign(payload);
      return sigs.asJSON();
    });
  }

  public async endorseLinkedDevice(
    targetMatrixDeviceId: string,
    targetEd25519: string,
  ): Promise<string> {
    return await withCryptoLock(this.storeName, async () => {
      const payload = buildDeviceEndorsementPayload({
        accountId: this.accountId,
        matrixDeviceId: targetMatrixDeviceId,
        ed25519: targetEd25519,
      });
      const sigs = await this.machine.sign(payload);
      return sigs.asJSON();
    });
  }

  public async getVerifiedDevicesForUser(matrixUserId: string): Promise<ReadonlyMap<string, string>> {
    return this.verifiedDevicesByUser.get(matrixUserId) ?? new Map();
  }

  private ingestKeysQueryEndorsements(resp: Record<string, unknown>): void {
    const endorsementsRaw = resp["endorsements"] as Record<string, Record<string, EndorsementNodeInfo>> | undefined;
    const ancestorsRaw = resp["endorsement_ancestors"] as Record<string, Record<string, EndorsementNodeInfo>> | undefined;
    const deviceKeysRaw = resp["device_keys"] as Record<string, unknown> | undefined;

    const users = new Set<string>([
      ...Object.keys(deviceKeysRaw ?? {}),
      ...Object.keys(endorsementsRaw ?? {}),
    ]);
    for (const uid of users) {
      this.endorsementMetaByUser.set(uid, {
        endorsements: endorsementsRaw?.[uid] ?? {},
        ancestors: ancestorsRaw?.[uid] ?? {},
      });
    }
  }

  private async verifyAndApplyDeviceTrustUnlocked(
    matrixUserId: string,
  ): Promise<Map<string, string>> {
    const meta = this.endorsementMetaByUser.get(matrixUserId);
    const subjAccountId = accountIdFromMatrixUserId(matrixUserId);
    const isOwnUser = matrixUserId.toLowerCase() === makeMatrixUserId(this.accountId).toLowerCase();

    const activeMeta = meta?.endorsements ?? {};
    const ancestorMeta = meta?.ancestors ?? {};
    const allNodes: Record<string, EndorsementNodeInfo> = { ...ancestorMeta, ...activeMeta };

    const userDevicesObj = await this.machine.getUserDevices(new cryptoWasm.UserId(matrixUserId));
    const wasmDevices = userDevicesObj.devices();

    // Anchor root via in-memory / IndexedDB TOFU pinning
    let pinnedRoot =
      this.inMemoryRoots.get(matrixUserId) ??
      (this.isInMemory ? null : await readTrustedRoot(this.accountId, this.matrixDeviceId, matrixUserId));

    if (!pinnedRoot && Object.keys(allNodes).length > 0) {
      const rootCandidates = Object.entries(allNodes)
        .filter(([, node]) => node.isRoot && !node.endorsedByMatrixDeviceId)
        .sort((a, b) => (a[1].createdAt ?? "").localeCompare(b[1].createdAt ?? ""));

      const chosen = rootCandidates[0];
      if (chosen) {
        const [rootDevId, rootNode] = chosen;
        const wasmDev = wasmDevices.find((d) => d.deviceId.toString() === rootDevId);
        const wasmEd = wasmDev?.ed25519Key?.toBase64();
        // If active in WASM, ensure Ed25519 matches WASM's cryptographic self-signature check
        if (!wasmDev || wasmEd === rootNode.ed25519) {
          pinnedRoot = { rootMatrixDeviceId: rootDevId, rootEd25519: rootNode.ed25519 };
          this.inMemoryRoots.set(matrixUserId, pinnedRoot);
          if (!this.isInMemory) {
            await writeTrustedRoot(
              this.accountId,
              this.matrixDeviceId,
              matrixUserId,
              pinnedRoot.rootMatrixDeviceId,
              pinnedRoot.rootEd25519,
            );
          }
        }
      }
    }

    const verifiedNodes = new Map<string, string>();
    if (isOwnUser) {
      verifiedNodes.set(this.matrixDeviceId, this.ed25519Key);
    }

    if (pinnedRoot) {
      const node = allNodes[pinnedRoot.rootMatrixDeviceId];
      if (node && node.ed25519 === pinnedRoot.rootEd25519) {
        verifiedNodes.set(pinnedRoot.rootMatrixDeviceId, pinnedRoot.rootEd25519);
      } else if (isOwnUser && pinnedRoot.rootMatrixDeviceId === this.matrixDeviceId) {
        verifiedNodes.set(this.matrixDeviceId, this.ed25519Key);
      }
    }

    // Iteratively verify Ed25519 endorsement chains rooted in verifiedNodes
    let progressed = true;
    const maxRounds = Object.keys(allNodes).length + 2;
    for (let round = 0; round < maxRounds && progressed; round++) {
      progressed = false;
      for (const [devId, node] of Object.entries(allNodes)) {
        if (verifiedNodes.has(devId)) continue;
        if (!node.endorsedByMatrixDeviceId || !node.endorsementSig) continue;

        const signerEd25519 = verifiedNodes.get(node.endorsedByMatrixDeviceId);
        if (!signerEd25519) continue;
        if (node.endorsedByEd25519 && node.endorsedByEd25519 !== signerEd25519) continue;

        const wasmDev = wasmDevices.find((d) => d.deviceId.toString() === devId);
        if (wasmDev && wasmDev.ed25519Key?.toBase64() !== node.ed25519) {
          continue;
        }

        const ok = await verifyDeviceEndorsementSignature({
          accountId: subjAccountId,
          targetMatrixDeviceId: devId,
          targetEd25519: node.ed25519,
          signerMatrixDeviceId: node.endorsedByMatrixDeviceId,
          signerEd25519,
          endorsementSigJson: node.endorsementSig,
        });
        if (ok) {
          verifiedNodes.set(devId, node.ed25519);
          progressed = true;
        }
      }
    }

    const verifiedActive = new Map<string, string>();
    for (const dev of wasmDevices) {
      const devId = dev.deviceId.toString();
      const wasmEd = dev.ed25519Key?.toBase64() ?? "";
      const isSelf = isOwnUser && devId === this.matrixDeviceId && wasmEd === this.ed25519Key;
      const inActiveEndorsements = activeMeta[devId]?.ed25519 === wasmEd;
      const chainEd = verifiedNodes.get(devId);

      if (isSelf || (inActiveEndorsements && chainEd && chainEd === wasmEd)) {
        verifiedActive.set(devId, wasmEd);
        await dev.setLocalTrust(cryptoWasm.LocalTrust.Verified);
      } else {
        await dev.setLocalTrust(cryptoWasm.LocalTrust.BlackListed);
      }
    }

    this.verifiedDevicesByUser.set(matrixUserId, verifiedActive);
    return verifiedActive;
  }

  public async flushOutgoing(api: ChatApiTransport): Promise<void> {
    await withCryptoLock(this.storeName, async () => {
      await this.flushOutgoingUnlocked(api);
    });
  }

  private async flushOutgoingUnlocked(api: ChatApiTransport): Promise<void> {
    const reqs = await this.machine.outgoingRequests();
    for (const req of reqs) {
      if (req.type === cryptoWasm.RequestType.KeysUpload) {
        const typed = req as cryptoWasm.KeysUploadRequest;
        const resp = await api.uploadKeys(JSON.parse(typed.body) as Record<string, unknown>);
        await this.machine.markRequestAsSent(typed.id, typed.type, JSON.stringify(resp));
      } else if (req.type === cryptoWasm.RequestType.KeysQuery) {
        const typed = req as cryptoWasm.KeysQueryRequest;
        const rawResp = await api.queryKeys(JSON.parse(typed.body) as Record<string, unknown>);
        this.ingestKeysQueryEndorsements(rawResp);
        const wasmSafeResp = {
          device_keys: rawResp["device_keys"] ?? {},
          failures: rawResp["failures"] ?? {},
        };
        await this.machine.markRequestAsSent(typed.id, typed.type, JSON.stringify(wasmSafeResp));
        for (const uid of Object.keys((rawResp["device_keys"] as Record<string, unknown>) ?? {})) {
          await this.verifyAndApplyDeviceTrustUnlocked(uid);
        }
      } else if (req.type === cryptoWasm.RequestType.KeysClaim) {
        const typed = req as cryptoWasm.KeysClaimRequest;
        const resp = await api.claimKeys(JSON.parse(typed.body) as Record<string, unknown>);
        await this.machine.markRequestAsSent(typed.id, typed.type, JSON.stringify(resp));
      } else if (req.type === cryptoWasm.RequestType.ToDevice) {
        const typed = req as cryptoWasm.ToDeviceRequest;
        const resp = await api.sendToDevice(
          typed.event_type,
          typed.txn_id,
          JSON.parse(typed.body) as Record<string, unknown>,
        );
        await this.machine.markRequestAsSent(typed.id, typed.type, JSON.stringify(resp));
      }
    }
  }

  public async syncOnce(api: ChatApiTransport): Promise<{ changedUsers: string[]; toDeviceCount: number }> {
    return await withCryptoLock(this.storeName, async () => {
      await this.flushOutgoingUnlocked(api);
      const syncData = await api.sync(this.nextBatchToken || undefined);

      const changedUsers = syncData.device_lists?.changed ?? [];
      for (const changedUid of changedUsers) {
        this.verifiedDevicesByUser.delete(changedUid);
      }
      const changedUserIds = changedUsers.map((uid) => new cryptoWasm.UserId(uid));
      const deviceLists = new cryptoWasm.DeviceLists(changedUserIds, []);
      const otpkCounts = new Map<string, number>(
        Object.entries(syncData.device_one_time_keys_count ?? {}),
      );
      const fallbackTypes = new Set<string>(syncData.device_unused_fallback_key_types ?? []);

      await this.machine.receiveSyncChanges(
        JSON.stringify(syncData.to_device?.events ?? []),
        deviceLists,
        otpkCounts,
        fallbackTypes,
      );

      await this.flushOutgoingUnlocked(api);

      if (syncData.next_batch) {
        this.nextBatchToken = syncData.next_batch;
        // Ack processed to-device / device-list batch cleanly on server
        if (syncData.to_device.events.length > 0 || changedUsers.length > 0) {
          await api.sync(this.nextBatchToken);
        }
      }

      return {
        changedUsers,
        toDeviceCount: syncData.to_device?.events?.length ?? 0,
      };
    });
  }

  private async reconcileRoomKeyEpochUnlocked(conversationId: string, serverKeyEpoch: number): Promise<void> {
    let prevEpoch = this.knownRoomEpochs.get(conversationId);
    if (prevEpoch === undefined && !this.isInMemory) {
      prevEpoch = await readRoomEpoch(this.accountId, this.matrixDeviceId, conversationId);
    }

    if ((prevEpoch !== undefined && serverKeyEpoch > prevEpoch) || (prevEpoch === undefined && serverKeyEpoch > 1)) {
      await this.machine.invalidateGroupSession(new cryptoWasm.RoomId(makeMatrixRoomId(conversationId)));
    }

    const nextEpoch = Math.max(prevEpoch ?? 0, serverKeyEpoch);
    this.knownRoomEpochs.set(conversationId, nextEpoch);
    if (!this.isInMemory) {
      await writeRoomEpoch(this.accountId, this.matrixDeviceId, conversationId, nextEpoch);
    }
  }

  public async ensureRoomKeyEpoch(conversationId: string, serverKeyEpoch: number): Promise<void> {
    await withCryptoLock(this.storeName, async () => {
      await this.reconcileRoomKeyEpochUnlocked(conversationId, serverKeyEpoch);
    });
  }

  public async encryptMessageForConversation(
    api: ChatApiTransport,
    conversationId: string,
    memberAccountIds: string[],
    serverKeyEpoch: number,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await withCryptoLock(this.storeName, async () => {
      await this.reconcileRoomKeyEpochUnlocked(conversationId, serverKeyEpoch);
      const roomIdStr = makeMatrixRoomId(conversationId);

      const matrixUsers = Array.from(new Set([this.accountId, ...memberAccountIds])).map(makeMatrixUserId);

      // Must pass fresh UserId[] instances on every call (Rust consumes ownership)
      await this.machine.updateTrackedUsers(matrixUsers.map((u) => new cryptoWasm.UserId(u)));
      await this.flushOutgoingUnlocked(api);

      // Ensure every participant user has fresh endorsement verification even after reload
      const missingVerificationUsers = matrixUsers.filter((u) => !this.verifiedDevicesByUser.has(u));
      if (missingVerificationUsers.length > 0) {
        const queryBody: Record<string, unknown[]> = {};
        for (const u of missingVerificationUsers) {
          queryBody[u] = [];
        }
        const rawQueryResp = await api.queryKeys({ device_keys: queryBody });
        this.ingestKeysQueryEndorsements(rawQueryResp);
        for (const u of missingVerificationUsers) {
          await this.verifyAndApplyDeviceTrustUnlocked(u);
        }
      } else {
        for (const u of matrixUsers) {
          await this.verifyAndApplyDeviceTrustUnlocked(u);
        }
      }

      const claimReq = await this.machine.getMissingSessions(
        matrixUsers.map((u) => new cryptoWasm.UserId(u)),
      );
      if (claimReq) {
        const claimResp = await api.claimKeys(JSON.parse(claimReq.body) as Record<string, unknown>);
        await this.machine.markRequestAsSent(claimReq.id, claimReq.type, JSON.stringify(claimResp));
      }

      const settings = new cryptoWasm.EncryptionSettings();
      settings.sharingStrategy = cryptoWasm.CollectStrategy.onlyTrustedDevices();

      const shareReqs = await this.machine.shareRoomKey(
        new cryptoWasm.RoomId(roomIdStr),
        matrixUsers.map((u) => new cryptoWasm.UserId(u)),
        settings,
      );
      for (const req of shareReqs) {
        const body = JSON.parse(req.body) as { messages?: Record<string, Record<string, unknown>> };
        if (req.event_type === "m.room.encrypted" && body.messages) {
          // Defense-in-depth: strip any unverified target device before sending room keys over the wire
          const filteredMessages: Record<string, Record<string, unknown>> = {};
          for (const [targetUid, devMap] of Object.entries(body.messages)) {
            const verifiedSet = this.verifiedDevicesByUser.get(targetUid);
            for (const [targetDevId, payload] of Object.entries(devMap)) {
              if (!verifiedSet?.has(targetDevId)) {
                throw new Error(`Refusing to share Megolm room key with unverified device ${targetDevId}`);
              }
              if (!filteredMessages[targetUid]) filteredMessages[targetUid] = {};
              filteredMessages[targetUid][targetDevId] = payload;
            }
          }
          body.messages = filteredMessages;
        }
        const resp = await api.sendToDevice(
          req.event_type,
          req.txn_id,
          body as Record<string, unknown>,
        );
        await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(resp));
      }

      const encryptedJson = await this.machine.encryptRoomEvent(
        new cryptoWasm.RoomId(roomIdStr),
        "m.room.message",
        JSON.stringify(content),
      );

      return JSON.parse(encryptedJson) as Record<string, unknown>;
    });
  }

  public async decryptRoomEvent(
    conversationId: string,
    event: {
      id: string;
      senderMatrixUserId: string;
      createdAt: string;
      payloadJson: Record<string, unknown>;
    },
  ): Promise<DecryptedMessageContent> {
    return await withCryptoLock(this.storeName, async () => {
      try {
        const rawMatrixEvent = JSON.stringify({
          type: "m.room.encrypted",
          event_id: `$${event.id}`,
          sender: event.senderMatrixUserId,
          origin_server_ts: Date.parse(event.createdAt) || Date.now(),
          content: event.payloadJson,
        });

        const decrypted = await this.machine.decryptRoomEvent(
          rawMatrixEvent,
          new cryptoWasm.RoomId(makeMatrixRoomId(conversationId)),
          new cryptoWasm.DecryptionSettings(cryptoWasm.TrustRequirement.Untrusted),
        );

        const parsed = JSON.parse(decrypted.event) as {
          content?: {
            msgtype?: string;
            body?: string;
            attachment?: DecryptedMessageContent["attachment"];
          };
        };

        return {
          decrypted: true,
          msgtype: parsed.content?.msgtype ?? "m.text",
          body: parsed.content?.body ?? "",
          attachment: parsed.content?.attachment,
          senderEd25519: decrypted.senderClaimedEd25519Key,
        };
      } catch (err) {
        return {
          decrypted: false,
          errorReason: (err as Error).message || "Unable to decrypt message on this device",
        };
      }
    });
  }

  public static async deactivateActiveSession(): Promise<void> {
    await deactivateActiveCryptoMeta();
  }

  public static async eraseLocalDeviceData(
    storeName?: string,
    accountId?: string,
    matrixDeviceId?: string,
  ): Promise<void> {
    if (accountId && matrixDeviceId) {
      await removeKnownDevice(accountId, matrixDeviceId);
    }
    await clearCryptoMeta();
    if (storeName && storeName !== "memory") {
      await deleteOlmStoreDatabase(storeName);
    }
  }

  public static async clearLocalMetadata(): Promise<void> {
    await clearCryptoMeta();
  }
}

export interface PairingWelcomePayload {
  accountId: string;
  matrixUserId: string;
  username: string;
  displayName: string;
  approvingMatrixDeviceId: string;
  approvingEd25519: string;
}

export interface Device2EciesOffer {
  ecies: cryptoWasm.Ecies;
  sasKeyPair: CryptoKeyPair;
  eciesPubBase64: string;
  sasPubBase64: string;
  publicKeyBase64: string;
}

async function computePairingSasCode(params: {
  myPrivateKey: CryptoKey;
  peerSasPubBase64: string;
  eciesCheckCode: cryptoWasm.CheckCode;
  linkId: string;
  accountId: string;
  eciesPub2: string;
  sasPub2: string;
  sasPub1: string;
}): Promise<string> {
  const peerRaw = base64ToBytes(params.peerSasPubBase64);
  const peerKey = await crypto.subtle.importKey(
    "raw",
    peerRaw.buffer.slice(peerRaw.byteOffset, peerRaw.byteOffset + peerRaw.byteLength) as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, params.myPrivateKey, 256),
  );
  const checkCodeBytes = new Uint8Array(params.eciesCheckCode.as_bytes());
  const transcriptStr = [
    "BITEBEND_PAIRING_SAS_V2",
    params.linkId,
    params.accountId.toLowerCase(),
    params.eciesPub2,
    params.sasPub2,
    params.sasPub1,
  ].join("|");
  const transcriptBytes = new TextEncoder().encode(transcriptStr);

  const combined = new Uint8Array(sharedBits.length + checkCodeBytes.length + transcriptBytes.length);
  combined.set(sharedBits, 0);
  combined.set(checkCodeBytes, sharedBits.length);
  combined.set(transcriptBytes, sharedBits.length + checkCodeBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
  return deriveMatrixSasDecimals(digest);
}

/**
 * Multi-Device Linking (Ecies + Ephemeral ECDH P-256 + Transcript-Bound Matrix 3x4-digit SAS)
 */
export async function createDevice2EciesOffer(): Promise<Device2EciesOffer> {
  await ensureCryptoWasm();
  const ecies = new cryptoWasm.Ecies();
  const sasKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const sasRaw = new Uint8Array(await crypto.subtle.exportKey("raw", sasKeyPair.publicKey));
  const eciesPubBase64 = ecies.public_key().toBase64();
  const sasPubBase64 = bytesToBase64(sasRaw);
  const publicKeyBase64 = JSON.stringify({
    v: 2,
    eciesPub: eciesPubBase64,
    sasPub: sasPubBase64,
  });

  return {
    ecies,
    sasKeyPair,
    eciesPubBase64,
    sasPubBase64,
    publicKeyBase64,
  };
}

export async function establishDevice1EciesChannel(
  device2PackedPub: string,
  welcomePayload: PairingWelcomePayload,
  context: { linkId: string },
): Promise<{
  channel: cryptoWasm.EstablishedEcies;
  initialMessage: string;
  sasCode: string;
}> {
  await ensureCryptoWasm();

  let parsedOffer: { v?: number; eciesPub?: string; sasPub?: string };
  try {
    parsedOffer = JSON.parse(device2PackedPub) as { v?: number; eciesPub?: string; sasPub?: string };
  } catch {
    throw new Error("Unsupported legacy or malformed device pairing offer");
  }
  if (parsedOffer.v !== 2 || !parsedOffer.eciesPub || !parsedOffer.sasPub) {
    throw new Error("Device pairing offer missing required ECDH v2 SAS public key");
  }

  const sas1KeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const sas1Raw = new Uint8Array(await crypto.subtle.exportKey("raw", sas1KeyPair.publicKey));
  const sas1PubBase64 = bytesToBase64(sas1Raw);

  const ecies = new cryptoWasm.Ecies();
  const pub = new cryptoWasm.Curve25519PublicKey(parsedOffer.eciesPub);
  const res = ecies.establish_outbound_channel(pub, JSON.stringify(welcomePayload));

  const sasCode = await computePairingSasCode({
    myPrivateKey: sas1KeyPair.privateKey,
    peerSasPubBase64: parsedOffer.sasPub,
    eciesCheckCode: res.channel.check_code(),
    linkId: context.linkId,
    accountId: welcomePayload.accountId,
    eciesPub2: parsedOffer.eciesPub,
    sasPub2: parsedOffer.sasPub,
    sasPub1: sas1PubBase64,
  });

  return {
    channel: res.channel,
    initialMessage: JSON.stringify({
      v: 2,
      eciesMsg: res.initial_message,
      sasPub: sas1PubBase64,
    }),
    sasCode,
  };
}

export async function establishDevice2EciesChannel(
  offer: Device2EciesOffer,
  device1PackedMessage: string,
  context: { linkId: string },
): Promise<{
  channel: cryptoWasm.EstablishedEcies;
  welcomePayload: PairingWelcomePayload;
  sasCode: string;
}> {
  let parsedChallenge: { v?: number; eciesMsg?: string; sasPub?: string };
  try {
    parsedChallenge = JSON.parse(device1PackedMessage) as {
      v?: number;
      eciesMsg?: string;
      sasPub?: string;
    };
  } catch {
    throw new Error("Unsupported legacy or malformed pairing challenge");
  }
  if (parsedChallenge.v !== 2 || !parsedChallenge.eciesMsg || !parsedChallenge.sasPub) {
    throw new Error("Pairing challenge missing required ECDH v2 SAS parameters");
  }

  const res = offer.ecies.establish_inbound_channel(parsedChallenge.eciesMsg);
  const welcomePayload = JSON.parse(res.message) as PairingWelcomePayload;
  if (!welcomePayload.approvingMatrixDeviceId || !welcomePayload.approvingEd25519) {
    res.channel.free();
    throw new Error("Approving device identity missing from ECIES welcome payload");
  }

  const sasCode = await computePairingSasCode({
    myPrivateKey: offer.sasKeyPair.privateKey,
    peerSasPubBase64: parsedChallenge.sasPub,
    eciesCheckCode: res.channel.check_code(),
    linkId: context.linkId,
    accountId: welcomePayload.accountId,
    eciesPub2: offer.eciesPubBase64,
    sasPub2: offer.sasPubBase64,
    sasPub1: parsedChallenge.sasPub,
  });

  return {
    channel: res.channel,
    welcomePayload,
    sasCode,
  };
}
