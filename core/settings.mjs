// Per-module settings: one document per module, schema-validated patches, change subscriptions.
//
// A module declares its schema once:
//   { key: { type:'number'|'string'|'boolean'|'object'|'enum', default, min, max, values, label } }
// and gets validation, defaults, persistence, and a `changed` callback for free. This is what makes
// "every param is registered" (a HandFX lesson) the default rather than a rule people remember.

import path from 'node:path';
import { JsonStore } from './store.mjs';
import { isObj, HttpError } from './id.mjs';

function coerce(def, value) {
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number.parseFloat(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `${def.key} must be a number`);
      let v = n;
      if (def.min !== undefined && v < def.min) v = def.min;
      if (def.max !== undefined && v > def.max) v = def.max;
      return def.integer ? Math.round(v) : v;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new HttpError(400, `${def.key} must be a boolean`);
    case 'string':
      if (typeof value !== 'string') throw new HttpError(400, `${def.key} must be a string`);
      if (def.maxLength && value.length > def.maxLength) throw new HttpError(400, `${def.key} too long`);
      return value;
    case 'enum':
      if (!def.values.includes(value)) throw new HttpError(400, `${def.key} must be one of ${def.values.join(', ')}`);
      return value;
    case 'array': {
      if (!Array.isArray(value)) throw new HttpError(400, `${def.key} must be an array`);
      if (def.items && def.items !== 'any') {
        for (const item of value) {
          if (typeof item !== def.items) throw new HttpError(400, `${def.key} items must be ${def.items}`);
        }
      }
      return value.slice();
    }
    case 'object': {
      if (!isObj(value)) throw new HttpError(400, `${def.key} must be an object`);
      // Shallow merge onto the default shape: partial patches are the normal case.
      return { ...(def.default || {}), ...value };
    }
    default:
      throw new HttpError(500, `${def.key}: unknown type ${def.type}`);
  }
}

export class Settings {
  constructor({ dir, file = 'settings.json', schema, log, onChange = null }) {
    this.schema = {};
    for (const [key, def] of Object.entries(schema)) this.schema[key] = { ...def, key };
    const def = {};
    for (const [key, d] of Object.entries(this.schema)) def[key] = JSON.parse(JSON.stringify(d.default));
    this.store = new JsonStore({
      dir,
      file,
      def,
      debounceMs: 120,
      log,
      migrate: (doc) => {
        let changed = false;
        for (const [key, d] of Object.entries(this.schema)) {
          if (!(key in doc)) {
            doc[key] = JSON.parse(JSON.stringify(d.default));
            changed = true;
          }
        }
        // Unknown keys are kept but flagged at load; a stale value is reported, never silently used.
        for (const key of Object.keys(doc)) {
          if (!(key in this.schema)) {
            if (log) log.warn(`settings: unknown key "${key}" kept as-is (not validated)`);
          }
        }
        return changed ? doc : doc;
      },
    });
    this.log = log;
    this.onChange = onChange;
    this.subs = new Set();
    this.data = this.store.load();
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  /** Validate and apply a patch. Returns the changed keys. */
  patch(patch) {
    if (!isObj(patch)) throw new HttpError(400, 'settings patch must be an object');
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      const def = this.schema[key];
      if (!def) throw new HttpError(400, `unknown setting "${key}"`);
      next[key] = coerce(def, value);
    }
    const changed = [];
    for (const [key, value] of Object.entries(next)) {
      if (JSON.stringify(this.data[key]) !== JSON.stringify(value)) {
        this.data[key] = value;
        changed.push(key);
      }
    }
    if (!changed.length) return changed;
    this.store.data = this.data;
    this.store.save();
    for (const fn of this.subs) {
      try {
        fn(changed, this.data);
      } catch (err) {
        if (this.log) this.log.error(`settings subscriber threw: ${err.message}`);
      }
    }
    if (this.onChange) this.onChange(changed, this.data);
    return changed;
  }

  set(key, value) {
    return this.patch({ [key]: value });
  }

  /**
   * Replace a subtree wholesale. Used for snapshots (the wall's preset state), where a
   * shallow object merge would leave stale keys from the previous state behind.
   */
  assign(key, value) {
    if (!(key in this.schema)) throw new HttpError(400, `unknown setting "${key}"`);
    const next = JSON.parse(JSON.stringify(value));
    const changed = JSON.stringify(this.data[key]) === JSON.stringify(next) ? [] : [key];
    if (!changed.length) return changed;
    this.data[key] = next;
    this.store.data = this.data;
    this.store.save();
    for (const fn of this.subs) {
      try {
        fn(changed, this.data);
      } catch (err) {
        if (this.log) this.log.error(`settings subscriber threw: ${err.message}`);
      }
    }
    if (this.onChange) this.onChange(changed, this.data);
    return changed;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /**
   * Additive change listener — the way a module hears about settings without taking over the
   * core's `onChange` (which is what writes the file). Returns an unsubscribe function.
   */
  on(event, fn) {
    if (event !== 'change') throw new HttpError(400, `settings: unknown event "${event}"`);
    return this.subscribe(fn);
  }

  /** Schema as a plain object for the UI (labels, ranges, current values). */
  describe() {
    const out = {};
    for (const [key, def] of Object.entries(this.schema)) {
      out[key] = {
        type: def.type,
        label: def.label || key,
        group: def.group || 'general',
        min: def.min,
        max: def.max,
        step: def.step,
        values: def.values,
        // An `array` row's element type is what lets a form render it as a list, not JSON text.
        items: def.items,
        help: def.help,
        value: this.data[key],
      };
    }
    return out;
  }

  flush() {
    this.store.flush();
  }
}

export function moduleSettingsDir(stateDir, id) {
  return path.join(stateDir, id);
}
