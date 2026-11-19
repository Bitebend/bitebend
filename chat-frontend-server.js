// Standalone production frontend + same-origin API/WebSocket proxy server for @workspace/chat on Railway.
// Serves built artifacts/chat/dist with SPA fallback, local /healthz, HTTP proxy for /api/*,
// and WebSocket upgrade proxy for /api/chat/ws while normalizing forwarded HTTPS headers for __Host- cookies.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "artifacts/chat/dist");
const indexHtmlPath = path.join(distDir, "index.html");

const port = Number(
  (process.env["RAILWAY_ENVIRONMENT"] ? process.env["PORT"] : undefined) ??
    process.env["CHAT_FRONTEND_PORT"] ??
    process.env["PORT"] ??
    4175,
);

const rawTarget = (
  process.env["CHAT_API_TARGET_URL"]?.trim() || "http://localhost:3002"
).replace(/\/+$/, "");

let targetUrl;
try {
  targetUrl = new URL(rawTarget);
} catch {
  console.error(`[chat-frontend-server.js] Invalid CHAT_API_TARGET_URL: ${rawTarget}`);
  process.exit(1);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function firstHeaderToken(val) {
  if (!val) return "";
  const raw = Array.isArray(val) ? val[0] : String(val);
  return raw.split(",")[0].trim();
}

function buildProxyHeaders(req) {
  const headers = { ...req.headers };
  delete headers["connection"];
  delete headers["keep-alive"];
  delete headers["proxy-connection"];
  delete headers["transfer-encoding"];

  const incomingProto = firstHeaderToken(req.headers["x-forwarded-proto"]).toLowerCase();
  const clientProto =
    incomingProto === "https" || incomingProto === "http"
      ? incomingProto
      : req.socket?.encrypted
        ? "https"
        : "http";

  const incomingHost = firstHeaderToken(req.headers["x-forwarded-host"] ?? req.headers["host"]);
  const existingFor = req.headers["x-forwarded-for"];
  const remoteAddr = req.socket?.remoteAddress ?? "";

  headers["host"] = targetUrl.host;
  headers["x-forwarded-proto"] = clientProto;
  if (incomingHost) {
    headers["x-forwarded-host"] = incomingHost;
  }
  if (remoteAddr) {
    headers["x-forwarded-for"] = existingFor ? `${existingFor}, ${remoteAddr}` : remoteAddr;
  }

  return headers;
}

function isApiPath(reqUrl) {
  const pathname = (reqUrl || "/").split("?")[0];
  return pathname === "/api" || pathname.startsWith("/api/");
}

function proxyHttp(req, res) {
  const transport = targetUrl.protocol === "https:" ? https : http;
  const targetPath = `${targetUrl.pathname.replace(/\/$/, "")}${req.url || "/"}`;

  const proxyReq = transport.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers: buildProxyHeaders(req),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    console.error("[chat-frontend-server.js] API proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Chat API upstream unavailable" }));
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head) {
  const pathname = (req.url || "/").split("?")[0];
  if (pathname !== "/api/chat/ws" && !pathname.startsWith("/api/")) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const transport = targetUrl.protocol === "https:" ? https : http;
  const targetPath = `${targetUrl.pathname.replace(/\/$/, "")}${req.url || "/"}`;
  const headers = buildProxyHeaders(req);
  if (req.headers["connection"]) headers["connection"] = req.headers["connection"];
  if (req.headers["upgrade"]) headers["upgrade"] = req.headers["upgrade"];

  const proxyReq = transport.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    method: req.method || "GET",
    path: targetPath,
    headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
    const rawHeaders = [];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) rawHeaders.push(`${k}: ${item}`);
      } else {
        rawHeaders.push(`${k}: ${v}`);
      }
    }
    socket.write(`${statusLine}${rawHeaders.join("\r\n")}\r\n\r\n`);
    if (proxyHead && proxyHead.length > 0) {
      socket.write(proxyHead);
    }
    if (head && head.length > 0) {
      proxySocket.write(head);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("response", (proxyRes) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? "Bad Gateway"}\r\n`;
    const rawHeaders = [];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) rawHeaders.push(`${k}: ${item}`);
      } else {
        rawHeaders.push(`${k}: ${v}`);
      }
    }
    socket.write(`${statusLine}${rawHeaders.join("\r\n")}\r\n\r\n`);
    proxyRes.pipe(socket);
  });

  proxyReq.on("error", (err) => {
    console.error("[chat-frontend-server.js] WS proxy error:", err.message);
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  proxyReq.end();
}

function serveStaticFile(filePath, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const isImmutableAsset = filePath.startsWith(path.join(distDir, "assets") + path.sep);
  const cacheControl = isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache";

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

export function createChatFrontendServer() {
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `Missing built chat frontend at ${indexHtmlPath}. Run 'npm run build:chat' first.`,
    );
  }

  const server = http.createServer((req, res) => {
    const reqUrl = req.url || "/";
    const pathname = reqUrl.split("?")[0];

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "bitebend-chat-frontend" }));
      return;
    }

    if (isApiPath(reqUrl)) {
      proxyHttp(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    let decodedPath = "/";
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    const safeRel = path.posix.normalize(decodedPath).replace(/^\/+/, "");
    const candidatePath = path.resolve(distDir, safeRel);

    if (
      candidatePath !== distDir &&
      candidatePath.startsWith(distDir + path.sep) &&
      fs.existsSync(candidatePath) &&
      fs.statSync(candidatePath).isFile()
    ) {
      serveStaticFile(candidatePath, req, res);
      return;
    }

    // SPA fallback to index.html for all non-API client routes
    serveStaticFile(indexHtmlPath, req, res);
  });

  server.on("upgrade", proxyUpgrade);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createChatFrontendServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[chat-frontend-server.js] Serving ${distDir} on 0.0.0.0:${port} (API proxy -> ${targetUrl.origin})`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
