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
]);

/** Numeric nudge commands: presets/pattern banks move by {delta} or {set}. */
const NUMERIC = new Set(['preset.index', 'pattern.index']);

export const COMMANDS = [...BARE, 'preset.set', 'pattern.set', 'text.send', 'text.enabled', 'settings.patch', ...NUMERIC].sort();

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

  if (cmd === 'preset.set' || cmd === 'pattern.set') {
    if (typeof args.name !== 'string' || !NAME_RE.test(args.name)) {
      throw new HttpError(400, `${cmd}: name must be 1..64 chars of [A-Za-z0-9 ._:-]`);
    }
    return { rec: { name: args.name }, view };
  }

  if (cmd === 'text.send') {
    const tv = viewArg();
    // The page resolves slots itself against its own pool copy; the module only checks the
    // shape and passes it through, so a pool edit between send and receive cannot 400.
    let rec;
    if (typeof args.text === 'string') rec = { text: args.text };
    else if (args.item !== undefined) {
      if (!isObj(args.item)) throw new HttpError(400, 'text.send item must be an object');
      rec = { item: args.item };
    } else if (args.poolId !== undefined) {
      if (typeof args.poolId !== 'string' || !args.poolId) throw new HttpError(400, 'text.send poolId must be a non-empty string');
      rec = { poolId: args.poolId };
    } else if (args.slot !== undefined) {
      if (!Number.isInteger(args.slot) || args.slot < 1) throw new HttpError(400, 'text.send slot must be an integer >= 1');
      rec = { slot: args.slot };
    } else throw new HttpError(400, 'text.send needs text, item, poolId or slot');
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
