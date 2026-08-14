import type { Response } from "express";
import { logger } from "./logger";

interface OrderEventPayload {
  id: number;
  customerName: string | null;
  tableNumber: string | null;
  total: number;
  itemCount: number;
}

export interface SessionScreenshotEventPayload {
  sessionId: number;
  billId: number;
  tableNumber: string;
  billNumber: string;
  total: number;
  customerPhone: string;
}

export interface ScreenshotInboxEventPayload {
  inboxId: number;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  receivedAt: string;
  isDuplicate?: boolean;
}

const connections = new Map<number, Set<Response>>();

function writeEvent(
  restaurantId: number,
  eventName: string,
  payload: unknown,
): void {
  const clients = connections.get(restaurantId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify(payload);

  for (const res of Array.from(clients)) {
    try {
      res.write(`event: ${eventName}\ndata: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  if (clients.size === 0) {
    connections.delete(restaurantId);
  }
}

export function addConnection(restaurantId: number, res: Response): void {
  let clients = connections.get(restaurantId);

  if (!clients) {
    clients = new Set<Response>();
    connections.set(restaurantId, clients);
  }

  clients.add(res);
}

export function removeConnection(restaurantId: number, res: Response): void {
  const clients = connections.get(restaurantId);
  if (!clients) return;

  clients.delete(res);

  if (clients.size === 0) {
    connections.delete(restaurantId);
  }
}

export function emitOrderEvent(
  restaurantId: number,
  payload: OrderEventPayload,
): void {
  writeEvent(restaurantId, "new-order", payload);
}

export function emitScreenshotEvent(
  restaurantId: number,
  payload: {
    orderId: number;
    customerPhone: string;
    customerName: string | null;
    total: number;
  },
): void {
  writeEvent(restaurantId, "screenshot-received", payload);
}

export function emitSessionScreenshotEvent(
  restaurantId: number,
  payload: SessionScreenshotEventPayload,
): void {
  const clients = connections.get(restaurantId);
  const clientCount = clients?.size ?? 0;

  logger.info(
    {
      restaurantId,
      clientCount,
      sessionId: payload.sessionId,
      billId: payload.billId,
      tableNumber: payload.tableNumber,
    },
    "[sse:emit] session-screenshot-received event fired",
  );

  writeEvent(restaurantId, "session-screenshot-received", payload);
}

export function emitScreenshotInboxEvent(
  restaurantId: number,
  payload: ScreenshotInboxEventPayload,
): void {
  writeEvent(restaurantId, "screenshot-inbox-received", payload);
}
