import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

interface OrderEvent {
  id: number;
  customerName: string | null;
  tableNumber: string | null;
  total: number;
  itemCount: number;
}

interface ScreenshotEvent {
  orderId: number;
  customerPhone: string;
  customerName: string | null;
  total: number;
}

export interface SessionScreenshotEvent {
  sessionId: number;
  billId: number;
  tableNumber: string;
  billNumber: string;
  total: number;
  customerPhone: string;
}

export interface ScreenshotInboxReceivedEvent {
  inboxId: number;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  receivedAt: string;
  isDuplicate?: boolean;
}

function playNotificationSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
    osc.onended = () => void ctx.close();
  } catch {
    // Browser autoplay / AudioContext policy may block sound.
  }
}

interface UseOrderNotificationsOptions {
  enabled: boolean;
  onNewOrder?: () => void;
  onSessionScreenshotReceived?: (sessionId: number) => void;
  onScreenshotInboxReceived?: () => void;
}

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T;
  } catch {
    return null;
  }
}

export function useOrderNotifications({
  enabled,
  onNewOrder,
  onSessionScreenshotReceived,
  onScreenshotInboxReceived,
}: UseOrderNotificationsOptions): void {
  const { toast } = useToast();

  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const stoppedRef = useRef(false);

  const onNewOrderRef = useRef(onNewOrder);
  const onSessionScreenshotRef = useRef(onSessionScreenshotReceived);
  const onScreenshotInboxRef = useRef(onScreenshotInboxReceived);

  useEffect(() => {
    onNewOrderRef.current = onNewOrder;
  }, [onNewOrder]);

  useEffect(() => {
    onSessionScreenshotRef.current = onSessionScreenshotReceived;
  }, [onSessionScreenshotReceived]);

  useEffect(() => {
    onScreenshotInboxRef.current = onScreenshotInboxReceived;
  }, [onScreenshotInboxReceived]);

  useEffect(() => {
    if (!enabled) return;

    stoppedRef.current = false;

    const clearRetry = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (stoppedRef.current || retryTimerRef.current !== null) return;

      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, 30_000);

      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connect();
      }, delay);
    };

    function connect() {
      if (stoppedRef.current) return;

      const es = new EventSource("/api/owner/orders/stream", {
        withCredentials: true,
      });

      esRef.current?.close();
      esRef.current = es;

      es.addEventListener("open", () => {
        retryDelayRef.current = 1000;
      });

      es.addEventListener("new-order", (event: MessageEvent) => {
        retryDelayRef.current = 1000;

        const order = parseEvent<OrderEvent>(event);
        if (!order) return;

        playNotificationSound();

        const table = order.tableNumber
          ? `Table ${order.tableNumber}`
          : "Take-away";
        const name = order.customerName ? ` · ${order.customerName}` : "";
        const amount = `₹${Number(order.total).toLocaleString("en-IN")}`;

        toast({
          title: "New Order!",
          description: `${table}${name} — ${order.itemCount} item${
            order.itemCount !== 1 ? "s" : ""
          } — ${amount}`,
        });

        onNewOrderRef.current?.();
      });

      es.addEventListener("screenshot-received", (event: MessageEvent) => {
        retryDelayRef.current = 1000;

        const data = parseEvent<ScreenshotEvent>(event);
        if (!data) return;

        playNotificationSound();

        const name = data.customerName ? ` · ${data.customerName}` : "";
        const amount = `₹${Number(data.total).toLocaleString("en-IN")}`;

        toast({
          title: "📸 Payment Screenshot Received",
          description: `Order #${data.orderId}${name} — ${amount} via WhatsApp`,
        });

        onNewOrderRef.current?.();
      });

      es.addEventListener(
        "session-screenshot-received",
        (event: MessageEvent) => {
          retryDelayRef.current = 1000;

          const data = parseEvent<SessionScreenshotEvent>(event);
          if (!data) return;

          playNotificationSound();

          toast({
            title: "📸 Payment Screenshot Received",
            description: `Table ${data.tableNumber} — ${data.billNumber} — ₹${Number(
              data.total,
            ).toLocaleString("en-IN")}`,
          });

          onSessionScreenshotRef.current?.(data.sessionId);
          onNewOrderRef.current?.();
        },
      );

      es.addEventListener(
        "screenshot-inbox-received",
        (event: MessageEvent) => {
          retryDelayRef.current = 1000;

          const data = parseEvent<ScreenshotInboxReceivedEvent>(event);
          if (!data) return;

          playNotificationSound();

          if (data.matchStatus === "matched") {
            toast({
              title: "📸 Payment Screenshot Received",
              description: data.isDuplicate
                ? "Duplicate screenshot received and retained in the inbox"
                : "Payment screenshot matched successfully",
            });
          } else {
            const label = data.matchStatus === "ambiguous" ? "Ambiguous" : "Unmatched";
            toast({
              title: data.isDuplicate ? "📸 Duplicate Payment Screenshot" : "⚠️ Payment Screenshot Needs Review",
              description: `${label} screenshot received — manual review required`,
            });
          }

          onScreenshotInboxRef.current?.();
        },
      );

      es.addEventListener("heartbeat", () => {
        retryDelayRef.current = 1000;
      });

      es.onerror = () => {
        es.close();

        if (esRef.current === es) {
          esRef.current = null;
        }

        scheduleReconnect();
      };
    }

    connect();

    return () => {
      stoppedRef.current = true;
      clearRetry();

      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, toast]);
}
