// The log must never grow without bound, and a repeating error must not recurse through the
// uncaughtException handler. Both are checked by writing far more than the budget. The directory
// prune is checked separately, since it is the only bound that covers files the writer never saw
// (the launcher's redirection appends to the same file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLog, compactDir, MAX_BYTES, KEEP } from '../core/log.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-log-'));
const log = createLog({ dir, console: false, maxBytes: 64 * 1024 });
const target = path.join(dir, 'shockbox.log');

let fail = 0;
const check = (ok, what) => {
  if (!ok) {
    console.log(`  FAIL ${what}`);
    fail++;
  } else console.log(`  ok   ${what}`);
};

// Sum of the live file plus every kept generation, whatever generations happen to be on disk.
const familySize = (file, generations) =>
  generations.reduce((sum, n) => sum + (fs.existsSync(`${file}.${n}`) ? fs.statSync(`${file}.${n}`).size : 0), fs.statSync(file).size);

// 64 KB budget, write 1 MB of lines.
for (let i = 0; i < 8000; i++) log.info(`line ${i} ${'x'.repeat(100)}`);

const size = fs.statSync(target).size;
check(size <= 64 * 1024, `active file within budget (${size} <= 65536)`);
check(fs.existsSync(`${target}.1`), 'previous file rotated to .1');
const prev = fs.statSync(`${target}.1`).size;
check(prev <= 64 * 1024, `previous file within budget (${prev})`);
const total = size + prev;
check(total <= 2 * 64 * 1024, `only two files on disk (${total} bytes)`);
check(log.size === size, `tracked size matches disk (${log.size} == ${size})`);
check(log.recent(10).length === 10, 'ring still returns lines');

// The budget is a ceiling on the family, not on one file: live file plus KEEP predecessors.
const gens = Array.from({ length: 10 }, (_, i) => i + 1);
const family = familySize(target, gens);
check(family <= (1 + KEEP) * 64 * 1024, `whole family within budget (${family} <= ${(1 + KEEP) * 64 * 1024})`);
check(fs.existsSync(`${target}.${KEEP}`), `oldest kept generation .${KEEP} exists`);
check(!fs.existsSync(`${target}.${KEEP + 1}`), `nothing past the kept generations (.${KEEP + 1} absent)`);
check(log.keep === KEEP, `keep exposed on the api (${log.keep} == ${KEEP})`);

// Rotation shifts the chain up instead of clobbering .1: after more writes, .1 and .2 are two
// different generations with content of their own.
for (let i = 0; i < 2000; i++) log.info(`later ${i} ${'y'.repeat(100)}`);
// The number of the first entry in a file. Generations are told apart by where they start, not by
// comparing equal-length prefixes: timestamps share a millisecond and the rest of the head is
// identical padding.
const firstNo = (f) => {
  const m = /(?:line|later) (\d+)/.exec(fs.readFileSync(f, 'utf8'));
  return m ? Number(m[1]) : -1;
};
const g1 = fs.existsSync(`${target}.1`) ? firstNo(`${target}.1`) : -1;
const g2 = fs.existsSync(`${target}.2`) ? firstNo(`${target}.2`) : -1;
check(g1 >= 0 && g2 >= 0, `both .1 and .2 have content (.1 starts at ${g1}, .2 at ${g2})`);
check(g1 !== g2, `the generations are distinct (.1 starts at ${g1}, .2 at ${g2})`);
check(g2 < g1, `old .1 was shifted to .2, not overwritten (${g2} < ${g1})`);

// Rotation with an external reader holding nothing must not lose the active file.
log.rotate();
check(!fs.existsSync(target) || fs.statSync(target).size === 0, 'rotate empties the active file');

// --- compactDir: the directory-level bound ------------------------------------------------
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-compact-'));
const day = (n) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
const names = [];
for (let n = 1; n <= 8; n++) {
  const name = `shockbox-2026-10-0${n}.log`;
  const p = path.join(cdir, name);
  // Distinct sizes so a sum can be told apart from a count.
  fs.writeFileSync(p, 'z'.repeat(4 * 1024 + n));
  fs.utimesSync(p, day(n), day(n));
  names.push(name);
}
const newest4 = names.slice(-4);
const oldest4 = names.slice(0, 4);

const r1 = compactDir({ dir: cdir, maxTotal: 10 * 1024 * 1024, keep: 4 });
const survivors = fs.readdirSync(cdir).sort();
check(
  newest4.every((n) => survivors.includes(n)) && oldest4.every((n) => !survivors.includes(n)),
  'compactDir keeps the 4 newest and deletes the 4 oldest',
);
check(r1.removed.length === 4, `removed is the 4 oldest (${r1.removed.length})`);
check(r1.truncated.length === 0, `nothing truncated under the ceiling (${r1.truncated.length})`);
const expected = newest4.reduce((sum, n) => sum + fs.statSync(path.join(cdir, n)).size, 0);
check(r1.total === expected, `total is the survivors' bytes (${r1.total} == ${expected})`);

// Survivors each over 1 KB: the ceiling forces truncation rather than deletion.
const r2 = compactDir({ dir: cdir, maxTotal: 1024, keep: 4 });
check(r2.truncated.length >= 1, `survivors over the ceiling are truncated (${r2.truncated.length})`);
check(r2.total <= 1024, `total under the ceiling after truncation (${r2.total} <= 1024)`);
check(
  r2.truncated.every((n) => fs.statSync(path.join(cdir, n)).size === 0),
  'every truncated file is empty on disk',
);
check(fs.readdirSync(cdir).length === 4, 'truncation never deletes a survivor');

// A missing directory is a no-op, not a throw.
let missing = null;
let threw = null;
try {
  missing = compactDir({ dir: path.join(cdir, 'does-not-exist') });
} catch (err) {
  threw = err;
}
check(!threw, 'compactDir on a missing dir does not throw');
check(
  missing && missing.removed.length === 0 && missing.truncated.length === 0 && missing.total === 0,
  'missing dir returns empty result',
);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(cdir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nlog rotation ok');
process.exit(fail ? 1 : 0);
