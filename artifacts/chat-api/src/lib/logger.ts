import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? (process.env["NODE_ENV"] === "production" ? "info" : "debug"),
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-bitebend-sig']",
      "req.headers['x-chat-admin-secret']",
      "res.headers['set-cookie']",
      "*.rawToken",
      "*.payload",
      "*.ciphertext",
      "*.deviceKeysJson",
    ],
    censor: "[REDACTED]",
  },
  ...(process.env["NODE_ENV"] !== "production"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, ignore: "pid,hostname" },
        },
      }
    : {}),
});
