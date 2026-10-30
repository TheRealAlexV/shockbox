// Message pool — the ONE list both notification modules read.
//
// Why this lives in core and not in a module: notifications and alerts are two modules,
// but a message is one record with one id, and repeats/history/storm eligibility all key on
// that id. Two module-local copies would drift within a day. So core owns the store and the
// HTTP surface (/api/pools, /api/pool/:id…, the legacy aliases), and the modules ask it for
// records; `kind` on each record is the only thing that decides who renders it.
//
// File: state/pool.json  (a module never writes it directly)

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, clamp } from './id.mjs';

export const POOL_IDS = ['all', 'random', 'dialogs', 'notifications'];
export const POOL_NAMES = { all: 'All messages', random: 'Random', dialogs: 'Alerts', notifications: 'Notifications' };

export const KINDS = ['dialog', 'notification'];
export const ACTIONS = new Set(['close', 'closeAll', 'spawn', 'none']);
export const ICONS = ['error', 'warning', 'info', 'question', 'none'];
export const MAX_TEXT = 600;
export const MAX_TYPE = 32;
export const MAX_TITLE = 40;
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 24;
export const MAX_BUTTONS = 5;
export const MAX_MESSAGES = 5000;

/* ---------------------------------------------------------------- validation */

function parseText(v) {
  if (typeof v !== 'string') return { error: 'text must be a string' };
  const text = v.replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'text must not be empty' };
  if (text.length > MAX_TEXT) return { error: `text must be at most ${MAX_TEXT} characters` };
  return { text };
}

function parseType(v, dflt) {
  if (v === undefined || v === null || v === '') return { type: dflt };
  if (typeof v !== 'string') return { error: 'type must be a string' };
  const type = v.trim();
  if (!type) return { type: dflt };
  if (type.length > MAX_TYPE) return { error: `type must be at most ${MAX_TYPE} characters` };
  return { type };
}

function parseTags(v) {
  if (v === undefined || v === null) return { tags: [] };
  if (!Array.isArray(v)) return { error: 'tags must be an array of strings' };
  if (v.length > MAX_TAGS) return { error: `tags must hold at most ${MAX_TAGS} entries` };
  const tags = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return { error: 'tags must be an array of strings' };
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) return { error: `tags must be at most ${MAX_TAG_LEN} characters` };
    if (!tags.includes(t)) tags.push(t);
  }
  return { tags };
}

function parseButtons(v) {
  if (v === undefined || v === null) return { buttons: [{ label: 'OK', action: 'close' }] };
  if (!Array.isArray(v)) return { error: 'buttons must be an array' };
  if (!v.length) return { error: 'buttons must not be empty' };
  if (v.length > MAX_BUTTONS) return { error: `buttons must hold at most ${MAX_BUTTONS} entries` };
  const buttons = [];
  for (const b of v) {
    if (!b || typeof b !== 'object') return { error: 'each button must be an object' };
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (!label) return { error: 'each button needs a label' };
    if (label.length > 24) return { error: 'button labels must be at most 24 characters' };
    const action = b.action === undefined ? 'close' : b.action;
    if (!ACTIONS.has(action)) return { error: `button action must be one of ${[...ACTIONS].join(', ')}` };
    const out = { label, action };
    if (action === 'spawn') {
      out.kind = b.kind === 'dialog' ? 'dialog' : 'notification';
      if (typeof b.text === 'string' && b.text.trim()) out.text = b.text.trim().slice(0, MAX_TEXT);
      if (typeof b.title === 'string' && b.title.trim()) out.title = b.title.trim().slice(0, MAX_TITLE);
    }
    buttons.push(out);
  }
  return { buttons };
}

