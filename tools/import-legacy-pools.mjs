#!/usr/bin/env node
/* Import the two legacy standalone apps' message stores into the one ShockBox pool.
 *
 *   node tools/import-legacy-pools.mjs                       # dry run, prints the plan
 *   node tools/import-legacy-pools.mjs --apply               # POST /api/pool/import (merge)
 *   node tools/import-legacy-pools.mjs --apply --url http://127.0.0.1:8972
 *   node tools/import-legacy-pools.mjs --apply --merge-tags  # union tags onto records already there
 *   node tools/import-legacy-pools.mjs --dry-run --out x.json
 *
 * Sources — read, never guessed. Each is a different shape and each is validated before use:
 *
 *   $OBS/led-wall/led-wall-state.json
 *       the delivered LED wall tree; proves the legacy app itself is there (no message records).
 *   $OBS/LEDWall/agent/data/pool.json
 *       the LIVE LED Wall Quick Text store: {version, counter, items:[{id,title,text,paras,tags,
 *       pinned,...}]}. Each item becomes one record, kind "wall".
 *   $OBS/LEDWall/agent/data/history.json
 *       what has actually climbed the wall: {version, seq, items:[{seq,at,view,title,text,source,
 *       duration}]}. Titles that the pool dropped but the wall really showed are recovered with
 *       `legacy:history`.
 *   $OBS/Content/error-popups/messages.json
 *       Error Popups v3, already one pool: {version, savedAt, messages:[{id,kind?,type,title,tags,
 *       buttons,random,storm}], legacy:{titles,buttonSets}}. An empty `buttons` array means the
 *       record renders as a phone notification, so kind "notification"; otherwise "dialog".
 *   $OBS/Content/error-popups/messages.v1.backup.json
 *       Error Popups v1: {titles:[...], messages:[bare string], buttonSets:[[...]]}. Bare strings
 *       give no type, so they land as kind "dialog" with type from the old title list.
 *
 * Every record is guaranteed at least one tag, derived from what the record IS (its source store,
 * its kind, its type prefix, the sender of a notification, and subject words in the text). A tag
 * is never invented to make the count look better — a record with nothing recognisable keeps only
 * its source facet, which still makes it findable by store.
 *
 * Text is imported exactly as the source stores it. Do not "normalise" a wall line to upper case
 * to match the live pool: the wall engine's `uppercase` style is off by default
 * (modules/wall/engine/sim.js:573), and the live pool records carry titles like "FUCK YOU SMILE"
 * over the text "FUCK YOU :)" — proof the stored text is what was authored, not what was drawn.
 *
 * Re-running is safe: POST /api/pool/import defaults to mode "merge" and skips text-identical
 * records (core/pool.mjs importRecords), so a second run reports added 0, skipped N.
 *
 * --merge-tags (with --apply) is the second half of the job, for a pool that ALREADY holds these
 * records under an older tag scheme: import adds nothing, so the new derived facets would never
 * land. It matches live records with the same identity merge uses (identical text), unions the
 * derived tags onto the live ones, and PATCHes only where the set actually grew. It is additive on
 * purpose: `legacy`, `led-wall`, `quick-text` are still true, and a user's saved filters may rely
 * on them, so nothing is ever dropped. A second run adds 0 by construction.
 *
 * Exit codes: 0 ok, 1 usage/source/import failure (nothing half-written — validation precedes POST),
 * 2 a source store exists but does not match the schema this tool knows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* The pool's own limits, duplicated here on purpose: the importer must fail loudly on a record the
 * server would reject, and it must not import core/pool.mjs (a tool, not a module consumer). */
const MAX_TEXT = 600;
const MAX_TYPE = 32;
const MAX_TITLE = 40;
const MAX_TAGS = 16;
const MAX_TAG_LEN = 24;
const MAX_BUTTONS = 5;
const KINDS = ['dialog', 'notification', 'wall'];
const ACTIONS = ['close', 'closeAll', 'spawn', 'none'];
/* Import bodies must carry no unknown keys (a replace would persist them); PATCHing a live record
 * back from an import body would likewise stick junk fields on it. */
const IMPORT_KEYS = new Set([
  'id', 'kind', 'type', 'title', 'text', 'tags', 'buttons', 'random', 'storm', 'pinned', 'icon',
]);

