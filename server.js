// Root entrypoint for Google Cloud Run (Node.js runtime)
// Automatically handles database migrations and starts the production API server.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    console.log(`[server.js] Running: ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      stdio: "inherit",
      cwd: __dirname,
      env: { ...env },
    });

    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command ${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function start() {
  console.log("[server.js] Starting Bitebend on Cloud Run...");

  // Run database migration if migrate.mjs exists and database URL is set
  const migrateScript = path.join(__dirname, "artifacts/api-server/dist/migrate.mjs");
  if (process.env.DATABASE_URL) {
    try {
      console.log("[server.js] Running database migrations...");
      await runCommand("node", [migrateScript]);
      console.log("[server.js] Migrations completed successfully.");
    } catch (err) {
      console.error("[server.js] Warning: Database migration failed, proceeding with server startup:", err.message);
    }
  }

  // Start the main compiled API server
  const serverScript = path.join(__dirname, "artifacts/api-server/dist/index.mjs");
  console.log("[server.js] Launching API server bundle:", serverScript);

  const serverProc = spawn("node", ["--enable-source-maps", serverScript], {
    stdio: "inherit",
    cwd: __dirname,
    env: process.env,
  });

  serverProc.on("error", (err) => {
    console.error("[server.js] Server process error:", err);
    process.exit(1);
  });

  serverProc.on("exit", (code, signal) => {
    console.log(`[server.js] Server process exited with code ${code}, signal ${signal}`);
    process.exit(code ?? 0);
  });

  const forwardSignal = (sig) => {
    process.on(sig, () => {
      if (!serverProc.killed) {
        serverProc.kill(sig);
      }
    });
  };

  forwardSignal("SIGINT");
  forwardSignal("SIGTERM");
}

start().catch((err) => {
  console.error("[server.js] Fatal startup failure:", err);
  process.exit(1);
});