/** Validate a create/patch body. Returns { values } or { error }. */
export function parseMessageBody(body, { partial }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const values = {};

  if (body.random !== undefined && typeof body.random !== 'boolean') return { error: 'random must be a boolean' };
  if (body.storm !== undefined && typeof body.storm !== 'boolean') return { error: 'storm must be a boolean' };
  if (body.kind !== undefined && !KINDS.includes(body.kind)) return { error: `kind must be one of ${KINDS.join(', ')}` };

  if (!partial || body.text !== undefined) {
    const r = parseText(body.text);
    if (r.error) return { error: r.error };
    values.text = r.text;
  }
  if (!partial || body.type !== undefined) {
    const r = parseType(body.type, 'Error');
    if (r.error) return { error: r.error };
    values.type = r.type;
  }
  if (!partial || body.tags !== undefined) {
    const r = parseTags(body.tags);
    if (r.error) return { error: r.error };
    values.tags = r.tags;
  }
  if (!partial || body.buttons !== undefined) {
    const r = parseButtons(body.buttons);
    if (r.error) return { error: r.error };
    values.buttons = r.buttons;
  }
  if (!partial || body.title !== undefined) {
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return { error: 'title must be a string' };
    const t = body.title === undefined || body.title === null ? '' : body.title.trim();
    if (t.length > MAX_TITLE) return { error: `title must be at most ${MAX_TITLE} characters` };
    values.title = t;
  }
  if (!partial || body.kind !== undefined) values.kind = body.kind === undefined ? 'notification' : body.kind;
  if (!partial || body.random !== undefined) values.random = body.random === undefined ? true : body.random;
  if (!partial || body.storm !== undefined) values.storm = body.storm === undefined ? true : body.storm;

  if (!partial && !values.text) return { error: 'text must not be empty' };
  if (partial && Object.keys(values).length === 0) return { error: 'nothing to update' };
  return { values };
}

/* ---------------------------------------------------------------------- pool */

