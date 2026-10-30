// Atomic JSON store with debounced saves and rolling backups.
// Lifted behaviour from error-popups' writeFileAtomic + its debounced history/repeat saves,
// generalised: any module can declare a document and get the same guarantees.

import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {object} o
   * @param {string} o.dir     directory for this module's data
   * @param {string} o.file    file name, e.g. 'settings.json'
   * @param {*}      o.def     default document when the file is missing or unreadable
   * @param {number} [o.debounceMs] 0 = write through immediately
   * @param {number} [o.backups]     how many rolling backups to keep (0 = none)
   * @param {(d:*)=>*} [o.migrate]   optional upgrader for older documents
   */
  constructor({ dir, file, def, debounceMs = 0, backups = 3, migrate = null, log = null }) {
    this.dir = dir;
    this.path = path.join(dir, file);
    this.def = def;
    this.debounceMs = debounceMs;
    this.backups = backups;
    this.migrate = migrate;
    this.log = log;
    this.timer = null;
    this.data = this.def;
    this.dirty = false;
    this.loaded = false;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch {
      raw = null;
    }
    if (raw === null) {
      this.data = clone(this.def);
      this.loaded = true;
      return this.data;
    }
    try {
      let doc = JSON.parse(raw);
      if (this.migrate) {
        const next = this.migrate(doc);
        if (next !== doc && next !== undefined) {
          doc = next;
          this.data = doc;
          this.dirty = true;
          this.saveNow();
        }
      }
      this.data = doc;
    } catch (err) {
      // Never lose the operator's data: keep the unreadable file, start from defaults.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const keep = `${this.path}.unreadable-${stamp}`;
      try {
        fs.renameSync(this.path, keep);
      } catch {
        /* ignore */
      }
      if (this.log) this.log.warn(`${this.path} unreadable (${err.message}) — kept as ${path.basename(keep)}`);
      this.data = clone(this.def);
    }
    this.loaded = true;
    return this.data;
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.path);
    this.dirty = false;
    this.backupTick();
  }

  save() {
    this.dirty = true;
    if (this.debounceMs <= 0) {
      this.saveNow();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.saveNow();
      } catch (err) {
        if (this.log) this.log.error(`save ${this.path} failed: ${err.message}`);
      }
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  // Backup policy: at most one copy per hour, newest first, `backups` kept.
  // Cheap (a stat per save) and it means a bad document never has only itself to blame.
  backupTick() {
    if (!this.backups) return;
    try {
      const dir = path.join(this.dir, '.backups');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(this.path, '.json');
      const existing = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.json')).sort();
      const newest = existing[existing.length - 1];
      const now = Date.now();
      // tag format: YYYYMMDD-HHMMSS  -> sortable, parseable
      if (newest) {
        const tag = newest.slice(base.length + 1, -'.json'.length);
        const when = Date.parse(tag.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z'));
        if (Number.isFinite(when) && now - when < 3600_000) return;
      }
      const d = new Date(now);
      const p = (n, w = 2) => String(n).padStart(w, '0');
      const tag = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
      fs.copyFileSync(this.path, path.join(dir, `${base}.${tag}.json`));
      const all = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`)).sort();
      while (all.length > this.backups) {
        const victim = all.shift();
        try {
          fs.unlinkSync(path.join(dir, victim));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* backups are best effort */
    }
  }

  flush() {
    if (this.dirty || this.timer) this.saveNow();
  }
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// One-time adoption: copy a legacy app's data file in if ours does not exist yet.
export function adoptFile(srcFile, destFile, log = null) {
  try {
    if (fs.existsSync(destFile)) return false;
    if (!fs.existsSync(srcFile)) return false;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    if (log) log.info(`adopted ${path.basename(srcFile)} from ${path.dirname(srcFile)}`);
    return true;
  } catch (err) {
    if (log) log.warn(`could not adopt ${srcFile}: ${err.message}`);
    return false;
  }
}
