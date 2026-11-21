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

export const COMMANDS = [...BARE, 'preset.set', 'preset.save', 'preset.delete', 'look.palette', 'look.pattern',
  'wall.image.set', 'wall.image.clear',
  'text.send', 'text.enabled', 'text.style', 'text.align', 'settings.patch', ...NUMERIC].sort();

// The renderer's real per-run size allowlist (sim.js SIZE_STEPS): glyph heights are whole
// cells, so these four are the only heights that land on the grid. `config.js` advertises a
// 0.1..2 range for the same key, which is a lie the validator refuses to honour.
const SIZE_STEPS = [0.8, 1, 1.25, 1.5];
// `config.js` `text.fonts` key -> CSS stack. A raw CSS family is also accepted (sim.js
// `String(st.font)`), so these are names, not the whole vocabulary.
const FONT_KEYS = new Set(['mono', 'cond', 'black', 'impact', 'serif', 'sans']);
const COLOUR_HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const ALIGNS = new Set(['left', 'center', 'right']);
const STYLE_KEYS = new Set(['size', 'font', 'tracking', 'uppercase', 'scroll', 'reveal',
  'colour', 'fit', 'cellThreshold']);

// The look the operator approved on the `sign` preset, and the default `text.send` carries when
// the caller sends no style: size 1 (the preset's 0.92 snaps to 1 in sim.js `sizeFor`), the
// preset's Arial stack, tracking .06, upper case, palette colour. It is a DEFAULT, not an
// override — an explicit style still wins key by key — and it goes through `stylePatch` on
// every send so it cannot drift out of the renderer's ranges.
const TEXT_SEND_STYLE = Object.freeze({
  size: 1,
  font: '"Arial", "Helvetica Neue", sans-serif',
  tracking: 0.06,
  uppercase: true,
  scroll: 0,
  reveal: 0,
  colour: 'palette',
});

/** A number inside the range the renderer actually draws, named so a bad field says which. */
function numRange(cmd, name, v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new HttpError(400, `${cmd}: ${name} must be a number ${lo}..${hi}`);
  }
  return n;
}

/**
 * Validate a `text.style` patch. Every key is one the renderer reads (sim.js raster, 577-690);
 * a key it does not read would be a control with no wire behind it, so unknown keys are a 400
 * rather than dropped — a typo has to be visible.
 */
function stylePatch(raw) {
  if (!isObj(raw)) throw new HttpError(400, 'text.style: style must be an object');
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!STYLE_KEYS.has(k)) {
      throw new HttpError(400, `text.style: unknown key "${k}" — use ${[...STYLE_KEYS].join(', ')}`);
    }
    switch (k) {
      case 'size': {
        const n = Number(v);
        if (!SIZE_STEPS.includes(n)) {
          throw new HttpError(400, `text.style: size must be one of ${SIZE_STEPS.join(', ')} (whole-cell glyph heights)`);
        }
        out.size = n;
        break;
      }
      case 'font': {
        if (typeof v !== 'string' || !v.trim() || v.length > 120) {
          throw new HttpError(400, 'text.style: font must be a key (mono, cond, black, impact, serif, sans) or a CSS family string up to 120 chars');
        }
        out.font = FONT_KEYS.has(v) ? v : v.trim();
        break;
      }
      case 'tracking': out.tracking = numRange('text.style', 'tracking', v, -0.2, 1); break;
      case 'scroll': out.scroll = numRange('text.style', 'scroll', v, -600, 600); break;
      case 'reveal': out.reveal = numRange('text.style', 'reveal', v, 0, 4000); break;
      case 'cellThreshold': out.cellThreshold = numRange('text.style', 'cellThreshold', v, 0, 1); break;
      case 'uppercase':
        if (typeof v !== 'boolean') throw new HttpError(400, 'text.style: uppercase must be a boolean');
        out.uppercase = v;
        break;
      case 'fit':
        if (v !== 'auto' && v !== 'none') throw new HttpError(400, 'text.style: fit must be "auto" or "none"');
        out.fit = v;
        break;
      case 'colour':
        // 'palette' is the sentinel that makes glyph cells adopt the wall's own ramp and
        // pattern (sim.js COLOUR_PALETTE); any hex is snapped to the nearest palette sample.
        if (v !== 'palette' && !(typeof v === 'string' && COLOUR_HEX_RE.test(v))) {
          throw new HttpError(400, 'text.style: colour must be "palette" or a #rgb/#rrggbb hex');
        }
        out.colour = v === 'palette' ? 'palette' : v.toLowerCase();
        break;
      default: break;
    }
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'text.style: style patch is empty');
  return out;
}

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

  if (cmd === 'preset.save' || cmd === 'preset.delete') {
    if (typeof args.name !== 'string' || !args.name.trim()) {
      throw new HttpError(400, `${cmd}: name is required`);
    }
    if (!NAME_RE.test(args.name)) {
      throw new HttpError(400, `${cmd}: name must be 1..64 chars of [A-Za-z0-9 ._:-]`);
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
    if (typeof args.text === 'string') {
      // A typed message is built into the same `item` shape `resolvePoolArgs` produces for a
      // pool message (server.js: `{title, paras:[{align, runs:[{t}]}]}`), because the engine's
      // `text.send` reads nothing but `item.paras`. Handing it `{text}` here is what made Quick
      // Send answer 200 and put nothing on the wall (verified 2026-11-19).
      const align = ALIGNS.has(args.align) ? args.align : 'center';
      rec = { item: {
        title: typeof args.title === 'string' ? args.title : '',
        paras: [{ align, runs: [{ t: args.text }] }],
      } };
      // A style bag rides with the send so a message carries the operator's current card
      // values even if no `text.style` was sent first (engine merges `item.style` over the
      // text object's own style). Absent style = the sign look, not the renderer's bare
      // defaults, so a script, deck key or scheduled send lands on the same look the operator
      // approved; an explicit style still wins per key over that default.
      const explicit = args.style === undefined ? {} : stylePatch(args.style);
      rec.item.style = stylePatch({ ...TEXT_SEND_STYLE, ...explicit });
    } else if (args.item !== undefined) {
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

  if (cmd === 'text.style') {
    // The engine merges this onto the live text object's `style`, so a partial patch is the
    // normal shape: one control, one key. It applies to the message on the wall now and to
    // every later send, which is what makes the card a style, not a one-shot.
    const tv = viewArg();
    return { rec: { style: stylePatch(args.style), view: tv }, view };
  }

  if (cmd === 'text.align') {
    // Per-paragraph align is the only layout knob there is (sim.js `alignF`: left/center/right).
    // One control sets every paragraph of the live text; a send carries its own from `text.send`.
    const tv = viewArg();
    if (!ALIGNS.has(args.align)) throw new HttpError(400, 'text.align: align must be left | center | right');
    return { rec: { align: args.align, view: tv }, view };
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
