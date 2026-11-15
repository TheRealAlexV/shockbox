// Minimal PNG writer (8-bit RGB, no interlace) for the diagnostic composites.
//
// There is no image library on this box and none is worth adding for this: a PNG is a signature,
// an IHDR, a zlib-deflated set of filtered scanlines and a CRC per chunk. That is all this does.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb  width*height*3 bytes, row-major
 * @returns {Buffer} a complete PNG
 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5x7 bitmap glyphs, one string per row. Only the characters the offset stamp uses: a font here
// is not worth a dependency, and a stamp of the numbers is all the image has to say.
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  a: ['00000', '01110', '00001', '01111', '10001', '01111', '00001'],
  c: ['00000', '01110', '10001', '10000', '10001', '01110', '00000'],
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01111'],
  e: ['00000', '01110', '10001', '11111', '10000', '01110', '00000'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  g: ['00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  k: ['10000', '10010', '10100', '11000', '10100', '10010', '10001'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  m: ['00000', '11011', '10101', '10101', '10001', '10001', '10001'],
  n: ['00000', '10110', '11001', '10001', '10001', '10001', '10001'],
  o: ['00000', '01110', '10001', '10001', '10001', '01110', '00000'],
  p: ['00000', '01110', '10001', '10001', '01110', '10000', '10000'],
  r: ['00000', '10110', '11001', '10000', '10000', '10000', '10000'],
  s: ['00000', '01111', '10000', '01110', '00001', '11110', '00000'],
  t: ['00100', '00100', '11111', '00100', '00100', '00110', '00000'],
  u: ['00000', '10001', '10001', '10001', '10001', '10011', '01101'],
  v: ['00000', '10001', '10001', '01010', '01010', '00100', '00000'],
  w: ['00000', '10001', '10001', '10101', '10101', '01010', '00000'],
  x: ['00000', '10001', '01010', '00100', '00100', '01010', '10001'],
  y: ['00000', '10001', '10001', '01010', '00100', '00100', '01000'],
};

/**
 * Draw text into an RGB buffer with the 5x7 glyphs above. Returns the width drawn.
 * `scale` multiplies both the glyph and its advance, so 2 is legible at 480 px wide.
 */
export function drawText(rgb, width, height, x0, y0, text, { scale = 2, color = [255, 255, 255] } = {}) {
  let x = x0;
  for (const ch of String(text)) {
    const glyph = GLYPHS[ch] || GLYPHS['?'] || GLYPHS[' '];
    for (let gy = 0; gy < 7; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          const py = y0 + gy * scale + sy;
          if (py < 0 || py >= height) continue;
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx;
            if (px < 0 || px >= width) continue;
            const o = (py * width + px) * 3;
            rgb[o] = color[0];
            rgb[o + 1] = color[1];
            rgb[o + 2] = color[2];
          }
        }
      }
    }
    x += 6 * scale;
  }
  return x - x0;
}
