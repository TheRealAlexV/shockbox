#!/usr/bin/env node
// Capture what the hand detector is actually fed, alongside what it reports.
//
// Reads GET <base>/api/handfx/camera/stream (multipart/x-mixed-replace, `--framebound` parts
// carrying image/jpeg), saves every Kth frame, and polls GET <base>/api/handfx/status at 1 Hz.
// Read-only: no POSTs, no settings, no reloads. A second reader of the relay is safe: one
// producer, N readers.
//
// Usage: node tools/handfx-capture.mjs [--seconds N] [--every K] [--out DIR] [--url BASE]
//
// Brightness is a real measurement, not a guess: a baseline JPEG's DC coefficient is the mean
// of its 8x8 block, so we Huffman-walk the scan, keep the luma DCs, and report their mean and
// standard deviation. Progressive JPEGs cannot be read this way; those frames record
// `brightness: null` with `brightnessNote`, never a fabricated number.

import { createWriteStream } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brightnessOf } from './lib/jpeg-luma.mjs';
import { relayFrames } from './lib/handfx-relay.mjs';

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const args = { seconds: 60, every: 10, out: null, url: 'http://127.0.0.1:8972', recompute: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--seconds') args.seconds = Number(next());
    else if (a === '--every') args.every = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--url') args.url = next().replace(/\/+$/, '');
    // Post-process an existing capture: re-measure the saved JPEGs and rewrite summary.json.
    // No server contact. Useful when a run captured frames but could not measure them.
    else if (a === '--recompute') args.recompute = path.resolve(next());
    else if (a === '-h' || a === '--help') {
      console.log('node tools/handfx-capture.mjs [--seconds N] [--every K] [--out DIR] [--url BASE]');
      console.log('node tools/handfx-capture.mjs --recompute DIR');
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.seconds) || args.seconds <= 0) throw new Error('--seconds must be > 0');
  if (!Number.isInteger(args.every) || args.every <= 0) throw new Error('--every must be an integer > 0');
  if (!args.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.out = path.join('captures', `handfx-${stamp}`);
  }
  args.out = path.resolve(args.out);
  return args;
}

// ---------------------------------------------------------------------------
// small helpers

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function summarize(values) {
  if (!values.length) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return {
    count: values.length,
    mean: round(mean, 2),
    sd: round(Math.sqrt(sq / values.length), 2),
    min: round(min, 2),
    max: round(max, 2),
  };
}

