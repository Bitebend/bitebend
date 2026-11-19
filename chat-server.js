// Standalone entrypoint for independent Bitebend Messaging (chat.bitebend.in) deployment on Railway.
// Runs Messaging database migrations and launches @workspace/chat-api serving @workspace/chat/dist, REST, and WebSockets.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    console.log(`[chat-server.js] Running: ${command} ${args.join(" ")}`);
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
  console.log("[chat-server.js] Starting Bitebend Messaging service...");

  const migrateScript = path.join(__dirname, "artifacts/chat-api/dist/migrate.mjs");
  if (!existsSync(migrateScript)) {
    throw new Error(`Missing compiled migration script: ${migrateScript}. Run 'npm run build:chat-api' first.`);
  }

  if (process.env.CHAT_DATABASE_URL || process.env.USE_LOCAL_DB === "true") {
    console.log("[chat-server.js] Running Messaging database migrations...");
    await runCommand("node", [migrateScript]);
    console.log("[chat-server.js] Messaging database migrations completed.");
  }

  const chatIndex = path.join(__dirname, "artifacts/chat/dist/index.html");
  if (!existsSync(chatIndex)) {
    console.warn(`[chat-server.js] Warning: ${chatIndex} not found; @workspace/chat static UI will not be served until built.`);
  }

  const serverScript = path.join(__dirname, "artifacts/chat-api/dist/index.mjs");
  if (!existsSync(serverScript)) {
    throw new Error(`Missing compiled chat-api bundle: ${serverScript}. Run 'npm run build:chat-api' first.`);
  }

  console.log("[chat-server.js] Launching Messaging API & WebSocket server:", serverScript);
  const serverProc = spawn("node", ["--enable-source-maps", serverScript], {
    stdio: "inherit",
    cwd: __dirname,
    env: process.env,
  });

  serverProc.on("error", (err) => {
    console.error("[chat-server.js] Server process error:", err);
    process.exit(1);
  });

  serverProc.on("exit", (code, signal) => {
    console.log(`[chat-server.js] Server process exited with code ${code}, signal ${signal}`);
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
  console.error("[chat-server.js] Fatal startup failure:", err);
  process.exit(1);
});
