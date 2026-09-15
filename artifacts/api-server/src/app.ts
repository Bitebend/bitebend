import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { createProxyMiddleware } from "http-proxy-middleware";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Trust reverse proxy
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => {
        const url = req.url?.split("?")[0];
        return url === "/healthz" || url === "/api/healthz" || url === "/robots.txt";
      },
    },
    customLogLevel(req, res, err) {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${req.url?.split("?")[0]} - ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      return `${req.method} ${req.url?.split("?")[0]} - ${res.statusCode} ${err?.message ? `(${err.message})` : ""}`;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "sessions",
      createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "none",
      partitioned: true,
    } as any,
  }),
);

// API routes
app.use("/api", router);

// ── WhatsApp Bridge proxy ────────────────────────────────────────────────────
// Handles REST + Socket.IO communication with WhatsApp Bridge service.
app.use(
  createProxyMiddleware({
    target: process.env.BRIDGE_URL ?? "http://localhost:3001",
    changeOrigin: true,
    ws: true,
    pathFilter: (path) => path.startsWith("/whatsapp-bridge"),
    pathRewrite: {
      "^/whatsapp-bridge": "",
    },
    on: {
      error: (_err, _req, res) => {
        if (res && "status" in res && !(res as express.Response).headersSent) {
          (res as express.Response).status(503).json({
            status: "unavailable",
            error: "WhatsApp Bridge service is not currently available",
          });
        }
      },
    },
  }),
);

import path from "node:path";
import fs from "node:fs";
import { WORKSPACE_ROOT } from "./lib/workspace";

// ── Frontend static assets & SPA routing ──────────────────────────────────────
function getMenuDistPath(): string {
  const p1 = path.join(WORKSPACE_ROOT, "artifacts/menu/dist/public");
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(WORKSPACE_ROOT, "artifacts/menu/dist");
  if (fs.existsSync(p2)) return p2;
  return p1;
}

function getPortalDistPath(): string {
  const p = path.join(WORKSPACE_ROOT, "artifacts/portal/dist");
  return p;
}

// Static assets
app.use("/menu", express.static(path.join(WORKSPACE_ROOT, "artifacts/menu/dist/public"), { redirect: false }));
app.use("/menu", express.static(path.join(WORKSPACE_ROOT, "artifacts/menu/dist"), { redirect: false }));
app.use(express.static(path.join(WORKSPACE_ROOT, "artifacts/portal/dist")));

// Menu SPA catch-all
app.get(/^\/menu(\/.*)?$/, (_req, res) => {
  const menuDist = getMenuDistPath();
  const indexHtml = path.join(menuDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  res.status(503).send("Menu application is building. Please refresh in a moment.");
});

// Portal / Root SPA catch-all (handles all non-api, non-whatsapp-bridge routes)
app.get(/^\/(?!api|whatsapp-bridge).*/, (_req, res) => {
  const portalDist = getPortalDistPath();
  const indexHtml = path.join(portalDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  res.status(503).send("Portal application is building. Please refresh in a moment.");
});

app.get("/robots.txt", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end("User-agent: *\nAllow: /\n");
});

// 404 for unhandled API endpoints or non-GET unhandled routes
app.use((_req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

// ── JSON error handler ──────────────────────────────────────────────────────

app.use(
  (
    _err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      typeof _err === "object" && _err !== null && "status" in _err
        ? Number((_err as { status: unknown }).status)
        : 500;

    const message =
      typeof _err === "object" && _err !== null && "message" in _err
        ? String((_err as { message: unknown }).message)
        : "Internal Server Error";

    logger.error({ err: _err }, message);

    res.status(status).json({
      error: message,
    });
  },
);

export default app;
