import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const isBackgroundMode = args.has("--background");
const isWorkerMode = args.has("--worker");

const apps = [
  {
    name: "portal",
    pkg: "@workspace/portal",
    built: () => existsSync(path.resolve(rootDir, "artifacts/portal/dist/index.html")),
  },
  {
    name: "menu",
    pkg: "@workspace/menu",
    built: () =>
      existsSync(path.resolve(rootDir, "artifacts/menu/dist/public/index.html")) ||
      existsSync(path.resolve(rootDir, "artifacts/menu/dist/index.html")),
  },
  {
    name: "home",
    pkg: "@workspace/home",
    built: () => existsSync(path.resolve(rootDir, "artifacts/home/dist/index.html")),
  },
  {
    name: "chat",
    pkg: "@workspace/chat",
    built: () => existsSync(path.resolve(rootDir, "artifacts/chat/dist/index.html")),
  },
];

const missingApps = apps.filter((app) => !app.built());

if (missingApps.length === 0) {
  console.log("[ensure-frontend-dist] Frontend artifacts verified.");
  process.exit(0);
}

let pmCmd = "npm --workspace=";
try {
  execSync("pnpm --version", { stdio: "ignore" });
  pmCmd = "pnpm --filter ";
} catch {
  pmCmd = "npm --workspace=";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildApp(app) {
  if (app.built()) return;
  console.log(`[ensure-frontend-dist] Building ${app.name} application...`);
  try {
    execSync(`${pmCmd}${app.pkg} run build`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`[ensure-frontend-dist] Failed to build ${app.name}:`, err);
    process.exit(1);
  }
}

const lockPath = path.join(os.tmpdir(), "bitebend-frontend-dist.lock");

if (isBackgroundMode && !isWorkerMode) {
  if (existsSync(lockPath)) {
    try {
      const existingPid = Number(readFileSync(lockPath, "utf8").trim());
      if (isProcessAlive(existingPid)) {
        console.log(
          `[ensure-frontend-dist] Background frontend build already running (pid=${existingPid}).`,
        );
        process.exit(0);
      }
    } catch {
      // Stale or unreadable lockfile; continue to spawn worker
    }
  }

  const logPath = path.join(os.tmpdir(), "bitebend-frontend-dist.log");
  const logFd = openSync(logPath, "a");
  console.log(
    `[ensure-frontend-dist] Building frontends (${missingApps.map((a) => a.name).join(", ")}) in background (log: ${logPath})...`,
  );
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid) {
    writeFileSync(lockPath, String(child.pid), "utf8");
  }
  child.unref();
  process.exit(0);
}

try {
  for (const app of missingApps) {
    buildApp(app);
  }
} finally {
  if (isWorkerMode && existsSync(lockPath)) {
    try {
      const lockPid = Number(readFileSync(lockPath, "utf8").trim());
      if (lockPid === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore cleanup error
    }
  }
}

console.log("[ensure-frontend-dist] Frontend artifacts verified.");
