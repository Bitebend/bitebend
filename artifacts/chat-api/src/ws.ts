import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveSessionFromCookieHeader } from "./middlewares/chatAuth";
import { logger } from "./lib/logger";
import { isAllowedChatOrigin } from "./lib/origins";

export interface SyncHintEvent {
  type: "sync_hint" | "device_revoked" | "link_update" | "connected";
  conversationId?: string;
  serverSeq?: number;
  deviceId?: string;
  linkId?: string;
}

interface ConnectedClient {
  ws: WebSocket;
  accountId: string;
  deviceId: string;
  isAlive: boolean;
}

const clientsByAccount = new Map<string, Set<ConnectedClient>>();
const clientsByDevice = new Map<string, Set<ConnectedClient>>();

function registerClient(client: ConnectedClient): void {
  let accSet = clientsByAccount.get(client.accountId);
  if (!accSet) {
    accSet = new Set();
    clientsByAccount.set(client.accountId, accSet);
  }
  accSet.add(client);

  let devSet = clientsByDevice.get(client.deviceId);
  if (!devSet) {
    devSet = new Set();
    clientsByDevice.set(client.deviceId, devSet);
  }
  devSet.add(client);
}

function unregisterClient(client: ConnectedClient): void {
  clientsByAccount.get(client.accountId)?.delete(client);
  if (clientsByAccount.get(client.accountId)?.size === 0) {
    clientsByAccount.delete(client.accountId);
  }
  clientsByDevice.get(client.deviceId)?.delete(client);
  if (clientsByDevice.get(client.deviceId)?.size === 0) {
    clientsByDevice.delete(client.deviceId);
  }
}

export function attachChatWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const reqUrl = req.url ?? "";
    const pathname = reqUrl.split("?")[0];
    if (pathname !== "/api/chat/ws") {
      return;
    }

    if (req.headers.origin && !isAllowedChatOrigin(req.headers.origin)) {
      logger.warn({ origin: req.headers.origin }, "WebSocket upgrade rejected: disallowed origin");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      const resolved = await resolveSessionFromCookieHeader(req.headers.cookie);
      if (resolved.status !== "ok") {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: ConnectedClient = {
          ws,
          accountId: resolved.auth.accountId,
          deviceId: resolved.auth.deviceId,
          isAlive: true,
        };
        registerClient(client);

        ws.on("pong", () => {
          client.isAlive = true;
        });

        ws.on("close", () => {
          unregisterClient(client);
        });

        ws.on("error", () => {
          unregisterClient(client);
        });

        ws.send(JSON.stringify({ type: "connected", deviceId: client.deviceId } satisfies SyncHintEvent));
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "WebSocket upgrade rejected");
      socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const accSet of clientsByAccount.values()) {
      for (const client of accSet) {
        if (!client.isAlive) {
          unregisterClient(client);
          client.ws.terminate();
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();

  return wss;
}

export function notifyAccount(accountId: string, event: SyncHintEvent): void {
  const set = clientsByAccount.get(accountId);
  if (!set) return;
  const serialized = JSON.stringify(event);
  for (const client of set) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(serialized);
    }
  }
}

export function notifyDevice(deviceId: string, event: SyncHintEvent): void {
  const set = clientsByDevice.get(deviceId);
  if (!set) return;
  const serialized = JSON.stringify(event);
  for (const client of set) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(serialized);
    }
  }
}

export function disconnectDeviceSockets(deviceId: string): void {
  const set = clientsByDevice.get(deviceId);
  if (!set) return;
  const payload = JSON.stringify({ type: "device_revoked", deviceId } satisfies SyncHintEvent);
  for (const client of set) {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
      client.ws.close(4001, "Device revoked");
    } catch {
      client.ws.terminate();
    }
    unregisterClient(client);
  }
}
