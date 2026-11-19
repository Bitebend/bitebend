import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import * as cryptoWasm from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  ChatCryptoSession,
  createDevice2EciesOffer,
  establishDevice1EciesChannel,
  establishDevice2EciesChannel,
  makeMatrixUserId,
  verifyDeviceEndorsementSignature,
  type ChatApiTransport,
  type EndorsementNodeInfo,
} from "../crypto/e2eeClient";
import {
  clearCryptoMeta,
  readAllRoomEpochs,
  readCryptoMeta,
  readTrustedRoot,
  writeCryptoMeta,
  writeRoomEpoch,
  writeTrustedRoot,
} from "../crypto/storageHealth";
import {
  encryptAttachmentBytes,
  decryptAttachmentBytes,
} from "../crypto/attachments";

/**
 * Lightweight IndexedDB mock backed by plain Maps to simulate persistence across page reloads.
 */
function installMockIndexedDb() {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();

  const makeReq = <T>(executor: () => T) => {
    const req: {
      result: T | undefined;
      error: Error | null;
      onsuccess: ((ev: unknown) => void) | null;
      onerror: ((ev: unknown) => void) | null;
      onupgradeneeded: ((ev: unknown) => void) | null;
    } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      try {
        req.result = executor();
        req.onsuccess?.({});
      } catch (err) {
        req.error = err as Error;
        req.onerror?.({});
      }
    });
    return req;
  };

  const prev = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open(name: string) {
      let stores = databases.get(name);
      const isNew = !stores;
      if (!stores) {
        stores = new Map();
        databases.set(name, stores);
      }

      const dbObj = {
        objectStoreNames: {
          contains: (s: string) => stores!.has(s),
        },
        createObjectStore: (s: string) => {
          if (!stores!.has(s)) stores!.set(s, new Map());
          return {};
        },
        close: () => {},
        transaction: (storeNames: string | string[]) => {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          const tx = {
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            objectStore: (sName: string) => {
              if (!names.includes(sName)) throw new Error(`Store ${sName} not in tx`);
              const map = stores!.get(sName) ?? new Map<string, unknown>();
              stores!.set(sName, map);
              return {
                get: (k: string) => makeReq(() => map.get(k)),
                getAll: () => makeReq(() => Array.from(map.values())),
                put: (val: { key: string }) => makeReq(() => {
                  map.set(val.key, val);
                  queueMicrotask(() => tx.oncomplete?.());
                  return val.key;
                }),
                delete: (k: string) => makeReq(() => {
                  map.delete(k);
                  queueMicrotask(() => tx.oncomplete?.());
                }),
                clear: () => makeReq(() => {
                  map.clear();
                  queueMicrotask(() => tx.oncomplete?.());
                }),
              };
            },
          };
          return tx;
        },
      };

      const req = {
        result: dbObj,
        error: null as Error | null,
        onsuccess: null as ((ev: unknown) => void) | null,
        onerror: null as ((ev: unknown) => void) | null,
        onupgradeneeded: null as ((ev: unknown) => void) | null,
      };
      queueMicrotask(() => {
        if (isNew || !stores!.has("room_epochs") || !stores!.has("trusted_roots")) {
          req.onupgradeneeded?.({});
        }
        req.onsuccess?.({});
      });
      return req;
    },
  };

  return () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = prev;
  };
}

