import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm, cp } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [
      { in: path.resolve(artifactDir, "src/index.ts"), out: "index" },
      { in: path.resolve(artifactDir, "src/migrate.ts"), out: "migrate" },
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external: [
      "*.node",
      "@electric-sql/*",
      "@electric-sql/pglite",
      "pg-native",
      "bufferutil",
      "utf-8-validate",
      "pino",
      "pino-pretty",
      "pino-http",
      "thread-stream",
    ],
    sourcemap: "linked",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
    },
  });

  const migrationsSource = path.resolve(artifactDir, "src/drizzle");
  const migrationsDest = path.resolve(distDir, "migrations");
  if (!existsSync(migrationsSource)) {
    throw new Error(`Missing chat-api migrations source directory: ${migrationsSource}`);
  }
  const sqlFiles = readdirSync(migrationsSource).filter((f) => f.endsWith(".sql"));
  if (sqlFiles.length === 0) {
    throw new Error(`No .sql migration files found in ${migrationsSource}`);
  }
  await cp(migrationsSource, migrationsDest, { recursive: true });
  console.log(`[chat-build] copied ${sqlFiles.length} migration file(s) -> dist/migrations`);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
