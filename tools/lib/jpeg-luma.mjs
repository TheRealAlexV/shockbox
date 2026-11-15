// Baseline-JPEG luma reader shared by tools/handfx-capture.mjs and tools/handfx-diag.mjs.
//
// A baseline JPEG DC coefficient is the mean of its 8x8 block, so walking the scan and keeping
// the luma DCs gives a 1/8-scale greyscale image of the frame plus real brightness statistics —
// no image library, no dependency. Progressive JPEGs cannot be read this way; those frames
// report an `error` and never a fabricated number.
//
// decodeJpegLuma(buf, { plane: true }) also returns `luma` (Uint8Array), `gridW`, `gridH`: one
// byte per 8x8 block in raster order, for the captured-frame composite image.

function decodeJpegLuma(buf, opts = {}) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { error: 'no SOI marker' };
  }
  const dqt = [];
  const dht = [];
  let frame = null;
  let restartInterval = 0;
  let i = 2;

  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    let marker = buf[i + 1];
    // fill bytes
    while (marker === 0xff && i + 2 < buf.length) { i++; marker = buf[i + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) break;
    if (i + 4 > buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    const seg = i + 4;
    const end = i + 2 + len;
    if (end > buf.length || len < 2) break;

    // SOF0 baseline, SOF1 extended sequential: 8-bit Huffman, DC-per-block is enough.
    if (marker === 0xc0 || marker === 0xc1) {
      const precision = buf[seg];
      const height = buf.readUInt16BE(seg + 1);
      const width = buf.readUInt16BE(seg + 3);
      const ncomp = buf[seg + 5];
      const comps = [];
      for (let c = 0; c < ncomp; c++) {
        const o = seg + 6 + c * 3;
        comps.push({
          id: buf[o],
          h: buf[o + 1] >> 4,
          v: buf[o + 1] & 15,
          q: buf[o + 2],
        });
      }
      frame = { precision, width, height, comps, progressive: false };
    } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf)) {
      const height = buf.readUInt16BE(seg + 1);
      const width = buf.readUInt16BE(seg + 3);
      return {
        width,
        height,
        error: marker === 0xc2 ? 'progressive JPEG (SOF2) unsupported' : `unsupported SOF 0x${marker.toString(16)}`,
      };
    } else if (marker === 0xc4) {
      let o = seg;
      while (o < end) {
        const tc = buf[o] >> 4;
        const th = buf[o] & 15;
        const counts = new Array(16);
        for (let k = 0; k < 16; k++) counts[k] = buf[o + 1 + k];
        let symCount = 0;
        for (let k = 0; k < 16; k++) symCount += counts[k];
        const symbols = buf.subarray(o + 17, o + 17 + symCount);
        dht[(tc << 4) | th] = buildHuffman(counts, symbols);
        o += 17 + symCount;
      }
    } else if (marker === 0xdb) {
      let o = seg;
      while (o < end) {
        const pq = buf[o] >> 4;
        const tq = buf[o] & 15;
        const vals = new Array(64);
        let p = o + 1;
        for (let k = 0; k < 64; k++) {
          if (pq === 0) { vals[k] = buf[p]; p += 1; }
          else { vals[k] = buf.readUInt16BE(p); p += 2; }
        }
        dqt[tq] = vals;
        o = p;
      }
    } else if (marker === 0xdd) {
      restartInterval = buf.readUInt16BE(seg);
    } else if (marker === 0xda) {
      if (!frame) return { error: 'SOS before SOF' };
      const ncomp = buf[seg];
      const scanComps = [];
      for (let c = 0; c < ncomp; c++) {
        const o = seg + 1 + c * 2;
        const id = buf[o];
        const tables = buf[o + 1];
        const comp = frame.comps.find((f) => f.id === id);
        if (!comp) return { error: `scan references unknown component ${id}` };
        scanComps.push({ comp, dc: tables >> 4, ac: tables & 15 });
      }
      return decodeScan(buf, end, frame, scanComps, dht, dqt, restartInterval, opts);
    }
    i = end;
  }
  return frame ? { width: frame.width, height: frame.height, error: 'no SOS marker' } : { error: 'no SOF marker' };
}

function buildHuffman(counts, symbols) {
  // Canonical codes as the three arrays the JPEG spec's decoder uses: first code and last code
  // for each length, and where that length's symbols start. No per-bit map lookups.
  const mincode = new Int32Array(17).fill(-1);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let code = 0;
  let vi = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) {
      valptr[l] = vi;
      mincode[l] = code;
      maxcode[l] = code + n - 1;
      vi += n;
    }
    // Every length consumes a bit level, including lengths with no codes.
    code = (code + n) << 1;
  }
  return { mincode, maxcode, valptr, val: symbols };
}