describe("Bitebend E2EE WASM, Persistence, Endorsements, SAS & Attachment Encryption", () => {
  let restoreIdb: (() => void) | null = null;

  afterEach(() => {
    if (restoreIdb) {
      restoreIdb();
      restoreIdb = null;
    }
  });

  it("persists room keyEpoch and trusted roots in IndexedDB across simulated reloads and rotates Megolm session on bumped epoch", async () => {
    restoreIdb = installMockIndexedDb();
    const accountId = crypto.randomUUID();
    const matrixDeviceId = "WEB_RELOAD1";
    const convId = crypto.randomUUID();
    const peerUid = makeMatrixUserId(crypto.randomUUID());

    await writeCryptoMeta({
      accountId,
      matrixDeviceId,
      storeName: `bb_chat_olm_${accountId}_${matrixDeviceId}`,
      initializedAt: new Date().toISOString(),
    });
    await writeRoomEpoch(accountId, matrixDeviceId, convId, 2);
    await writeTrustedRoot(accountId, matrixDeviceId, peerUid, "PEER_ROOT1", "A".repeat(43));

    // Simulate fresh tab/reload reading directly from IndexedDB
    const meta = await readCryptoMeta();
    expect(meta?.matrixDeviceId).toBe(matrixDeviceId);
    const epochs = await readAllRoomEpochs(accountId, matrixDeviceId);
    expect(epochs.get(convId)).toBe(2);
    const pinnedRoot = await readTrustedRoot(accountId, matrixDeviceId, peerUid);
    expect(pinnedRoot).toEqual({ rootMatrixDeviceId: "PEER_ROOT1", rootEd25519: "A".repeat(43) });

    // Also verify ChatCryptoSession rotates Megolm session_id when server keyEpoch bumps 1 -> 2 and on > 1 reload check
    const senderPrep = await ChatCryptoSession.prepareNewDeviceForRegistration({
      proposedAccountId: accountId,
      matrixDeviceId: "SENDER_DEV1",
      inMemory: true,
    });
    await senderPrep.markRegistered({ signed_curve25519: 50 });

    const transport: ChatApiTransport = {
      uploadKeys: async () => ({ one_time_key_counts: { signed_curve25519: 50 } }),
      queryKeys: async () => ({
        device_keys: {
          [makeMatrixUserId(accountId)]: {
            SENDER_DEV1: senderPrep.uploadPayload.deviceKeysJson,
          },
        },
        failures: {},
        endorsements: {
          [makeMatrixUserId(accountId)]: {
            SENDER_DEV1: {
              isRoot: true,
              ed25519: senderPrep.session.ed25519Key,
              endorsedByMatrixDeviceId: null,
              endorsedByEd25519: null,
              endorsementSig: null,
            },
          },
        },
      }),
      claimKeys: async () => ({ one_time_keys: {}, failures: {} }),
      sendToDevice: async () => ({}),
      sync: async () => ({
        next_batch: "td:0|dl:0",
        to_device: { events: [] },
        device_lists: { changed: [] },
        device_one_time_keys_count: { signed_curve25519: 50 },
        device_unused_fallback_key_types: [],
      }),
    };

    const enc1 = await senderPrep.session.encryptMessageForConversation(transport, convId, [], 1, {
      msgtype: "m.text",
      body: "epoch 1 msg 1",
    });
    const enc2 = await senderPrep.session.encryptMessageForConversation(transport, convId, [], 1, {
      msgtype: "m.text",
      body: "epoch 1 msg 2",
    });
    expect(enc2["session_id"]).toBe(enc1["session_id"]);

    const enc3 = await senderPrep.session.encryptMessageForConversation(transport, convId, [], 2, {
      msgtype: "m.text",
      body: "epoch 2 rotated",
    });
    expect(enc3["session_id"]).not.toBe(enc1["session_id"]);

    await clearCryptoMeta();
    const afterClear = await readAllRoomEpochs(accountId, matrixDeviceId);
    expect(afterClear.size).toBe(0);
  });

  it("verifies Ed25519 device endorsements and NEVER shares Megolm room keys with unverified or root-swapped devices", async () => {
    const aliceAcc = crypto.randomUUID();
    const bobAcc = crypto.randomUUID();
    const bobUid = makeMatrixUserId(bobAcc);
    const aliceUid = makeMatrixUserId(aliceAcc);

    const alice = await ChatCryptoSession.prepareNewDeviceForRegistration({
      proposedAccountId: aliceAcc,
      matrixDeviceId: "ALICE_D1",
      inMemory: true,
    });
    await alice.markRegistered({ signed_curve25519: 50 });

    const bob1 = await ChatCryptoSession.prepareNewDeviceForRegistration({
      proposedAccountId: bobAcc,
      matrixDeviceId: "BOB_D1",
      inMemory: true,
    });
    await bob1.markRegistered({ signed_curve25519: 50 });

    const bob2 = await ChatCryptoSession.prepareLinkedDevice({
      accountId: bobAcc,
      matrixDeviceId: "BOB_D2",
      approvingDevice: { matrixDeviceId: "BOB_D1", ed25519: bob1.session.ed25519Key },
      inMemory: true,
    });
    await bob2.commitLinked();

    // Rogue unendorsed device (forged signature) + rogue second root injected by untrusted server
    const bobRogue = await ChatCryptoSession.prepareNewDeviceForRegistration({
      proposedAccountId: bobAcc,
      matrixDeviceId: "BOB_ROGUE",
      inMemory: true,
    });
    await bobRogue.markRegistered({ signed_curve25519: 50 });

    const bob2Sig = await bob1.session.endorseLinkedDevice("BOB_D2", bob2.ed25519Key);
    expect(
      await verifyDeviceEndorsementSignature({
        accountId: bobAcc,
        targetMatrixDeviceId: "BOB_D2",
        targetEd25519: bob2.ed25519Key,
        signerMatrixDeviceId: "BOB_D1",
        signerEd25519: bob1.session.ed25519Key,
        endorsementSigJson: bob2Sig,
      }),
    ).toBe(true);

    // Forged signature must fail client verification
    const forgedSig = JSON.stringify({
      [bobUid]: { "ed25519:BOB_D1": Buffer.alloc(64, 9).toString("base64").replace(/=+$/, "") },
    });
    expect(
      await verifyDeviceEndorsementSignature({
        accountId: bobAcc,
        targetMatrixDeviceId: "BOB_ROGUE",
        targetEd25519: bobRogue.session.ed25519Key,
        signerMatrixDeviceId: "BOB_D1",
        signerEd25519: bob1.session.ed25519Key,
        endorsementSigJson: forgedSig,
      }),
    ).toBe(false);

    const toDeviceSentTo: Record<string, Array<{ type: string; content: Record<string, unknown> }>> = {
      BOB_D1: [],
      BOB_D2: [],
      BOB_ROGUE: [],
    };
    const bobOtpkMap: Record<string, Record<string, Record<string, unknown>>> = {
      BOB_D1: bob1.uploadPayload.oneTimeKeys as Record<string, Record<string, unknown>>,
      BOB_D2: bob2.uploadPayload.oneTimeKeys as Record<string, Record<string, unknown>>,
      BOB_ROGUE: bobRogue.uploadPayload.oneTimeKeys as Record<string, Record<string, unknown>>,
    };

    let bobEndorsements: Record<string, EndorsementNodeInfo> = {
      BOB_D1: {
        isRoot: true,
        ed25519: bob1.session.ed25519Key,
        endorsedByMatrixDeviceId: null,
        endorsedByEd25519: null,
        endorsementSig: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      BOB_D2: {
        isRoot: false,
        ed25519: bob2.ed25519Key,
        endorsedByMatrixDeviceId: "BOB_D1",
        endorsedByEd25519: bob1.session.ed25519Key,
        endorsementSig: bob2Sig,
        createdAt: "2026-01-01T00:01:00.000Z",
      },
      BOB_ROGUE: {
        isRoot: false,
        ed25519: bobRogue.session.ed25519Key,
        endorsedByMatrixDeviceId: "BOB_D1",
        endorsedByEd25519: bob1.session.ed25519Key,
        endorsementSig: forgedSig,
        createdAt: "2026-01-01T00:02:00.000Z",
      },
    };

    const transport: ChatApiTransport = {
      uploadKeys: async () => ({ one_time_key_counts: { signed_curve25519: 50 } }),
      queryKeys: async () => ({
        device_keys: {
          [aliceUid]: { ALICE_D1: alice.uploadPayload.deviceKeysJson },
          [bobUid]: {
            BOB_D1: bob1.uploadPayload.deviceKeysJson,
            BOB_D2: bob2.uploadPayload.deviceKeysJson,
            BOB_ROGUE: bobRogue.uploadPayload.deviceKeysJson,
          },
        },
        failures: {},
        endorsements: {
          [aliceUid]: {
            ALICE_D1: {
              isRoot: true,
              ed25519: alice.session.ed25519Key,
              endorsedByMatrixDeviceId: null,
              endorsedByEd25519: null,
              endorsementSig: null,
            },
          },
          [bobUid]: bobEndorsements,
        },
      }),
      claimKeys: async (body) => {
        const reqOtk = (body["one_time_keys"] as Record<string, Record<string, string>>) ?? {};
        const claimed: Record<string, Record<string, Record<string, unknown>>> = {};
        for (const [uid, devMap] of Object.entries(reqOtk)) {
          if (uid !== bobUid) continue;
          claimed[uid] = {};
          for (const devId of Object.keys(devMap)) {
            const first = Object.entries(bobOtpkMap[devId] ?? {})[0];
            if (first) claimed[uid][devId] = { [first[0]]: first[1] };
          }
        }
        return { one_time_keys: claimed, failures: {} };
      },
      sendToDevice: async (eventType, _txnId, body) => {
        const msgs = (body["messages"] as Record<string, Record<string, Record<string, unknown>>>) ?? {};
        for (const [devId, content] of Object.entries(msgs[bobUid] ?? {})) {
          toDeviceSentTo[devId] = toDeviceSentTo[devId] ?? [];
          toDeviceSentTo[devId]!.push({ type: eventType, content });
        }
        return {};
      },
      sync: async () => ({
        next_batch: "td:0|dl:0",
        to_device: { events: [] },
        device_lists: { changed: [] },
        device_one_time_keys_count: { signed_curve25519: 50 },
        device_unused_fallback_key_types: [],
      }),
    };

    const convId = crypto.randomUUID();
    const encryptedPayload = await alice.session.encryptMessageForConversation(
      transport,
      convId,
      [bobAcc],
      1,
      { msgtype: "m.text", body: "Verified devices only" },
    );

    // Verified devices BOB_D1 and BOB_D2 MUST receive m.room.encrypted room key
    expect(toDeviceSentTo["BOB_D1"]!.some((e) => e.type === "m.room.encrypted")).toBe(true);
    expect(toDeviceSentTo["BOB_D2"]!.some((e) => e.type === "m.room.encrypted")).toBe(true);
    // Unverified BOB_ROGUE MUST NEVER receive m.room.encrypted (at most m.room_key.withheld)
    expect(toDeviceSentTo["BOB_ROGUE"]!.some((e) => e.type === "m.room.encrypted")).toBe(false);

    // Deliver sync to BOB_D1, BOB_D2, and BOB_ROGUE
    const syncTransportFor = (devId: string): ChatApiTransport => ({
      ...transport,
      sync: async () => ({
        next_batch: "td:1|dl:0",
        to_device: {
          events: toDeviceSentTo[devId]!.map((ev) => ({
            sender: aliceUid,
            type: ev.type,
            content: ev.content,
          })),
        },
        device_lists: { changed: [] },
        device_one_time_keys_count: { signed_curve25519: 49 },
        device_unused_fallback_key_types: [],
      }),
    });

    await bob1.session.syncOnce(syncTransportFor("BOB_D1"));
    await bob2.session.syncOnce(syncTransportFor("BOB_D2"));
    await bobRogue.session.syncOnce(syncTransportFor("BOB_ROGUE"));

    const eventEnvelope = {
      id: "evt1",
      senderMatrixUserId: aliceUid,
      createdAt: new Date().toISOString(),
      payloadJson: encryptedPayload,
    };

    const dec1 = await bob1.session.decryptRoomEvent(convId, eventEnvelope);
    const dec2 = await bob2.session.decryptRoomEvent(convId, eventEnvelope);
    const decRogue = await bobRogue.session.decryptRoomEvent(convId, eventEnvelope);

    expect(dec1.decrypted).toBe(true);
    expect(dec1.body).toBe("Verified devices only");
    expect(dec2.decrypted).toBe(true);
    expect(dec2.body).toBe("Verified devices only");
    expect(decRogue.decrypted).toBe(false);

    // Also test TOFU root-swap defense: even if server tries marking BOB_ROGUE as isRoot:true, Alice keeps BOB_D1 pinned & blocks BOB_ROGUE
    bobEndorsements = {
      ...bobEndorsements,
      BOB_ROGUE: {
        isRoot: true,
        ed25519: bobRogue.session.ed25519Key,
        endorsedByMatrixDeviceId: null,
        endorsedByEd25519: null,
        endorsementSig: null,
      },
    };
    toDeviceSentTo["BOB_ROGUE"] = [];
    await alice.session.syncOnce({
      ...transport,
      sync: async () => ({
        next_batch: "td:2|dl:1",
        to_device: { events: [] },
        device_lists: { changed: [bobUid] },
        device_one_time_keys_count: { signed_curve25519: 50 },
        device_unused_fallback_key_types: [],
      }),
    });
    await alice.session.encryptMessageForConversation(transport, convId, [bobAcc], 2, {
      msgtype: "m.text",
      body: "Root swap rejected",
    });
    expect(toDeviceSentTo["BOB_ROGUE"]!.some((e) => e.type === "m.room.encrypted")).toBe(false);
  });

  it("derives matching 3x4-digit ECDH-bound Matrix SAS codes and detects active ECIES/ECDH MITM", async () => {
    const linkId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const offer2 = await createDevice2EciesOffer();

    const ch1 = await establishDevice1EciesChannel(
      offer2.publicKeyBase64,
      {
        accountId,
        matrixUserId: makeMatrixUserId(accountId),
        username: "alice",
        displayName: "Alice",
        approvingMatrixDeviceId: "DEV1",
        approvingEd25519: "A".repeat(43),
      },
      { linkId },
    );

    const ch2 = await establishDevice2EciesChannel(offer2, ch1.initialMessage, { linkId });

    // Format must be 3x4-digit decimal Matrix SAS (>= 6 decimal digits)
    expect(ch1.sasCode).toMatch(/^\d{4} · \d{4} · \d{4}$/);
    expect(ch2.sasCode).toBe(ch1.sasCode);
    expect(ch2.welcomePayload.approvingMatrixDeviceId).toBe("DEV1");

    const sealed = ch2.channel.encrypt("device2_ed25519_proof");
    expect(ch1.channel.decrypt(sealed)).toBe("device2_ed25519_proof");

    // Simulate active ECIES+ECDH MITM forwarding tampered channel to a fresh Device 2 offer
    const bobOfferForMitm = await createDevice2EciesOffer();
    const mitmOffer = await createDevice2EciesOffer();
    const aliceToMitm = await establishDevice1EciesChannel(
      mitmOffer.publicKeyBase64,
      {
        accountId,
        matrixUserId: makeMatrixUserId(accountId),
        username: "alice",
        displayName: "Alice",
        approvingMatrixDeviceId: "DEV1",
        approvingEd25519: "A".repeat(43),
      },
      { linkId },
    );
    const mitmInbound = await establishDevice2EciesChannel(mitmOffer, aliceToMitm.initialMessage, { linkId });
    const mitmToBob = await establishDevice1EciesChannel(
      bobOfferForMitm.publicKeyBase64,
      mitmInbound.welcomePayload,
      { linkId },
    );
    const bobViaMitm = await establishDevice2EciesChannel(bobOfferForMitm, mitmToBob.initialMessage, { linkId });
    expect(aliceToMitm.sasCode).not.toBe(bobViaMitm.sasCode);
  });

  it("runs raw 1:1 Olm + Group Megolm round-trip and keyEpoch rotation via vodozemac", async () => {
    const aliceId = new cryptoWasm.UserId(`@${crypto.randomUUID()}:chat.bitebend.in`);
    const aliceDev = new cryptoWasm.DeviceId("ALICE_WEB1");
    const alice = await cryptoWasm.OlmMachine.initialize(aliceId, aliceDev);

    const bobUuid = crypto.randomUUID();
    const bobId = new cryptoWasm.UserId(`@${bobUuid}:chat.bitebend.in`);
    const bobDev = new cryptoWasm.DeviceId("BOB_WEB1");
    const bob = await cryptoWasm.OlmMachine.initialize(bobId, bobDev);

    const aliceReqs = await alice.outgoingRequests();
    const aliceUp = aliceReqs.find((r) => r.type === cryptoWasm.RequestType.KeysUpload) as cryptoWasm.KeysUploadRequest;
    const aliceBody = JSON.parse(aliceUp.body) as { device_keys: Record<string, unknown> };
    await alice.markRequestAsSent(aliceUp.id, aliceUp.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));

    const bobReqs = await bob.outgoingRequests();
    const bobUp = bobReqs.find((r) => r.type === cryptoWasm.RequestType.KeysUpload) as cryptoWasm.KeysUploadRequest;
    const bobBody = JSON.parse(bobUp.body) as {
      device_keys: Record<string, unknown>;
      one_time_keys: Record<string, unknown>;
    };
    await bob.markRequestAsSent(bobUp.id, bobUp.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));

    const aliceUidStr = aliceId.toString();
    const bobUidStr = bobId.toString();
    await alice.updateTrackedUsers([new cryptoWasm.UserId(aliceUidStr), new cryptoWasm.UserId(bobUidStr)]);
    const afterTrackReqs = await alice.outgoingRequests();
    for (const req of afterTrackReqs) {
      if (req.type === cryptoWasm.RequestType.KeysQuery) {
        await alice.markRequestAsSent(
          req.id ?? "",
          req.type,
          JSON.stringify({
            device_keys: {
              [aliceUidStr]: { ALICE_WEB1: aliceBody.device_keys },
              [bobUidStr]: { BOB_WEB1: bobBody.device_keys },
            },
            failures: {},
          }),
        );
      }
    }

    const claimReq = await alice.getMissingSessions([new cryptoWasm.UserId(aliceUidStr), new cryptoWasm.UserId(bobUidStr)]);
    expect(claimReq).toBeTruthy();
    const firstBobOtpkEntry = Object.entries(bobBody.one_time_keys)[0]!;
    await alice.markRequestAsSent(
      claimReq!.id,
      claimReq!.type,
      JSON.stringify({
        one_time_keys: {
          [bobUidStr]: {
            BOB_WEB1: {
              [firstBobOtpkEntry[0]]: firstBobOtpkEntry[1],
            },
          },
        },
        failures: {},
      }),
    );

    const roomStr = `!${crypto.randomUUID()}:chat.bitebend.in`;
    const encSettings = new cryptoWasm.EncryptionSettings();
    encSettings.sharingStrategy = cryptoWasm.CollectStrategy.allDevices();

    const toDeviceReqs = await alice.shareRoomKey(
      new cryptoWasm.RoomId(roomStr),
      [new cryptoWasm.UserId(aliceUidStr), new cryptoWasm.UserId(bobUidStr)],
      encSettings,
    );
    const toDeviceEventsForBob: unknown[] = [];
    for (const req of toDeviceReqs) {
      const parsed = JSON.parse(req.body) as { messages: Record<string, Record<string, unknown>> };
      const bobMsg = parsed.messages[bobUidStr]?.BOB_WEB1;
      if (bobMsg) {
        toDeviceEventsForBob.push({
          sender: aliceUidStr,
          type: req.event_type,
          content: bobMsg,
        });
      }
      await alice.markRequestAsSent(req.id, req.type, JSON.stringify({}));
    }

    await bob.receiveSyncChanges(
      JSON.stringify(toDeviceEventsForBob),
      new cryptoWasm.DeviceLists([], []),
      new Map([["signed_curve25519", 49]]),
    );

    const encrypted = await alice.encryptRoomEvent(
      new cryptoWasm.RoomId(roomStr),
      "m.room.message",
      JSON.stringify({ msgtype: "m.text", body: "Hello from Bitebend E2EE!" }),
    );
    const decrypted = await bob.decryptRoomEvent(
      JSON.stringify({
        type: "m.room.encrypted",
        event_id: "$evt1",
        sender: aliceUidStr,
        origin_server_ts: Date.now(),
        content: JSON.parse(encrypted),
      }),
      new cryptoWasm.RoomId(roomStr),
      new cryptoWasm.DecryptionSettings(cryptoWasm.TrustRequirement.Untrusted),
    );
    const decObj = JSON.parse(decrypted.event) as { content: { body: string } };
    expect(decObj.content.body).toBe("Hello from Bitebend E2EE!");
  });

  it("encrypts and decrypts chunked AES-256-GCM attachments and rejects tampered ciphertext", async () => {
    const raw = new Uint8Array(crypto.randomBytes(1.5 * 1024 * 1024 + 123));
    const { encryptedBytes, meta } = await encryptAttachmentBytes(raw, "receipt.png", "image/png");
    const decrypted = await decryptAttachmentBytes(encryptedBytes, meta);
    expect(Buffer.from(decrypted).equals(Buffer.from(raw))).toBe(true);

    const tampered = new Uint8Array(encryptedBytes);
    tampered[500] ^= 0xff;
    await expect(decryptAttachmentBytes(tampered, meta)).rejects.toThrow();
  });
});