/* ---------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function usage(msg) {
  if (msg) console.error(`import-legacy-pools: ${msg}`);
  console.error(`
usage: node tools/import-legacy-pools.mjs [--apply | --dry-run] [--merge-tags] [options]

  --apply              POST the records to /api/pool/import (default: dry run)
  --dry-run            print the plan and tag histogram, touch no server (default)
  --merge-tags         with --apply: union the derived tags onto the live records that already
                       hold this text, instead of importing (nothing existing is dropped)
  --url <base>         server base URL (default ${process.env.SHOCKBOX_URL || 'http://127.0.0.1:8972'})
  --obs <dir>          root holding LEDWall/ and Content/ (default /mnt/c/OBS, then $OBS)
  --batch <n>          records per POST (default 50; server reads each one anyway)
  --out <file>         write the records that were built to this JSON file
  --state-dir <dir>    where import.last.json goes (default <repo>/state)
  -h, --help           this text

  $OBS is honoured as an alias for --obs; $SHOCKBOX_URL for --url.
`);
  process.exit(msg ? 1 : 0);
}

if (flag('help') || argv.includes('-h')) usage();
if (flag('merge-tags') !== undefined && flag('merge-tags') !== true) usage('--merge-tags takes no value');

const APPLY = argv.includes('--apply') && !argv.includes('--dry-run');
const MERGE_TAGS = argv.includes('--merge-tags');
const BASE = String(flag('url') || process.env.SHOCKBOX_URL || 'http://127.0.0.1:8972').replace(/\/+$/, '');
const BATCH = Math.max(1, Number(flag('batch') || 50) || 50);
const OBS = path.resolve(
  String(flag('obs') || process.env.OBS || (fs.existsSync('/mnt/c/OBS') ? '/mnt/c/OBS' : '')),
);
const OUT = flag('out') === true ? null : flag('out');
const STATE_DIR = path.resolve(String(flag('state-dir') || path.join(ROOT, 'state')));
/* The marker proves a re-run is a re-run. It deliberately sits outside the server's state directory
 * by default so an import against a running server writes only its own record. It is replaced on
 * every run, so it always describes the most recent one. */
const MARKER = path.join(STATE_DIR, 'import.last.json');

/* ---------------------------------------------------------------- helpers */

