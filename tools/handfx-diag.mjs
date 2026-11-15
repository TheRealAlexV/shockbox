#!/usr/bin/env node
// ShockFX overlay diagnostic capture — one command, self-service, Ctrl-C to stop.
//
//   node tools/handfx-diag.mjs --seconds 300
//
// It does four things at once against the running server:
//   1. reads the relay's frame stream and saves every Nth JPEG (what the camera actually saw),
//   2. arms the overlay's per-frame sampler (`diag.start`) and drains its samples into diag.jsonl
//      (the geometry, landmarks, mapped points, anchors and effect centres the page computed),
//   3. keeps the 1 Hz /api/handfx/status sample going in status.jsonl,
//   4. on stop, writes summary.json, README.md, offsets.csv and composites/<frame>.png: each saved
//      frame with the mapped landmarks and the effect's draw position burnt on, so an offset is
//      read off the picture instead of argued about.
//
// Everything is additive: a page that is not armed posts nothing and the folder is still written
// (summary.json says diag never arrived), and a failed diag POST in the page is swallowed there.
//
// --recompute DIR: redo the pairing, CSV, composites, summary and README for an existing capture
// (e.g. after a run that was cut short before its post-pass).

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { brightnessOf, decodeJpegLuma } from './lib/jpeg-luma.mjs';
import { relayFrames } from './lib/handfx-relay.mjs';
import { encodePng, drawText } from './lib/png.mjs';

// ---------------------------------------------------------------------------
// arguments

function parseArgs(argv) {
  const args = {
    seconds: 300,
    every: 30, // one saved frame per second at a 30 fps relay
    out: '',
    url: 'http://127.0.0.1:8972',
    note: '',
    maxFrames: 400,
    composite: true,
    recompute: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--seconds') args.seconds = Math.max(1, Number(next()) || 300);
    else if (a === '--every') args.every = Math.max(1, Number(next()) || 30);
    else if (a === '--out') args.out = String(next() || '');
    else if (a === '--url') args.url = String(next() || args.url).replace(/\/+$/, '');
    else if (a === '--note') args.note = String(next() || '');
    else if (a === '--max-frames') args.maxFrames = Math.max(1, Number(next()) || 400);
    else if (a === '--no-composite') args.composite = false;
    else if (a === '--recompute') args.recompute = String(next() || '');
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'usage: node tools/handfx-diag.mjs [--seconds N] [--every N] [--out DIR] [--url URL]',
          '',
          '  --seconds N     stop after N seconds (default 300); Ctrl-C stops sooner',
          '  --every N       save one relay frame in N (default 30, i.e. ~1/s)',
          '  --out DIR       capture folder (default captures/handfx-diag-<timestamp>)',
          '  --url URL       server base (default http://127.0.0.1:8972)',
          '  --note TEXT     one line on what the operator was doing; goes in README.md',
          '  --max-frames N  stop saving frames after N (default 400)',
          '  --no-composite  skip the per-frame PNGs (offsets.csv is still written)',
          '  --recompute DIR rebuild CSV/composites/summary for an existing capture folder',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  if (!args.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.out = path.join('captures', `handfx-diag-${stamp}`);
  }
  args.out = path.resolve(args.out);
  return args;
}

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

async function fetchJson(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// composite image

const CROSS = 5; // half-arm of a cross, in composite pixels
const SCALE = 4; // composite pixels per luma cell; a cell is 8 source pixels
const LM_COLOR = [0, 235, 240]; // cyan: where the page put the landmark
const FX_COLOR = [255, 120, 0]; // orange: where the effect was drawn
const TEXT_COLOR = [255, 255, 255];

/**
 * The three canvas-pixel landmarks, converted back to source-pixel positions. `mapped` is in
 * canvas device pixels; the composite is at 1/2 source scale, so the value divides by
 * (canvasWidth / sourceWidth) * 2. Both are recorded in the sample, so this is a division and not
 * a guess about the device pixel ratio.
 */
function sourceFromCanvasPx(px, sample) {
  if (!px || !Number.isFinite(px.x)) return null;
  const cw = sample.geometry && sample.geometry.canvas ? sample.geometry.canvas.w : null;
  const fw = sample.geometry && sample.geometry.frame ? sample.geometry.frame.w : null;
  if (!cw || !fw) return null;
  const k = fw / cw; // one canvas pixel in source pixels
  return { x: px.x * k, y: px.y * k };
}

function fillRect(rgb, W, H, x0, y0, w, h, color) {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const o = (y * W + x) * 3;
      rgb[o] = color[0];
      rgb[o + 1] = color[1];
      rgb[o + 2] = color[2];
    }
  }
}

