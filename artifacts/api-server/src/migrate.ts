import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}
interface Journal {
  entries: JournalEntry[];
}

const REQUIRED_TABLES = [
  "users",
  "restaurants",
  "menu_categories",
  "menu_items",
  "orders",
  "order_items",
  "notifications",
  "restaurant_tables",
  "platform_settings",
  "subscription_plans",
  "subscription_transactions",
  "admin_password_reset_tokens",
  "owner_password_reset_tokens",
  "image_blobs",
  "bill_links",
  "resources",
  "sessions",
  "table_sessions",
  "session_bills",
  "payment_screenshot_inbox",
  "partners",
  "partner_commissions",
  "partner_audit_logs",
  "restaurant_hardware_orders",
] as const;

const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "resources",                     column: "visible_to"       },
  { table: "resources",                     column: "approval_status"  },
  { table: "owner_password_reset_tokens",   column: "user_id"          },
  { table: "owner_password_reset_tokens",   column: "token"            },
  { table: "bill_links",                    column: "short_id"         },
  { table: "restaurants",                   column: "razorpay_webhook_secret" },
  { table: "restaurants",                   column: "partner_id"       },
  { table: "orders",                        column: "verification_method" },
  { table: "orders",                        column: "verified_by"      },
  { table: "orders",                        column: "verified_at"      },
  { table: "orders",                        column: "session_id"       },
  { table: "table_sessions",               column: "restaurant_id"    },
  { table: "table_sessions",               column: "table_number"     },
  { table: "table_sessions",               column: "status"           },
  // 0019_takeaway_sessions
  { table: "table_sessions",               column: "session_type"     },
  { table: "table_sessions",               column: "customer_phone"   },
  // 0016_session_bills
  { table: "session_bills",                column: "session_id"       },
  { table: "session_bills",                column: "restaurant_id"    },
  { table: "session_bills",                column: "bill_number"      },
  { table: "session_bills",                column: "total"            },
  { table: "session_bills",                column: "status"           },
  // 0017_session_bill_payment
  { table: "session_bills",                column: "customer_phone"   },
  { table: "session_bills",                column: "screenshot_url"   },
  // 0018_session_bill_resend
  { table: "session_bills",                column: "resent_at"        },
  { table: "session_bills",                column: "resent_count"     },
  // 0028_payment_screenshot_inbox
  { table: "payment_screenshot_inbox",     column: "restaurant_id"    },
  { table: "payment_screenshot_inbox",     column: "received_at"      },
  { table: "payment_screenshot_inbox",     column: "match_status"     },
  { table: "payment_screenshot_inbox",     column: "image_hash"       },
  // 0031_partner_system
  { table: "partners",                     column: "referral_code"    },
  { table: "partner_commissions",          column: "subscription_transaction_id" },
  // 0034_qr_stands_and_hardware
  { table: "restaurant_hardware_orders",   column: "restaurant_id"    },
  { table: "restaurant_hardware_orders",   column: "stand_quantity"   },
  { table: "restaurant_hardware_orders",   column: "collection_status"},
];

/**
 * When a database was initially set up via `drizzle-kit push` (no migration
 * files), the `__drizzle_migrations` journal table does not exist and all
 * tables are already present. Running `migrate()` would try to execute
 * CREATE TABLE for each table and fail with "already exists".
 *
 * This function detects that situation and stamps every migration in the
 * journal as already applied, so the next `migrate()` call becomes a no-op.
 */
