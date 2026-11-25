export interface PgQueryClient {
  query: <T = Record<string, unknown>>(text: string) => Promise<{ rows: T[] }>;
}

export interface NormalizedPgIdentity {
  protocol: "postgres";
  username: string;
  host: string;
  port: number;
  database: string;
  searchPath: string;
  canonicalKey: string;
}

export const MAIN_TEST_DB_SAFETY_CHECKS = [
  "1. Verify process.env.TEST_PG_URL is explicitly configured and is a valid postgres:// or postgresql:// URL (never fall back to DATABASE_URL).",
  "2. Parse and normalize TEST_PG_URL connection identity (host, port, database, username, search_path).",
  "3. Reject immediately if TEST_PG_URL normalized identity matches DATABASE_URL or CHAT_DATABASE_URL, regardless of NODE_ENV.",
  "4. Reject immediately if TEST_PG_URL normalized identity matches TEST_CHAT_PG_URL (Main API and Chat API test databases must remain independent).",
  "5. Reject any database identity whose database name looks like a production target without explicit test isolation.",
  "6. Verify live connected PostgreSQL database identity (SELECT current_database(), current_schema()) before executing migrations, truncation, cleanup, or fixture seeding.",
] as const;

export function normalizePgConnectionIdentity(rawUrl: string, label: string): NormalizedPgIdentity {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(`[TEST_DB_SAFETY_ABORT] ${label} is empty.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`[TEST_DB_SAFETY_ABORT] ${label} is not a valid URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `[TEST_DB_SAFETY_ABORT] ${label} must use postgres:// or postgresql:// protocol (got ${parsed.protocol}).`,
    );
  }

  const rawHost = decodeURIComponent(parsed.hostname || "").trim().toLowerCase();
  const host = rawHost === "127.0.0.1" || rawHost === "::1" ? "localhost" : rawHost;
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`[TEST_DB_SAFETY_ABORT] ${label} has invalid host or port.`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).trim();
  if (!database) {
    throw new Error(`[TEST_DB_SAFETY_ABORT] ${label} must specify an explicit target database name.`);
  }

  const username = decodeURIComponent(parsed.username || "").trim();
  const optionsParam = parsed.searchParams.get("options") ?? "";
  const searchPathMatch = optionsParam.match(/search_path=([^\s,&]+)/i);
  const searchPath = (searchPathMatch?.[1] ?? parsed.searchParams.get("schema") ?? "public").trim();

  const canonicalKey = `postgres://${username}@${host}:${port}/${database}?schema=${searchPath}`;

  return {
    protocol: "postgres",
    username,
    host,
    port,
    database,
    searchPath,
    canonicalKey,
  };
}

function sameDbTarget(a: NormalizedPgIdentity, b: NormalizedPgIdentity): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.database.toLowerCase() === b.database.toLowerCase() &&
    a.searchPath.toLowerCase() === b.searchPath.toLowerCase()
  );
}

/**
 * Mandatory Test Database Safety Guard for Main API external PostgreSQL tests.
 * Runs BEFORE any migrations, truncation, cleanup, seeding, or test execution.
 * NODE_ENV !== 'production' is NOT accepted as bypass authorization.
 */
