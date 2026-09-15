export interface WhatsAppBridgeConfig {
  bridgeUrl: string;
  bridgeApiSecret: string;
  webhookSecret: string;
}

export function getWhatsAppBridgeConfig(): WhatsAppBridgeConfig {
  const isProd = process.env.NODE_ENV === "production";
  const bridgeUrl = process.env.BRIDGE_URL?.trim();
  const bridgeApiSecret = process.env.BRIDGE_API_SECRET?.trim();
  const webhookSecret = process.env.BITEBEND_WEBHOOK_SECRET?.trim();

  if (isProd) {
    const missing: string[] = [];
    if (!bridgeUrl) missing.push("BRIDGE_URL");
    if (!bridgeApiSecret) missing.push("BRIDGE_API_SECRET");
    if (!webhookSecret) missing.push("BITEBEND_WEBHOOK_SECRET");

    if (missing.length > 0) {
      throw new Error(
        `[CONFIG_ERROR] Missing required WhatsApp bridge environment variable(s) in production: ${missing.join(", ")}`,
      );
    }
  }

  return {
    bridgeUrl: bridgeUrl || "http://localhost:3001",
    bridgeApiSecret: bridgeApiSecret || "",
    webhookSecret: webhookSecret || "",
  };
}

export function validateWhatsAppConfig(): void {
  getWhatsAppBridgeConfig();
}
