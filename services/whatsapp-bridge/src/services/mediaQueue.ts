/**
 * In-memory retry queue for WhatsApp media downloads.
 *
 * When all inline download attempts fail, the message is placed here.
 * A background worker retries every 30 seconds until either the download
 * succeeds or the item exceeds its maximum lifetime (10 minutes).
 *
 * Uses dependency injection for the download function so this module does not
 * import from whatsappClient.ts — avoiding the circular import chain:
 *   whatsappClient → incomingMessages → mediaQueue → whatsappClient
 */

import util from 'util';
import { Message, MessageMedia } from 'whatsapp-web.js';
import logger from '../utils/logger';
import {
  sendWebhook,
  sendPaymentScreenshotWebhook,
  type PaymentScreenshotPayload,
} from '../webhooks/webhookSender';
import type { MediaDownloadResult, MediaHints } from './whatsappClient';

// ── Constants ──────────────────────────────────────────────────────────────────

const QUEUE_MAX_AGE_MS   = 10 * 60 * 1_000; // 10 minutes
const WORKER_INTERVAL_MS = 30_000;           // 30 seconds

// ── Types ──────────────────────────────────────────────────────────────────────

interface QueueItem {
  restaurantId:  number;
  msg:           Message;
  customerPhone: string;
  timestamp:     string;
  enqueuedAt:    number;
  attempts:      number;
  /** Pre-fetched _data fields; enables step-0.5 bypass for @lid senders. */
  mediaHints:    MediaHints | null;
}

interface WebhookRetryItem {
  payload:    PaymentScreenshotPayload;
  enqueuedAt: number;
  attempts:   number;
}

/** Injected download function — same signature as downloadMediaDirect. */
type DownloadFn = (restaurantId: number, msgId: string, hints: MediaHints | null) => Promise<MessageMedia | MediaDownloadResult>;

// ── State ──────────────────────────────────────────────────────────────────────

const queue: QueueItem[] = [];
const webhookQueue: WebhookRetryItem[] = [];
let workerTimer: ReturnType<typeof setInterval> | null = null;

function refreshHintsFromMessage(msg: Message): MediaHints | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (msg as any)?._data;
  if (!d || !d.directPath || !d.mediaKey) return null;
  const rawMime = d.mimetype ? String(d.mimetype).split(';')[0].trim().toLowerCase() : '';
  const rawType = d.type ? String(d.type) : 'image';
  const mime = (rawMime && rawMime !== 'application/octet-stream')
    ? rawMime
    : (rawType === 'image' || rawType === 'document' || !rawType ? 'image/jpeg' : (rawMime || 'image/jpeg'));
  return {
    directPath:        String(d.directPath),
    mediaKey:          String(d.mediaKey),
    mediaKeyTimestamp: d.mediaKeyTimestamp != null ? Number(d.mediaKeyTimestamp) : null,
    mimetype:          mime,
    encFilehash:       d.encFilehash  ? String(d.encFilehash)  : null,
    filehash:          d.filehash     ? String(d.filehash)      : null,
    type:              rawType,
    filesize:          d.size         != null ? Number(d.size)  : null,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Add a failed media message to the retry queue. */
export function enqueueMedia(
  restaurantId:  number,
  msg:           Message,
  customerPhone: string,
  timestamp:     string,
  mediaHints:    MediaHints | null = null,
): void {
  queue.push({ restaurantId, msg, customerPhone, timestamp, enqueuedAt: Date.now(), attempts: 0, mediaHints });
  logger.info('[media] queued for retry', {
    id:          msg.id?._serialized,
    restaurantId,
    phone:       customerPhone,
    queueLength: queue.length,
  });
}

/** Queue a screenshot webhook whose inline delivery attempts failed so it is not dropped. */
export function enqueuePaymentScreenshotWebhook(payload: PaymentScreenshotPayload): void {
  webhookQueue.push({ payload, enqueuedAt: Date.now(), attempts: 0 });
  logger.warn('[webhook] queued payment screenshot webhook for background retry', {
    restaurantId: payload.restaurantId,
    phone:        payload.customerPhone,
    queueLength:  webhookQueue.length,
  });
}

/**
 * Start the background retry worker.
 *
 * @param downloadMedia - injected download function (downloadMediaDirect from
 *   whatsappClient).  DI avoids a circular import; the caller (index.ts) wires it.
 */
export function startRetryWorker(downloadMedia: DownloadFn): void {
  if (workerTimer !== null) return;
  logger.info('[media] retry worker started');
  workerTimer = setInterval(() => {
    runWorkerTick(downloadMedia).catch((err: unknown) => {
      logger.error('[media] retry worker tick threw unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack   : undefined,
      });
    });
  }, WORKER_INTERVAL_MS);
}