async function recomputeBrightness(dir) {
  const summaryPath = path.join(dir, 'summary.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const means = [];
  const sds = [];
  const notes = {};
  let failed = 0;
  for (const frame of summary.frames || []) {
    const buf = await readFile(path.join(dir, frame.file));
    const info = brightnessOf(buf);
    if (info.width) frame.width = info.width;
    if (info.height) frame.height = info.height;
    if (info.brightness) {
      frame.brightness = info.brightness;
      delete frame.brightnessNote;
      means.push(info.brightness.mean);
      sds.push(info.brightness.sd);
    } else {
      frame.brightness = null;
      frame.brightnessNote = info.brightnessNote;
      failed += 1;
      notes[info.brightnessNote] = (notes[info.brightnessNote] || 0) + 1;
    }
  }
  summary.brightness = {
    measuredFrames: means.length,
    unmeasuredFrames: failed,
    perFrameMean: summarize(means),
    perFrameSd: summarize(sds),
    ...(failed ? { unmeasuredReasons: notes } : {}),
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`recomputed ${means.length} frames in ${dir} (${failed} unmeasured)`);
  if (summary.brightness.perFrameMean) {
    const b = summary.brightness.perFrameMean;
    const s = summary.brightness.perFrameSd;
    console.log(`brightness mean ${b.mean} (sd across frames ${b.sd}, min ${b.min}, max ${b.max})`);
    console.log(`in-frame luma sd ${s.mean} (min ${s.min}, max ${s.max})`);
  }
}

async function fetchJson(url, timeoutMs = 4000) {  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'cache-control': 'no-store' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// main

const args = parseArgs(process.argv.slice(2));

if (args.recompute) {
  await recomputeBrightness(args.recompute);
  process.exit(0);
}

const startedAt = new Date();
const deadline = startedAt.getTime() + args.seconds * 1000;

await mkdir(args.out, { recursive: true });

const state = {
  framesParsed: 0,
  framesSaved: 0,
  framesUndecodable: 0,
  reconnects: 0,
  streamErrors: [],
  brightnessSamples: [],
  undecodableNotes: {},
  frames: [],
  statusSamples: 0,
  statusErrors: [],
  firstStatus: null,
  lastStatus: null,
  maxDetects: null,
  maxHands: null,
  clientsBefore: null,
  clientsAfter: null,
  stoppedBy: 'duration',
};

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

function pickStatus(raw, at) {
  return {
    ts: at.getTime(),
    iso: at.toISOString(),
    timestamp: at.getTime(),
    tracker: raw.tracker ?? null,
    cameraFeed: raw.cameraFeed
      ? {
          clients: raw.cameraFeed.clients ?? null,
          clientCount: raw.cameraFeed.clientCount ?? null,
          frames: raw.cameraFeed.frames ?? null,
          state: raw.cameraFeed.state ?? null,
          reason: raw.cameraFeed.reason ?? null,
          capture: raw.cameraFeed.capture ?? null,
        }
      : null,
    publish: raw.publish ?? null,
    pageState: raw.pageState ?? null,
    effectiveSource: raw.effectiveSource ?? null,
    trackingSource: raw.trackingSource ?? null,
    cameraSource: raw.cameraSource ?? null,
    cameraLabel: raw.cameraLabel ?? null,
    cameraError: raw.cameraError ?? null,
    relayError: raw.relayError ?? null,
    model: raw.model ?? null,
    stale: raw.stale ?? null,
  };
}

const statusStream = createWriteStream(path.join(args.out, 'status.jsonl'), { flags: 'a' });

function noteStatus(sample) {
  if (state.firstStatus === null) state.firstStatus = sample;
  state.lastStatus = sample;
  const t = sample.tracker;
  if (t) {
    if (typeof t.detects === 'number') state.maxDetects = Math.max(state.maxDetects ?? 0, t.detects);
    if (typeof t.hands === 'number') state.maxHands = Math.max(state.maxHands ?? 0, t.hands);
  }
  if (state.statusSamples % 10 === 0) {
    const tr = t ?? {};
    console.log(
      `[status] ${state.statusSamples.toString().padStart(3)}s ` +
        `detects=${tr.detects ?? '?'} hands=${tr.hands ?? '?'} empties=${tr.empties ?? '?'} ` +
        `fps=${tr.fps ?? '?'} frames=${tr.frames ?? '?'} ` +
        `clients=${sample.cameraFeed?.clients ?? '?'} page=${sample.pageState ?? '?'} src=${sample.effectiveSource ?? '?'}`,
    );
  }
}

async function pollStatus() {
  while (!stopping && Date.now() < deadline) {
    const at = new Date();
    try {
      const raw = await fetchJson(`${args.url}/api/handfx/status`);
      const sample = pickStatus(raw, at);
      statusStream.write(JSON.stringify(sample) + '\n');
      state.statusSamples++;
      noteStatus(sample);
    } catch (err) {
      state.statusErrors.push({ iso: at.toISOString(), error: String(err && err.message ? err.message : err) });
    }
    const waitUntil = at.getTime() + 1000;
    while (!stopping && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function handleFrame(jpeg) {
  state.framesParsed++;
  const index = state.framesParsed;
  if (index % args.every !== 0) return Promise.resolve();
  return saveFrame(jpeg, index);
}

async function saveFrame(jpeg, index) {
  const file = `frame-${String(state.framesSaved + 1).padStart(5, '0')}.jpg`;
  const filePath = path.join(args.out, file);
  await writeFile(filePath, jpeg);
  const info = brightnessOf(jpeg);
  const record = {
    file,
    sourceFrameIndex: index,
    bytes: jpeg.length,
    width: info.width,
    height: info.height,
    brightness: info.brightness,
    ...(info.brightnessNote ? { brightnessNote: info.brightnessNote } : {}),
    at: new Date().toISOString(),
  };
  if (info.brightness) {
    state.brightnessSamples.push(info.brightness);
  } else {
    state.framesUndecodable++;
    state.undecodableNotes[info.brightnessNote] = (state.undecodableNotes[info.brightnessNote] || 0) + 1;
  }
  state.frames.push(record);
  state.framesSaved++;
  console.log(
    `[frame] saved ${file} ${(jpeg.length / 1024).toFixed(1)}kB ` +
      `${info.width ?? '?'}x${info.height ?? '?'} ` +
      (info.brightness
        ? `luma mean=${info.brightness.mean} sd=${info.brightness.sd} min=${info.brightness.min} max=${info.brightness.max}`
        : `luma=unmeasured (${info.brightnessNote})`),
  );
}

async function readStreamOnce() {
  // Saving and measuring must never stall the read: a slow reader makes the relay drop frames
  // for this client, which would silently turn a 30 fps feed into a 1 fps one. The queue is
  // bounded at 8 frames in flight; past that the read waits for one to finish.
  let chain = Promise.resolve();
  let depth = 0;
  for await (const jpeg of relayFrames({ url: `${args.url}/api/handfx/camera/stream`, signal: stopCtl.signal })) {
    depth += 1;
    chain = chain
      .then(() => handleFrame(jpeg))
      .catch((err) => {
        state.streamErrors.push({ at: new Date().toISOString(), error: `frame handling: ${err && err.message ? err.message : err}` });
      })
      .finally(() => { depth -= 1; });
    if (depth > 8) await chain;
  }
  await chain;
}

async function captureFrames() {
  let attempt = 0;
  while (!stopping && Date.now() < deadline) {
    attempt++;
    try {
      await readStreamOnce();
      if (stopping || Date.now() >= deadline) break;
      state.reconnects++;
      console.log(`[stream] ended on its own after ${state.framesParsed} frames; reconnecting (#${state.reconnects})`);
    } catch (err) {
      if (stopping) break;
      const msg = String(err && err.message ? err.message : err);
      state.streamErrors.push({ at: new Date().toISOString(), error: msg });
      console.error(`[stream] error: ${msg}`);
      if (Date.now() >= deadline) break;
      state.reconnects++;
    }
    const backoff = Math.min(2000, 250 * attempt);
    const until = Date.now() + backoff;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
}

async function finalize() {
  const endedAt = new Date();
  // One last read for the after-clients count, unless we are already past the wire.
  try {
    const raw = await fetchJson(`${args.url}/api/handfx/status`, 3000);
    const sample = pickStatus(raw, new Date());
    state.lastStatus = sample;
    state.clientsAfter = sample.cameraFeed?.clients ?? null;
    if (!state.firstStatus) state.firstStatus = sample;
    const t = sample.tracker;
    if (t && typeof t.detects === 'number') state.maxDetects = Math.max(state.maxDetects ?? 0, t.detects);
    if (t && typeof t.hands === 'number') state.maxHands = Math.max(state.maxHands ?? 0, t.hands);
  } catch (err) {
    state.statusErrors.push({ at: new Date().toISOString(), error: `final snapshot: ${String(err && err.message ? err.message : err)}` });
  }

  const before = state.firstStatus?.tracker ?? null;
  const after = state.lastStatus?.tracker ?? null;
  const delta = (k) =>
    before && after && typeof before[k] === 'number' && typeof after[k] === 'number'
      ? after[k] - before[k]
      : null;

  const means = state.brightnessSamples.map((b) => b.mean);
  const sds = state.brightnessSamples.map((b) => b.sd);
  const brightness = {
    measuredFrames: state.brightnessSamples.length,
    unmeasuredFrames: state.framesUndecodable,
    perFrameMean: summarize(means),
    perFrameSd: summarize(sds),
  };
  if (state.framesUndecodable) brightness.unmeasuredReasons = state.undecodableNotes;

  const totalBytes = state.frames.reduce((n, f) => n + f.bytes, 0);

  const summary = {
    outDir: args.out,
    url: args.url,
    requestedSeconds: args.seconds,
    everyNthFrame: args.every,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedSeconds: round((endedAt.getTime() - startedAt.getTime()) / 1000, 2),
    stoppedBy: state.stoppedBy,
    totalFramesParsed: state.framesParsed,
    framesSaved: state.framesSaved,
    framesBetweenSaves: state.framesParsed - state.framesSaved,
    totalSavedBytes: totalBytes,
    streamReconnects: state.reconnects,
    streamErrors: state.streamErrors,
    statusSamples: state.statusSamples,
    statusErrors: state.statusErrors,
    counters: {
      first: before,
      last: after,
      deltaEmpties: delta('empties'),
      deltaDetects: delta('detects'),
      deltaHands: delta('hands'),
      maxDetects: state.maxDetects,
      maxHands: state.maxHands,
    },
    detectedAnything: (state.maxDetects ?? 0) > 0,
    anyHandsTracked: (state.maxHands ?? 0) > 0,
    brightness,
    cameraFeedClients: {
      before: state.clientsBefore,
      after: state.clientsAfter,
    },
    frames: state.frames,
  };

  await writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2));
  statusStream.end();

  console.log('\n=== handfx capture summary ===');
  console.log(`dir                 ${args.out}`);
  console.log(`stopped by          ${summary.stoppedBy}`);
  console.log(`elapsed             ${summary.elapsedSeconds}s of ${summary.requestedSeconds}s requested`);
  console.log(`frames parsed       ${summary.totalFramesParsed}`);
  console.log(`frames saved        ${summary.framesSaved} (every ${args.every}), ${(totalBytes / 1048576).toFixed(2)} MB`);
  console.log(`stream reconnects   ${summary.streamReconnects}`);
  console.log(`status samples      ${summary.statusSamples}`);
  console.log(
    `counters first      detects=${before?.detects ?? '?'} hands=${before?.hands ?? '?'} empties=${before?.empties ?? '?'} frames=${before?.frames ?? '?'}`,
  );
  console.log(
    `counters last       detects=${after?.detects ?? '?'} hands=${after?.hands ?? '?'} empties=${after?.empties ?? '?'} frames=${after?.frames ?? '?'}`,
  );
  console.log(
    `deltas              detects=${summary.counters.deltaDetects ?? '?'} hands=${summary.counters.deltaHands ?? '?'} empties=${summary.counters.deltaEmpties ?? '?'}`,
  );
  console.log(`max detects/hands   ${state.maxDetects ?? '?'} / ${state.maxHands ?? '?'}`);
  console.log(`detectedAnything    ${summary.detectedAnything}`);
  if (brightness.perFrameMean) {
    const b = brightness.perFrameMean;
    console.log(`brightness mean     ${b.mean} (sd across frames ${b.sd}, min ${b.min}, max ${b.max}) n=${b.count}`);
    const s = brightness.perFrameSd;
    if (s) console.log(`brightness in-frame ${s.mean} mean sd (min ${s.min}, max ${s.max})`);
  } else {
    console.log(`brightness          unmeasured (${JSON.stringify(state.undecodableNotes)})`);
  }
  console.log(`relay clients       before=${state.clientsBefore ?? '?'} after=${state.clientsAfter ?? '?'}`);
  console.log(`summary             ${path.join(args.out, 'summary.json')}`);
}

// --- run

try {
  const pre = await fetchJson(`${args.url}/api/handfx/status`);
  const preSample = pickStatus(pre, new Date());
  state.clientsBefore = preSample.cameraFeed?.clients ?? null;
  state.firstStatus = preSample;
  console.log(`[start] ${args.url} for ${args.seconds}s, 1/${args.every} frames -> ${args.out}`);
  console.log(
    `[start] relay clients=${state.clientsBefore ?? '?'} pageState=${preSample.pageState} src=${preSample.effectiveSource} ` +
      `tracker=${preSample.tracker?.state ?? '?'}/${preSample.tracker?.model ?? '?'} detects=${preSample.tracker?.detects ?? '?'} hands=${preSample.tracker?.hands ?? '?'}`,
  );
} catch (err) {
  console.error(`[start] status preflight failed: ${err && err.message ? err.message : err}`);
}

const durationTimer = setTimeout(() => requestStop('duration'), Math.max(0, deadline - Date.now()));

await Promise.allSettled([captureFrames(), pollStatus()]);
clearTimeout(durationTimer);

if (!finalizePromise) finalizePromise = finalize();
await finalizePromise;
process.exit(0);
