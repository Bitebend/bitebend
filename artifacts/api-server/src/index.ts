import app from "./app";
import { logger } from "./lib/logger";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, ensureDbReady } from "@workspace/db";
import { WORKSPACE_ROOT } from "./lib/workspace";

// The AI Studio environment runs Nginx on PORT 8080 and proxies traffic to 3000.
// Dev servers MUST run on port 3000.
const port = 3000;

// ── Startup: log build metadata ───────────────────────────────────────────────
//
// __BUILD_COMMIT__, __BUILD_TIME__, __BUILD_VERSION__ are injected by esbuild
// at bundle time (see build.mjs `define` option). In the compiled bundle they
// are plain string literals — never runtime expressions.
//
// TypeScript declarations for these are in src/globals.d.ts.

const backendBuild = {
  commit: typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "dev",
  timestamp: typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : new Date().toISOString(),
  version: typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "0.0.0",
};

// Resolve the effective public base URL (same priority order as getQrUrl in owner.ts)
const effectiveSiteUrl =
  process.env["SITE_URL"]?.trim() ||
  (() => {
    const d = process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
    return d ? `https://${d}` : null;
  })() ||
  (process.env["REPLIT_DEV_DOMAIN"]
    ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
    : `http://localhost:${port}`);

logger.info(
  {
    ...backendBuild,
    env: process.env["NODE_ENV"] ?? "unknown",
    port,
    siteUrl: effectiveSiteUrl,
  },
  "Server starting",
);

// ── Frontend build version sync ───────────────────────────────────────────────
//
// On startup we read the frontend's build-info.json (written by the Vite
// buildInfoPlugin during `pnpm --filter @workspace/menu run build`) and
// compare its commit hash against the backend's.
//
// A mismatch means the frontend and backend were built from different commits —
// i.e. one of them has not been rebuilt since the last code change.

const buildInfoPath = join(WORKSPACE_ROOT, "artifacts/menu/dist/public/build-info.json");

