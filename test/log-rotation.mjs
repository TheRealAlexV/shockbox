// The log must never grow without bound, and a repeating error must not recurse through the
// uncaughtException handler. Both are checked by writing far more than the budget.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLog, MAX_BYTES } from '../core/log.mjs';

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

// Rotation with an external reader holding nothing must not lose the active file.
log.rotate();
check(!fs.existsSync(target) || fs.statSync(target).size === 0, 'rotate empties the active file');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nlog rotation ok');
process.exit(fail ? 1 : 0);