function stamp(rgb, W, H, lines) {
  const pad = 4;
  const lineH = 9 * 2;
  const boxW = Math.max(...lines.map((l) => l.length)) * 6 * 2 + pad * 2;
  const boxH = lines.length * lineH + pad; 
  const x = Math.max(0, W - boxW - 4);
  const y = 4;
  fillRect(rgb, W, H, x, y, boxW, boxH, [0, 0, 0]);
  lines.forEach((line, i) => drawText(rgb, W, H, x + pad, y + pad + i * lineH, line, { scale: 2, color: TEXT_COLOR }));
}

/**
 * One composite: the source frame at half scale (from its luma DCs), the mapped landmarks as cyan
 * crosses, the effect's draw position as an orange cross, a line between wrist and effect, and the
 * offset in source pixels stamped on it.
 */
function compositeFor(jpeg, sample) {
  const dec = decodeJpegLuma(jpeg, { plane: true });
  if (dec.error || !dec.luma) return { error: dec.error || 'no luma plane' };
  const W = dec.gridW * SCALE;
  const H = dec.gridH * SCALE;
  const rgb = new Uint8Array(W * H * 3);
  // Nearest-neighbour from the 1/8-scale plane: a block fills an SCALE x SCALE square.
  for (let gy = 0; gy < dec.gridH; gy++) {
    for (let gx = 0; gx < dec.gridW; gx++) {
      const v = dec.luma[gy * dec.gridW + gx];
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const o = ((gy * SCALE + sy) * W + (gx * SCALE + sx)) * 3;
          rgb[o] = v;
          rgb[o + 1] = v;
          rgb[o + 2] = v;
        }
      }
    }
  }
  // Source pixel -> composite pixel: source / 8 * SCALE.
  const toImg = (p) => ({
    x: Math.round((p.x / 8) * SCALE),
    y: Math.round((p.y / 8) * SCALE),
  });
  const cross = (p, color, arm = CROSS) => {
    fillRect(rgb, W, H, p.x - arm, p.y, arm * 2 + 1, 1, color);
    fillRect(rgb, W, H, p.x, p.y - arm, 1, arm * 2 + 1, color);
  };

  const pts = sample.mapped && sample.mapped[0] ? sample.mapped[0] : null;
  const srcPts = pts
    ? {
        wrist: sourceFromCanvasPx(pts.wrist, sample),
        middleMcp: sourceFromCanvasPx(pts.middleMcp, sample),
        indexTip: sourceFromCanvasPx(pts.indexTip, sample),
      }
    : null;
  const fx = sample.effects && sample.effects.find((e) => e.active && e.at) ? sample.effects.find((e) => e.active && e.at) : null;
  // Trust the page's own report: `on` is what the overlay actually applied this frame, so the
  // tool never re-derives the rule (`underlay`/`setting` are recorded beside it to explain it).
  const mirror = sample.mirror ? sample.mirror.on === true : false;
  const fxSource = fx && fx.at ? { x: (mirror ? 1 - fx.at.x : fx.at.x) * (dec.width || 0), y: fx.at.y * (dec.height || 0) } : null;

  if (srcPts && srcPts.middleMcp) cross(toImg(srcPts.middleMcp), LM_COLOR);
  if (srcPts && srcPts.wrist) cross(toImg(srcPts.wrist), LM_COLOR, 3);
  if (srcPts && srcPts.indexTip) cross(toImg(srcPts.indexTip), LM_COLOR, 3);
  if (fxSource) {
    // The connector is the whole point: it is the offset, drawn.
    const a = toImg(srcPts && srcPts.middleMcp ? srcPts.middleMcp : { x: 0, y: 0 });
    const b = toImg(fxSource);
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      fillRect(rgb, W, H, Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), 1, 1, FX_COLOR);
    }
    cross(toImg(fxSource), FX_COLOR, CROSS + 1);
  }

  const offset =
    srcPts && srcPts.middleMcp && fxSource
      ? { dx: round(fxSource.x - srcPts.middleMcp.x, 1), dy: round(fxSource.y - srcPts.middleMcp.y, 1) }
      : null;
  const lines = [
    `dx ${offset ? (offset.dx >= 0 ? '+' : '') + offset.dx : '--'}  dy ${offset ? (offset.dy >= 0 ? '+' : '') + offset.dy : '--'}`,
    `f${sample.n ?? '?'} ${fx ? fx.id || 'fx' : 'no fx'} ${sample.mirror && sample.mirror.on === true ? 'mirror' : 'nomirror'}`,
  ];
  stamp(rgb, W, H, lines);
  return {
    png: encodePng(W, H, rgb),
    width: W,
    height: H,
    offset,
    source: { width: dec.width, height: dec.height },
  };
}

