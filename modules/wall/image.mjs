// Wall image ingest — bytes in, a storable file out.
//
// The wall's HTTP layer hands every request body through core's `readJson`, which means a route
// cannot receive a picture body at all. The upload route is therefore mediated by core (see
// `rawRoutes` in modules/wall/server.js): core hands the raw Buffer here, and this module is the
// only place that decides what a picture is.
//
// No image library, no new dependency: the browser decodes and resizes (it already has the
// picture on screen to drag), so all the server must do is refuse what it cannot trust and keep
// the bytes byte-for-byte.

import crypto from 'node:crypto';
import { HttpError } from '../../core/id.mjs';

/** Hard ceiling on one upload. 8 MB: a 4096px PNG is ~2 MB, a phone JPEG ~4 MB. */
export const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Accepted formats, identified by magic bytes — never by the client's content type or file name,
 * which are both advisory. Each entry also carries the MIME the read route serves it with, so a
 * `.png` file cannot be served as `text/html` and executed in the pane's origin.
 */
const TYPES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

/** The MIME for a picture this module accepted, or null. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  for (const t of TYPES) if (t.test(buf)) return t.mime;
  return null;
}

/**
 * Pixel dimensions, read from the header. Only used to record what was uploaded (the engine
 * learns the real size from the decoded bitmap anyway), so PNG/GIF/WebP and the common JPEG
 * SOF markers are enough — anything else reports 0 rather than guessing.
 */
export function imageSize(buf) {
  try {
    const mime = sniffImage(buf);
    if (mime === 'image/png') {
      // IHDR is the first chunk: width/height are big-endian at 16/20.
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') {
        return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      }
      return { w: 0, h: 0 };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT(c4)/JPG(c8)/DAC(cc) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* a truncated header reports 0 */
  }
  return { w: 0, h: 0 };
}

/**
 * Validate an upload. Throws `{status, message}`-shaped errors the route turns into HttpErrors,
 * so one place owns "what is a legal picture".
 */
export function acceptUpload(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'image: empty body');
  if (buf.length > MAX_BYTES) throw new HttpError(413, `image: ${buf.length} bytes > ${MAX_BYTES} limit`);
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(400, 'image: not a PNG, JPEG, WebP or GIF (content sniff failed)');
  const { w, h } = imageSize(buf);
  return { mime, ext: TYPES.find((t) => t.mime === mime).ext, bytes: buf.length, w, h };
}

/** Content-addressed name: an identical upload reuses the stored file. */
export function nameFor(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}
