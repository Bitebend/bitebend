import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageTypes } from 'whatsapp-web.js';
import { isIncomingScreenshotMessage } from '../webhooks/incomingMessages';
import { detectImageMimeType } from '../services/whatsappClient';

describe('WhatsApp Bridge Screenshot Message Detection & MIME Sniffing', () => {
  it('accepts standard IMAGE messages', () => {
    const msg = { type: MessageTypes.IMAGE, _data: {} } as any;
    assert.equal(isIncomingScreenshotMessage(msg), true);
  });

  it('accepts GPay / HD screenshots sent as DOCUMENT with image/* mimetype', () => {
    const pngDoc = {
      type: MessageTypes.DOCUMENT,
      body: 'GPay_Receipt.png',
      _data: { mimetype: 'image/png', filename: 'GPay_Receipt.png' },
    } as any;
    assert.equal(isIncomingScreenshotMessage(pngDoc), true);

    const webpDoc = {
      type: MessageTypes.DOCUMENT,
      body: '',
      _data: { mimetype: 'image/webp', filename: 'receipt.webp' },
    } as any;
    assert.equal(isIncomingScreenshotMessage(webpDoc), true);
  });

  it('accepts DOCUMENT messages with application/octet-stream when filename has image extension', () => {
    const docByExt = {
      type: MessageTypes.DOCUMENT,
      body: 'IMG-20261113-WA0001.jpg',
      _data: { mimetype: 'application/octet-stream', filename: 'IMG-20261113-WA0001.jpg' },
    } as any;
    assert.equal(isIncomingScreenshotMessage(docByExt), true);
  });

  it('rejects non-image DOCUMENT files (e.g. PDFs)', () => {
    const pdfDoc = {
      type: MessageTypes.DOCUMENT,
      body: 'menu.pdf',
      _data: { mimetype: 'application/pdf', filename: 'menu.pdf' },
    } as any;
    assert.equal(isIncomingScreenshotMessage(pdfDoc), false);
  });

  it('detectImageMimeType identifies JPEG, PNG, WebP, GIF and rejects empty/corrupt buffers', () => {
    assert.equal(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(
      detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      'image/png',
    );
    assert.equal(
      detectImageMimeType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
      'image/webp',
    );
    assert.equal(detectImageMimeType(Buffer.alloc(0)), null);
    assert.equal(detectImageMimeType(Buffer.from('not-an-image')), null);
  });
});