// ---------------------------------------------------------------------------
// post-pass: pair, CSV, composites, summary, README


async function postPass(dir, opts) {
  const files = await readdir(dir);
  const frameFiles = files.filter((f) => /^frame-\d+\.jpg$/.test(f)).sort();
  let frames = [];
  try {
    frames = JSON.parse(await readFile(path.join(dir, 'frames.json'), 'utf8'));
  } catch {
    frames = [];
  }
  let diag = [];
  try {
    const text = await readFile(path.join(dir, 'diag.jsonl'), 'utf8');
    diag = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    diag = [];
  }
  const byWall = diag.filter((s) => Number.isFinite(s.wallAt)).sort((a, b) => a.wallAt - b.wallAt);

  /** Nearest diag sample in wall-clock time, if it is close enough to be the same moment. */
  function nearest(wallAt, toleranceMs = 400) {
    if (!byWall.length || !Number.isFinite(wallAt)) return null;
    let lo = 0;
    let hi = byWall.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byWall[mid].wallAt < wallAt) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo, lo + 1]) {
      const s = byWall[i];
      if (!s) continue;
      const d = Math.abs(s.wallAt - wallAt);
      if (d <= toleranceMs && (!best || d < best.d)) best = { s, d };
    }
    return best ? best.s : null;
  }

  const csvRows = [];
  const paired = [];
  const compositeNotes = [];
  let composites = 0;
  let compositeErrors = 0;
  const offsets = [];

  for (const rec of frames) {
    const wall = rec.atMs ?? Date.parse(rec.at);
    const sample = nearest(wall);
    const row = { frame: rec.file, diag: sample ? sample.n : null };
    if (sample) {
      const fx = sample.effects && sample.effects.find((e) => e.active && e.at);
      // Consume the page's recorded boolean; never recompute the rule here.
      const mirror = sample.mirror ? sample.mirror.on === true : false;
      const fw = sample.geometry && sample.geometry.frame ? sample.geometry.frame.w : null;
      const fh = sample.geometry && sample.geometry.frame ? sample.geometry.frame.h : null;
      const pts = sample.mapped && sample.mapped[0];
      const lmSrc = pts ? sourceFromCanvasPx(pts.middleMcp, sample) : null;
      const fxSrc = fx && fx.at && fw && fh ? { x: (mirror ? 1 - fx.at.x : fx.at.x) * fw, y: fx.at.y * fh } : null;
      Object.assign(row, {
        lmX: lmSrc ? round(lmSrc.x, 1) : null,
        lmY: lmSrc ? round(lmSrc.y, 1) : null,
        effectId: fx ? fx.id : null,
        effectX: fxSrc ? round(fxSrc.x, 1) : null,
        effectY: fxSrc ? round(fxSrc.y, 1) : null,
        dx: lmSrc && fxSrc ? round(fxSrc.x - lmSrc.x, 1) : null,
        dy: lmSrc && fxSrc ? round(fxSrc.y - lmSrc.y, 1) : null,
      });
      if (Number.isFinite(row.dx) && Number.isFinite(row.dy)) offsets.push({ dx: row.dx, dy: row.dy });
      paired.push({ rec, sample });

      if (opts.composite) {
        try {
          const jpeg = await readFile(path.join(dir, 'frames', rec.file));
          const out = compositeFor(jpeg, sample);
          if (out.error) {
            compositeErrors++;
            compositeNotes.push(`${rec.file}: ${out.error}`);
          } else {
            await mkdir(path.join(dir, 'composites'), { recursive: true });
            await writeFile(path.join(dir, 'composites', rec.file.replace(/\.jpg$/, '.png')), out.png);
            composites++;
          }
        } catch (err) {
          compositeErrors++;
          compositeNotes.push(`${rec.file}: ${err && err.message ? err.message : err}`);
        }
      }
    }
    csvRows.push(row);
  }

  const header = 'frame,diag,lmX,lmY,effectId,effectX,effectY,dx,dy';
  const csv = [
    header,
    ...csvRows.map((r) =>
      [r.frame, r.diag ?? '', r.lmX ?? '', r.lmY ?? '', r.effectId ?? '', r.effectX ?? '', r.effectY ?? '', r.dx ?? '', r.dy ?? ''].join(','),
    ),
  ].join('\n');
  await writeFile(path.join(dir, 'offsets.csv'), csv + '\n');

  const mean = (k) => (offsets.length ? round(offsets.reduce((a, o) => a + o[k], 0) / offsets.length, 1) : null);
  const absMean = (k) => (offsets.length ? round(offsets.reduce((a, o) => a + Math.abs(o[k]), 0) / offsets.length, 1) : null);

  let summary = {};
  try {
    summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
  } catch {
    summary = {};
  }
  const diagGaps = [];
  for (let i = 1; i < byWall.length; i++) {
    const gap = byWall[i].wallAt - byWall[i - 1].wallAt;
    if (gap > 600) diagGaps.push({ afterSeq: byWall[i - 1].seq ?? null, gapMs: gap, at: new Date(byWall[i].wallAt).toISOString() });
  }
  summary.diag = {
    samples: diag.length,
    arrived: diag.length > 0,
    firstAt: byWall.length ? new Date(byWall[0].wallAt).toISOString() : null,
    lastAt: byWall.length ? new Date(byWall[byWall.length - 1].wallAt).toISOString() : null,
    gapsOver600ms: diagGaps.slice(0, 50),
    gapCount: diagGaps.length,
    fullSamples: diag.filter((s) => s.full).length,
    clients: [...new Set(diag.map((s) => s.clientId).filter(Boolean))].slice(0, 8),
    builds: [...new Set(diag.map((s) => s.build).filter(Boolean))].slice(0, 8),
  };
  summary.pairing = {
    savedFrames: frames.length,
    pairedFrames: paired.length,
    unpairedFrames: frames.length - paired.length,
    composites,
    compositeErrors,
    compositeErrorNotes: compositeNotes.slice(0, 10),
    toleranceMs: 400,
  };
  summary.offset = {
    unit: 'source pixels (960x540 relay frame)',
    landmark: 'mapped middle-finger MCP (landmark 9)',
    effect: 'the active effect\'s own draw position (fx.live … drawnAt)',
    n: offsets.length,
    meanDx: mean('dx'),
    meanDy: mean('dy'),
    meanAbsDx: absMean('dx'),
    meanAbsDy: absMean('dy'),
  };
  summary.files = {
    'frames/*.jpg': 'every Nth relay frame, exactly as the relay sent it (what the camera saw)',
    'composites/*.png': 'the same frame at half scale with mapped landmarks (cyan) and the effect draw position (orange)',
    'diag.jsonl': 'one line per page sample: geometry, landmarks, mapped points, anchors, effects, gesture',
    'status.jsonl': 'one line per second of /api/handfx/status',
    'offsets.csv': 'per saved frame: landmark vs effect position and the offset between them, in source pixels',
    'summary.json': 'counts, durations, whether diag data arrived, gaps, and the offset statistics',
    'README.md': 'this page',
  };
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(path.join(dir, 'README.md'), readmeFor(summary, opts));
  return { summary, csvRows };
}

