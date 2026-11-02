// The wall's command whitelist — a port of the ledwall-agent's validateCommand.
//
// One shape in, one record out. `httpCmd` in core is generic (a module gets `{cmd, args}` and
// answers `{ok}`); this file is the only place that knows which commands exist, so the control
// pane, the deck and the engine page all validate identically.

import { HttpError } from '../../core/id.mjs';

const NAME_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;
const VIEWS = new Set(['landscape', 'portrait']);
const TARGETS = new Set(['landscape', 'portrait', 'both']);

/** Commands that need no arguments. */
const BARE = new Set([
  'preset.next',
  'preset.prev',
  'pattern.next',
  'pattern.prev',
  'blackout.on',
  'blackout.off',
  'blackout.toggle',
  'reload',
  'text.clear',
  'text.reveal',
  // a17: the ratio key toggles 9:16 <-> 16:9. A forcing scene pins 16:9 anyway, so the toggle
  // is a no-op there rather than a way to sneak portrait into Theater.
  'ratio.toggle',
  'ratio.force16x9',
  'fence.toggle',
  // a4: the three lookup selectors the pane and the deck drive. `preset.save` snapshots the
  // look on the wall right now into a named preset; it never reads or writes a text-mode pool
  // record. `look.palette` is the ramp only; `look.pattern` is the animation only.
  'look.palette.next',
  'look.palette.prev',
  'look.pattern.next',
  'look.pattern.prev',
]);

/** Numeric nudge commands: presets/pattern banks move by {delta} or {set}. */
const NUMERIC = new Set(['preset.index', 'pattern.index']);

export const COMMANDS = [...BARE, 'preset.set', 'preset.save', 'look.palette', 'look.pattern',
  'wall.image.set', 'wall.image.clear',
  'text.send', 'text.enabled', 'settings.patch', ...NUMERIC].sort();

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A 0..1 fraction, named in the message so a bad field says which one it is. */
function num01(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, `wall.image.set: ${name} must be 0..1`);
  return n;
}

/**
 * Validate one command. Returns `{rec, view}` where `rec` is what the browser source receives
 * and `view` is the delivery scope (null = every page).
 * @throws {HttpError} 400 on any malformed argument; the message names the field.
 */
