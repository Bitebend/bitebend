import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-profile-pin-token']",
      "req.headers['x-bitebend-sig']",
      "res.headers['set-cookie']",
      "*.pin",
      "*.currentPin",
      "*.newPin",
      "*.confirmPin",
      "*.otp",
      "*.pinHash",
      "*.otpHmac",
      "*.unlockToken",
      "*.pepper",
      "*.signingKey",
      "*.phone",
      "*.registrationPhone",
      "*.registrationPhoneNorm",
      "*.phoneHmac",
    ],
    censor: "[REDACTED]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
