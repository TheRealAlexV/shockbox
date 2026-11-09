// A `fetch` carrying `keepalive: true` rides a separate browser quota. When that quota drains it
// does not queue the request: every later keepalive fetch rejects instantly with a `TypeError`, for
// the life of the document, and each failure measures as ~1 ms so it looks like a fast success. That
// killed the overlay's ack lane for 529 s (1057 instant `type` errors, `lastAckAt` frozen on the
// server) and armed the same trap in the watchdog, whose whole job is noticing silence.
//
// So the property is banned by static check rather than by memory. Node only: no browser, no host.
//   node test/no-keepalive-fetch.mjs    # exits 1 listing every offender as file:line
//
// Prose is not a call, so comments and string/regex/template bodies are masked before the scan: the
// fixes legitimately leave the word behind in explanatory text, and this gate must pass on them.
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const ROOTS = ['modules/handfx/pages/js', 'public/src'];
const EXT = new Set(['.js', '.mjs']);

/** Values that are not truthy. Anything else after `keepalive:` is treated as armed. */
const FALSEY = new Set(['false', '0', 'null', 'undefined', 'NaN', "''", '""', '``', 'void']);

/** `keepalive: <value>` as an object property, not `somekeepalive:` or `x.keepalive:`. */
const PROP = /(?<![\w$.])keepalive\s*:\s*([^\s,;}\])]+)/g;

/**
 * Comment bodies are blanked in place (spaces, newlines kept); string, template and regex bodies are
 * kept verbatim but flagged in `masked`, so a match that starts inside one is prose or data. Offsets
 * and line numbers survive either way.
 */
function scanView(src) {
  const out = src.split('');
  const masked = new Uint8Array(src.length);
  const regexAfter = '([{,;=:?!&|+-*%^~<>';
  let i = 0;
  let prev = '';
  let state = 'code';
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line';
        out[i] = out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        out[i] = out[i + 1] = ' ';
        i += 2;
        continue;
      }
      // A `/` that follows an operator or a bracket opens a regex; one that follows a value divides.
      if (c === '/' && (prev === '' || regexAfter.includes(prev))) {
        state = 'regex';
        inClass = false;
        masked[i] = 1;
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        masked[i] = 1;
        i++;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        out[i] = out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'regex') {
      masked[i] = 1;
      if (c === '\\') {
        masked[i + 1] = 1;
        i += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) state = 'code';
      i++;
      continue;
    }
    // String or template body: keep the text, flag it, honour escapes.
    masked[i] = 1;
    if (c === '\\') {
      masked[i + 1] = 1;
      i += 2;
      continue;
    }
    if (c === state) state = 'code';
    i++;
  }
  return { text: out.join(''), masked };
}

function collect(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collect(full, out);
    else if (EXT.has(path.extname(ent.name))) out.push(full);
  }
}

const files = [];
for (const rel of ROOTS) {
  const dir = path.join(ROOT, rel);
  if (fs.existsSync(dir)) collect(dir, files);
  else console.log(`  skip ${rel} (absent)`);
}

let fail = 0;
const check = (ok, what) => {
  if (!ok) {
    console.log(`  FAIL ${what}`);
    fail++;
  } else console.log(`  ok   ${what}`);
};

const offenders = [];
for (const file of files) {
  const { text, masked } = scanView(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file);
  for (const m of text.matchAll(PROP)) {
    if (masked[m.index]) continue;
    if (FALSEY.has(m[1])) continue;
    const line = 1 + (text.slice(0, m.index).match(/\n/g) || []).length;
    offenders.push(`${rel}:${line} keepalive: ${m[1]}`);
  }
}

if (offenders.length === 0) check(true, `no truthy keepalive fetch (${files.length} files scanned)`);
else for (const o of offenders) check(false, `keepalive fetch at ${o}`);

process.exit(fail ? 1 : 0);