async function stampPushInitialisedDb(folder: string) {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
      id         SERIAL PRIMARY KEY,
      hash       text   NOT NULL,
      created_at bigint
    )
  `);

  const journalPath = path.join(folder, "meta/_journal.json");
  if (!existsSync(journalPath)) return;

  const journal: Journal = JSON.parse(readFileSync(journalPath, "utf-8"));

  const tableRows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  const existingTables = new Set(tableRows.rows.map((r) => r.table_name));

  for (const entry of journal.entries) {
    const sqlPath = path.join(folder, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) break;
    const sqlContent = readFileSync(sqlPath, "utf-8");

    // Only stamp this migration as already applied if every table it
    // creates or alters already exists in the database.
    // Because migrations form a strict dependency sequence, stop stamping
    // immediately at the first unapplied migration so subsequent migrations
    // are executed by migrate() in order rather than falsely stamped.
    const createdTables = [...sqlContent.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)].map((m) => m[1]);
    const alteredTables = [...sqlContent.matchAll(/ALTER TABLE (?:ONLY )?"?(\w+)"?/gi)].map((m) => m[1]);

    const allCreatedExist = createdTables.every((t) => existingTables.has(t));
    const allAlteredExist = alteredTables.every((t) => existingTables.has(t));

    if (!allCreatedExist || !allAlteredExist) {
      console.log(`[DB_BOOT] Stopping stamping at ${entry.tag} (schema prerequisites not met)`);
      break;
    }

    const hash = createHash("sha256").update(sqlContent).digest("hex");
    const createdAt = entry.when;
    await db.execute(
      sql`INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES (${hash}, ${createdAt})`
    );
    console.log(`[DB_BOOT] stamped ${entry.tag} (when=${createdAt})`);
  }
}

/**
 * Detects and removes invalid migration stamps in drizzle.__drizzle_migrations.
 * If a prior failed deployment or flawed bootstrap stamped future migrations
 * while their prerequisite tables (e.g., 'partners' from 0031) were never created,
 * Drizzle will erroneously skip the missing migration and fail on later ones
 * (e.g., 0034 failing with "relation 'partners' does not exist").
 *
 * This function finds the earliest migration whose created tables do NOT exist,
 * and clears any __drizzle_migrations records with created_at >= that migration's timestamp,
 * ensuring Drizzle applies the migration chain sequentially from that point forward.
 */
async function cleanupCorruptMigrationStamps(folder: string) {
  try {
    const schemaCheck = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      ) as exists
    `);
    if (!schemaCheck.rows[0]?.exists) return;

    const journalPath = path.join(folder, "meta/_journal.json");
    if (!existsSync(journalPath)) return;

    const journal: Journal = JSON.parse(readFileSync(journalPath, "utf-8"));

    const tableRows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const existingTables = new Set(tableRows.rows.map((r) => r.table_name));

    let earliestMissingTimestamp: number | null = null;
    let earliestMissingTag: string | null = null;

    for (const entry of journal.entries) {
      const sqlPath = path.join(folder, `${entry.tag}.sql`);
      if (!existsSync(sqlPath)) continue;
      const sqlContent = readFileSync(sqlPath, "utf-8");
      const createdTables = [...sqlContent.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)].map((m) => m[1]);
      const missingTable = createdTables.find((t) => !existingTables.has(t));
      if (missingTable) {
        earliestMissingTimestamp = entry.when;
        earliestMissingTag = entry.tag;
        break;
      }
    }

    if (earliestMissingTimestamp != null) {
      const stampCheck = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text as count FROM drizzle."__drizzle_migrations" 
        WHERE created_at >= ${earliestMissingTimestamp}
      `);
      const count = Number(stampCheck.rows[0]?.count ?? 0);
      if (count > 0) {
        console.warn(
          `[DB_BOOT] Detected ${count} premature/corrupt migration stamp(s) >= ${earliestMissingTimestamp} (${earliestMissingTag}). Required table(s) not found in database. Cleaning up stamps so migration can run sequentially.`
        );
        await db.execute(sql`
          DELETE FROM drizzle."__drizzle_migrations" WHERE created_at >= ${earliestMissingTimestamp}
        `);
      }
    }
  } catch (err) {
    console.warn("[DB_BOOT] Warning during migration stamp cleanup check:", err);
  }
}

/**
 * The `sessions` table is managed by connect-pg-simple, not Drizzle ORM.
 * It is the only table created at runtime rather than via a migration file
 * because connect-pg-simple manages its own DDL outside of Drizzle.
 */
async function ensureSessionsTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "sessions" (
      "sid"    varchar        NOT NULL,
      "sess"   json           NOT NULL,
      "expire" timestamp(6)   NOT NULL,
      CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
    ) WITH (OIDS=FALSE)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_sessions_expire" ON "sessions" ("expire")
  `);
  console.log("[DB_BOOT] sessions table ready");
}

/**
 * Post-migration schema validation.
 * Checks that every required table and column exists.
 * Logs [DB_SCHEMA_VALIDATED] on success or [MIGRATION_ERROR] listing
 * every missing object, then throws so the process exits non-zero.
 */
