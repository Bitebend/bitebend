/**
 * Resolves the monorepo workspace root from the location of the running bundle.
 *
 * The compiled bundle lives at:
 *   artifacts/api-server/dist/index.mjs
 *
 * URL resolution strips the filename first, then applies the relative path:
 *   base dir = .../artifacts/api-server/dist/
 *   ../       → .../artifacts/api-server/
 *   ../../    → .../artifacts/
 *   ../../../  → <workspace root>   ← 3 levels from dist/
 *
 * Using import.meta.url (not process.cwd()) ensures this works regardless of
 * which directory the node process was started from.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findWorkspaceRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = currentDir;

  while (dir && dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(dir, "pnpm-lock.yaml"))
    ) {
      return dir;
    }

    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) {
          return dir;
        }
      } catch {
        // continue
      }
    }

    dir = path.dirname(dir);
  }

  return process.cwd();
}

export const WORKSPACE_ROOT = findWorkspaceRoot();
