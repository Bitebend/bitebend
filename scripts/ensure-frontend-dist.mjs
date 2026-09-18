import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const portalIndex = path.resolve(rootDir, "artifacts/portal/dist/index.html");
const menuIndex1 = path.resolve(rootDir, "artifacts/menu/dist/public/index.html");
const menuIndex2 = path.resolve(rootDir, "artifacts/menu/dist/index.html");

const isPortalBuilt = existsSync(portalIndex);
const isMenuBuilt = existsSync(menuIndex1) || existsSync(menuIndex2);

const pmCmd = existsSync(path.resolve(rootDir, "pnpm-lock.yaml")) ? "pnpm --filter " : "npm --workspace=";

if (!isPortalBuilt) {
  console.log("[ensure-frontend-dist] Building portal application...");
  try {
    execSync(`${pmCmd}@workspace/portal run build`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("[ensure-frontend-dist] Failed to build portal:", err);
    process.exit(1);
  }
}

if (!isMenuBuilt) {
  console.log("[ensure-frontend-dist] Building menu application...");
  try {
    execSync(`${pmCmd}@workspace/menu run build`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("[ensure-frontend-dist] Failed to build menu:", err);
    process.exit(1);
  }
}

console.log("[ensure-frontend-dist] Frontend artifacts verified.");