async function validateSchema(): Promise<void> {
  const tableRows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const existingTables = new Set(tableRows.rows.map((r) => r.table_name));

  const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));

  const columnRows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const existingColumns = new Set(
    columnRows.rows.map((r) => `${r.table_name}.${r.column_name}`)
  );
  const missingColumns = REQUIRED_COLUMNS
    .map(({ table, column }) => `${table}.${column}`)
    .filter((key) => !existingColumns.has(key));

  const errors: string[] = [
    ...missingTables.map((t) => `missing table: ${t}`),
    ...missingColumns.map((c) => `missing column: ${c}`),
  ];

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[MIGRATION_ERROR] ${e}`);
    }
    console.error("[MIGRATION_ERROR] Run: pnpm migrate");
    throw new Error(`Schema validation failed: ${errors.join("; ")}`);
  }

  console.log("[DB_SCHEMA_VALIDATED] All required tables present");
  console.log("[DB_SCHEMA_VALIDATED] All required columns present");
  console.log("[DB_SCHEMA_VALIDATED] Schema validation passed");
}

function logDatabaseError(err: unknown) {
  const e = err as any;
  const target = e?.cause ?? e;
  console.error("[MIGRATION_ERROR] Underlying PostgreSQL/database error details:");
  console.error(`  message: ${e?.message ?? String(e)}`);
  console.error(`  code: ${target?.code ?? e?.code ?? "none"}`);
  console.error(`  detail: ${target?.detail ?? e?.detail ?? "none"}`);
  console.error(`  hint: ${target?.hint ?? e?.hint ?? "none"}`);
  console.error(`  position: ${target?.position ?? e?.position ?? "none"}`);
  console.error(`  table: ${target?.table ?? e?.table ?? "none"}`);
  console.error(`  column: ${target?.column ?? e?.column ?? "none"}`);
  console.error(`  constraint: ${target?.constraint ?? e?.constraint ?? "none"}`);
  console.error(`  schema: ${target?.schema ?? e?.schema ?? "none"}`);
  if (e?.cause) {
    console.error(`  cause: ${e.cause?.message ?? String(e.cause)}`);
    if (e.cause?.code) console.error(`  cause.code: ${e.cause.code}`);
    if (e.cause?.detail) console.error(`  cause.detail: ${e.cause.detail}`);
    if (e.cause?.hint) console.error(`  cause.hint: ${e.cause.hint}`);
    if (e.cause?.position) console.error(`  cause.position: ${e.cause.position}`);
  }
  console.error(`  stack: ${e?.stack ?? "none"}`);
}

async function main() {
  const mainStart = Date.now();
  console.log("[DB_BOOT] Starting database bootstrap");

  // Resolve migrations folder — works with both tsx (import.meta.url) and
  // esbuild-compiled output (platform:node injects __dirname as a literal).
  const migrationsFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations"
  );
  console.log(`[DB_BOOT] migrations folder: ${migrationsFolder}`);

  await ensureSessionsTable();
  await cleanupCorruptMigrationStamps(migrationsFolder);

  const migrationStart = Date.now();
  console.log("[MIGRATION_START] Applying migrations...");
  try {
    await migrate(db, { migrationsFolder });
    console.log(`[MIGRATION_COMPLETE] All migrations applied in ${Date.now() - migrationStart}ms`);
    console.log("[DB_MIGRATIONS_OK] All migrations applied");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = String((err as any)?.cause?.message ?? "");
    const causeCode = String((err as any)?.cause?.code ?? "");
    const isDuplicateTable =
      causeCode === "42P07" ||
      causeMsg.includes("already exists") ||
      msg.includes("already exists");

    if (isDuplicateTable) {
      console.log("[DB_BOOT] Push-initialised DB detected — stamping journal and retrying");
      await stampPushInitialisedDb(migrationsFolder);
      const retryStart = Date.now();
      await migrate(db, { migrationsFolder });
      console.log(`[MIGRATION_COMPLETE] All migrations applied (after stamp) in ${Date.now() - retryStart}ms`);
      console.log("[DB_MIGRATIONS_OK] All migrations applied (after stamp)");
    } else {
      console.error("[MIGRATION_ERROR] Migration failed:", msg);
      logDatabaseError(err);
      console.error("[MIGRATION_ERROR] Fix: run 'pnpm migrate' again — if it persists, check docs/database-lifecycle.md");
      throw err;
    }
  }

  await validateSchema();

  console.log(`[DB_BOOT_COMPLETE] Bootstrap complete in ${Date.now() - mainStart}ms`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[MIGRATION_ERROR] Bootstrap failed:", err instanceof Error ? err.message : err);
  logDatabaseError(err);
  process.exit(1);
});
