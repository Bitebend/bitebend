import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

const { Pool } = pg;

// Helper to find monorepo workspace root
function findWorkspaceRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(import.meta.dirname, "../../.."),
    path.resolve(import.meta.dirname, "../.."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json")) && fs.existsSync(path.join(c, "lib/db"))) {
      return c;
    }
  }
  return process.cwd();
}

// Helper to find migrations directory from various execution locations
function findMigrationsDir(): string | null {
  const wsRoot = findWorkspaceRoot();
  const candidates = [
    path.resolve(wsRoot, "lib/db/drizzle"),
    path.resolve(process.cwd(), "lib/db/drizzle"),
    path.resolve(process.cwd(), "../lib/db/drizzle"),
    path.resolve(process.cwd(), "../../lib/db/drizzle"),
    path.resolve(import.meta.dirname, "../drizzle"),
    path.resolve(import.meta.dirname, "../../drizzle"),
    path.resolve(import.meta.dirname, "../../../lib/db/drizzle"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

type MainDrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;

let poolInstance: InstanceType<typeof Pool>;
let dbInstance: MainDrizzleDb;
let pgliteInstance: PGlite | null = null;

const dbUrl = process.env.DATABASE_URL?.trim();
const isValidPostgresUrl = Boolean(
  dbUrl && (
    dbUrl.startsWith("postgres://") ||
    dbUrl.startsWith("postgresql://")
  )
);

const useExternalPg = Boolean(
  isValidPostgresUrl &&
  process.env.USE_LOCAL_DB !== "true"
);

const pgliteState: { current: PGlite | null } = { current: null };

async function runPgliteSchemaInit(instance: PGlite): Promise<void> {
  await instance.waitReady;
  await instance.exec(`
    CREATE TABLE IF NOT EXISTS "sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" ("expire");
  `);

  const migrationsDir = findMigrationsDir();
  if (migrationsDir) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const statements = content.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        try {
          await instance.exec(stmt);
        } catch (stmtErr: any) {
          const msg = String(stmtErr?.message ?? stmtErr ?? "");
          if (msg.includes("Aborted") || stmtErr?.name === "RuntimeError") {
            throw stmtErr;
          }
          // Ignore already existing types/tables/constraints
        }
      }
    }
  }

  await instance.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1`,
  );
}

if (useExternalPg && dbUrl) {
  console.log("[db] Connecting to external PostgreSQL database...");
  const p = new Pool({
    connectionString: dbUrl,
    max: 10,
  });

  p.on("error", (err) => {
    console.error("[db] pool error (connection will be replaced):", err.message);
  });

  poolInstance = p;
  dbInstance = drizzlePg(p, { schema });
} else {
  const wsRoot = findWorkspaceRoot();
  const dataDir = path.resolve(wsRoot, ".data/pglite");
  console.log(`[db] Initializing local persistent PGlite database at: ${dataDir}`);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const safeCreateDiskPglite = (dir: string): PGlite => {
    try {
      return new PGlite(dir);
    } catch (err: any) {
      console.warn("[db] Initial disk PGlite open failed, resetting local .data/pglite:", err?.message ?? err);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        return new PGlite(dir);
      } catch {
        return new PGlite();
      }
    }
  };

  pgliteState.current = safeCreateDiskPglite(dataDir);
  pgliteInstance = new Proxy(pgliteState.current, {
    get(_target, prop) {
      const current = pgliteState.current as any;
      const val = Reflect.get(current, prop, current);
      return typeof val === "function" ? val.bind(current) : val;
    },
    set(_target, prop, value) {
      return Reflect.set(pgliteState.current as any, prop, value);
    },
  });

  // Pool compatibility adapter for connect-pg-simple and raw pg consumers
  class PglitePoolAdapter extends EventEmitter {
    async query(textOrConfig: any, paramsOrCallback?: any, callback?: any): Promise<any> {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text;
      const params = Array.isArray(paramsOrCallback) ? paramsOrCallback : textOrConfig?.values || [];
      const cb = typeof paramsOrCallback === "function" ? paramsOrCallback : callback;

      try {
        await ensureDbReady();
        if (!pgliteState.current) throw new Error("PGlite not initialized");
        const res = await pgliteState.current.query(text, params);
        const result = {
          rows: res.rows,
          rowCount: res.rows.length,
          command: "",
          fields: res.fields || [],
        };
        if (cb) cb(null, result);
        return result;
      } catch (err) {
        if (cb) {
          cb(err);
          return { rows: [], rowCount: 0, command: "", fields: [] };
        }
        throw err;
      }
    }

    async connect() {
      return {
        query: this.query.bind(this),
        release: () => {},
      };
    }

    async end() {
      if (pgliteState.current) {
        await pgliteState.current.close().catch(() => {});
      }
    }
  }

  poolInstance = new PglitePoolAdapter() as unknown as InstanceType<typeof Pool>;
  dbInstance = drizzlePglite(pgliteInstance, { schema }) as unknown as MainDrizzleDb;
}

let dbReadyPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (dbReadyPromise) return dbReadyPromise;

  if (useExternalPg) {
    dbReadyPromise = Promise.resolve();
    return dbReadyPromise;
  }

  dbReadyPromise = (async () => {
    const wsRoot = findWorkspaceRoot();
    const dataDir = path.resolve(wsRoot, ".data/pglite");

    try {
      if (!pgliteState.current) return;
      await runPgliteSchemaInit(pgliteState.current);
      console.log("[db] Local PGlite database initialized and schema ready.");
      return;
    } catch (err: any) {
      console.error("[db] Error initializing local PGlite schema:", err?.message ?? err);
      await pgliteState.current?.close().catch(() => {});
    }

    // Attempt 2: wipe corrupted local PGlite data directory and reinitialize cleanly
    try {
      console.warn("[db] Recreating local PGlite data directory after initialization failure...");
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });
      const freshDisk = new PGlite(dataDir);
      pgliteState.current = freshDisk;
      await runPgliteSchemaInit(freshDisk);
      console.log("[db] Local PGlite database recovered on disk and schema ready.");
      return;
    } catch (diskErr: any) {
      console.error("[db] Disk PGlite recovery failed, falling back to in-memory PGlite:", diskErr?.message ?? diskErr);
      await pgliteState.current?.close().catch(() => {});
    }

    // Attempt 3: in-memory PGlite fallback so local preview/dev always boots
    const memPglite = new PGlite();
    pgliteState.current = memPglite;
    await runPgliteSchemaInit(memPglite);
    console.log("[db] In-memory PGlite fallback initialized and schema ready.");
  })();

  return dbReadyPromise;
}

// Start initialization immediately
ensureDbReady().catch(() => {});

export const pool = poolInstance;
export const db = dbInstance;
export { pgliteInstance };
export * from "./schema";