function decodeScan(buf, start, frame, scanComps, dht, dqt, restartInterval, opts = {}) {
  const luma = scanComps[0].comp;
  const lumaIdx = frame.comps.indexOf(luma);
  const hmax = Math.max(...frame.comps.map((c) => c.h));
  const vmax = Math.max(...frame.comps.map((c) => c.v));
  const mcuW = 8 * hmax;
  const mcuH = 8 * vmax;
  const mcusX = Math.ceil(frame.width / mcuW);
  const mcusY = Math.ceil(frame.height / mcuH);
  // The optional 1/8-scale plane: one byte per luma block, in raster order (the composite image).
  const gridW = mcusX * luma.h;
  const gridH = mcusY * luma.v;
  const plane = opts.plane ? new Uint8Array(gridW * gridH) : null;

  const reader = new BitReader(buf, start);
  const pred = new Int32Array(scanComps.length);
  let blocks = 0;
  let sum = 0;
  let sumsq = 0;
  let lumaMin = 255;
  let lumaMax = 0;
  const qLuma = dqt[luma.q];
  if (!qLuma) return { width: frame.width, height: frame.height, error: 'missing luma quant table' };

  const ensure = (dcTable, acTable) => {
    if (!dcTable || !acTable) throw new Error('missing Huffman table for scan');
  };

  try {
    let mcu = 0;
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
          reader.restart();
          pred.fill(0);
        }
        for (let ci = 0; ci < scanComps.length; ci++) {
          const { comp, dc, ac } = scanComps[ci];
          const dct = dht[dc];
          const act = dht[0x10 | ac];
          ensure(dct, act);
          const nblocks = comp.h * comp.v;
          for (let b = 0; b < nblocks; b++) {
            const s = reader.huff(dct);
            const diff = s === 0 ? 0 : reader.receiveExtend(s);
            pred[ci] += diff;
            // AC coefficients must be walked to stay in sync; their values are discarded.
            walkAc(reader, act);
            if (ci === 0) {
              const v = (pred[ci] * qLuma[0]) / 8 + 128;
              const c = v < 0 ? 0 : v > 255 ? 255 : v;
              sum += c;
              sumsq += c * c;
              if (c < lumaMin) lumaMin = c;
              if (c > lumaMax) lumaMax = c;
              blocks++;
              if (plane) {
                // Luma blocks sit comp.h x comp.v per MCU; place each on its own grid cell so the
                // plane reads as the frame and not as MCU groups.
                const bx = mx * comp.h + (b % comp.h);
                const by = my * comp.v + ((b / comp.h) | 0);
                if (bx < gridW && by < gridH) plane[by * gridW + bx] = c;
              }
            }
          }
        }
        mcu++;
      }
    }
  } catch (err) {
    return {
      width: frame.width,
      height: frame.height,
      error: `scan decode failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  if (!blocks) return { width: frame.width, height: frame.height, error: 'no luma blocks decoded' };

  const mean = sum / blocks;
  const variance = Math.max(0, sumsq / blocks - mean * mean);
  return {
    width: frame.width,
    height: frame.height,
    blocks,
    lumaMean: mean,
    lumaSd: Math.sqrt(variance),
    lumaMin,
    lumaMax,
    ...(plane ? { luma: plane, gridW, gridH } : {}),
  };
}

function walkAc(reader, table) {
  let k = 1;
  while (k < 64) {
    const sym = reader.huff(table);
    if (sym === 0x00) return; // EOB
    if (sym === 0xf0) { k += 16; continue; } // ZRL
    const run = sym >> 4;
    const size = sym & 15;
    k += run;
    if (size) reader.skip(size);
    k++;
  }
}

class BitReader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.acc = 0; // 32-bit lookahead, valid bits in the low `n`
    this.n = 0;
  }
  fill() {
    while (this.n <= 24) {
      if (this.pos >= this.buf.length) return;
      const byte = this.buf[this.pos];
      if (byte === 0xff) {
        const next = this.buf[this.pos + 1];
        if (next === 0x00) this.pos += 2; // stuffed byte, carries 0xFF
        else return; // a marker: no more entropy bytes until a restart
      } else {
        this.pos += 1;
        this.acc = ((this.acc << 8) | byte) >>> 0;
        this.n += 8;
        continue;
      }
      this.acc = ((this.acc << 8) | 0xff) >>> 0;
      this.n += 8;
    }
  }
  bits(k) {
    if (k === 0) return 0;
    if (this.n < k) {
      this.fill();
      if (this.n < k) throw new Error('bitstream exhausted');
    }
    this.n -= k;
    return (this.acc >>> this.n) & ((1 << k) - 1);
  }
  skip(k) {
    while (k > 0) {
      if (this.n === 0) {
        this.fill();
        if (this.n === 0) throw new Error('bitstream exhausted');
      }
      const t = k < this.n ? k : this.n;
      this.n -= t;
      k -= t;
    }
  }
  huff(table) {
    let code = this.bits(1);
    let l = 1;
    while (l <= 16 && code > table.maxcode[l]) {
      code = (code << 1) | this.bits(1);
      l++;
    }
    if (l > 16) throw new Error('bad Huffman code');
    return table.val[table.valptr[l] + code - table.mincode[l]];
  }
  receiveExtend(s) {
    const v = this.bits(s);
    const half = 1 << (s - 1);
    return v < half ? v - (1 << s) + 1 : v;
  }
  restart() {
    // Drop buffered bits (byte-align), then consume the RSTn marker.
    this.acc = 0;
    this.n = 0;
    while (this.pos + 1 < this.buf.length) {
      if (this.buf[this.pos] === 0xff && this.buf[this.pos + 1] >= 0xd0 && this.buf[this.pos + 1] <= 0xd7) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
  }
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function brightnessOf(buf) {
  const r = decodeJpegLuma(buf);
  if (r.error) {
    return { width: r.width ?? null, height: r.height ?? null, brightness: null, brightnessNote: r.error };
  }
  return {
    width: r.width,
    height: r.height,
    brightness: {
      mean: round(r.lumaMean, 2),
      sd: round(r.lumaSd, 2),
      min: round(r.lumaMin, 2),
      max: round(r.lumaMax, 2),
      blocks: r.blocks,
    },
  };
}

export { decodeJpegLuma, brightnessOf };