export function createPool({ file, log, onChange = null }) {
  let messages = [];
  let seq = 0;
  let loaded = false;

  function syncSeq() {
    let max = 0;
    for (const m of messages) {
      const n = /^m(\d+)$/.exec(m.id || '');
      if (n) max = Math.max(max, Number(n[1]));
    }
    seq = Math.max(seq, max);
  }

  function normalise(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const parsed = parseMessageBody({ ...r, text: r.text ?? r.body }, { partial: false });
    if (parsed.error) return null;
    const v = parsed.values;
    return {
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : null,
      kind: v.kind,
      type: v.type,
      title: v.title || undefined,
      text: v.text,
      tags: v.tags,
      buttons: v.buttons,
      random: v.random,
      storm: v.storm,
      icon: ICONS.includes(r.icon) ? r.icon : undefined,
    };
  }

  function load() {
    if (loaded) return messages;
    loaded = true;
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`pool: cannot read ${file} (${err.message})`);
      return messages;
    }
    const list = Array.isArray(doc) ? doc : Array.isArray(doc && doc.messages) ? doc.messages : null;
    if (!list) return messages;
    const seen = new Set();
    messages = [];
    for (const raw of list) {
      const rec = normalise(raw);
      if (!rec) continue;
      if (!rec.id || seen.has(rec.id)) rec.id = `m${++seq}`;
      seen.add(rec.id);
      messages.push(rec);
    }
    syncSeq();
    log.info(`pool: ${messages.length} messages from ${path.basename(file)}`);
    return messages;
  }

  function save() {
    const doc = { version: 4, updated: new Date().toISOString(), messages };
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      log.error(`pool: write failed — ${err.message}`);
      return false;
    }
  }

  /** Change + persist + notify. Every mutating helper ends here, so the SSE frame is never missed. */
  function commit(reason) {
    const ok = save();
    if (ok && onChange) {
      try {
        onChange(reason);
      } catch (err) {
        log.error(`pool onChange: ${err.message}`);
      }
    }
    return ok;
  }

  function all() {
    load();
    return messages;
  }

  function byId(id) {
    return all().find((m) => m.id === id) || null;
  }

  function eligible(kind, flag) {
    return all().filter((m) => (!kind || m.kind === kind) && (flag ? m[flag] === true : true));
  }

  function add(values) {
    load();
    const rec = { id: `m${++seq}`, ...values };
    messages.push(rec);
    return rec;
  }

  function remove(id) {
    load();
    const i = messages.findIndex((m) => m.id === id);
    if (i === -1) return false;
    messages.splice(i, 1);
    return true;
  }

  function move(id, to, index) {
    load();
    const at = messages.findIndex((m) => m.id === id);
    if (at === -1) return { error: `unknown message ${id}` };
    const [rec] = messages.splice(at, 1);
    let insert;
    if (to === 'random') {
      rec.random = true;
      rec.kind = 'notification';
      insert = clamp(Number.isInteger(index) ? index : Number.MAX_SAFE_INTEGER, 0, messages.length);
    } else if (to === 'dialogs') {
      rec.kind = 'dialog';
      insert = clamp(Number.isInteger(index) ? index : messages.length, 0, messages.length);
    } else {
      rec.kind = 'notification';
      rec.random = false;
      insert = clamp(Number.isInteger(index) ? index : messages.length, 0, messages.length);
    }
    messages.splice(insert, 0, rec);
    return { to, index: insert, kind: rec.kind, random: rec.random === true, storm: rec.storm === true };
  }

  function replaceAll(list) {
    load();
    if (!Array.isArray(list)) return { error: 'messages must be an array' };
    if (list.length > MAX_MESSAGES) return { error: `messages must hold at most ${MAX_MESSAGES} records` };
    if (!list.length) return { error: 'messages must not be empty (delete records one by one instead)' };
    const byText = new Map(messages.map((m) => [m.text, m]));
    const seen = new Set();
    const checked = [];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `messages[${i}] must be an object` };
      const parsed = parseMessageBody(entry, { partial: false });
      if (parsed.error) return { error: `messages[${i}]: ${parsed.error}` };
      let id = null;
      if (entry.id !== undefined && entry.id !== null) {
        if (typeof entry.id !== 'string' || !entry.id.trim()) return { error: `messages[${i}]: id must be a non-empty string` };
        id = entry.id.trim().slice(0, 40);
      } else {
        const twin = byText.get(parsed.values.text);
        if (twin && !seen.has(twin.id)) id = twin.id;
      }
      if (id) {
        if (seen.has(id)) return { error: `messages[${i}]: duplicate id ${id}` };
        seen.add(id);
      }
      checked.push({ id, values: parsed.values });
    }
    messages = checked.map(({ id, values }) => ({ id: id || `m${++seq}`, ...values }));
    return { count: messages.length };
  }

  function typesAndTags() {
    const types = [];
    const tags = [];
    for (const m of all()) {
      if (m.type && !types.includes(m.type)) types.push(m.type);
      for (const t of m.tags) if (!tags.includes(t)) tags.push(t);
    }
    tags.sort();
    return { types, tags };
  }

  /** Filtered view for one pool tab. */
  function view(poolId, query = {}) {
    load();
    const typeFilter = (query.type || '').trim().toLowerCase();
    const tagFilter = (query.tag || '').trim().toLowerCase();
    const q = (query.q || '').trim().toLowerCase();
    const randomOnly = /^(1|true|yes)$/i.test(query.random || '');
    const stormOnly = /^(1|true|yes)$/i.test(query.storm || '');
    const list = all().filter((m) => {
      if (poolId === 'dialogs' && m.kind !== 'dialog') return false;
      if (poolId === 'notifications' && m.kind !== 'notification') return false;
      if (poolId === 'random' && m.random !== true) return false;
      if (randomOnly && m.random !== true) return false;
      if (stormOnly && m.storm !== true) return false;
      if (typeFilter && m.type.toLowerCase() !== typeFilter) return false;
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      if (q && !m.text.toLowerCase().includes(q)) return false;
      return true;
    });
    const { types, tags } = typesAndTags();
    return {
      id: poolId,
      name: POOL_NAMES[poolId],
      types,
      tags,
      counts: {
        all: all().length,
        dialogs: all().filter((m) => m.kind === 'dialog').length,
        notifications: all().filter((m) => m.kind === 'notification').length,
        random: all().filter((m) => m.random === true).length,
        storm: all().filter((m) => m.storm === true).length,
      },
      messages: list.map((m) => ({ ...m, tags: m.tags.slice(), buttons: m.buttons.map((b) => ({ ...b })) })),
    };
  }

  function reorder(poolId, ids) {
    load();
    const current = view(poolId).messages.map((m) => m.id);
    if (ids.length !== current.length) return { error: `ids must list all ${current.length} messages of pool ${poolId}` };
    const wanted = new Set(ids);
    if (wanted.size !== ids.length || !current.every((id) => wanted.has(id))) return { error: "ids must be a permutation of the pool's message ids" };
    const byIdMap = new Map(all().map((m) => [m.id, m]));
    if (poolId !== 'random') {
      const next = ids.map((id) => byIdMap.get(id));
      messages.length = 0;
      messages.push(...next);
      return { order: ids.slice() };
    }
    // `random` is a subset: place those records into the slots they already occupy.
    const slots = [];
    messages.forEach((m, i) => {
      if (m.random === true) slots.push(i);
    });
    ids.forEach((id, k) => {
      if (k < slots.length) messages[slots[k]] = byIdMap.get(id);
    });
    return { order: ids.slice() };
  }

  return {
    log,
    load,
    save,
    commit,
    all,
    byId,
    eligible,
    add,
    remove,
    move,
    replaceAll,
    typesAndTags,
    view,
    reorder,
    get length() {
      return all().length;
    },
  };
}