export function validateCommand(cmd, args = {}, topView = null) {
  if (typeof cmd !== 'string' || !cmd) throw new HttpError(400, 'cmd must be a non-empty string');
  if (!isObj(args)) throw new HttpError(400, 'args must be an object');
  let view = null;
  if (topView !== undefined && topView !== null) {
    if (!VIEWS.has(topView)) throw new HttpError(400, 'view must be "landscape" or "portrait"');
    view = topView;
  }
  const viewArg = (dflt = 'both') => {
    if (args.view === undefined) return dflt;
    if (!TARGETS.has(args.view)) throw new HttpError(400, 'args.view must be landscape | portrait | both');
    return args.view;
  };

  if (BARE.has(cmd)) return { rec: {}, view };

  // `look.palette` / `look.pattern` with no argument move one step in the bank; the deck's
  // four bare `*.next` / `*.prev` commands are the same thing with the step folded in.
  if (cmd === 'look.palette.next' || cmd === 'look.palette.prev' ||
      cmd === 'look.pattern.next' || cmd === 'look.pattern.prev') {
    const step = cmd.endsWith('.next') ? 1 : -1;
    return { rec: { name: undefined, delta: step }, view };
  }

  if (cmd === 'look.palette' || cmd === 'look.pattern') {
    if (args.name !== undefined) {
      if (typeof args.name !== 'string' || !NAME_RE.test(args.name)) {
        throw new HttpError(400, `${cmd}: name must be 1..64 chars of [A-Za-z0-9 ._:-]`);
      }
      return { rec: { name: args.name }, view };
    }
    const step = args.delta === undefined ? 1 : args.delta;
    if (typeof step !== 'number' || !Number.isFinite(step) || step === 0) {
      throw new HttpError(400, `${cmd}: delta must be a finite non-zero number`);
    }
    return { rec: { delta: step }, view };
  }

  if (cmd === 'preset.save') {
    if (typeof args.name !== 'string' || !args.name.trim()) {
      throw new HttpError(400, 'preset.save: name is required');
    }
    if (!NAME_RE.test(args.name)) {
      throw new HttpError(400, 'preset.save: name must be 1..64 chars of [A-Za-z0-9 ._:-]');
    }
    return { rec: { name: args.name }, view };
  }

  if (cmd === 'preset.set' || cmd === 'pattern.set') {
    if (typeof args.name !== 'string' || !NAME_RE.test(args.name)) {
      throw new HttpError(400, `${cmd}: name must be 1..64 chars of [A-Za-z0-9 ._:-]`);
    }
    return { rec: { name: args.name }, view };
  }

  if (cmd === 'wall.image.clear') return { rec: {}, view };

  if (cmd === 'wall.image.set') {
    // Two callers, one command: the upload route hands the bytes in (already read raw by core,
    // so this validator only sees the envelope), and a deck/script call names a placement on the
    // picture already stored. `body` is required for an upload and never forwarded to a page —
    // the pages learn the outcome from the settings snapshot (`imageRev`).
    const hasBody = Buffer.isBuffer(args.body) ? args.body.length > 0 : Boolean(args.body && args.body.length);
    const rec = {};
    if (hasBody) rec.body = args.body;
    if (args.rev !== undefined) {
      if (!Number.isInteger(args.rev) || args.rev < 0) throw new HttpError(400, 'wall.image.set: rev must be a non-negative integer');
      rec.rev = args.rev;
    }
    if (args.x !== undefined) rec.x = num01('x', args.x);
    if (args.y !== undefined) rec.y = num01('y', args.y);
    if (args.scale !== undefined) {
      const n = Number(args.scale);
      if (!Number.isFinite(n) || n < 0.05 || n > 4) throw new HttpError(400, 'wall.image.set: scale must be 0.05..4');
      rec.scale = n;
    }
    if (args.rotate !== undefined) {
      const n = Number(args.rotate);
      if (!Number.isFinite(n) || n < -180 || n > 180) throw new HttpError(400, 'wall.image.set: rotate must be -180..180');
      rec.rotate = n;
    }
    if (args.colour !== undefined) {
      if (!['raw', 'match', 'palette'].includes(args.colour)) throw new HttpError(400, 'wall.image.set: colour must be raw | match | palette');
      rec.colour = args.colour;
    }
    if (args.bits !== undefined) {
      const b = String(args.bits);
      // 8/10/12 are the LED depths: 8 bit is the picture as decoded, 10 and 12 band and rely on
      // the ordered dither. '4' was retired - 16 levels per channel is coarser than the wall's
      // own ramp and made every colour mode look like it had thrown the picture away.
      if (!['8', '10', '12'].includes(b)) throw new HttpError(400, 'wall.image.set: bits must be 8 | 10 | 12');
      rec.bits = b;
    }
    if (args.dither !== undefined) rec.dither = num01('dither', args.dither);
    if (!hasBody && !Object.keys(rec).length) throw new HttpError(400, 'wall.image.set: needs the image body or a placement to change');
    return { rec, view };
  }

  if (cmd === 'text.send') {
    const tv = viewArg();
    // `poolId`/`slot` never reach here: server.js `send()` resolves them against the core
    // pool into a concrete `item` first (resolvePoolArgs). Earlier revisions also accepted a
    // bare `poolId`/`slot` through the module, but the engine's text.send only consumes
    // `item`, so that path was accepted and then silently ignored — removed, not kept.
    let rec;
    if (typeof args.text === 'string') rec = { text: args.text };
    else if (args.item !== undefined) {
      if (!isObj(args.item)) throw new HttpError(400, 'text.send item must be an object');
      rec = { item: args.item };
    } else throw new HttpError(400, 'text.send needs text or item (poolId/slot are resolved upstream)');
    if (args.duration !== undefined) {
      if (!Number.isInteger(args.duration) || args.duration < 0 || args.duration > 600) {
        throw new HttpError(400, 'text.send duration must be an integer 0..600 (0 or absent = hold)');
      }
      rec.duration = args.duration;
    }
    rec.view = tv;
    return { rec, view: tv };
  }

  if (cmd === 'text.enabled') {
    if (typeof args.on !== 'boolean') throw new HttpError(400, 'text.enabled: on must be a boolean');
    return { rec: { view: viewArg(), on: args.on }, view };
  }

  if (cmd === 'settings.patch') {
    if (!isObj(args.patch)) throw new HttpError(400, 'settings.patch: patch must be an object');
    if (Object.keys(args.patch).length > 64) throw new HttpError(400, 'settings.patch: patch has more than 64 keys');
    if (JSON.stringify(args.patch).length > 16 * 1024) throw new HttpError(400, 'settings.patch: patch > 16 KB');
    let ptView = null;
    if (args.view !== undefined) {
      if (!TARGETS.has(args.view)) throw new HttpError(400, 'settings.patch: view must be landscape | portrait | both');
      ptView = args.view;
    }
    return { rec: { view: ptView ?? 'both', patch: args.patch }, view };
  }

  if (NUMERIC.has(cmd)) {
    const hasDelta = args.delta !== undefined;
    const hasSet = args.set !== undefined;
    if (hasDelta === hasSet) throw new HttpError(400, `${cmd} needs exactly one of {delta} or {set}`);
    const v = hasDelta ? args.delta : args.set;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${cmd}: ${hasDelta ? 'delta' : 'set'} must be a finite number`);
    if (Math.abs(v) > 100) throw new HttpError(400, `${cmd}: out of range (|v| <= 100)`);
    return { rec: hasDelta ? { delta: v } : { set: v }, view };
  }

  throw new HttpError(400, `unknown cmd: ${String(cmd)} (known: ${COMMANDS.join(', ')})`);
}
