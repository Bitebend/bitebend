import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import { logger } from "./lib/logger";
import { isAllowedChatOrigin } from "./lib/origins";
import healthRouter from "./routes/health";
import sessionRouter from "./routes/session";
import keysRouter from "./routes/keys";
import devicesRouter from "./routes/devices";
import conversationsRouter from "./routes/conversations";
import attachmentsRouter from "./routes/attachments";

export function createChatApp(): express.Express {
  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin(origin, cb) {
        cb(null, isAllowedChatOrigin(origin));
      },
      credentials: true,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/api/healthz",
      },
    }),
  );

  app.use(cookieParser());

  // Keep raw attachment route ahead of general JSON parser or isolate JSON to 2 MB
  app.use("/api/chat/attachments", attachmentsRouter);

  app.use(express.json({ limit: "2mb" }));

  // Mount Messaging API endpoints cleanly
  app.use("/api", healthRouter);
  app.use("/api/chat", sessionRouter);
  app.use("/api/chat", keysRouter);
  app.use("/api/chat", devicesRouter);
  app.use("/api/chat", conversationsRouter);

  // Serve built independent frontend (@workspace/chat/dist) when running standalone
  const candidates = [
    path.resolve(import.meta.dirname, "../../chat/dist"),
    path.resolve(process.cwd(), "../chat/dist"),
    path.resolve(process.cwd(), "artifacts/chat/dist"),
  ];
  const staticDir = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
  if (staticDir) {
    logger.info({ staticDir }, "Serving built @workspace/chat static frontend");
    app.use(express.static(staticDir));
    app.get("/{*path}", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    logger.warn("Built @workspace/chat dist/index.html not found; API-only mode active");
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; message?: string };
    const status = e.status ?? 500;
    if (status >= 500) {
      logger.error({ err: e.message }, "Unhandled chat-api error");
    }
    res.status(status).json({ error: status >= 500 ? "Internal server error" : e.message ?? "Bad request" });
  });

  return app;
}
