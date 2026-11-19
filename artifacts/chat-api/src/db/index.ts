import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const { Pool } = pg;

export function findWorkspaceRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(import.meta.dirname, "../../../.."),
    path.resolve(import.meta.dirname, "../../.."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json")) && fs.existsSync(path.join(c, "artifacts/chat-api"))) {
      return c;
    }
  }
  return process.cwd();
}

export function findMigrationsDir(): string | null {
  const wsRoot = findWorkspaceRoot();
  const candidates = [
    path.resolve(import.meta.dirname, "migrations"),
    path.resolve(import.meta.dirname, "../drizzle"),
    path.resolve(wsRoot, "artifacts/chat-api/src/drizzle"),
    path.resolve(wsRoot, "artifacts/chat-api/dist/migrations"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).some((f) => f.endsWith(".sql"))) {
      return c;
    }
  }
  return null;
}

export interface ChatPoolAdapter {
  query: <T = Record<string, unknown>>(
    textOrConfig: string | { text: string; values?: unknown[] },
    paramsOrCallback?: unknown,
    callback?: unknown,
  ) => Promise<{ rows: T[]; rowCount: number }>;
  end: () => Promise<void>;
}

const chatDbUrl = process.env["CHAT_DATABASE_URL"]?.trim();
const isProd = process.env["NODE_ENV"] === "production";
const isValidPostgresUrl = Boolean(
  chatDbUrl && (chatDbUrl.startsWith("postgres://") || chatDbUrl.startsWith("postgresql://")),
);

if (isProd && !isValidPostgresUrl && process.env["USE_LOCAL_DB"] !== "true") {
  throw new Error(
    "FATAL: CHAT_DATABASE_URL is required in production. Refusing to fall back to DATABASE_URL.",
  );
}

const useExternalPg = Boolean(isValidPostgresUrl && process.env["USE_LOCAL_DB"] !== "true");

type ChatDrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;

let poolInstance: ChatPoolAdapter;
let dbInstance: ChatDrizzleDb;
let pgliteInstance: PGlite | null = null;
let pgPoolInstance: InstanceType<typeof Pool> | null = null;

class PglitePoolAdapter extends EventEmitter implements ChatPoolAdapter {
  async query<T = Record<string, unknown>>(
    textOrConfig: string | { text: string; values?: unknown[] },
    paramsOrCallback?: unknown,
    callback?: unknown,
  ): Promise<{ rows: T[]; rowCount: number }> {
    const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text;
    const params = Array.isArray(paramsOrCallback)
      ? paramsOrCallback
      : typeof textOrConfig === "object" && Array.isArray(textOrConfig?.values)
        ? textOrConfig.values
        : [];
    const cb = typeof paramsOrCallback === "function" ? paramsOrCallback : callback;

    try {
      if (!pgliteInstance) throw new Error("PGlite not initialized");
      await ensureChatDbReady();
      const res = await pgliteInstance.query<T>(text, params);
      const result = { rows: res.rows, rowCount: res.rows.length };
      if (typeof cb === "function") cb(null, result);
      return result;
    } catch (err) {
      if (typeof cb === "function") {
        cb(err);
        return { rows: [], rowCount: 0 };
      }
      throw err;
    }
  }

  async end(): Promise<void> {
    if (pgliteInstance) {
      await pgliteInstance.close();
    }
  }
}

if (useExternalPg && chatDbUrl) {
  const p = new Pool({
    connectionString: chatDbUrl,
    max: 15,
  });
  p.on("error", (err) => {
    console.error("[chat-db] pool error:", err.message);
  });
  pgPoolInstance = p;
  poolInstance = p as unknown as ChatPoolAdapter;
  dbInstance = drizzlePg(p, { schema });
} else {
  const wsRoot = findWorkspaceRoot();
  const overrideDir = process.env["CHAT_PGLITE_DIR"]?.trim();
  const dataDir = overrideDir || path.resolve(wsRoot, ".data/pglite-chat");
  if (dataDir !== ":memory:" && !dataDir.startsWith("memory://") && !fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  pgliteInstance = dataDir === ":memory:" ? new PGlite() : new PGlite(dataDir);
  poolInstance = new PglitePoolAdapter();
  dbInstance = drizzlePglite(pgliteInstance, { schema }) as unknown as ChatDrizzleDb;
}

let readyPromise: Promise<void> | null = null;

export async function runChatMigrations(): Promise<void> {
  const migrationsDir = findMigrationsDir();
  if (!migrationsDir) {
    throw new Error("Could not locate chat-api migrations directory containing .sql files");
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`No .sql migration files found in ${migrationsDir}`);
  }

  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    if (pgliteInstance) {
      for (const stmt of statements) {
        await pgliteInstance.exec(stmt);
      }
    } else if (pgPoolInstance) {
      const client = await pgPoolInstance.connect();
      try {
        await client.query("BEGIN");
        for (const stmt of statements) {
          await client.query(stmt);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      for (const stmt of statements) {
        await poolInstance.query(stmt);
      }
    }
  }
}

export async function ensureChatDbReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      if (pgliteInstance) {
        await pgliteInstance.waitReady;
      }
      await runChatMigrations();
    } catch (err) {
      readyPromise = null;
      throw err;
    }
  })();
  return readyPromise;
}

export const chatPool = poolInstance;
export const chatDb = dbInstance;
export const isExternalPostgres = useExternalPg;
export { pgliteInstance };
export * from "./schema";
