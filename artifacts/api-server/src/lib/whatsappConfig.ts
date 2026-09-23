export interface WhatsAppBridgeConfig {
  bridgeUrl: string;
  bridgeApiSecret: string;
  webhookSecret: string;
}

export function getWhatsAppBridgeConfig(): WhatsAppBridgeConfig {
  const bridgeUrl = process.env.BRIDGE_URL?.trim();
  const bridgeApiSecret = process.env.BRIDGE_API_SECRET?.trim();
  const webhookSecret = process.env.BITEBEND_WEBHOOK_SECRET?.trim();

  return {
    bridgeUrl: bridgeUrl || "http://localhost:3001",
    bridgeApiSecret: bridgeApiSecret || "",
    webhookSecret: webhookSecret || "",
  };
}

export function validateWhatsAppConfig(): void {
  getWhatsAppBridgeConfig();
}