function die(msg, code = 1) {
  console.error(`import-legacy-pools: ${msg}`);
  process.exit(code);
}

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`${label}: cannot read ${file} — ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`${label}: ${file} is not JSON — ${err.message}`, 2);
  }
}

/** Schema drift is a hard stop: importing a shape we guessed would put junk in the pool. */
function expectShape(cond, label, file, detail) {
  if (!cond) die(`${label}: ${file} does not match the known schema${detail ? ` — ${detail}` : ''}`, 2);
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_TAG_LEN);
}

/** Text-identical is what the server dedupes on, so dedupe here the same way. */
function textKey(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* The pool's tag rule, copied from core/pool.mjs parseTags: trim, lower-case, drop empties, keep
 * first occurrence. Tags are unioned through this so a merge cannot create a case-duplicate that
 * the server would then happily persist. No length cap here: the cap is a write constraint handled
 * by planTagMerge, not a reason to silently rename a tag that already exists. */
function normTag(s) {
  return String(s ?? '').trim().toLowerCase();
}

function normTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/* Merge's identity, reused rather than re-derived: core/pool.mjs importRecords builds
 * `new Map(base.map((m) => [m.text, m]))`, so the key is the record's stored `text` exactly as the
 * server holds it, and a re-import of that text is reported as `skipped`. Match that. A record
 * whose text differs is a different record and is never patched silently. */
function byTextIndex(messages) {
  const map = new Map();
  for (const m of messages) if (!map.has(m.text)) map.set(m.text, m);
  return map;
}

/**
 * Union `derived` onto `existing` for a live record: existing order first, then the new tags in
 * derived order. Nothing is removed — a union that dropped a tag would break the user's saved
 * filters. Returns the PATCH body and the bookkeeping the run summary needs.
 */
function planTagMerge(existing, derived) {
  const have = normTags(existing);
  const want = normTags(derived);
  const union = have.slice();
  const added = [];
  for (const t of want) {
    if (have.includes(t)) continue;
    union.push(t);
    added.push(t);
  }
  /* Rebuild `have` from the union so `existing` cannot contribute a case-duplicate. */
  const canon = [];
  for (const t of have) if (!canon.includes(t)) canon.push(t);
  return {
    have: canon,
    want,
    union,
    added,
    unchanged: added.length === 0,
    over: union.length > MAX_TAGS,
    overlong: union.filter((t) => t.length > MAX_TAG_LEN),
  };
}

function clipText(s) {
  const text = textKey(s).replace(/\n{3,}/g, '\n\n');
  if (!text) return '';
  if (text.length <= MAX_TEXT) return text;
  /* Cut on a word boundary so a truncated line does not end mid-word on air. */
  const cut = text.slice(0, MAX_TEXT);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_TEXT - 80 ? cut.slice(0, space) : cut).trim();
}

function clipTitle(s) {
  const t = textKey(s);
  if (!t) return undefined;
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(' ');
  return (space > 12 ? cut.slice(0, space) : cut).trim();
}

function cap(s, n) {
  return String(s || '').slice(0, n);
}

/* ------------------------------------------------------------------- tags */

/* Subject facets. Each entry is what the text is ABOUT; the regex is only the detector. Order is
 * the order tags appear on a record, so the most defining facet reads first. */
const SUBJECTS = [
  ['ego', /\b(ego|narcissis\w*|main character|diva|self[- ]?absorbed|arrogant|swollen)\b/i],
  ['hygiene', /\b(sock|smell\w*|shower|deodorant\w*|sweat\w*|breath|teeth|rash|stink\w*)\b/i],
  ['appearance', /\b(hair|face|camera|mirror|filter|ugly|angle|skin)\b/i],
  ['roast', /\b(roast\w*|insult\w*|savage|destroyed|clap ?back|read(ing)? (them|you)|burn\w*|drag(ged)?)\b/i],
  ['skill', /\b(skill|talent|ability|gamer|aim|carry|rank|elo|uninstall|git gud|practice|bot|noob)\b/i],
  ['chat', /\b(chat|viewers?|audience|lurkers?|followers?|subs?|subscribers?|donat\w*|engage\w*|retention|comment\w*)\b/i],
  ['social', /\b(friend\w*|mom|dad|coworker\w*|family|group chat|ex-?(partner|wife|husband|boyfriend|girlfriend)|neighbou?r\w*)\b/i],
  ['money', /\b(\$\d|money|paid|broke|bankrupt|rich|poor|tip\w*|price|cost|invoice|subscription|wallet|salary|deposit)\b/i],
  ['time', /\b(wait\w*|loading\w*|soon|forever|years?|hours?|minutes?|late|patience|still|never)\b/i],
  ['network', /\b(connect\w*|internet|wifi|wi-fi|network|offline|ethernet|router|dns|timeout\w*|packet|404)\b/i],
  ['hardware', /\b(disk|drive|memory|ram|storage|cache|swap|quota|gpu|cpu|device|printer|usb|driver|pixels?|screen|monitor)\b/i],
  ['software', /\b(\.exe|\.dll|error|exception|crash\w*|fatal|corrupt\w*|failed|failure|segfault|bug|stack trace|update|install\w*|setup)\b/i],
  ['os', /\b(windows|obs|explorer|discord|instagram|messenger|tiktok|whatsapp|imessage|steam|mac ?os)\b/i],
  ['panic', /\b(danger|critical|imminent|last chance|final|warning|abort|emergency|911|fire alarm)\b/i],
  ['absence', /\b(not found|missing|absent|gone|vanish\w*|nowhere|empty|nobody|no one|0%)\b/i],
  ['quit', /\b(leav(e|ing)|quit|exit|goodbye|bye|go home|abandon\w*|give up|log(ging)? ?out|shut ?down)\b/i],
  ['praise', /\b(legend|congrat\w*|amazing|perfect|genius|great job|gg|winning|victory|clap for)\b/i],
  ['crude', /\b(fuck\w*|shit\w*|ass|bastard|crap)\b/i],
];

function subjects(text, exclude = null) {
  const out = [];
  for (const [tag, re] of SUBJECTS) {
    if (exclude && exclude.has(tag)) continue;
    if (re.test(text)) out.push(tag);
  }
  return out;
}

/** Notification app -> coarse transport facet, from what the sender app actually is. */
const PLATFORM = {
  imessage: 'ios',
  instagram: 'ios',
  whatsapp: 'phone',
  messenger: 'phone',
  discord: 'desktop',
  tiktok: 'social-app',
};

/**
 * Final tag list for one record: normalise, drop empties, keep order, cap at the pool's limits,
 * and guarantee at least one entry. A record that reached here with nothing keeps its source
 * facet, which is always present, so the "carefully tagged" promise cannot silently break.
 */
function finalTags(candidates, sourceTag) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const t = slug(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  if (!out.length) {
    const t = slug(sourceTag) || 'legacy';
    out.push(t);
    /* still under-tagged: the store name alone is a real facet, not a lie about the text */
  }
  return out;
}

const KIND_TAG = { wall: 'kind-wall', dialog: 'kind-dialog', notification: 'kind-notification' };

/* ---------------------------------------------------------------- records */

const records = [];
const sources = [];
const skipped = { duplicate: 0, empty: 0 };
const warnings = [];
const seen = new Set();

function push(rec, meta) {
  const key = textKey(rec.text);
  if (!key) {
    skipped.empty += 1;
    return false;
  }
  if (seen.has(key)) {
    skipped.duplicate += 1;
    return false;
  }
  seen.add(key);
  records.push(rec);
  meta.text = rec.text;
  meta.tags = rec.tags;
  rec.__source = meta.source;
  return true;
}

function source(name, file, extra = {}) {
  const entry = { name, file, exists: fs.existsSync(file), records: 0, note: extra.note || '' };
  sources.push(entry);
  return entry;
}

/* --- 1. the legacy LED wall app itself ----------------------------------- */

const wallState = source(
  'led-wall',
  path.join(OBS, 'led-wall', 'led-wall-state.json'),
  { note: 'the delivered LED wall app; proves it is here, holds no message records' },
);
if (wallState.exists) readJson(wallState.file, 'led-wall');

/* --- 2. LED Wall Quick Text (kind wall) --------------------------------- */

const quickText = source('ledwall-quick-text', path.join(OBS, 'LEDWall', 'agent', 'data', 'pool.json'), { kind: 'wall' });
if (quickText.exists) {
  const doc = readJson(quickText.file, 'ledwall-quick-text');
  expectShape(doc && Array.isArray(doc.items), 'ledwall-quick-text', quickText.file, 'expected { items: [...] }');
  for (const it of doc.items) {
    /* The item's own text wins; a rich-text-only item is flattened from its runs. */
    const body =
      textKey(it.text) ||
      (Array.isArray(it.paras) ? it.paras.map((p) => (p?.runs || []).map((r) => r?.t || '').join('')).join(' ') : '');
    const text = clipText(body);
    if (!text) {
      skipped.empty += 1;
      continue;
    }
    const title = clipTitle(it.title);
    const tags = finalTags(
      [
        'ledwall',
        'legacy',
        'quick-text',
        KIND_TAG.wall,
        ...(Array.isArray(it.tags) ? it.tags : []),
        ...subjects(`${text} ${title || ''}`),
        /* `uses` on these items is bookkeeping the panel increments, not on-air proof — the
         * history store is what proves a line ran, so no tag is derived from this counter. */
        it.pinned ? 'pinned' : '',
      ],
      'ledwall',
    );
    const ok = push(
      {
        id: /^p_[0-9]+$/.test(String(it.id || '')) ? `w${it.id.slice(2)}` : undefined,
        kind: 'wall',
        type: cap(it.type || 'Roast', MAX_TYPE),
        title,
        text,
        tags,
        buttons: [{ label: 'OK', action: 'close' }],
        random: it.pinned !== true,
        storm: false,
        pinned: it.pinned === true,
        icon: 'none',
      },
      { source: 'ledwall-quick-text' },
    );
    if (ok) quickText.records += 1;
  }
}

/* --- 3. LED Wall history: text the wall showed but the pool no longer has */

const wallHistory = source('ledwall-history', path.join(OBS, 'LEDWall', 'agent', 'data', 'history.json'), {
  kind: 'wall',
  note: 'titles recovered from the on-air history',
});
if (wallHistory.exists) {
  const doc = readJson(wallHistory.file, 'ledwall-history');
  expectShape(doc && Array.isArray(doc.items), 'ledwall-history', wallHistory.file, 'expected { items: [...] }');
  for (const h of doc.items) {
    const text = clipText(h.text);
    const title = clipTitle(h.title);
    if (!text) continue;
    const tags = finalTags(
      ['ledwall', 'legacy', 'history', KIND_TAG.wall, ...subjects(`${text} ${title || ''}`), h.source ? slug(h.source) : ''],
      'ledwall',
    );
    const ok = push(
      {
        kind: 'wall',
        type: 'Roast',
        title,
        text,
        tags,
        buttons: [{ label: 'OK', action: 'close' }],
        random: false,
        storm: false,
        pinned: false,
        icon: 'none',
      },
      { source: 'ledwall-history' },
    );
    if (ok) wallHistory.records += 1;
  }
}

/* --- 4. Error Popups v3 (one pool already) ------------------------------- */

function normButtons(list, fallback) {
  if (!Array.isArray(list) || !list.length) return fallback;
  const out = [];
  for (const b of list.slice(0, MAX_BUTTONS)) {
    if (!b || typeof b !== 'object') continue;
    const label = cap(textKey(b.label), 24);
    if (!label) continue;
    out.push({ label, action: ACTIONS.includes(b.action) ? b.action : 'close' });
  }
  return out.length ? out : fallback;
}

const popups = source('error-popups-v3', path.join(OBS, 'Content', 'error-popups', 'messages.json'), {
  note: 'current Error Popups pool (dialogs + phone notifications)',
});
if (popups.exists) {
  const doc = readJson(popups.file, 'error-popups-v3');
  expectShape(doc && Array.isArray(doc.messages), 'error-popups-v3', popups.file, 'expected { messages: [...] }');
  for (const m of doc.messages) {
    if (!m || typeof m !== 'object') {
      skipped.empty += 1;
      continue;
    }
    const text = clipText(m.text);
    if (!text) {
      skipped.empty += 1;
      continue;
    }
    /* No buttons is how v3 marks a record that renders as a phone banner; anything with a button
     * row is a Windows/macOS dialog. An explicit `kind` on the record wins. */
    const kind = KINDS.includes(m.kind) ? m.kind : Array.isArray(m.buttons) && m.buttons.length ? 'dialog' : 'notification';
    const type = cap(m.type || (kind === 'dialog' ? 'Error' : 'iMessage'), MAX_TYPE);
    const typeFacet = slug(type);
    const isLegacyType = kind === 'dialog' && ['error', 'alert', 'system', 'warning'].includes(typeFacet);
    const own = Array.isArray(m.tags) ? m.tags : [];
    /* The source's own `insults` facet marks the ALERT type, so a looser `insult` regex must not
     * re-lable the text as an insult. A derived tag may add detail, never disagree. */
    const derived = subjects(
      `${text} ${m.title || ''}`,
      own.some((t) => /insult/i.test(String(t))) ? new Set(['roast']) : null,
    );
    const tags = finalTags(
      [
        'error-popups',
        'legacy',
        KIND_TAG[kind],
        typeFacet,
        isLegacyType ? `legacy-type-${typeFacet}` : '',
        kind === 'notification' ? slug(PLATFORM[typeFacet] || 'phone') : '',
        kind === 'notification' ? 'phone' : '',
        ...own,
        ...derived,
        m.storm ? 'storm' : '',
        m.random ? 'random' : '',
      ],
      'error-popups',
    );
    const iconFor = { error: 'error', alert: 'warning', warning: 'warning', system: 'info' };
    const ok = push(
      {
        id: typeof m.id === 'string' && m.id.trim() ? cap(m.id.trim(), 40) : undefined,
        kind,
        type,
        title: clipTitle(m.title),
        text,
        tags,
        /* `buttons: []` is rejected by parseButtons ("must not be empty"); the field must be
         * absent for a record that never shows a button row. */
        ...(kind === 'dialog' ? { buttons: normButtons(m.buttons, [{ label: 'OK', action: 'close' }]) } : {}),
        random: m.random !== false,
        storm: m.storm !== false,
        icon: iconFor[typeFacet] || (kind === 'dialog' ? 'error' : 'none'),
      },
      { source: 'error-popups-v3' },
    );
    if (ok) popups.records += 1;
  }
}

/* --- 5. Error Popups v1 (bare strings) ----------------------------------- */

const popupsV1 = source('error-popups-v1', path.join(OBS, 'Content', 'error-popups', 'messages.v1.backup.json'), {
  note: 'v1 backup: bare strings, prefixes stripped from the pool text',
});
if (popupsV1.exists) {
  const doc = readJson(popupsV1.file, 'error-popups-v1');
  expectShape(doc && Array.isArray(doc.messages), 'error-popups-v1', popupsV1.file, 'expected { messages: ["..."] }');
  const titles = Array.isArray(doc.titles) ? doc.titles : [];
  for (const raw of doc.messages) {
    const text = clipText(raw);
    if (!text) {
      skipped.empty += 1;
      continue;
    }
    /* v1's own title list is mostly dialog chrome ("Setup", "Windows") — good as a type facet,
     * so the old heading survives, but the record's real identity is the text. */
    const typeFacet = titles.map(slug).find((t) => /^(error|alert|warning|system)/.test(t)) || 'error';
    const tags = finalTags(
      ['error-popups', 'legacy', KIND_TAG.dialog, 'v1', 'legacy-type-system-error', ...subjects(text)],
      'error-popups',
    );
    const ok = push(
      {
        kind: 'dialog',
        type: typeFacet === 'system-error' ? 'System' : cap(typeFacet.replace(/^./, (c) => c.toUpperCase()), MAX_TYPE),
        text,
        tags,
        buttons: [{ label: 'OK', action: 'close' }],
        random: true,
        storm: false,
        icon: 'warning',
      },
      { source: 'error-popups-v1' },
    );
    if (ok) popupsV1.records += 1;
  }
}

/* ---------------------------------------------------------------- report */

const fileName = (f) => path.relative(OBS, f) || f;

if (!sources.some((s) => s.exists)) die(`no legacy store found under ${OBS} — pass --obs <root>`);
for (const s of sources) if (!s.exists) warnings.push(`missing source ${s.name}: ${s.file}`);
if (!records.length) die('every legacy store was empty — nothing to import');

/* A record must carry only fields the server knows: `__source` is this tool's bookkeeping and is
 * stripped before any request, and an unknown key would otherwise persist through a replace. */
for (const [i, r] of records.entries()) {
  for (const k of Object.keys(r)) {
    if (k !== '__source' && !IMPORT_KEYS.has(k)) die(`records[${i}] carries unknown field ${k}`, 2);
  }
}

/* Anything that would be rejected by the server is a bug in this tool, not a runtime surprise. */
for (const [i, r] of records.entries()) {
  const bad = [];
  if (!KINDS.includes(r.kind)) bad.push(`kind ${r.kind}`);
  if (!r.text) bad.push('empty text');
  if (r.text.length > MAX_TEXT) bad.push(`text ${r.text.length} chars`);
  if (!r.tags.length) bad.push('no tags');
  if (r.tags.length > MAX_TAGS) bad.push(`${r.tags.length} tags`);
  if (r.tags.some((t) => t.length > MAX_TAG_LEN)) bad.push('overlong tag');
  if (r.type && r.type.length > MAX_TYPE) bad.push(`type ${r.type.length} chars`);
  if (r.title && r.title.length > MAX_TITLE) bad.push(`title ${r.title.length} chars`);
  if (bad.length) die(`records[${i}] (${r.__source}) failed validation: ${bad.join(', ')}`, 2);
}

const byKind = {};
for (const r of records) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

const histogram = new Map();
for (const r of records) for (const t of r.tags) histogram.set(t, (histogram.get(t) || 0) + 1);
const facets = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const thin = records.filter((r) => r.tags.length < 2);

function histogramText() {
  const lines = [];
  for (const [t, n] of facets) lines.push(`  ${String(n).padStart(4)}  ${t}`);
  return lines.join('\n');
}

const modeLine = MERGE_TAGS
  ? APPLY
    ? `apply -> ${BASE} (merge-tags: add derived tags to records already in the pool)`
    : 'dry run, merge-tags plan (no server is contacted)'
  : APPLY
    ? `apply -> ${BASE}/api/pool/import (merge)`
    : 'dry run (no server is contacted)';
console.log(`mode          ${modeLine}`);
console.log(`obs root      ${OBS}`);
console.log('');
console.log('sources');
for (const s of sources) {
  const state = s.exists ? `${String(s.records).padStart(3)} records` : 'MISSING';
  console.log(`  ${s.exists ? 'ok  ' : 'fail'}  ${String(s.name).padEnd(20)} ${state.padEnd(14)} ${fileName(s.file)}`);
  if (s.note) console.log(`        ${' '.repeat(20)} ${s.note}`);
}
console.log('');
console.log(`records built ${records.length}  ${JSON.stringify(byKind)}`);
console.log(`deduped       ${skipped.duplicate} text-identical, ${skipped.empty} empty`);
console.log(`tags          ${histogram.size} distinct, mean ${(records.reduce((a, r) => a + r.tags.length, 0) / records.length).toFixed(2)}/record`);
console.log(`under-tagged  ${thin.length} record(s) with fewer than 2 tags${thin.length ? ':' : ''}`);
for (const r of thin.slice(0, 12)) console.log(`    ${r.tags.join(',') || '(none)'}  ${r.text.slice(0, 60)}`);
if (warnings.length) {
  console.log('');
  for (const w of warnings) console.log(`warning       ${w}`);
}

const payloadRecords = records.map(({ __source, ...rest }) => rest);
/* The written file keeps `importedFrom` so a reviewer can see which store each record came from;
 * the POST body never carries it (the server would reject the unknown key on a replace). */
const dumpRecords = records.map(({ __source, ...rest }) => ({ ...rest, importedFrom: __source }));
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), `${JSON.stringify(dumpRecords, null, 2)}\n`);
  console.log(`\nwrote         ${path.resolve(OUT)} (${dumpRecords.length} records)`);
}

if (!APPLY && MERGE_TAGS) {
  /* A merge-tags plan cannot be worked out offline: it is the diff between the derived tags and
   * what the pool ALREADY holds, so the plan needs the server. Refuse rather than "contact nothing"
   * with a plan that was never computed — run it with --apply (idempotent) or on a copy of state. */
  console.log('');
  if (MERGE_TAGS) console.error('import-legacy-pools: --merge-tags needs the live pool, so it cannot plan offline.');
  console.error('  The plan is the diff against what the pool already holds. Run one of:');
  console.error(`    node tools/import-legacy-pools.mjs --apply --merge-tags --url ${BASE}`);
  console.error('  or point --url at a server running with --state <copy of state> to see it before you patch.');
  process.exit(1);
}

if (!APPLY) {
  console.log('');
  console.log('tag histogram');
  console.log(histogramText());
  console.log('');
  console.log('dry run — nothing sent. Re-run with --apply (and --url <base>) to import.');
  process.exit(0);
}

/* ---------------------------------------------------------------- api */

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    die(`${method} ${route} failed — ${err.message}. Is ShockBox running at ${BASE}?`);
  }
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON body is reported below */
  }
  if (!res.ok) die(`${method} ${route} -> ${res.status} ${raw.slice(0, 300)}`);
  return json;
}

const wallCount = (v) => (v.messages || []).length;

/* ---------------------------------------------------------------- merge-tags */

/* For a pool that already holds these records under an older tag scheme. Same identity rule as
 * merge (identical stored text, core/pool.mjs importRecords), so this cannot disagree with what a
 * re-import reports as skipped: a record with no text match here is one an import would ADD. */
if (MERGE_TAGS) {
  const readAll = async () => (await api('GET', '/api/pool/all')).messages || [];
  const tagCount = (messages) => {
    const out = {};
    for (const m of messages) for (const t of normTags(m.tags)) out[t] = (out[t] || 0) + 1;
    return out;
  };

  const poolsBefore = await api('GET', '/api/pools');
  const wallBefore = await api('GET', '/api/pool/wall');
  const liveBefore = await readAll();
  const liveByText = byTextIndex(liveBefore);
  const tagCountBefore = tagCount(liveBefore);

  const plans = [];
  const unmatched = [];
  for (const r of records) {
    const hit = liveByText.get(r.text);
    if (!hit) {
      unmatched.push(r);
      continue;
    }
    plans.push({ rec: r, live: hit, ...planTagMerge(hit.tags, r.tags) });
  }

  const changed = plans.filter((p) => !p.unchanged);
  const already = plans.filter((p) => p.unchanged);
  const refused = changed.filter((p) => p.over || p.overlong.length);
  const willPatch = changed.filter((p) => !p.over && !p.overlong.length);
  const tagsToAdd = willPatch.reduce((a, p) => a + p.added.length, 0);

  console.log('');
  console.log(
    `before        ${JSON.stringify(poolsBefore.counts)}  tags ${Object.keys(tagCountBefore).length} distinct in ${liveBefore.length} records`,
  );
  console.log(`matched       ${plans.length} of ${records.length} legacy record(s) by identical text`);
  console.log(`unmatched     ${unmatched.length}${unmatched.length ? ' (an import would add these)' : ''}`);
  for (const r of unmatched.slice(0, 10)) console.log(`    no match  ${JSON.stringify(r.text.slice(0, 60))}`);
  console.log(`changed       ${changed.length} record(s) gain tags, ${tagsToAdd} tag(s) total`);
  console.log(`unchanged     ${already.length} record(s) already carry every derived tag`);
  if (refused.length) {
    for (const p of refused) {
      const why = p.over ? `union would be ${p.union.length} > ${MAX_TAGS} tags` : `tag over ${MAX_TAG_LEN} chars: ${p.overlong.join(',')}`;
      console.log(`    refused   ${p.live.id} — ${why}; had ${p.have.length}, derived adds ${p.added.length}`);
    }
  }

  let patched = 0;
  for (const p of willPatch) {
    /* Only `tags` in the body: parseMessageBody runs partial here, so text, kind, title, buttons,
     * pinned and icon on the live record stay exactly as the user has them. */
    await api('PATCH', `/api/pool/all/messages/${encodeURIComponent(p.live.id)}`, { tags: p.union });
    patched += 1;
    const sample = p.added.slice(0, 8).join(',') + (p.added.length > 8 ? `,+${p.added.length - 8}` : '');
    console.log(`  patch ${String(patched).padStart(3)}  ${p.live.id.padEnd(6)} ${String(p.live.kind).padEnd(13)} ${String(p.have.length).padStart(2)} -> ${String(p.union.length).padStart(2)} tags  +${sample}`);
  }

  /* Prove it from the server, not from the plan. */
  const liveAfter = await readAll();
  const tagCountAfter = tagCount(liveAfter);
  const afterById = new Map(liveAfter.map((m) => [m.id, m]));
  const lost = [];
  for (const m of liveBefore) {
    const now = normTags((afterById.get(m.id) || {}).tags);
    for (const t of normTags(m.tags)) if (!now.includes(t)) lost.push(`${m.id}:${t}`);
  }
  const missing = [];
  for (const p of plans) {
    const now = normTags((afterById.get(p.live.id) || {}).tags);
    for (const t of p.want) if (!now.includes(t)) missing.push(`${p.live.id}:${t}`);
  }
  const untaggedAfter = liveAfter.filter((m) => !normTags(m.tags).length);
  const poolsAfter = await api('GET', '/api/pools');
  const wallAfter = await api('GET', '/api/pool/wall');
  const newTags = Object.keys(tagCountAfter).filter((t) => !(t in tagCountBefore)).sort();

  const marker = {
    at: new Date().toISOString(),
    tool: 'tools/import-legacy-pools.mjs',
    run: 'merge-tags',
    url: BASE,
    sources: sources.map((s) => ({ name: s.name, file: s.file, exists: s.exists, records: s.records })),
    records: records.length,
    byKind,
    matched: plans.length,
    unmatched: unmatched.map((r) => ({ source: r.__source, textStart: r.text.slice(0, 60) })),
    changed: changed.length,
    patched,
    refused: refused.map((p) => ({ id: p.live.id, tags: p.union.length })),
    alreadyComplete: already.length,
    tagsAdded: tagsToAdd,
    pools: { before: poolsBefore.counts, after: poolsAfter.counts },
    wall: { before: wallCount(wallBefore), after: wallCount(wallAfter) },
    tagCounts: { before: Object.keys(tagCountBefore).length, after: Object.keys(tagCountAfter).length },
    newTags,
    lostTags: lost.length,
    missingDerived: missing.length,
    untaggedAfter: untaggedAfter.length,
    perRecord: plans.map((p) => ({ id: p.live.id, kind: p.live.kind, had: p.have.length, now: p.union.length, added: p.added })),
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);

  console.log('');
  console.log(`patched       ${patched} record(s)${refused.length ? `, ${refused.length} refused` : ''} — ${tagsToAdd} tag(s) added`);
  console.log(`after         ${JSON.stringify(poolsAfter.counts)}  tags ${Object.keys(tagCountAfter).length} distinct (+${newTags.length})`);
  console.log(`old tags kept ${lost.length === 0 ? 'yes — no live record lost a tag' : `NO — ${lost.length} tag(s) lost`}`);
  console.log(`derived tags  ${missing.length === 0 ? 'yes — every derived tag is on its record' : `NO — ${missing.length} missing`}`);
  console.log(`untagged      ${untaggedAfter.length} of ${liveAfter.length} records`);
  console.log(`new tags      ${newTags.slice(0, 40).join(', ')}${newTags.length > 40 ? `, … (${newTags.length - 40} more)` : ''}`);
  console.log(`marker        ${MARKER}  (${marker.at})`);

  if (lost.length) die(`${lost.length} live record(s) lost a tag — merge-tags is not additive: ${lost.slice(0, 5).join(' ')}`);
  if (missing.length) die(`${missing.length} derived tag(s) did not land: ${missing.slice(0, 5).join(' ')}`);
  if (untaggedAfter.length) die(`${untaggedAfter.length} record(s) in the pool have no tags`);
  if (unmatched.length) die(`${unmatched.length} legacy record(s) have no text-identical live record — run the plain import first`);
  console.log(patched === 0 ? '\nok — nothing to change (this was a re-run)' : '\nok');
  process.exit(0);
}

/* ---------------------------------------------------------------- import */

const before = await api('GET', '/api/pools');
const wallBefore = await api('GET', '/api/pool/wall');
console.log('');
console.log(`before        ${JSON.stringify(before.counts)}  types ${before.types.length}  tags ${before.tags.length}`);

let added = 0;
let serverSkipped = 0;
const batches = [];
for (let i = 0; i < payloadRecords.length; i += BATCH) {
  const chunk = payloadRecords.slice(i, i + BATCH);
  const r = await api('POST', '/api/pool/import', { mode: 'merge', messages: chunk });
  added += r.added || 0;
  serverSkipped += r.skipped || 0;
  batches.push({ offset: i, size: chunk.length, added: r.added, skipped: r.skipped, count: r.count });
  console.log(`  batch ${String(i / BATCH + 1).padStart(2)}  ${String(chunk.length).padStart(3)} sent  +${r.added} new  ${r.skipped} skipped`);
}

const after = await api('GET', '/api/pools');
const wallAfter = await api('GET', '/api/pool/wall');

/* The real proof: untagged records anywhere in the pool, read back from the server. */
const all = await api('GET', '/api/pool/all');
const untagged = (all.messages || []).filter((m) => !Array.isArray(m.tags) || !m.tags.length);

const marker = {
  at: new Date().toISOString(),
  tool: 'tools/import-legacy-pools.mjs',
  run: 'import',
  url: BASE,
  mode: 'merge',
  sources: sources.map((s) => ({ name: s.name, file: s.file, exists: s.exists, records: s.records })),
  records: payloadRecords.length,
  byKind,
  added,
  skipped: serverSkipped,
  deduped: skipped,
  batches,
  counts: { before: before.counts, after: after.counts },
  wall: { before: wallCount(wallBefore), after: wallCount(wallAfter) },
  tags: { distinct: histogram.size, histogram: Object.fromEntries(facets) },
  untaggedAfter: untagged.length,
};

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);

console.log('');
console.log(`added         ${added}`);
console.log(`skipped       ${serverSkipped} (already in the pool)`);
console.log(`after         ${JSON.stringify(after.counts)}  types ${after.types.length}  tags ${after.tags.length}`);
console.log(`wall pool     ${wallCount(wallBefore)} -> ${wallCount(wallAfter)}`);
console.log(`untagged      ${untagged.length} of ${(all.messages || []).length} records`);
console.log(`tags          ${histogram.size} distinct`);
console.log(`marker        ${MARKER}  (${marker.at})`);

if (untagged.length) {
  console.error(`\nimport-legacy-pools: ${untagged.length} record(s) in the pool have no tags — import incomplete`);
  for (const m of untagged.slice(0, 10)) console.error(`  ${m.id} ${String(m.text).slice(0, 60)}`);
  process.exit(1);
}
if (added === 0) {
  console.log('\nok — nothing new (this was a re-run)');
  console.log('hint: the pool already holds these records; --apply --merge-tags unions the derived tags onto them');
} else {
  console.log('\nok');
}
