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

let poolInstance: any;
let dbInstance: any;
let pgliteInstance: PGlite | null = null;

const dbUrl = process.env.DATABASE_URL?.trim();
const isRailwayUrl = Boolean(
  dbUrl && (
    dbUrl.includes("railway") ||
    dbUrl.includes("rlwy.net") ||
    dbUrl.includes("railway.internal") ||
    dbUrl.includes("postgres.railway")
  )
);
const useExternalPg = Boolean(
  dbUrl &&
  process.env.USE_LOCAL_DB !== "true" &&
  !isRailwayUrl &&
  process.env.NODE_ENV === "production" &&
  !process.env.DEV
);

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

  pgliteInstance = new PGlite(dataDir);

  // Pool compatibility adapter for connect-pg-simple and raw pg consumers
  class PglitePoolAdapter extends EventEmitter {
    async query(textOrConfig: any, paramsOrCallback?: any, callback?: any): Promise<any> {
      let text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text;
      let params = Array.isArray(paramsOrCallback) ? paramsOrCallback : textOrConfig?.values || [];
      let cb = typeof paramsOrCallback === "function" ? paramsOrCallback : callback;

      try {
        if (!pgliteInstance) throw new Error("PGlite not initialized");
        const res = await pgliteInstance.query(text, params);
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
      if (pgliteInstance) {
        await pgliteInstance.close();
      }
    }
  }

  poolInstance = new PglitePoolAdapter();
  dbInstance = drizzlePglite(pgliteInstance, { schema });
}

let dbReadyPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (dbReadyPromise) return dbReadyPromise;

  if (useExternalPg) {
    dbReadyPromise = Promise.resolve();
    return dbReadyPromise;
  }

  dbReadyPromise = (async () => {
    try {
      if (!pgliteInstance) return;
      await pgliteInstance.waitReady;
      await pgliteInstance.exec(`
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
              await pgliteInstance.exec(stmt);
            } catch (ignore) {
              // Ignore already existing types/tables
            }
          }
        }
      }
      console.log("[db] Local PGlite database initialized and schema ready.");
    } catch (err: any) {
      console.error("[db] Error initializing local PGlite schema:", err.message);
    }
  })();

  return dbReadyPromise;
}

// Start initialization immediately
ensureDbReady().catch(() => {});

export const pool = poolInstance;
export const db = dbInstance;
export { pgliteInstance };
export * from "./schema";

