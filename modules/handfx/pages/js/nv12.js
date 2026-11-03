// RGBA → NV12, shared by the page and the server.
//
// The page converts before it uploads (RGBA at 1280x720 is 3.7 MB per frame; NV12 is 1.38 MB, and
// the upload is the expensive half of a publish round trip), and the server converts when a frame
// arrives in RGBA. One implementation, imported over HTTP by the page and by path in Node, so the
// two can never disagree about the bytes the pipe receives.
//
// BT.601 studio swing (the source advertises MFNominalRange_16_235): Y 16..235, U/V 16..240.
// Integer only and no clamping: the formulas are bounded by 16..235 / 16..240 for 8-bit input.

/**
 * Write width*height*3/2 bytes of NV12 into `out`, at offset 0 (Y plane, then interleaved U/V,
 * stride == width, no padding).
 */
export function nv12Into(rgba, width, height, out) {
  const w = width;
  const h = height;
  const ySize = w * h;
  let y = 0;
  let s = 0;
  for (let row = 0; row < h; row++) {
    const rowEnd = s + w * 4;
    while (s < rowEnd) {
      // Y = ((66R + 129G + 25B + 128) >> 8) + 16
      out[y++] = ((66 * rgba[s] + 129 * rgba[s + 1] + 25 * rgba[s + 2] + 128) >> 8) + 16;
      s += 4;
    }
  }
  // One chroma sample per 2x2 block, interleaved U then V.
  let uv = ySize;
  for (let row = 0; row < h; row += 2) {
    const rowA = row * w * 4;
    const rowB = rowA + w * 4;
    for (let col = 0; col < w; col += 2) {
      const a = rowA + col * 4;
      const b = rowB + col * 4;
      const r = rgba[a] + rgba[a + 4] + rgba[b] + rgba[b + 4];
      const g = rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5];
      const bl = rgba[a + 2] + rgba[a + 6] + rgba[b + 2] + rgba[b + 6];
      // U = ((-38R - 74G + 112B) >> 8) + 128, V = ((112R - 94G - 18B) >> 8) + 128,
      // on the 4-pixel sum, hence the extra >> 2.
      out[uv++] = ((-38 * r - 74 * g + 112 * bl) >> 10) + 128;
      out[uv++] = ((112 * r - 94 * g - 18 * bl) >> 10) + 128;
    }
  }
}

/** Bytes one NV12 frame of this geometry occupies. */
export function nv12Size(width, height) {
  return ((width * height * 3) >> 1);
}
