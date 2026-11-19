import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const rateLimitWindows = pgTable("rate_limit_windows", {
  key: text("key").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(1),
});

export const messagingAccounts = pgTable(
  "messaging_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull(),
    displayName: text("display_name").notNull(),
    identityStatus: text("identity_status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_messaging_accounts_username_lower").on(t.usernameLower)],
);

export const messagingContactClaims = pgTable(
  "messaging_contact_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),
    // Non-unique HMAC digest of unverified phone input (never used for login/merge)
    phoneHmac: text("phone_hmac").notNull(),
    phoneMasked: text("phone_masked").notNull(),
    source: text("source").notNull().default("qr_order_handoff"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_contact_claims_account").on(t.accountId),
    index("idx_contact_claims_phone_hmac").on(t.phoneHmac),
  ],
);

export const messagingDevices = pgTable(
  "messaging_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),
    deviceLabel: text("device_label").notNull(),
    matrixDeviceId: text("matrix_device_id").notNull(),
    identityKeyEd25519: text("identity_key_ed25519").notNull(),
    identityKeyCurve25519: text("identity_key_curve25519").notNull(),
    deviceKeysJson: jsonb("device_keys_json").$type<Record<string, unknown>>().notNull(),
    endorsedByDeviceId: uuid("endorsed_by_device_id"),
    endorsementSig: text("endorsement_sig"),
    status: text("status").notNull().default("pending_link"), // pending_link | active | revoked
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_messaging_devices_account_matrix").on(t.accountId, t.matrixDeviceId),
    index("idx_messaging_devices_account_status").on(t.accountId, t.status),
  ],
);

export const messagingOneTimePrekeys = pgTable(
  "messaging_one_time_prekeys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => messagingDevices.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").notNull(),
    publicKeyJson: jsonb("public_key_json").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_otpk_device_key").on(t.deviceId, t.keyId),
    index("idx_otpk_device_id").on(t.deviceId),
  ],
);

export const messagingFallbackKeys = pgTable("messaging_fallback_keys", {
  deviceId: uuid("device_id")
    .primaryKey()
    .references(() => messagingDevices.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  algorithm: text("algorithm").notNull(),
  publicKeyJson: jsonb("public_key_json").$type<unknown>().notNull(),
  used: boolean("used").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messagingSessions = pgTable(
  "messaging_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => messagingDevices.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_messaging_sessions_token_hash").on(t.tokenHash),
    index("idx_messaging_sessions_account").on(t.accountId),
  ],
);

export const messagingHandoffDrafts = pgTable(
  "messaging_handoff_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    draftTokenHash: text("draft_token_hash").notNull(),
    sourceHandoffId: uuid("source_handoff_id").notNull(),
    restaurantId: integer("restaurant_id").notNull(),
    maskedName: text("masked_name").notNull(),
    maskedPhone: text("masked_phone").notNull(),
    phoneHmac: text("phone_hmac").notNull(),
    status: text("status").notNull().default("pending"), // pending | superseded | activated | expired
    activatedAccountId: uuid("activated_account_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_handoff_drafts_token_hash").on(t.draftTokenHash),
    uniqueIndex("uq_handoff_drafts_source_handoff").on(t.sourceHandoffId),
  ],
);

export const messagingDeviceLinkTokens = pgTable(
  "messaging_device_link_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secretHash: text("secret_hash").notNull(),
    shortCode: text("short_code").notNull(),
    shortCodeExpiresAt: timestamp("short_code_expires_at", { withTimezone: true }).notNull(),
    claimCookieHash: text("claim_cookie_hash").notNull(),
    accountId: uuid("account_id"),
    approvingDeviceId: uuid("approving_device_id"),
    device2Label: text("device2_label").notNull(),
    device2MatrixId: text("device2_matrix_id").notNull(),
    device2Ed25519: text("device2_ed25519").notNull(),
    device2Curve25519: text("device2_curve25519").notNull(),
    device2KeysJson: jsonb("device2_keys_json").$type<Record<string, unknown>>().notNull(),
    device2OtpkJson: jsonb("device2_otpk_json").$type<Record<string, unknown>>().notNull(),
    device2EciesPub: text("device2_ecies_pub").notNull(),
    device1EciesOutMsg: text("device1_ecies_out_msg"),
    device1EndorsementSig: text("device1_endorsement_sig"),
    device2DeviceId: uuid("device2_device_id"),
    sasConfirmedAt: timestamp("sas_confirmed_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    status: text("status").notNull().default("pending_scan"), // pending_scan | responded | approved | expired | rejected
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_device_link_secret_hash").on(t.secretHash),
    index("idx_device_link_short_code").on(t.shortCode),
  ],
);

export const messagingConversations = pgTable(
  "messaging_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(), // direct | group
    title: text("title"),
    directPairKey: text("direct_pair_key"),
    keyEpoch: integer("key_epoch").notNull().default(1),
    nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(0),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_conversations_direct_pair").on(t.directPairKey)],
);

export const messagingConversationMembers = pgTable(
  "messaging_conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => messagingConversations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | member
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.accountId] }),
    index("idx_conv_members_account").on(t.accountId),
  ],
);

export const messagingMessages = pgTable(
  "messaging_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => messagingConversations.id, { onDelete: "cascade" }),
    senderAccountId: uuid("sender_account_id").notNull(),
    senderDeviceId: uuid("sender_device_id").notNull(),
    clientMsgId: uuid("client_msg_id").notNull(),
    serverSeq: bigint("server_seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull().default("m.room.encrypted"),
    keyEpoch: integer("key_epoch").notNull().default(1),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    attachmentIdsJson: jsonb("attachment_ids_json").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_messages_idempotency").on(t.conversationId, t.senderDeviceId, t.clientMsgId),
    uniqueIndex("uq_messages_server_seq").on(t.conversationId, t.serverSeq),
    index("idx_messages_conv_seq").on(t.conversationId, t.serverSeq),
  ],
);

export const messagingToDeviceEvents = pgTable(
  "messaging_to_device_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recipientAccountId: uuid("recipient_account_id").notNull(),
    recipientDeviceId: uuid("recipient_device_id").notNull(),
    senderAccountId: uuid("sender_account_id").notNull(),
    senderDeviceId: uuid("sender_device_id").notNull(),
    txnId: text("txn_id").notNull(),
    eventType: text("event_type").notNull(),
    contentJson: jsonb("content_json").$type<Record<string, unknown>>().notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_to_device_idemp").on(t.senderDeviceId, t.recipientDeviceId, t.eventType, t.txnId),
    index("idx_to_device_recipient").on(t.recipientDeviceId, t.id),
  ],
);

export const messagingDeviceListChanges = pgTable(
  "messaging_device_list_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    observerAccountId: uuid("observer_account_id").notNull(),
    subjectAccountId: uuid("subject_account_id").notNull(),
    reason: text("reason").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_device_list_observer").on(t.observerAccountId, t.consumedAt)],
);

export const messagingAttachments = pgTable(
  "messaging_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    uploaderAccountId: uuid("uploader_account_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    // Ciphertext stored base64-encoded so both node-postgres and PGlite handle identical blobs cleanly.
    // Plaintext filename and MIME type are NEVER stored server-side.
    blobBase64: text("blob_base64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_attachments_uploader").on(t.uploaderAccountId),
    index("idx_attachments_conversation").on(t.conversationId),
  ],
);

export const messagingAuditEvents = pgTable(
  "messaging_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventType: text("event_type").notNull(),
    accountId: uuid("account_id"),
    deviceId: uuid("device_id"),
    metaJson: jsonb("meta_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_audit_events_type").on(t.eventType, t.createdAt)],
);