// ── Internal ───────────────────────────────────────────────────────────────────

async function runWorkerTick(downloadMedia: DownloadFn): Promise<void> {
  const now = Date.now();

  // ── 1. Retry any failed payment screenshot webhook deliveries ─────────────
  for (let i = webhookQueue.length - 1; i >= 0; i--) {
    const item = webhookQueue[i];
    if (now - item.enqueuedAt > QUEUE_MAX_AGE_MS) {
      webhookQueue.splice(i, 1);
      logger.error('[webhook] payment screenshot webhook retry expired (exceeded 10-minute lifetime)', {
        restaurantId: item.payload.restaurantId,
        phone:        item.payload.customerPhone,
        attempts:     item.attempts,
      });
      continue;
    }

    item.attempts++;
    const delivered = await sendPaymentScreenshotWebhook(item.payload);
    if (delivered) {
      logger.info('[webhook] payment screenshot webhook retry succeeded', {
        restaurantId: item.payload.restaurantId,
        phone:        item.payload.customerPhone,
        attempts:     item.attempts,
      });
      webhookQueue.splice(i, 1);
    }
  }

  if (queue.length === 0) return;

  // ── 2. Expire media items that exceeded their maximum lifetime ────────────
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (now - item.enqueuedAt > QUEUE_MAX_AGE_MS) {
      queue.splice(i, 1);
      logger.warn('[media] retry expired — dropping message (exceeded 10-minute lifetime)', {
        id:          item.msg.id?._serialized,
        restaurantId: item.restaurantId,
        phone:        item.customerPhone,
        attempts:     item.attempts,
        ageMs:        now - item.enqueuedAt,
      });
    }
  }

  if (queue.length === 0) return;
  logger.info(`[media] retry worker tick — ${queue.length} queued item(s)`);

  // Iterate backwards so splice() by index is safe.
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    item.attempts++;

    if (!item.mediaHints) {
      item.mediaHints = refreshHintsFromMessage(item.msg);
    }

    logger.info('[media] retry worker attempting download', {
      id:           item.msg.id?._serialized,
      restaurantId: item.restaurantId,
      phone:        item.customerPhone,
      attempt:      item.attempts,
    });

    try {
      const result = await downloadMedia(item.restaurantId, item.msg.id._serialized, item.mediaHints);

      if (!(result instanceof MessageMedia)) {
        // Structured failure from downloadMediaDirect.
        logger.warn('[media] retry failed', {
          id:      item.msg.id?._serialized,
          attempt: item.attempts,
          reason:  (result as MediaDownloadResult).ok === false
                   ? (result as MediaDownloadResult & { ok: false }).reason
                   : 'unknown',
          detail:  (result as MediaDownloadResult).ok === false
                   ? (result as MediaDownloadResult & { ok: false }).detail
                   : undefined,
        });
        continue; // leave in queue for next tick
      }

      if (!result.data || result.data.length === 0) {
        logger.warn('[media] retry returned empty image payload — leaving in queue', {
          id: item.msg.id?._serialized,
          attempt: item.attempts,
        });
        continue;
      }

      // ── Success ────────────────────────────────────────────────────────────
      const cleanMime = String(result.mimetype || 'image/jpeg').split(';')[0].trim().toLowerCase() || 'image/jpeg';
      const dataUrl = `data:${cleanMime};base64,${result.data}`;

      await sendWebhook({
        restaurantId:  item.restaurantId,
        customerPhone: item.customerPhone,
        messageType:   'image',
        imageUrl:      dataUrl,
        timestamp:     item.timestamp,
      });
      const delivered = await sendPaymentScreenshotWebhook({
        restaurantId:  item.restaurantId,
        customerPhone: item.customerPhone,
        imageUrl:      dataUrl,
        timestamp:     item.timestamp,
        senderJid:     item.msg.from,
      });

      if (!delivered) {
        enqueuePaymentScreenshotWebhook({
          restaurantId:  item.restaurantId,
          customerPhone: item.customerPhone,
          imageUrl:      dataUrl,
          timestamp:     item.timestamp,
          senderJid:     item.msg.from,
        });
      }

      logger.info('[media] retry success', {
        id:           item.msg.id?._serialized,
        restaurantId: item.restaurantId,
        phone:        item.customerPhone,
        attempts:     item.attempts,
        delivered,
        imageUrl:     dataUrl.slice(0, 80) + '…',
      });

      queue.splice(i, 1);

    } catch (err) {
      logger.warn('[media] retry failed — unexpected exception', {
        id:        item.msg.id?._serialized,
        attempt:   item.attempts,
        error:     err instanceof Error ? err.message : String(err),
        inspected: util.inspect(err, { depth: 5 }),
      });
    }
  }
}