function readmeFor(summary, opts) {
  const when = summary.startedAt || new Date().toISOString();
  const secs = summary.elapsedSeconds ?? null;
  return [
    '# ShockFX overlay diagnostic capture',
    '',
    `Started ${when}${secs ? `, ran ${secs}s` : ''}, stopped by: ${summary.stoppedBy || 'unknown'}.`,
    `Server: ${summary.serverUrl || opts.url}.  Rig mount: /mnt/c/OBS/ShockBox.`,
    '',
    '## What the operator was doing',
    '',
    opts.note ? opts.note : '_No --note given. Fill this in while it is fresh: which hand, how far from the camera, which effect was on screen, and whether the offset moved with the hand._',
    '',
    '## What each file is',
    '',
    '| file | what it holds |',
    '| --- | --- |',
    ...Object.entries(summary.files || {}).map(([f, what]) => `| \`${f}\` | ${what} |`),
    '',
    '## How to read it',
    '',
    '- `composites/` is the answer at a glance: **cyan** crosses are the landmarks the page mapped,',
    '  **orange** is where the effect was actually drawn, and the line between them is the offset.',
    '  If the cyan crosses sit off the hand, the detector or the mirroring is wrong. If they sit on',
    '  the hand but the orange cross does not, the mapping from page space to canvas is wrong.',
    '- `offsets.csv` is the same measurement as numbers, one row per saved frame: `dx`/`dy` are the',
    '  effect position minus the middle-finger MCP, in source pixels of the 960x540 relay frame.',
    '- `diag.jsonl` is the page\'s own account per sample (~10 Hz): the frame and canvas geometry,',
    '  the raw landmarks, the mapped landmarks in canvas pixels, `view.hands` as the effect layer got',
    '  it, every live effect with the centre it drew at, and the classifier\'s gesture with its',
    '  intermediates (`open`, `count`, `palmFacing`) so a threshold failure is visible.',
    '- `status.jsonl` is the server\'s 1 Hz view: tracker counts, relay clients, frame rate.',
    '',
    '## What was true for this run',
    '',
    `- diag data arrived: **${summary.diag && summary.diag.arrived ? 'yes' : 'no'}**` +
      (summary.diag && summary.diag.samples ? ` (${summary.diag.samples} samples)` : ''),
    `- saved frames: ${summary.pairing ? summary.pairing.savedFrames : 0}, paired to a diag sample: ` +
      `${summary.pairing ? summary.pairing.pairedFrames : 0}, composites written: ${summary.pairing ? summary.pairing.composites : 0}`,
    `- diag gaps over 600 ms: ${summary.diag ? summary.diag.gapCount : 0}`,
    `- mean offset: dx ${summary.offset ? summary.offset.meanDx : 'n/a'} px, dy ${summary.offset ? summary.offset.meanDy : 'n/a'} px` +
      ` (mean |dx| ${summary.offset ? summary.offset.meanAbsDx : 'n/a'}, |dy| ${summary.offset ? summary.offset.meanAbsDy : 'n/a'})`,
    '',
    'If `diag` says it never arrived: the overlay page was not armed. Arm it with',
    '`POST /api/handfx/cmd {"cmd":"diag.start","args":{"seconds":300}}` (this tool does that itself)',
    'and make sure the server was restarted after the /diag route was added.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// main

const args = parseArgs(process.argv.slice(2));

if (args.recompute) {
  const dir = path.resolve(args.recompute);
  const { summary } = await postPass(dir, { ...args, composite: args.composite, note: args.note || '' });
  console.log(`[recompute] ${dir}: ${summary.pairing.pairedFrames}/${summary.pairing.savedFrames} frames paired, ${summary.pairing.composites} composites`);
  process.exit(0);
}

const startedAt = new Date();
const deadline = startedAt.getTime() + args.seconds * 1000;
await mkdir(args.out, { recursive: true });
await mkdir(path.join(args.out, 'frames'), { recursive: true });

const state = {
  framesParsed: 0,
  framesSaved: 0,
  framesUndecodable: 0,
  reconnects: 0,
  streamErrors: [],
  brightnessSamples: [],
  frames: [],
  diagSamples: 0,
  diagDrains: 0,
  diagErrors: [],
  diagSeq: 0,
  diagArmed: null,
  diagDropped: 0,
  statusSamples: 0,
  statusErrors: [],
  firstStatus: null,
  lastStatus: null,
  maxDetects: null,
  maxHands: null,
  stoppedBy: 'duration',
};

const statusStream = createWriteStream(path.join(args.out, 'status.jsonl'), { flags: 'a' });
const diagStream = createWriteStream(path.join(args.out, 'diag.jsonl'), { flags: 'a' });

let stopping = false;
const stopCtl = new AbortController();
let finalizePromise = null;

function requestStop(why) {
  if (stopping) return;
  stopping = true;
  state.stoppedBy = why;
  stopCtl.abort();
  finalizePromise = finalize();
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

// ---------------------------------------------------------------------------
// arm the page

async function armDiag() {
  try {
    const r = await fetchJson(`${args.url}/api/handfx/cmd`, {
      method: 'POST',
      body: { cmd: 'diag.start', args: { seconds: Math.ceil(args.seconds) } },
    });
    state.diagArmed = { ok: r.ok, status: r.status, response: r.json };
    if (!r.ok) {
      console.log(`[diag] arm refused (${r.status}): ${JSON.stringify(r.json).slice(0, 200)}`);
      console.log('[diag] the overlay will only sample if the page was loaded with ?diag=1 and this server has the /diag route');
    } else {
      console.log('[diag] armed the overlay sampler');
    }
  } catch (err) {
    state.diagArmed = { ok: false, status: 0, error: String(err && err.message ? err.message : err) };
    console.log(`[diag] could not arm: ${err && err.message ? err.message : err}`);
  }
}

async function disarmDiag() {
  try {
    await fetchJson(`${args.url}/api/handfx/cmd`, { method: 'POST', body: { cmd: 'diag.stop', args: {} } });
  } catch {
    /* stopping anyway */
  }
}

// ---------------------------------------------------------------------------
// diag drain: the server's ring, one cursor

async function drainDiag() {
  while (!stopping && Date.now() < deadline) {
    const at = new Date();
    try {
      const r = await fetchJson(`${args.url}/api/handfx/diag?since=${state.diagSeq}&limit=500`);
      if (r.ok && r.json && Array.isArray(r.json.samples)) {
        for (const s of r.json.samples) {
          diagStream.write(JSON.stringify(s) + '\n');
          state.diagSamples++;
          state.diagSeq = Math.max(state.diagSeq, s.seq || 0);
        }
        state.diagDrains++;
        if (Number.isFinite(r.json.dropped)) state.diagDropped = r.json.dropped;
        if (r.json.total > 0 && state.diagDrains % 10 === 1) {
          console.log(`[diag] ${r.json.total} samples received by the server, ${state.diagSamples} drained, enabled=${r.json.enabled}`);
        }
      } else if (!r.ok) {
        state.diagErrors.push({ iso: at.toISOString(), status: r.status });
      }
    } catch (err) {
      state.diagErrors.push({ iso: at.toISOString(), error: String(err && err.message ? err.message : err) });
    }
    const waitUntil = at.getTime() + 500;
    while (!stopping && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// status: unchanged from handfx-capture (1 Hz)

async function pollStatus() {
  while (!stopping && Date.now() < deadline) {
    const at = new Date();
    try {
      const r = await fetchJson(`${args.url}/api/handfx/status`);
      if (r.ok && r.json) {
        const sample = {
          ts: at.getTime(),
          iso: at.toISOString(),
          tracker: r.json.tracker ?? null,
          cameraFeed: r.json.cameraFeed ?? null,
          publish: r.json.publish ?? null,
          ratio: r.json.ratio ?? null,
          build: r.json.build ?? null,
          pageState: r.json.pageState ?? null,
          effectiveSource: r.json.effectiveSource ?? null,
        };
        statusStream.write(JSON.stringify(sample) + '\n');
        state.statusSamples++;
        if (!state.firstStatus) state.firstStatus = sample;
        state.lastStatus = sample;
        const t = sample.tracker;
        if (t) {
          if (typeof t.detects === 'number') state.maxDetects = Math.max(state.maxDetects ?? 0, t.detects);
          if (typeof t.hands === 'number') state.maxHands = Math.max(state.maxHands ?? 0, t.hands);
        }
        if (state.statusSamples % 10 === 0) {
          const tr = t ?? {};
          console.log(
            `[status] ${state.statusSamples.toString().padStart(3)}s detects=${tr.detects ?? '?'} hands=${tr.hands ?? '?'} ` +
              `fps=${tr.fps ?? '?'} page=${sample.pageState ?? '?'}`,
          );
        }
      }
    } catch (err) {
      state.statusErrors.push({ iso: at.toISOString(), error: String(err && err.message ? err.message : err) });
    }
    const waitUntil = at.getTime() + 1000;
    while (!stopping && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// frames

function handleFrame(jpeg) {
  state.framesParsed++;
  const index = state.framesParsed;
  if (state.framesSaved >= args.maxFrames) return Promise.resolve();
  if (index % args.every !== 0) return Promise.resolve();
  return saveFrame(jpeg, index);
}

async function saveFrame(jpeg, index) {
  const at = new Date();
  const file = `frame-${String(state.framesSaved + 1).padStart(5, '0')}.jpg`;
  await writeFile(path.join(args.out, 'frames', file), jpeg).catch(async (err) => {
    if (err && err.code === 'ENOENT') {
      await mkdir(path.join(args.out, 'frames'), { recursive: true });
      await writeFile(path.join(args.out, 'frames', file), jpeg);
    } else throw err;
  });
  const info = brightnessOf(jpeg);
  const record = {
    file,
    sourceFrameIndex: index,
    bytes: jpeg.length,
    width: info.width,
    height: info.height,
    brightness: info.brightness,
    ...(info.brightnessNote ? { brightnessNote: info.brightnessNote } : {}),
    at: at.toISOString(),
    atMs: at.getTime(),
  };
  if (info.brightness) state.brightnessSamples.push(info.brightness);
  else state.framesUndecodable++;
  state.frames.push(record);
  state.framesSaved++;
  if (state.framesSaved % 10 === 0) {
    console.log(`[frame] ${state.framesSaved} saved (of ${state.framesParsed} parsed) ${state.diagSamples} diag samples`);
  }
}

async function captureFrames() {
  let attempt = 0;
  while (!stopping && Date.now() < deadline) {
    attempt++;
    try {
      let chain = Promise.resolve();
      let depth = 0;
      for await (const jpeg of relayFrames({ url: `${args.url}/api/handfx/camera/stream`, signal: stopCtl.signal })) {
        depth += 1;
        chain = chain
          .then(() => handleFrame(jpeg))
          .catch((err) => {
            state.streamErrors.push({ at: new Date().toISOString(), error: `frame handling: ${err && err.message ? err.message : err}` });
          })
          .finally(() => {
            depth -= 1;
          });
        if (depth > 8) await chain;
      }
      await chain;
      if (stopping || Date.now() >= deadline) break;
      state.reconnects++;
      console.log(`[stream] ended after ${state.framesParsed} frames; reconnecting (#${state.reconnects})`);
    } catch (err) {
      if (stopping) break;
      const msg = String(err && err.message ? err.message : err);
      state.streamErrors.push({ at: new Date().toISOString(), error: msg });
      console.error(`[stream] error: ${msg}`);
      if (attempt > 20) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// finalize

async function finalize() {
  try {
    await disarmDiag();
  } catch {
    /* ignore */
  }
  statusStream.end();
  diagStream.end();
  await new Promise((r) => setTimeout(r, 120));

  await writeFile(path.join(args.out, 'frames.json'), JSON.stringify(state.frames, null, 2) + '\n');

  const elapsedSeconds = round((Date.now() - startedAt.getTime()) / 1000, 1);
  const brightness = state.brightnessSamples.length
    ? {
        n: state.brightnessSamples.length,
        mean: round(state.brightnessSamples.reduce((a, b) => a + b.mean, 0) / state.brightnessSamples.length, 2),
        sd: round(state.brightnessSamples.reduce((a, b) => a + b.sd, 0) / state.brightnessSamples.length, 2),
      }
    : null;

  const summary = {
    tool: 'tools/handfx-diag.mjs',
    version: 1,
    serverUrl: args.url,
    outDir: args.out,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedSeconds,
    requestedSeconds: args.seconds,
    stoppedBy: state.stoppedBy,
    note: args.note || null,
    every: args.every,
    frames: {
      parsed: state.framesParsed,
      saved: state.framesSaved,
      undecodable: state.framesUndecodable,
      reconnects: state.reconnects,
      streamErrors: state.streamErrors.slice(0, 20),
      streamErrorCount: state.streamErrors.length,
      brightness,
    },
    status: {
      samples: state.statusSamples,
      errorCount: state.statusErrors.length,
      maxDetects: state.maxDetects,
      maxHands: state.maxHands,
      first: state.firstStatus ? { iso: state.firstStatus.iso, page: state.firstStatus.pageState } : null,
      last: state.lastStatus ? { iso: state.lastStatus.iso, page: state.lastStatus.pageState } : null,
    },
    diagTransport: {
      how: 'overlay POSTs batches to /api/handfx/diag; this tool drains GET /api/handfx/diag?since=',
      armed: state.diagArmed,
      drained: state.diagSamples,
      drains: state.diagDrains,
      serverDropped: state.diagDropped,
      errorCount: state.diagErrors.length,
      errors: state.diagErrors.slice(0, 10),
    },
  };
  await writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  // The post-pass fills in pairing, offsets, composites and rewrites summary.json + README.md.
  let post = null;
  try {
    post = await postPass(args.out, { composite: args.composite, note: args.note });
  } catch (err) {
    console.error(`[post] failed: ${err && err.message ? err.message : err}`);
  }

  const s = post ? post.summary : summary;
  console.log('');
  console.log(`capture: ${args.out}`);
  console.log(`  stopped by ${s.stoppedBy || state.stoppedBy} after ${s.elapsedSeconds ?? elapsedSeconds}s`);
  console.log(`  frames: ${state.framesSaved} saved of ${state.framesParsed} parsed`);
  console.log(`  diag:   ${(s.diag && s.diag.samples) ?? 0} samples` + (s.diag && s.diag.arrived ? '' : ' — NEVER ARRIVED (page not armed?)'));
  console.log(`  paired: ${(s.pairing && s.pairing.pairedFrames) ?? 0} frames, ${(s.pairing && s.pairing.composites) ?? 0} composites`);
  if (s.offset && s.offset.n) console.log(`  offset: mean dx ${s.offset.meanDx} dy ${s.offset.meanDy} source px (n=${s.offset.n})`);
  console.log('  files:  summary.json  README.md  offsets.csv  diag.jsonl  status.jsonl  frames/  composites/');
}

const durationTimer = setTimeout(() => requestStop('duration'), Math.max(0, deadline - Date.now()));
process.on('exit', () => clearTimeout(durationTimer));

console.log(`[start] ${args.out}`);
console.log(`[start] ${args.seconds}s max, one frame per ${args.every}, Ctrl-C to stop early`);
await armDiag();
await Promise.all([captureFrames(), drainDiag(), pollStatus()]);
if (!finalizePromise) finalizePromise = finalize();
await finalizePromise;