export function assertSafeMainTestDatabase(env: NodeJS.ProcessEnv = process.env): {
  testUrl: string;
  identity: NormalizedPgIdentity;
} {
  const testUrl = env["TEST_PG_URL"]?.trim();
  if (!testUrl) {
    throw new Error(
      "[TEST_DB_SAFETY_ABORT] TEST_PG_URL is not configured. Refusing to run Main API external PostgreSQL tests or fall back to DATABASE_URL.",
    );
  }

  const testIdentity = normalizePgConnectionIdentity(testUrl, "TEST_PG_URL");

  const prodDbUrl = env["DATABASE_URL"]?.trim();
  if (prodDbUrl && (prodDbUrl.startsWith("postgres://") || prodDbUrl.startsWith("postgresql://"))) {
    const prodIdentity = normalizePgConnectionIdentity(prodDbUrl, "DATABASE_URL");
    if (sameDbTarget(testIdentity, prodIdentity) || testIdentity.canonicalKey === prodIdentity.canonicalKey) {
      throw new Error(
        `[TEST_DB_SAFETY_ABORT] TEST_PG_URL (${testIdentity.host}:${testIdentity.port}/${testIdentity.database}) resolves to the same target as DATABASE_URL. Aborting immediately (NODE_ENV=${env["NODE_ENV"] ?? "unset"} does not override this guard).`,
      );
    }
  }

  const prodChatUrl = env["CHAT_DATABASE_URL"]?.trim();
  if (prodChatUrl && (prodChatUrl.startsWith("postgres://") || prodChatUrl.startsWith("postgresql://"))) {
    const chatProdIdentity = normalizePgConnectionIdentity(prodChatUrl, "CHAT_DATABASE_URL");
    if (sameDbTarget(testIdentity, chatProdIdentity)) {
      throw new Error(
        `[TEST_DB_SAFETY_ABORT] TEST_PG_URL (${testIdentity.host}:${testIdentity.port}/${testIdentity.database}) collides with CHAT_DATABASE_URL. Aborting immediately.`,
      );
    }
  }

  const testChatUrl = env["TEST_CHAT_PG_URL"]?.trim();
  if (testChatUrl && (testChatUrl.startsWith("postgres://") || testChatUrl.startsWith("postgresql://"))) {
    const testChatIdentity = normalizePgConnectionIdentity(testChatUrl, "TEST_CHAT_PG_URL");
    if (sameDbTarget(testIdentity, testChatIdentity)) {
      throw new Error(
        `[TEST_DB_SAFETY_ABORT] TEST_PG_URL (${testIdentity.host}:${testIdentity.port}/${testIdentity.database}) matches TEST_CHAT_PG_URL. Main API and Chat API test databases must be independent.`,
      );
    }
  }

  const dbLower = testIdentity.database.toLowerCase();
  if ((dbLower === "production" || dbLower === "prod" || dbLower.includes("prod")) && !dbLower.includes("test")) {
    throw new Error(
      `[TEST_DB_SAFETY_ABORT] Refusing to execute destructive test operations against suspicious database name "${testIdentity.database}".`,
    );
  }

  return { testUrl, identity: testIdentity };
}

export async function verifyConnectedMainTestDbIdentity(
  client: PgQueryClient,
  expectedIdentity: NormalizedPgIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ currentDatabase: string; currentSchema: string }> {
  const res = await client.query<{ current_db: string; current_schema: string }>(
    `SELECT current_database() AS current_db, current_schema() AS current_schema`,
  );
  const currentDatabase = res.rows[0]?.current_db ?? "";
  const currentSchema = res.rows[0]?.current_schema ?? "";
  if (!currentDatabase || currentDatabase.toLowerCase() !== expectedIdentity.database.toLowerCase()) {
    throw new Error(
      `[TEST_DB_SAFETY_ABORT] Connected database "${currentDatabase}" does not match expected TEST_PG_URL database "${expectedIdentity.database}".`,
    );
  }
  const expectedSchema = expectedIdentity.searchPath.split(",")[0]?.trim() || "public";
  if (!currentSchema || currentSchema.toLowerCase() !== expectedSchema.toLowerCase()) {
    throw new Error(
      `[TEST_DB_SAFETY_ABORT] Connected schema "${currentSchema}" does not match expected TEST_PG_URL search_path/schema "${expectedSchema}".`,
    );
  }

  const prodDbUrl = env["DATABASE_URL"]?.trim();
  if (prodDbUrl && (prodDbUrl.startsWith("postgres://") || prodDbUrl.startsWith("postgresql://"))) {
    const prodId = normalizePgConnectionIdentity(prodDbUrl, "DATABASE_URL");
    if (
      prodId.host === expectedIdentity.host &&
      prodId.port === expectedIdentity.port &&
      prodId.database.toLowerCase() === currentDatabase.toLowerCase()
    ) {
      throw new Error(
        `[TEST_DB_SAFETY_ABORT] Live connected database "${currentDatabase}" matches DATABASE_URL target. Aborting before any writes.`,
      );
    }
  }

  return { currentDatabase, currentSchema };
}