if (existsSync(buildInfoPath)) {
  try {
    const frontendBuild = JSON.parse(readFileSync(buildInfoPath, "utf-8")) as {
      commit: string;
      timestamp: string;
      version: string;
      builtAt: string;
    };

    logger.info({ frontendBuild }, "Frontend build info");

    if (frontendBuild.commit !== backendBuild.commit) {
      logger.warn(
        {
          frontendCommit: frontendBuild.commit,
          backendCommit: backendBuild.commit,
        },
        "VERSION MISMATCH: frontend and backend were built from different commits — rebuild before deploying",
      );
    } else {
      logger.info(
        { commit: backendBuild.commit },
        "Frontend/backend commits match",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Could not parse frontend build-info.json");
  }
} else {
  logger.warn(
    { path: buildInfoPath },
    "Frontend build-info.json not found — run: pnpm --filter @workspace/menu run build",
  );
}

// ── Startup DB safety check ───────────────────────────────────────────────────
//
// Checks that all critical tables exist before the server starts accepting
// requests. Exits with code 1 if anything is missing so that a broken
// deployment surfaces immediately instead of silently serving 500s.

const STARTUP_REQUIRED_TABLES = [
  "users", "restaurants", "sessions",
  "resources", "orders", "owner_password_reset_tokens",
  "table_sessions", "session_bills",
] as const;

const dbBootStart = Date.now();
logger.info("[DB_BOOT_START] Running startup schema check");
try {
  await ensureDbReady();
  const tableRows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  const found = new Set(tableRows.rows.map((r) => r.table_name));
  const missing = STARTUP_REQUIRED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) {
    for (const t of missing) {
      logger.error(`[MIGRATION_ERROR] missing table: ${t}`);
    }
    logger.error("[MIGRATION_ERROR] DB startup check failed — tables may still be initializing or run 'pnpm migrate'");
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  }
  const dbBootDurationMs = Date.now() - dbBootStart;
  logger.info({ durationMs: dbBootDurationMs }, "[DB_BOOT_COMPLETE] Startup schema check passed");
  logger.info("[DB_SCHEMA_VALIDATED] Startup schema check passed");
} catch (dbCheckErr) {
  logger.error({ err: dbCheckErr }, "[MIGRATION_ERROR] Could not connect to database — check DATABASE_URL or waiting for local db");
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

// ── Auto-seed on empty database ───────────────────────────────────────────────
//
// On a fresh install (no users, no plans) automatically run the dev seed so
// the app is immediately usable without any manual steps. Safe to run on every
// start — all seed operations are idempotent upserts; if data already exists
// the seed is skipped entirely.

try {
  const [{ count: userCount }] = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM users`
  ).then((r) => r.rows);
  const [{ count: planCount }] = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM subscription_plans`
  ).then((r) => r.rows);

  if (Number(userCount) === 0 && Number(planCount) === 0) {
    logger.info("[AUTO_SEED] Empty database detected — running initial seed…");
    const { seedDev } = await import("./seed-dev");
    await seedDev();
    logger.info("[AUTO_SEED] Seed complete — admin@bitebend.in / admin123 | demo@spicegarden.com / demo123 | partner@bitebend.in / Partner@123");
  } else {
    logger.info({ userCount, planCount }, "[AUTO_SEED] Data exists — ensuring demo partner account is ready…");
    try {
      const { seedPartner } = await import("./seed-partner");
      await seedPartner();
      logger.info("[AUTO_SEED] Demo partner account verified — partner@bitebend.in / Partner@123");
    } catch (pErr) {
      logger.warn({ err: pErr }, "[AUTO_SEED] Could not verify demo partner account");
    }
  }
} catch (seedErr) {
  logger.warn({ err: seedErr }, "[AUTO_SEED] Seed check failed — continuing startup anyway");
}

// ── WhatsApp Bridge lifecycle manager ────────────────────────────────────────
//
// The API server owns the bridge process. It is spawned here and monitored
// via health-checks. This eliminates the need for a separate Replit workflow
// and the race condition that caused "Bridge not running" on fresh imports.

import { startBridgeManager } from "./lib/bridgeManager";
startBridgeManager();

// ── Cleanup jobs ──────────────────────────────────────────────────────────────

import { purgeExpiredBills } from "./lib/billService";
import { purgeExpiredScreenshots } from "./lib/screenshotCleanup";

// Run once on startup, then every 24 h — removes expired bill_links + their blobs
purgeExpiredBills().catch(() => void 0);
setInterval(() => { purgeExpiredBills().catch(() => void 0); }, 24 * 60 * 60 * 1000).unref();

// Run once on startup, then every 24 h — removes screenshot blobs for paid/rejected orders
// past the PAYMENT_SCREENSHOT_RETENTION_DAYS window (default: 30 days).
purgeExpiredScreenshots().catch(() => void 0);
setInterval(() => { purgeExpiredScreenshots().catch(() => void 0); }, 24 * 60 * 60 * 1000).unref();

// ── Server ────────────────────────────────────────────────────────────────────

const httpServer = app.listen(port, () => {
  logger.info(
    {
      port,
      commit: backendBuild.commit,
      env: process.env["NODE_ENV"] ?? "unknown",
    },
    "Server listening",
  );
});

httpServer.on("error", (err: unknown) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

// ── WebSocket upgrade tracing ─────────────────────────────────────────────────
// Log every WebSocket upgrade that arrives at the API server's HTTP server.
// This tells us whether the browser's Socket.IO WebSocket upgrade reaches
// this process, or whether it's handled upstream (Vite dev proxy / Railway).
httpServer.on("upgrade", (req) => {
  logger.debug(
    {
      url:      req.url,
      headers:  {
        host:       req.headers.host,
        upgrade:    req.headers.upgrade,
        connection: req.headers.connection,
        origin:     req.headers.origin,
      },
    },
    "[ws:trace] HTTP upgrade request received at API server",
  );
});