/** HTTP surface for the pool, mounted by core (it is shared, so no single module owns it). */
export function poolRoutes({ pool, events, log = pool.log }) {
  function broadcast() {
    events.emit('pool', 'pools', pool.view('all'));
  }

  return [
    {
      method: 'GET',
      path: '/api/pools',
      handler() {
        const { types, tags } = pool.typesAndTags();
        const v = pool.view('all');
        return { pools: POOL_IDS.map((id) => ({ id, name: POOL_NAMES[id], count: v.counts[id] })), types, tags, counts: v.counts };
      },
    },
    {
      method: 'PUT',
      path: '/api/pools',
      handler(req, res, url, body) {
        const r = pool.replaceAll(body && body.messages);
        if (r.error) throw new HttpError(400, r.error);
        pool.commit('replace');
        broadcast();
        return { ok: true, count: r.count };
      },
    },
    {
      method: 'GET',
      path: /^\/api\/pool\/([^/]+)$/,
      handler(req, res, url, body, params) {
        const id = decodeURIComponent(params[0]);
        if (!POOL_IDS.includes(id)) throw new HttpError(404, `unknown pool ${id}`);
        const q = Object.fromEntries(url.searchParams.entries());
        return pool.view(id, q);
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/pool\/([^/]+)$/,
      handler(req, res, url, body) {
        const r = pool.replaceAll(body && body.messages);
        if (r.error) throw new HttpError(400, r.error);
        pool.commit('replace');
        broadcast();
        return { ok: true, count: r.count };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/pool\/([^/]+)\/messages$/,
      handler(req, res, url, body, params) {
        const id = decodeURIComponent(params[0]);
        if (!POOL_IDS.includes(id)) throw new HttpError(404, `unknown pool ${id}`);
        const parsed = parseMessageBody(body || {}, { partial: false });
        if (parsed.error) throw new HttpError(400, parsed.error);
        const rec = pool.add(parsed.values);
        pool.commit('add');
        broadcast();
        log.info(`message added ${rec.id} (${rec.kind}, pool ${id})`);
        return { ok: true, id: rec.id, message: rec };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/pool\/([^/]+)\/reorder$/,
      handler(req, res, url, body, params) {
        const id = decodeURIComponent(params[0]);
        if (!POOL_IDS.includes(id)) throw new HttpError(404, `unknown pool ${id}`);
        const ids = body && body.ids;
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'ids must be an array of message ids');
        const r = pool.reorder(id, ids);
        if (r.error) throw new HttpError(400, r.error);
        pool.commit('reorder');
        broadcast();
        return { ok: true, order: r.order };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/pool\/([^/]+)\/messages\/([^/]+)\/move$/,
      handler(req, res, url, body, params) {
        const fromId = decodeURIComponent(params[0]);
        if (!POOL_IDS.includes(fromId)) throw new HttpError(404, `unknown pool ${fromId}`);
        const to = body && body.to;
        if (!POOL_IDS.includes(to)) throw new HttpError(400, `to must be one of ${POOL_IDS.join(', ')}`);
        const r = pool.move(decodeURIComponent(params[1]), to, body && body.index);
        if (r.error) throw new HttpError(404, r.error);
        pool.commit('move');
        broadcast();
        return { ok: true, ...r };
      },
    },
    {
      method: 'any',
      path: /^\/api\/pool\/([^/]+)\/messages\/([^/]+)$/,
      handler(req, res, url, body, params) {
        const id = decodeURIComponent(params[0]);
        if (!POOL_IDS.includes(id)) throw new HttpError(404, `unknown pool ${id}`);
        const mid = decodeURIComponent(params[1]);
        const rec = pool.byId(mid);
        if (!rec) throw new HttpError(404, `unknown message ${mid}`);
        const m = req.method;
        if (m === 'GET' || m === 'HEAD') return { id, name: POOL_NAMES[id], message: rec };
        if (m === 'DELETE') {
          pool.remove(mid);
          pool.commit('delete');
          broadcast();
          return { ok: true };
        }
        const parsed = parseMessageBody(body || {}, { partial: true });
        if (parsed.error) throw new HttpError(400, parsed.error);
        Object.assign(rec, parsed.values);
        pool.commit('update');
        broadcast();
        return { ok: true, message: rec };
      },
    },
  ];
}
