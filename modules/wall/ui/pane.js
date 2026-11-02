// LED wall control pane.
//
// The wall is two surfaces: a 2560×1440 landscape canvas inside OBS, and a 9:16 "fence"
// — a whole-cell window inside that canvas. This pane is the operator's desk for both:
//
//   • a scaled, live preview of the wall (pattern still, fence window, dim outside it)
//   • the fence: drag to move, corner grip to resize at a locked 9:16, arrow-key nudge
//   • quick controls: pattern / preset / blackout / ratio (with a forcing scene locked out)
//   • the look, straight from the module's settings schema
//   • text pool quick send, and a status strip with the last commands
//
// Data:
//   GET   /api/wall/live         one snapshot: settings describe, ratio state, render doc
//   GET   /api/wall/render       {settings:{look,ratio,fence,rev}, online, seq}
//   PATCH /api/wall/settings     {key:value}            → persists + broadcasts
//   POST  /api/wall/cmd          {cmd, args}            → bus command (pages)
//   POST  /api/wall/broadcast    {patch:{fence}}        → live push only, not persisted
//   Settings are changed through PATCH (it also broadcasts), so a failed PATCH is a failed
//   change: the control snaps back to the server's value and says why.

// The shell loads this pane from /mod/wall/… so relative imports resolve inside the module.
// /src/ui.js is the same module object the shell already holds (the browser dedupes by URL),
// so `el`/`actionButton` are exactly the shell's, not a second copy.
import { el, clear, dot, actionButton } from '/src/ui.js';
import { toast } from '/src/toast.js';
import { renderSettingsForm } from '/src/settings-form.js';
// the shared module preview: one 16:9 frame + 9:16 window for every pane (see preview.js)
import { mountPreview } from '/src/preview.js';
import { mountQuickSend } from '/src/quicksend.js';
import { mountSchedulePanel } from '/src/schedule-panel.js';

/* The wall surface the preview draws, in the render page's pixel space at scale 2. */
const WALL_W = 2560;
const WALL_H = 1440;
// Whole-wall bounds: 2560 wide, 2560*16/9 tall — the portrait window's height at full width.
const OUTER_H = (WALL_W * 16) / 9; // whole-wall (9:16) bounds; the picture is WALL_H tall
const FENCE_RATIO = 9 / 16;

/* Look keys that have a dedicated control above the schema form. */
const HANDLED = new Set(['ratio', 'fence', 'blackout', 'pattern', 'preset', 'fenceOutDim']);
const LOOK_GROUPS = ['look', 'general', 'behaviour', 'timing', 'audio', 'advanced', 'obs', 'ratio', 'compat'];

/* Palette stops mirrored from the engine (engine/config.js, window.LEDWALL_PALETTES), so the
 * preview's still can be tinted like the wall without running WebGL.
 *
 * Key order is the engine's own bank order on purpose: `look.palette` with no name steps through
 * `Object.keys(LEDWALL_PALETTES)`, so a name's place in this object (and therefore in the
 * dropdown) has to be its place in the engine's list or a step and a pick disagree. This is the
 * same list `engine/config.js` puts in window.LEDWALL_PALETTES; nothing fetches the engine file
 * here — the pane must paint even when no render page is open. */
const PALETTES = {
  synthwave: ['#7b2ff7', '#c026d3', '#ff2d95'],
  arctic: ['#9fb8d8', '#e6fbff', '#3a86ff'],
  lava: ['#8c0f00', '#e01b00', '#ff8c1a'],
  neonwave: ['#00f5d4', '#3a86ff', '#ff2d95'],
  ember: ['#b80000', '#ff3c00', '#ffd166'],
  candy: ['#ff5ec4', '#6f5bff', '#7bffd4'],
  mono: ['#ffffff', '#c8dcff', '#9fb8d8'],
};
// The engine's default ramp and look, named once: a live look that says nothing about its
// palette is the engine's default, and the dropdown must point at what the wall is running.
const DEFAULT_PALETTE = 'neonwave';

/* a select shows exactly one option and nothing else, so the placeholder has to be the default
   the wall runs: `— preset —` would read as "no preset" when the wall is in fact rendering one */
const DEFAULT_PRESET = 'neonwave';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round(n, step = 1) {
  return Math.round(n / step) * step;
}
function fmtPx(n) {
  return String(Math.round(Number(n) || 0));
}

/* The module manifest carries no `label`/`group`, so core's describe() hands every wall key
 * back as group "general" with the raw key as its name. The pane knows its own schema, so it
 * labels and groups here: the knobs an operator reaches for first go on top. Anything the
 * manifest marks itself (a future `label`/`group`) wins over this table. */
/* Every key here must exist in modules/wall/module.json: a row for a key the schema does not
 * have PATCHes a name the server rejects, which is a dead control that teaches nothing. */
const LOOK_META = {
  brightness: ['Brightness', 'look', 0, 2, 0.01],
  speed: ['Speed', 'look', 0, 4, 0.05],
  saturation: ['Saturation', 'colour', 0, 2, 0.05],
  gridCols: ['Columns', 'grid', 16, 200, 1],
  gridColsPortrait: ['Columns (portrait)', 'grid', 16, 120, 1],
  gridRows: ['Rows (0 = auto)', 'grid', 0, 160, 1],
  ledSize: ['LED size', 'grid', 0.3, 2.5, 0.05],
  cellShape: ['Cell shape', 'grid', 0.5, 2, 0.05],
  paletteWeight: ['Palette weight', 'colour', 0, 1, 0.01],
  hdrGain: ['HDR gain', 'colour', 1, 8, 0.1],
  bloom: ['Bloom', 'grade', 0, 2, 0.05],
  bloomThreshold: ['Bloom threshold', 'grade', 0, 1, 0.01],
  bloomRadius: ['Bloom radius', 'grade', 0.5, 2, 0.05],
  exposure: ['Exposure', 'grade', 0.2, 3, 0.05],
  contrast: ['Contrast', 'grade', 0.5, 1.8, 0.05],
  lift: ['Black lift', 'grade', -0.2, 0.2, 0.01],
  vignette: ['Vignette', 'grade', 0, 1, 0.01],
  grain: ['Grain', 'grade', 0, 0.3, 0.01],
  dither: ['Dither', 'grade', 0, 1, 1],
  acsTonemap: ['ACES tonemap', 'grade', 0, 1, 1],
  streakOpacity: ['Streak', 'effects', 0, 0.5, 0.01],
  flareIntensity: ['Flare', 'effects', 0, 1, 0.01],
  flareLength: ['Flare length', 'effects', 0.2, 3, 0.1],
  flareRotation: ['Flare rotation', 'effects', 0, 45, 1],
  flashDensity: ['Flash density', 'effects', 0, 0.6, 0.01],
  waveFrequency: ['Wave frequency', 'effects', 0.5, 10, 0.1],
  persistence: ['Persistence', 'effects', 0, 0.95, 0.01],
  transitionSpeed: ['Transition speed', 'effects', 0.1, 4, 0.05],
};

/* Group ids are the shell form's own vocabulary (see public/src/settings-form.js): rows are
 * ordered look → behaviour → timing → advanced, so "grid" and "colour" live under Look and
 * the rest under Behaviour. */
const GROUP_LABEL = {
  look: 'Look',
  grid: 'Grid',
  colour: 'Colour',
  grade: 'Grade & bloom',
  effects: 'Effects',
  scenes: 'Scenes',
};
const PATTERNS = ['random', 'wave', 'bottomCenter', 'sweep', 'bars', 'ripple', 'plasma', 'chase',
  'sweepMirror', 'comet', 'matrix', 'spectrum', 'orbits', 'rain', 'equalizer', 'static', 'heartbeat'];
const PALETTE_NAMES = Object.keys(PALETTES);
// A preset saved by hand carries a `+` next to its name, so an operator-made look reads apart
// from the shipped ones in a list that is otherwise just names. The value is always the raw name.
const SAVED_PRESET_PREFIX = '+ ';
// Mirrors server.js / commands.mjs: a name outside this is a refused command, so the inline save
// field answers it here instead of sending a request that can only fail.
const PRESET_NAME_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;

/** Turn core's describe() map into the shape the shell's settings form renders. */
function lookRows(meta) {
  const out = {};
  for (const [key, def] of Object.entries(meta || {})) {
    if (HANDLED.has(key)) continue;
    const known = LOOK_META[key];
    const row = {
      ...def,
      // the name only: the group is the form's own heading, so repeating it in the label
      // ("Hue shift · Look") would just say it twice
      label: def.label && def.label !== key ? def.label : known ? known[0] : key,
      // every row lands in one group the pane retitles to "Look"
      group: 'look',
    };
    if (known && row.min === undefined) row.min = known[2];
    if (known && row.max === undefined) row.max = known[3];
    if (known && row.step === undefined) row.step = known[4];
    if (key === 'palette') row.values = PALETTE_NAMES;
    if (key === 'pattern') row.values = PATTERNS;
    out[key] = row;
  }
  return out;
}

export async function render(container, ctx) {
  const { api, signal } = ctx;
  const unsubs = [];
  const timers = [];

  /* One look for every view of the wall.
   *
   * This pane used to keep its `look` to itself, so a palette the merged column set was invisible
   * here and vice versa. `ctx.sharedLook` is the shell's store (merged-preview.js): this pane
   * PUBLISHES every look it reads from the server into it, and PAINTS from it when it changes —
   * two directions through one object, no second copy. `synth` still holds the page's own answer
   * for a command, because a page command is not in the settings document.
   *
   * `shared` is null when the shell has no store (a pane mounted by a test harness): every call
   * below degrades to the old behaviour, which is why this is a small change and not a rewrite.
   */
  const shared = ctx.sharedLook || null;

  let live = null; // last /live body
  let renderDoc = null; // last /render settings doc
  let online = { landscape: false, portrait: false };
  let history = [];
  let seq = 0;

  let fencePx = null; // committed fence px, or null = whole wall
  let frameEl = null; // the preview frame node, for drawing the module's own layer at its size
  let textOn = true; // the server's text-layer visibility, mirrored so the toggle can flip it
  let fenceCells = null; // server's cells for that rect (or derived)
  let pitch = null; // {x,y}
  let cols = 112;
  let rows = 63;

  /* ------------------------------------------------------------ structure */

  const header = el('div', { class: 'pane-head' });
  const headStatus = el('div', { class: 'pane-head-status' });
  header.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: 'LED wall control' }),
      el('p', { class: 'pane-desc', text: 'Drag the 9:16 window on the preview, or pick a look. Everything here is the live document the OBS page follows.' }),
    ),
    headStatus,
  );

  /* --- quick controls: the three dropdowns / blackout / ratio ---------------- */

const blackoutBadge = el('span', { class: 'badge', 'data-tone': 'idle', text: 'live' });
  const ratioWrap = el('div', { class: 'wall-ratio' });
  const ratioSeg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Wall ratio' });
  const seg169 = el('button', { type: 'button', class: 'seg mono', text: '16:9', dataset: { value: '16:9' } });
  const seg916 = el('button', { type: 'button', class: 'seg mono', text: '9:16', dataset: { value: '9:16' } });
  seg169.setAttribute('aria-checked', 'false');
  seg916.setAttribute('aria-checked', 'false');
  seg169.title = 'Whole wall';
  seg916.title = '9:16 window inside the wall';
  seg169.addEventListener('click', () => chooseRatio('16:9'));
  seg916.addEventListener('click', () => chooseRatio('9:16'));
  // the pair is one radio group; arrow keys move the choice like the arrow buttons around it
  ratioSeg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    chooseRatio(e.key === 'ArrowLeft' ? '16:9' : '9:16');
  });
  ratioSeg.append(seg169, seg916);
  const forceWrap = el('div', { class: 'wall-force', hidden: true });
  const forceNote = el('span', { class: 'wall-force-note mono' });
  const forceBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Force 16:9 now' });
  forceBtn.addEventListener('click', () => cmd('ratio.force16x9'));
  forceWrap.append(forceNote, forceBtn);
  ratioWrap.append(ratioSeg, forceWrap);

  /* --- the three look selectors ------------------------------------------------------ */

  // One dropdown per dimension, because that is what the three commands change: `preset.set`
  // takes the whole look, `look.palette` only the ramp, `look.pattern` only the animation. An
  // arrow pair said "there is a list, press until you find it"; a dropdown names the list.
  // A select keeps its own value while the list is open, so the "" option (with its name) is a
  // real state: the look names something the bank does not hold, and the dropdown says so
  // instead of silently pointing at the first entry.
  const presetSelect = el('select', { class: 'input wall-select', id: 'wall-look-preset', 'aria-label': 'Wall preset', title: 'Whole-wall preset' });
  const paletteSelect = el('select', { class: 'input wall-select', id: 'wall-look-palette', 'aria-label': 'Wall palette', title: 'Palette (ramp only)' });
  const patternSelect = el('select', { class: 'input wall-select', id: 'wall-look-pattern', 'aria-label': 'Wall pattern', title: 'Pattern (animation only)' });

  const noneOption = (text) => el('option', { value: '', text, disabled: true });

  function fillSelect(sel, names, { unknown = 'not in the bank' } = {}) {
    const keep = sel.value;
    clear(sel);
    sel.appendChild(noneOption(unknown));
    for (const n of names) sel.appendChild(el('option', { value: n, text: n }));
    sel.value = keep;
    sel.dataset.count = String(names.length);
  }

  function fillPatterns(extra = null) {
    // A pattern the bank does not list (an engine that grew one, a saved look from a newer
    // build) still gets a row: the dropdown must be able to show what the wall is running.
    const names = PATTERNS.slice();
    if (extra && !names.includes(extra)) names.push(extra);
    fillSelect(patternSelect, names, { unknown: 'no pattern' });
  }

  function fillPalettes(extra = null) {
    const names = PALETTE_NAMES.slice();
    if (extra && !names.includes(extra)) names.push(extra);
    fillSelect(paletteSelect, names, { unknown: 'engine default' });
  }

  function fillPresets(order, saved = {}) {
    const names = Array.isArray(order) ? order.filter((n) => typeof n === 'string' && n) : [];
    clear(presetSelect);
    presetSelect.appendChild(noneOption('— preset —'));
    for (const n of names) {
      // the value is the name the server takes; the marker is only what the operator reads
      const label = saved && Object.prototype.hasOwnProperty.call(saved, n) ? SAVED_PRESET_PREFIX + n : n;
      presetSelect.appendChild(el('option', { value: n, text: label }));
    }
    presetSelect.dataset.count = String(names.length);
  }

  fillPresets([]);
  fillPalettes();
  fillPatterns();

  presetSelect.addEventListener('change', () => {
    const name = presetSelect.value;
    if (!name) return;
    cmd('preset.set', { name }).then((out) => {
      if (out && out.ok !== false) synth = { ...synth, preset: name };
      paintQuick();
      scheduleRefreshLook();
    });
  });
  paletteSelect.addEventListener('change', () => {
    const name = paletteSelect.value;
    if (!name) return;
    // optimism is honest here: the command can only fail on transport or an unknown name, and
    // both answers land within a beat and repaint the dropdown from the server
    setLookField('palette', name);
    paintQuick();
    cmd('look.palette', { name }).then((out) => onLookCmdAnswer(out, 'palette', name));
  });
  patternSelect.addEventListener('change', () => {
    const name = patternSelect.value;
    if (!name) return;
    setLookField('pattern', name);
    paintQuick();
    cmd('look.pattern', { name }).then((out) => onLookCmdAnswer(out, 'pattern', name));
  });

  /* --- save look: an inline name field, never a native prompt ------------------------ */

  // The OBS browser source has no dialog surface and the headless test has no way to answer
  // one, so the name is typed in the bar itself. Enter and the Save button are the same action.
  const saveBtn = el('button', { type: 'button', class: 'btn btn-sm wall-save-btn', text: 'Save look…', title: 'Save the look on the wall right now as a preset' });
  const saveNameInput = el('input', { type: 'text', class: 'input wall-save-input', id: 'wall-look-save-name', maxlength: '64', placeholder: 'preset name', 'aria-label': 'Name for the saved look', autocomplete: 'off', spellcheck: 'false' });
  const saveOkBtn = el('button', { type: 'button', class: 'btn btn-sm wall-save-ok', text: 'Save' });
  const saveCancelBtn = el('button', { type: 'button', class: 'btn btn-sm btn-icon wall-save-cancel', text: '×', 'aria-label': 'Cancel saving a look', title: 'Cancel' });
  const saveNote = el('span', { class: 'wall-save-note mono', role: 'status', 'aria-live': 'polite' });
  const saveForm = el('div', { class: 'wall-save', hidden: true }, saveNameInput, saveOkBtn, saveCancelBtn, saveNote);
  let saveNoteTimer = null;
  timers.push(() => clearTimeout(saveNoteTimer));

  function setSaveNote(text, tone = 'info', hold = 0) {
    clearTimeout(saveNoteTimer);
    saveNote.textContent = text || '';
    saveNote.dataset.tone = tone;
    // a confirmation fades on its own; a refusal stays until the operator edits the name
    if (hold > 0) saveNoteTimer = setTimeout(() => setSaveNote(''), hold);
  }

  function openSave() {
    saveForm.hidden = false;
    saveBtn.hidden = true;
    saveNameInput.value = '';
    saveNameInput.removeAttribute('data-bad');
    setSaveNote('');
    saveNameInput.focus();
  }

  function closeSave() {
    saveForm.hidden = true;
    saveBtn.hidden = false;
    setSaveNote('');
    saveNameInput.value = '';
    saveNameInput.removeAttribute('data-bad');
  }

  saveBtn.addEventListener('click', openSave);
  saveCancelBtn.addEventListener('click', closeSave);
  saveNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSave();
      saveBtn.focus();
    }
  });
  saveNameInput.addEventListener('input', () => {
    saveNameInput.removeAttribute('data-bad');
    if (saveNote.dataset.tone === 'bad') setSaveNote('');
  });
  saveOkBtn.addEventListener('click', () => { void submitSave(); });

  let saving = false;
  async function submitSave() {
    if (saving || signal.aborted) return;
    const name = saveNameInput.value.trim();
    // Refuse here, with the reason in the bar: a request for a name the server cannot take is a
    // round trip that teaches the operator nothing the regex does not already say.
    if (!name) {
      saveNameInput.setAttribute('data-bad', 'true');
      setSaveNote('a name is required', 'bad');
      saveNameInput.focus();
      return;
    }
    if (!PRESET_NAME_RE.test(name)) {
      saveNameInput.setAttribute('data-bad', 'true');
      setSaveNote('letters, digits, space and . _ : - only (1–64)', 'bad');
      saveNameInput.focus();
      return;
    }
    saving = true;
    saveOkBtn.disabled = true;
    setSaveNote('saving…', 'info');
    try {
      const out = await cmd('preset.save', { name });
      if (!out || out.ok === false) {
        // cmd() already toasted the server's own words; put the field back on the running name
        paintQuick();
        scheduleRefreshLook();
        scheduleLookPull();
        return;
      }
      // A save makes the saved name the live preset, and the server says which name it took.
      synth = { ...synth, preset: cleanLookName(out.preset) || name };
      // the answer carries the whole bank, so the new name is in the list without a reload
      adoptPresets(out.presets);
      presetSelect.value = synth.preset;
      paintQuick();
      // the field closes, the confirmation stays on the bar for a beat, then the button returns
      saveForm.hidden = true;
      saveBtn.hidden = false;
      setSaveNote(`saved “${synth.preset}”`, 'ok', 2400);
      scheduleRefreshLook();
    } catch (err) {
      setSaveNote(`not saved: ${err.message}`, 'bad');
    } finally {
      saving = false;
      saveOkBtn.disabled = false;
    }
  }

  function adoptPresets(presets) {
    if (!presets || !Array.isArray(presets.order)) return;
    // a bank that has not changed is not refilled: replacing the options under an open dropdown
    // closes it, and every snapshot carries the bank
    const key = presets.order.join('\u0000') + '\u0001' + Object.keys(presets.saved || {}).join('\u0000');
    if (key === presetBankKey) return;
    presetBankKey = key;
    presetBank = presets;
    fillPresets(presets.order, presets.saved);
    paintQuick();
  }

  const blackoutBtn = el('button', { type: 'button', class: 'btn btn-sm wall-blackout', title: 'Kill switch: LEDs and background go black' });
  const blackoutLabel = el('span', { class: 'btn-label', text: 'Blackout' });
  blackoutBtn.append(blackoutLabel);
  blackoutBtn.addEventListener('click', () => cmd(blackout ? 'blackout.off' : 'blackout.on'));

  const quick = el('div', { class: 'look-bar wall-quick' },
    el('label', { class: 'wall-look-field', for: 'wall-look-preset' },
      el('span', { class: 'look-label', text: 'Preset' }),
      presetSelect,
    ),
    el('span', { class: 'look-sep' }),
    el('label', { class: 'wall-look-field', for: 'wall-look-palette' },
      el('span', { class: 'look-label', text: 'Palette' }),
      paletteSelect,
    ),
    el('span', { class: 'look-sep' }),
    el('label', { class: 'wall-look-field', for: 'wall-look-pattern' },
      el('span', { class: 'look-label', text: 'Pattern' }),
      patternSelect,
    ),
    // the save flow sits beside the Preset field it writes into
    saveBtn, saveForm,
    el('span', { class: 'look-sep' }),
    blackoutBtn, blackoutBadge,
    el('span', { class: 'control-spacer' }),
    ratioWrap,
  );

  /* --- preview ------------------------------------------------------------ */

  // One preview component for every module pane (public/src/preview.js). It owns the shape:
  // a 16:9 frame (the wall's real picture) with the 9:16 window inside it, sized from the
  // frame's width — so this pane can no longer grow a portrait column the height of the screen,
  // which is what the old `wall-surface` did by making the whole 9:16 bounds the drag plane.
  // The module keeps everything it knows and the component does not: the fence cells, the
  // committed rect, the pixel readout and which commands the window moves.
  const previewHost = el('div', { class: 'wall-preview-host' });
  let preview = null;
  let previewLayerPainted = false;

  // The layer drawn inside the 9:16 window: the wall's lattice and its tag. The dotted veil is
  // NOT here — the preview applies it itself, which is why an unmodified default fence rect can
  // still be lit (a full-size grid would otherwise read as "the wall is not dimmed at all").
  const layerEl = el('div', { class: 'wall-layer' });
  const surfaceTag = el('span', { class: 'wall-surface-tag mono' });
  layerEl.append(surfaceTag);

  const readout = el('div', { class: 'wall-readout' });
  const cellsOut = el('div', { class: 'wall-readout-row' },
    el('span', { class: 'wall-readout-k mono dim', text: 'cells' }),
    el('span', { class: 'wall-readout-v mono', text: '—' }));
  const pxOut = el('div', { class: 'wall-readout-row' },
    el('span', { class: 'wall-readout-k mono dim', text: 'px' }),
    el('span', { class: 'wall-readout-v mono', text: '—' }));
  const gutter = el('div', { class: 'wall-gutter mono' });
  // x ticks on the top edge: the drag is 2-D, so both axes need a frame of reference
  const axis = el('div', { class: 'wall-axis mono', 'aria-hidden': 'true' });
  readout.append(cellsOut, pxOut);

  // The component's window is the fence. It is appended into the component's stage after mount
  // so the shared drag handling and the wall's own grip cannot fight over the same element.
  //
  // The panel joins the body, so the whole pane lands in one append: a pane that appears in two
  // steps is a pane the shell's next paint can catch half-built.
  const previewPanel = el('section', { class: 'wall-preview' }, previewHost, axis, readout, gutter);

  /* --- fence controls ----------------------------------------------------- */

  const fenceToggle = el('input', { type: 'checkbox', id: 'wall-fence-on' });
  // A rect is the persisted fence and the only shape the settings schema stores. "Whole wall"
  // is `ratio: 16:9`: the preview draws no window and no dim there, and turning the window back
  // on also picks 9:16. The schema's `fence` is an object, so `null` is a refused PATCH.
  fenceToggle.addEventListener('change', () => {
    const want = fenceToggle.checked;
    const rect = fencePx ? snapToCells(fencePx) : snapToCells(centredFence());
    fenceToggle.disabled = true;
    patchSettings(want ? { fence: rect, ratio: '9:16' } : { ratio: '16:9' })
      .then((out) => {
        if (want && out) {
          fencePx = rect;
          paintPreview();
          paintFenceFields();
        }
      })
      .finally(() => {
        fenceToggle.disabled = false;
        paintFenceFields();
      });
  });
  const resetBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Centre', title: 'Centre the window at 1440×2560' });
  resetBtn.addEventListener('click', () => {
    const rect = snapToCells(centredFence());
    fencePx = rect;
    paintPreview();
    paintFenceFields();
    commitFence(rect);
  });

  const numFields = {};
  for (const k of ['x', 'y', 'w', 'h']) {
    const box = el('input', { type: 'number', class: 'input input-num', step: '1', id: `wall-fence-${k}` });
    box.addEventListener('change', () => {
      const n = Number(box.value);
      // an empty box is "leave it", not NaN; an out-of-wall number is clamped by the snap
      if (box.value.trim() === '' || !Number.isFinite(n)) {
        paintFenceFields();
        return;
      }
      const next = { ...(fencePx || centredFence()), [k]: round(n) };
      const snapped = snapToCells(next, k === 'w' || k === 'h' ? k : null);
      fencePx = snapped;
      paintPreview();
      autoZoom();
      commitFence(snapped);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        box.dispatchEvent(new Event('change'));
        box.blur();
      }
    });
    numFields[k] = box;
  }
  const dimRange = el('input', { type: 'range', id: 'wall-fence-dim', min: '0', max: '1', step: '0.01', 'aria-label': 'Dim outside the window' });
  const dimNum = el('input', { type: 'number', class: 'input input-num', id: 'wall-fence-dim-num', min: '0', max: '1', step: '0.01' });
  const dimWrap = el('div', { class: 'wall-slider' }, dimRange, dimNum);
  let dimTimer = null;
  dimRange.addEventListener('input', () => {
    dimNum.value = dimRange.value;
    applyDimLocal(Number(dimRange.value));
    clearTimeout(dimTimer);
    // live while sliding, one PATCH when the hand stops
    dimTimer = setTimeout(() => patchSettings({ fenceOutDim: Number(dimRange.value) }), 220);
  });
  dimRange.addEventListener('change', () => {
    clearTimeout(dimTimer);
    patchSettings({ fenceOutDim: Number(dimRange.value) });
  });
  dimNum.addEventListener('change', () => {
    const v = clamp(Number(dimNum.value) || 0, 0, 1);
    dimNum.value = v.toFixed(2);
    dimRange.value = String(v);
    patchSettings({ fenceOutDim: v });
  });
  timers.push(() => clearTimeout(dimTimer));

  const resetGrip = el('div', { class: 'fence-grip', 'aria-hidden': 'true' });
  resetGrip.classList.add('wall-reset-mark');

  const fenceStateOut = el('span', { class: 'wall-fence-state mono', text: 'whole wall' });
  const fencePanel = el('section', { class: 'panel wall-fence-panel' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: '9:16 window' }),
      fenceStateOut,
      el('span', { class: 'panel-hint' },
        // a switch needs a name a person can read: the state is the name
        el('label', { class: 'switch wall-switch', for: 'wall-fence-on', title: 'Off = the wall is whole (no window)' },
          fenceToggle, el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
          el('span', { class: 'wall-switch-label mono', text: 'window' })),
      ),
    ),
    el('div', { class: 'wall-fence-body' },
      el('div', { class: 'wall-fence-grid' },
      el('div', { class: 'wall-fields' },
        el('label', { class: 'wall-field', for: 'wall-fence-x' }, el('span', { class: 'mono dim', text: 'x' }), numFields.x),
        el('label', { class: 'wall-field', for: 'wall-fence-y' }, el('span', { class: 'mono dim', text: 'y' }), numFields.y),
        el('label', { class: 'wall-field', for: 'wall-fence-w' }, el('span', { class: 'mono dim', text: 'w' }), numFields.w),
        el('label', { class: 'wall-field', for: 'wall-fence-h' }, el('span', { class: 'mono dim', text: 'h' }), numFields.h),
        el('span', { class: 'wall-field-unit mono dim', text: 'px' }),
      ),
      el('div', { class: 'wall-fields-note mono dim', text: 'width follows height × 9/16, snapped to the grid' }),
      el('div', { class: 'wall-row wall-row-dim', hidden: true },
        el('label', { class: 'wall-dim-label', for: 'wall-fence-dim' }, el('span', { text: 'Dim outside' })),
        dimWrap,
      ),
      el('div', { class: 'wall-fence-foot' }, resetBtn),
      ),
      el('p', { class: 'wall-hint dim', text: 'Taller window = bigger portrait. The drag keeps 9:16; the server pins the width to the height.' }),
    ),
  );

  /* --- text quick send ---------------------------------------------------- */

  // The message pool is reached through the quick-send box at the top of the page: one picker,
  // searchable and tag-filterable, replacing the old <select> + Send row that duplicated it here.
  // What stays local is the text layer's own controls (show/hide, clear, reveal).
  let wallMsgs = [];
  async function loadWallPool() {
    const r = await api.get('/api/pool/wall');
    wallMsgs = (r && r.messages) || [];
    await quickBox.refresh().catch(() => {});
  }
  loadWallPool().catch((err) => toast(`wall pool: ${err.message}`, 'error'));

  const textToggle = el('button', { type: 'button', class: 'btn btn-sm', title: 'Show or hide the wall’s text layer' });
  const textToggleLabel = el('span', { class: 'btn-label', text: 'Text layer' });
  textToggle.append(textToggleLabel);
  textToggle.addEventListener('click', async () => {
    textToggle.disabled = true;
    try {
      await api.post('/api/wall/cmd', { cmd: 'text.enabled', args: { on: !textOn } });
      textOn = !textOn;
      paintTextToggle();
    } catch (err) {
      toast(`text layer: ${err.message}`, 'error');
    } finally {
      textToggle.disabled = false;
    }
  });
  const textClearBtn = actionButton({ label: 'Clear', variant: '', run: () => api.post('/api/wall/cmd', { cmd: 'text.clear' }), onError: (e) => toast(`clear: ${e.message}`, 'error') });
  const textRevealBtn = actionButton({ label: 'Reveal', variant: '', run: () => api.post('/api/wall/cmd', { cmd: 'text.reveal' }), onError: (e) => toast(`reveal: ${e.message}`, 'error') });

  const textPanel = el('section', { class: 'panel wall-text-panel' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Text' }),
      el('span', { class: 'panel-hint mono dim' }, 'sends to landscape + portrait'),
    ),
    el('div', { class: 'wall-text-body' },
      // the message itself comes from the quick-send box above; this row only drives the layer
      textToggle, textClearBtn, textRevealBtn,
    ),
  );
  function paintTextToggle() {
    // the server owns text visibility; adopt it whenever a document arrives, and leaving the
    // toggle alone while the operator is mid-click keeps the optimistic flip from fighting it
    const s = lookValue('text');
    if (s && typeof s === 'object' && typeof s.enabled === 'boolean') textOn = s.enabled;
    if (typeof s === 'boolean') textOn = s;
    textToggle.setAttribute('aria-pressed', String(textOn));
    textToggle.dataset.on = String(textOn);
  }

  /* --- status strip ------------------------------------------------------- */

  // One served 16:9 page draws both ratios, so there is one page to be online (2026-10-29).
  const onlineLand = statusItem('render');
  const sceneOut = el('span', { class: 'mono', text: '—' });
  const forcingOut = el('span', { class: 'mono dim', text: '' });
  const seqOut = el('span', { class: 'mono dim', text: '' });
  const streamOut = el('span', { class: 'mono wall-stream', text: 'sse · connecting', title: 'live event stream from the wall bus' });
  const logList = el('ol', { class: 'wall-log' });

  const strip = el('div', { class: 'wall-status' },
    el('div', { class: 'wall-status-row' },
      el('span', { class: 'look-label', text: 'Page' }),
      onlineLand,
    ),
    el('div', { class: 'wall-status-row' },
      el('span', { class: 'look-label', text: 'Scene' }),
      sceneOut, forcingOut,
    ),
    el('div', { class: 'wall-status-row' },
      el('span', { class: 'look-label', text: 'Bus' }),
      seqOut, streamOut,
    ),
  );

  const logPanel = el('section', { class: 'panel wall-log-panel' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Last commands' }),
      el('span', { class: 'panel-hint mono dim', text: 'live' }),
    ),
    logList,
  );

  function statusItem(label) {
    return el('span', { class: 'wall-online', dataset: { view: label } }, dot('idle'), el('span', { text: label }));
  }
  function paintOnline() {
    for (const [node, up] of [[onlineLand, online.landscape]]) {
      node.dataset.on = String(up);
      node.replaceChildren(dot(up ? 'ok' : 'idle', up ? 'reporting' : 'no heartbeat'), el('span', { text: node.dataset.view }));
      node.append(el('span', { class: 'wall-online-state mono', text: up ? 'live' : 'offline' }));
    }
  }


  /* --- image -------------------------------------------------------------- */

  /**
   * The picture on the wall, as six controls: which file, where it sits, how big, how turned,
   * how it is coloured, how deep.
   *
   * Every value comes from the server's settings document (`lookValue`) and every change goes
   * back through `PATCH /api/wall/settings` with the schema's own key names, so a deck key, a
   * preset or another client all reach these controls through the same snapshot repaint the
   * rest of the pane already uses. Nothing here keeps local state that the document does not.
   *
   * The surface is a schematic of the wall, not the live preview: the picture's rectangle is
   * positioned by `imageX`/`imageY`/`imageScale`/`imageRotate` against a box whose aspect is the
   * picture's own, so a drag maps one-to-one onto the same numbers the engine lights.
   */
  const IMG_CAP = 8 * 1024 * 1024; // matches the server's MAX_BYTES; the route refuses above it
  const IMG_ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16 };

  const imgStage = el('div', {
    class: 'wall-img-stage',
    id: 'wall-img-stage',
    role: 'application',
    'aria-label': 'Picture position on the wall',
    tabindex: '0',
  });
  const imgBox = el('div', { class: 'wall-img-box' }, el('div', { class: 'wall-img-thumb' }));
  const imgHandle = el('div', {
    class: 'wall-img-handle',
    id: 'wall-img-handle',
    role: 'button',
    tabindex: '0',
    title: 'drag: resize  ·  shift-drag: rotate',
  });
  // the grips hang a few pixels outside the picture so they can be grabbed; the stage keeps them
  // in view instead of clipping them flush with the rectangle's edge
  imgBox.append(imgHandle);
  imgStage.append(imgBox);

  const imgFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'wall-img-file', id: 'wall-img-file' });
  const imgPick = el('button', { type: 'button', class: 'btn btn-sm', id: 'wall-img-pick' }, 'Choose picture');
  const imgRemove = el('button', { type: 'button', class: 'btn btn-sm', id: 'wall-img-remove', title: 'takes the picture off the wall; the upload is kept' }, 'Remove');
  const imgStatus = el('span', { class: 'wall-img-status mono dim', id: 'wall-img-status', text: 'no picture' });

  const imgColour = el('select', { class: 'wall-field wall-img-select', id: 'wall-img-colour', 'aria-label': 'Picture colours' },
    el('option', { value: 'raw', text: 'Image colours' }),
    el('option', { value: 'match', text: 'Match the palette' }),
    el('option', { value: 'palette', text: 'Palette only (luminance)' }));
  const imgBits = el('select', { class: 'wall-field wall-img-select', id: 'wall-img-bits', 'aria-label': 'Colour depth' },
    el('option', { value: '8', text: '8-bit' }),
    el('option', { value: '10', text: '10-bit' }),
    el('option', { value: '12', text: '12-bit' }));
  const imgDither = el('input', { type: 'checkbox', id: 'wall-img-dither', class: 'wall-switch' });
  const imgDitherRow = el('label', { class: 'wall-field-row', for: 'wall-img-dither' },
    imgDither, el('span', { text: 'Dither' }));
  // A slider, not only the corner handle: on a 9:16 schematic 180px wide the picture already fills
  // the stage, so a corner drag has almost no travel left and reads as broken. The slider is the
  // honest control for "how big", and the handle stays for the corner drag it looks like.
  const imgScale = el('input', {
    type: 'range', class: 'wall-img-range', id: 'wall-img-scale',
    min: '0.05', max: '2', step: '0.01', value: '0.6', 'aria-label': 'Picture size',
  });
  const imgScaleOut = el('span', { class: 'mono dim', id: 'wall-img-scale-out', text: '0.60' });
  const imgRotOut = el('span', { class: 'mono dim', id: 'wall-img-rot-out', text: '0°' });

  const imgPanel = el('section', { class: 'panel wall-img', id: 'wall-image' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Image' }),
      imgStatus),
    imgStage,
    el('div', { class: 'wall-img-tools' }, imgPick, imgRemove, imgFile),
    el('div', { class: 'wall-img-grid' },
      el('label', { class: 'wall-field-row', for: 'wall-img-colour' }, el('span', { text: 'Colours' }), imgColour),
      el('label', { class: 'wall-field-row', for: 'wall-img-bits' }, el('span', { text: 'Depth' }), imgBits),
      imgDitherRow,
      el('label', { class: 'wall-field-row wall-img-size', for: 'wall-img-scale' },
        el('span', { text: 'Size' }), imgScale, imgScaleOut),
      el('div', { class: 'wall-field-row' }, el('span', { text: 'Turn' }), imgRotOut),
    ),
  );

  /** Read one picture value out of the live settings document, with the schema's default. */
  function imgVal(key, fallback) {
    const v = lookValue(key);
    return v === undefined || v === null || v === '' ? fallback : v;
  }

  /** Where the picture sits, in the numbers the shader is given. */
  function imageState() {
    const aspect = IMG_ASPECTS[String(lookValue('ratio') ?? '16:9')] || IMG_ASPECTS['16:9'];
    return {
      on: Number(imgVal('imageOn', 0)) >= 0.5,
      x: clamp(Number(imgVal('imageX', 0.5)), 0, 1),
      y: clamp(Number(imgVal('imageY', 0.5)), 0, 1),
      scale: clamp(Number(imgVal('imageScale', 0.6)), 0.05, 4),
      rot: Number(imgVal('imageRotate', 0)) || 0,
      colour: String(imgVal('imageColour', 'raw')),
      bits: String(imgVal('imageBits', '8')),
      dither: Number(imgVal('imageDither', 1)) >= 0.5,
      cap: Number(imgVal('imageRev', 0)) > 0,
      aspect,
    };
  }

  /** The picture's own w/h, from the server's record of the accepted upload. */
  function imageMeta() {
    const doc = (renderDoc && renderDoc.settings) || ctx.settings || null;
    return (doc && doc.image) || null;
  }

  /**
   * Paint the controls from the settings document.
   *
   * Assigns `.value` / `.checked` and never dispatches `change`, so adopting a snapshot cannot
   * echo a command back at the server — the same rule the quick-bar dropdowns follow.
   */
  function paintImage() {
    const st = imageState();
    const meta = imageMeta();

    imgColour.value = st.colour;
    imgBits.value = st.bits;
    imgDither.checked = st.dither;
    // The picture is quantised to `imageBits` inside the image path, before it becomes a cell
    // colour. Which depths get steps worth filling is the engine's answer, not a guess here:
    // 8 bit is 256 levels - finer than the uploaded picture - so dithering it only adds noise,
    // while 10 and 12 bit band visibly and the 4x4 Bayer pattern is what recovers the in-between
    // colours. Hence: enabled only from 10-bit up, and only once a picture is stored.
    const ditherWorks = st.cap && st.bits !== '8';
    imgDither.disabled = !ditherWorks;
    imgDitherRow.title = ditherWorks
      ? `4×4 Bayer pattern: fills the steps between the ${st.bits}-bit levels`
      : (st.cap ? 'not needed at 8-bit — the picture already has that many levels' : 'needs a stored picture');
    imgDitherRow.dataset.inert = String(!ditherWorks);

    imgRemove.disabled = !st.on;
    // Never dispatch `change` here: adopting a snapshot must not echo a command back.
    imgScale.value = st.scale.toFixed(2);
    imgScaleOut.textContent = st.scale.toFixed(2);
    imgRotOut.textContent = `${Math.round(st.rot)}°`;
    imgStatus.textContent = st.on
      ? (meta ? `${meta.w || '?'}×${meta.h || '?'} · ${st.colour} · ${st.bits}-bit` : 'picture on')
      : (st.cap ? 'picture stored, off' : 'no picture');

    imgStage.dataset.ratio = String(lookValue('ratio') ?? '16:9');
    imgStage.dataset.on = String(st.on && st.cap);
    imgBox.classList.toggle('is-on', st.on && st.cap);

    // The rectangle: `imageScale` is a fraction of the wall's width, exactly what the engine's
    // `u_imgXf.z` means; the picture's height follows its own aspect.
    const stageW = imgStage.clientWidth || 0;
    const stageH = imgStage.clientHeight || 0;
    if (!stageW || !stageH) return;
    const w = Math.max(8, st.scale * stageW);
    const picAspect = meta && meta.w && meta.h ? meta.h / meta.w : 1;
    const h = Math.max(8, w * picAspect);
    const box = imgBox.style;
    box.width = `${w.toFixed(1)}px`;
    box.height = `${h.toFixed(1)}px`;
    box.left = `${(st.x * stageW - w / 2).toFixed(1)}px`;
    box.top = `${(st.y * stageH - h / 2).toFixed(1)}px`;
    box.transform = `rotate(${st.rot}deg)`;
    imgBox.dataset.x = st.x.toFixed(3);
    imgBox.dataset.y = st.y.toFixed(3);
    imgBox.dataset.scale = st.scale.toFixed(2);
    imgBox.dataset.rot = String(Math.round(st.rot));
    const thumb = imgBox.firstElementChild;
    if (thumb) {
      thumb.style.backgroundImage = st.cap && st.on
        ? `url("/api/wall/image?rev=${Number(imgVal('imageRev', 0))}")`
        : '';
    }
  }

  /* --- the surface: drag to move, drag the handle to resize, shift-drag to turn --- */

  // One gesture, one patch: moves repaint the box locally for feedback and post on release, so a
  // slow server cannot fill the bus with a hundred intermediate positions.
  let imgGesture = null;

  function imgStageRect() {
    const r = imgStage.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1, left: r.left, top: r.top };
  }

  function beginImageGesture(kind, ev) {
    const st = imageState();
    if (!st.cap) return;
    const box = imgStageRect();
    imgGesture = {
      kind,
      box,
      ox: ev.clientX,
      oy: ev.clientY,
      start: st,
      pointerId: ev.pointerId,
      moved: false,
    };
    ev.preventDefault();
    imgStage.classList.add('is-dragging');
    try { imgStage.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
  }

  function moveImageGesture(ev) {
    const g = imgGesture;
    if (!g) return;
    const dx = (ev.clientX - g.ox) / g.box.w;
    const dy = (ev.clientY - g.oy) / g.box.h;
    if (Math.abs(ev.clientX - g.ox) > 2 || Math.abs(ev.clientY - g.oy) > 2) g.moved = true;
    if (g.kind === 'move') {
      const x = clamp(g.start.x + dx, 0, 1);
      const y = clamp(g.start.y + dy, 0, 1);
      imgBox.style.left = `${(x * g.box.w - imgBox.offsetWidth / 2).toFixed(1)}px`;
      imgBox.style.top = `${(y * g.box.h - imgBox.offsetHeight / 2).toFixed(1)}px`;
    } else if (g.kind === 'rotate') {
      const cx = g.box.left + g.start.x * g.box.w;
      const cy = g.box.top + g.start.y * g.box.h;
      const a0 = Math.atan2(g.oy - cy, g.ox - cx);
      const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      const deg = wrapDeg(g.start.rot + ((a1 - a0) * 180) / Math.PI);
      imgBox.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    } else {
      // The picture's scale is its width as a fraction of the stage, and the handle IS the far
      // corner: its distance from the centre is half the width, so doubling that distance doubles
      // the picture. Measuring from the centre is symmetric — either corner grows it.
      const halfW = Math.max(4, g.start.scale * g.box.w) / 2;
      const cx = g.box.left + g.start.x * g.box.w;
      const cy = g.box.top + g.start.y * g.box.h;
      const reach = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const a0 = Math.hypot(g.ox - cx, g.oy - cy) || halfW;
      const next = clamp((reach / a0) * g.start.scale, 0.05, 4);
      const w = Math.max(8, next * g.box.w);
      const aspect = imgBox.offsetWidth ? imgBox.offsetHeight / imgBox.offsetWidth : 1;
      imgBox.style.width = `${w.toFixed(1)}px`;
      imgBox.style.height = `${Math.max(8, w * aspect).toFixed(1)}px`;
    }
    ev.preventDefault();
  }

  async function endImageGesture(ev) {
    const g = imgGesture;
    if (!g) return;
    imgGesture = null;
    imgStage.classList.remove('is-dragging');
    try { imgStage.releasePointerCapture(g.pointerId); } catch { /* already released */ }
    if (!g.moved) return; // a click on the surface is not a move
    const patch = {};
    if (g.kind === 'move') {
      const dx = (ev.clientX - g.ox) / g.box.w;
      const dy = (ev.clientY - g.oy) / g.box.h;
      patch.imageX = round3(clamp(g.start.x + dx, 0, 1));
      patch.imageY = round3(clamp(g.start.y + dy, 0, 1));
    } else if (g.kind === 'rotate') {
      const m = /rotate\((-?[\d.]+)deg\)/.exec(imgBox.style.transform || '');
      patch.imageRotate = Math.round(clamp(Number(m && m[1]) || 0, -180, 180));
    } else {
      patch.imageScale = Math.round(clamp(imgBox.offsetWidth / g.box.w, 0.05, 4) * 100) / 100;
    }
    const out = await patchSettings(patch);
    // Always repaint from the document after a gesture: a refused patch must not leave the box
    // where the pointer left it, and an accepted one must show the rounded values it now holds.
    paintImage();
    return out;
  }

  // The gesture follows the pointer on the window, not on the stage: dragging off the edge of a
  // 160px schematic is normal, and a capture that is refused (or lost) must not freeze the
  // rectangle half-way. Press and move stay on the stage, which is what maps to the wall.
  imgStage.addEventListener('pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (!imageState().cap) return;
    const onHandle = ev.target === imgHandle || (ev.target.closest && ev.target.closest('.wall-img-handle'));
    beginImageGesture(onHandle ? (ev.shiftKey ? 'rotate' : 'size') : 'move', ev);
  });
  imgStage.addEventListener('pointermove', (ev) => {
    if (imgGesture) moveImageGesture(ev);
  });
  window.addEventListener('pointermove', (ev) => {
    if (imgGesture) moveImageGesture(ev);
  });
  window.addEventListener('pointerup', (ev) => { void endImageGesture(ev); });
  window.addEventListener('pointercancel', (ev) => { void endImageGesture(ev); });
  // keys, for an operator driving the pane without a pointer
  imgHandle.addEventListener('keydown', (ev) => {
    const st = imageState();
    if (!st.cap) return;
    let patch = null;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      patch = { imageScale: Math.round(clamp(st.scale + (ev.key === 'ArrowRight' ? 0.05 : -0.05), 0.05, 4) * 100) / 100 };
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === '[' || ev.key === ']') {
      const step = ev.key === 'ArrowUp' || ev.key === ']' ? 5 : -5;
      patch = { imageRotate: Math.round(clamp(st.rot + step, -180, 180)) };
    }
    if (patch) {
      ev.preventDefault();
      void patchSettings(patch, { optimistic: () => paintImage() });
    }
  });

  /* --- the six controls --------------------------------------------------- */

  imgPick.addEventListener('click', () => imgFile.click());
  imgFile.addEventListener('change', () => {
    const f = imgFile.files && imgFile.files[0];
    imgFile.value = '';
    if (f) void sendImageFile(f);
  });
  imgStage.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    imgStage.classList.add('is-over');
  });
  imgStage.addEventListener('dragleave', () => imgStage.classList.remove('is-over'));
  imgStage.addEventListener('drop', (ev) => {
    ev.preventDefault();
    imgStage.classList.remove('is-over');
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) void sendImageFile(f);
  });

  imgColour.addEventListener('change', () => {
    void patchSettings({ imageColour: imgColour.value }, { optimistic: () => paintImage() });
  });
  imgBits.addEventListener('change', () => {
    // changing depth can make the dither meaningful or inert; the paint below follows the answer
    void patchSettings({ imageBits: imgBits.value }, { optimistic: () => paintImage() });
  });
  // `input` only moves the number beside the slider (the wall would get a patch per pixel of
  // travel otherwise); `change` — pointer released, or a key press on a focused slider — is the
  // one patch, exactly like the stage's own drag.
  imgScale.addEventListener('input', () => { imgScaleOut.textContent = Number(imgScale.value).toFixed(2); });
  imgScale.addEventListener('change', () => {
    const v = Math.round(clamp(Number(imgScale.value) || 0.6, 0.05, 4) * 100) / 100;
    void patchSettings({ imageScale: v }, { optimistic: () => paintImage() });
  });
  imgDither.addEventListener('change', () => {
    void patchSettings({ imageDither: imgDither.checked ? 1 : 0 }, { optimistic: () => paintImage() });
  });
  imgRemove.addEventListener('click', () => {
    // off, not gone: the upload stays on disk so the same picture can be brought back
    void patchSettings({ imageOn: 0 }, { optimistic: () => paintImage() });
  });

  /**
   * Upload one file through the server's raw route, then adopt the revision it answers.
   *
   * `POST /api/wall/image` reads the bytes raw (core hands the Buffer through untouched), stores
   * the picture and answers with the record plus the event that switched the layer on.
   */
  async function sendImageFile(file) {
    if (!/^image\//.test(file.type || '')) {
      toast(`picture: ${file.name || 'that file'} is not an image`, 'error');
      return;
    }
    if (file.size > IMG_CAP) {
      toast(`picture is ${(file.size / 1048576).toFixed(1)} MB — the limit is 8 MB`, 'error');
      return;
    }
    imgStatus.textContent = 'uploading…';
    try {
      const r = await fetch('/api/wall/image', {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      const out = await r.json().catch(() => null);
      if (!r.ok || !out || !out.ok) throw new Error((out && out.error) || `upload failed (${r.status})`);
      await pull();
      paintImage();
      toast(`picture up · ${out.image.w}×${out.image.h}`, 'ok');
    } catch (err) {
      paintImage();
      toast(`picture: ${err.message}`, 'error');
    }
  }

  /** Degrees folded into −180..180, so a full turn reads as 0 rather than 360. */
  function wrapDeg(d) {
    let v = d % 360;
    if (v > 180) v -= 360;
    if (v < -180) v += 360;
    return Math.round(v * 10) / 10;
  }

  /** Three decimals: enough to place a picture, short enough to read in the document. */
  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  /* --- settings slot ------------------------------------------------------ */

  const settingsSlot = el('div', { class: 'pane-settings wall-settings' });

  const body = el('div', { class: 'wall-body' },
    el('div', { class: 'wall-main' },
      previewPanel,
      imgPanel,
      textPanel,
      el('div', { class: 'wall-split' }, fencePanel),
      settingsSlot,
    ),
    el('aside', { class: 'wall-side' },
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Live state' })),
        strip,
      ),
      logPanel,
    ),
  );

  clear(container);
  const quickSlot = el('div', { class: 'qs-slot' });
  const quickBox = mountQuickSend(quickSlot, {
    title: 'Quick send',
    api,
    poolId: 'wall',
    kinds: ['wall'],
    placeholder: 'Message to the wall — text, or pick from the pool…',
    onSend: (p) => api.post('/api/wall/cmd', {
      cmd: 'text.send',
      args: p.text ? { text: p.text, ...(p.title ? { title: p.title } : {}) } : { poolId: p.poolId },
    }),
    onSchedule: (p) => api.post('/api/schedules', {
      module: 'wall',
      at: p.at,
      payload: p.text ? { text: p.text } : { poolId: p.poolId },
    }),
    onSave: (p) => api.post('/api/pool/wall/messages', { text: p.text, title: p.title || undefined, kind: 'wall' }),
    signal,
  });

  const schedSlot = el('div', { class: 'sch-slot' });
  mountSchedulePanel(schedSlot, { module: 'wall', api, title: 'Scheduled wall text', signal });

  // The pane is appended whole, then its preview goes up before this module returns: the merged
  // column draws a `.pv-window` of its own from page load, so a caller that grabs the preview
  // right after mount can otherwise catch this module before it has put its own in the document.
  container.append(header, quickSlot, schedSlot, quick, body);

  /* ---------------------------------------------------------------- state */

  let settingsMeta = {}; // key -> describe meta
  let blackout = false;
  let look = {};
  // The command answer is the truth for the two split dimensions: `look.palette` and
  // `look.pattern` are page commands, so the settings document never learns their outcome (it
  // has no `palette`/`look` key) and a snapshot only lands when the page reports back. Without
  // this the Palette dropdown snapped back to the old name after every pick.
  let synth = { palette: null, pattern: null, preset: null };
  // The preset bank last read from the server (`render.settings.presets`), kept for the
  // dropdown's fill after a save so the two cannot disagree about what the wall offers.
  let presetBank = { order: [], saved: {} };
  let presetBankKey = ''; // what the filled dropdown currently shows, so a snapshot cannot refill it
  let lookRefreshTimer = null;
  timers.push(() => clearTimeout(lookRefreshTimer));
  // until the first live frame arrives there is no wall to describe: leave it empty so the mode
  // segments are neither checked nor a guess, and the preview keeps its windowed default
  let ratioSelection = null;
  let ratioState = { lastScene: null, forcing: false, forced: [] };

  function metaValue(key) {
    return settingsMeta[key] ? settingsMeta[key].value : undefined;
  }
  function lookValue(key) {
    if (key in look) return look[key];
    return metaValue(key);
  }

  /** Adopt a server fence doc ({cells, px, pitch, cols, rows} | null) into the local rect. */
  function applyFenceDoc(f) {
    // While the pointer is down the pane owns the rect: a /live poll or a `state.snapshot` frame
    // carries the server's pre-drag document, and adopting it here is what dragged the window
    // back mid-gesture. The commit on release sends the rect the operator actually produced.
    if (preview && preview.isDragging && preview.isDragging()) return;
    if (!f) {
      fencePx = null;
      fenceCells = null;
      return;
    }
    if (f.px) fencePx = { ...f.px };
    else if (f.x !== undefined && f.y !== undefined) fencePx = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (f.cells) fenceCells = f.cells;
    if (f.pitch) pitch = f.pitch;
    if (f.cols) cols = f.cols;
    if (f.rows) rows = f.rows;
  }

  // The settings document is the truth: take the schema map the server just sent and let the
  // mounted form read its values back. Without this, a knob only ever painted what the *local*
  // edit left behind — the 4 s pull replaced `settingsMeta` but never touched the form, so a
  // Speed changed anywhere else showed a stale number until a reload.
  function adoptSettings(next) {
    if (!next) return;
    settingsMeta = next;
    // A push and the 4 s poll both land here, and the form writes `input.value` straight from
    // the document — so an unguarded refresh reverted whatever field the operator was typing
    // in. Leave the mounted form alone while it holds focus; the next adoption after blur
    // catches it up.
    if (form && !(document.activeElement && settingsSlot.contains(document.activeElement))) {
      form.refresh(settingsMeta);
    }
  }

  function applyLive(data) {
    if (!data) return;
    live = data;
    seq = Number(data.seq) || seq;
    if (data.online) online = { landscape: !!data.online.landscape, portrait: !!data.online.portrait };
    if (Array.isArray(data.history)) history = data.history;
    if (data.settings) adoptSettings(data.settings);
    if (data.ratio) ratioState = data.ratio;
    if (data.render) {
      renderDoc = data.render;
      const s = data.render;
      look = s.look || {};
      // The bank rides on the render document: a preset saved anywhere shows up on the next
      // pull. (`renderSettings()` carries `presets`; `/render` also does, through the same call.)
      if (s.presets) adoptPresets(s.presets);
      if (!(preview && preview.isDragging && preview.isDragging())) applyFenceDoc(s.fence);
      // an absent ratio means the server has no opinion yet (fresh state, windowed default);
      // only an explicit '16:9' should put the pane into whole-wall mode
      if (s.ratio === '9:16' || s.ratio === '16:9') ratioSelection = s.ratio;
    }
    paintAll();
  }

  function paintAll() {
    paintQuick();
    paintRatio();
    paintPreview();
    paintFenceFields();
    paintOnline();
    paintStrip();
    paintStream();
    paintTextToggle();
    paintImage();
  }

  /**
   * The three dropdowns, painted from the live look. Values are only assigned, never dispatched:
   * `.value = x` fires no `change`, so a paint can never send the command it is describing —
   * which is what would make a deck press echo back as a second, competing command.
   */
  function paintQuick() {
    const pattern = synth.pattern || cleanLookName(lookValue('pattern'));
    const palette = liveLook('palette');
    const preset = presetBankName();

    // keep the list in step with the bank when a paint happens to be the first to see it; the
    // usual path is `adoptPresets`, which refills only when the bank actually changed
    if (presetSelect.dataset.count !== String(presetBank.order.length)) {
      fillPresets(presetBank.order, presetBank.saved);
    }
    if (!paletteSelect.querySelector(`option[value="${cssEscape(palette)}"]`)) fillPalettes(palette);
    if (!patternSelect.querySelector(`option[value="${cssEscape(pattern)}"]`)) fillPatterns(pattern);

    presetSelect.value = preset || '';
    paletteSelect.value = palette || '';
    patternSelect.value = pattern || '';
    // the running name on the control itself: a select shows its text, but a test (and a person
    // reading the markup) needs the name without asking which option is selected
    presetSelect.dataset.live = preset || '';
    paletteSelect.dataset.live = palette || '';
    patternSelect.dataset.live = pattern || '';

    blackout = Number(lookValue('blackout') || 0) > 0;
    blackoutBadge.textContent = blackout ? 'black' : 'live';
    blackoutBadge.dataset.tone = blackout ? 'bad' : 'ok';
    blackoutBtn.dataset.on = String(blackout);
    blackoutLabel.textContent = blackout ? 'Blackout ON' : 'Blackout';
    blackoutBtn.setAttribute('aria-pressed', String(blackout));
    // Publish what this pane just learned to the shared store: `blackout`/`contrast`/… are the
    // settings document's, and the palette is the page answer this pane keeps in `synth`. The store
    // is what the merged column and any other view of the wall read.
    if (shared) {
      // `undefined` means "say nothing about this key": the store keeps what it had, so a pane
      // that only knows the document's half cannot overwrite a palette the column learned
      shared.set({
        palette: cleanLookName(synth.palette) || cleanLookName(look.palette) || undefined,
        pattern: cleanLookName(synth.pattern) || cleanLookName(lookValue('pattern')) || undefined,
        preset: cleanLookName(synth.preset) || cleanLookName(lookValue('preset')) || undefined,
        brightness: Number(lookValue('brightness') ?? 1),
        saturation: Number(lookValue('saturation') ?? 1),
        speed: Number(lookValue('speed') ?? 1),
        blackout: Number(lookValue('blackout') ?? 0) > 0,
      });
    }
    paintPreviewLook();
  }

  /* Look names as the four sources spell them:
   *   · the settings document (`pattern`, `preset`)  — what the wall is told to run
   *   · a command answer (`look.palette` / `look.pattern` / `preset.set`) — what the page applied
   *   · a state snapshot (`echo.look`) — what the page reports after acting
   * The last answer wins, because it is the latest word on a dimension the document cannot hold. */
  function cleanLookName(v) {
    return typeof v === 'string' && v && v !== 'default' ? v : '';
  }
  function liveLook(key) {
    if (key === 'pattern') {
      return cleanLookName(synth.pattern) || cleanLookName(lookValue('pattern')) || '';
    }
    if (key === 'palette') {
      // A palette ABSENT from the document is not "unknown": the engine's default ramp is not a
      // schema key, so the pane offers `neonwave` (engine/config.js DEFAULT_PALETTE) as the name
      // of the ramp the wall is running until a page reports something else.
      return cleanLookName(synth.palette) || cleanLookName(look.palette) || DEFAULT_PALETTE;
    }
    return cleanLookName(synth.preset) || cleanLookName(lookValue('preset')) || DEFAULT_PRESET;
  }
  // A preset name the bank does not list still belongs in the dropdown (a preset saved on
  // another rig, or a shipped default): appended rather than left as "— preset —".
  function presetBankName() {
    const name = liveLook('preset');
    const known = name && presetSelect.querySelector(`option[value="${cssEscape(name)}"]`);
    if (name && !known && presetBank.order.length) {
      presetBank = { ...presetBank, order: [...presetBank.order, name] };
      presetBankKey = presetBank.order.join('\u0000') + '\u0001' + Object.keys(presetBank.saved || {}).join('\u0000');
      fillPresets(presetBank.order, presetBank.saved);
    }
    return name;
  }
  function cssEscape(v) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(v)) : String(v);
  }

  /**
   * An answer to `look.palette` / `look.pattern`. A refusal puts the dropdown back to what the
   * wall is running; a delivery is adopted as the live name; and the page is read a beat later,
   * because a page that refuses the name for its own reason (a live text it will not drop) only
   * says so on its next report.
   */
  function onLookCmdAnswer(out, key, want) {
    if (!out || out.ok === false) {
      // nothing was sent to change, so there is nothing to undo; read the wall and paint it
      scheduleRefreshLook(0);
      return;
    }
    // the answer names each dimension the page now runs, so every dropdown follows, not just
    // the one that was picked (a deck press of `look.palette.next` lands here too)
    if (cleanLookName(out.palette)) setLookField('palette', out.palette);
    if (cleanLookName(out.pattern)) setLookField('pattern', out.pattern);
    if (!cleanLookName(out[key])) setLookField(key, want);
    paintQuick();
    scheduleRefreshLook();
    scheduleLookPull();
  }
  function scheduleRefreshLook(delay = 350) {
    clearTimeout(lookRefreshTimer);
    lookRefreshTimer = setTimeout(() => { void refreshLook(); }, delay);
  }

  /** Read the render document back and adopt its look; `/render` is the page's own truth. */
  async function refreshLook() {
    try {
      const r = await api.get('/api/wall/render', { signal });
      if (!r || !r.settings) return;
      renderDoc = r.settings;
      look = { ...look, ...(r.settings.look || {}) };
      if (r.settings.presets) adoptPresets(r.settings.presets);
      paintQuick();
      paintPreview();
      paintImage();
    } catch {
      /* the answer already painted the change; a failed read is not a failed command */
    }
  }

  /** An optimistic single-dimension change: the server's word lands a moment later. */
  function setLookField(key, value) {
    if (key === 'pattern') synth = { ...synth, pattern: cleanLookName(value) };
    else if (key === 'palette') synth = { ...synth, palette: cleanLookName(value) };
    else if (key === 'preset') synth = { ...synth, preset: cleanLookName(value) };
  }

  function paintRatio() {
    seg169.setAttribute('aria-checked', String(ratioSelection === '16:9'));
    seg916.setAttribute('aria-checked', String(ratioSelection === '9:16'));
    const forcing = !!ratioState.forcing;
    // Locked, not disabled: the server refuses the toggle and says why, and a dead control
    // teaches nothing. A click on 9:16 while locked surfaces that answer as a toast.
    seg916.setAttribute('aria-disabled', String(forcing));
    seg916.dataset.locked = String(forcing);
    seg916.title = forcing
      ? `"${ratioState.lastScene || 'this scene'}" forces 16:9 — clicking asks the server why`
      : '9:16 window inside the wall';
    // `hidden` is display:none !important-free, but this rule must also beat `.wall-force { display:inline-flex }`
    forceWrap.hidden = !forcing;
    if (forcing) {
      forceNote.replaceChildren(dot('warn'), el('span', { text: `Forced by ${ratioState.lastScene || 'the live scene'}` }));
      forceNote.title = `Scenes that force 16:9: ${(ratioState.forced || []).join(', ') || '—'}`;
    }
    header.dataset.forcing = String(forcing);
    ratioWrap.dataset.forcing = String(forcing);
    ratioWrap.dataset.ratio = ratioSelection;
    // the preview follows the mode: the window (and its dim ring) only exists on a 9:16 wall
    paintPreview();
  }

  // The stream chip is the pane's one "is anything arriving" signal: the SSE connection is
  // long-lived, so a silent log and a dead socket look the same without it.
  let lastFrameAt = 0;
  function markStream() {
    lastFrameAt = Date.now();
    paintStream();
  }
  function paintStream() {
    // The bus is long-lived and silent when nobody acts, so "connected but quiet" is a normal
    // state, not a fault: say when the last frame arrived instead of implying a dead socket.
    const age = lastFrameAt ? Date.now() - lastFrameAt : null;
    const live = age !== null && age < 90_000;
    streamOut.dataset.state = live ? 'live' : age === null ? 'connecting' : 'idle';
    if (age === null) streamOut.textContent = 'sse · connecting';
    else if (live) streamOut.textContent = 'sse · live';
    else streamOut.textContent = `sse · quiet ${Math.round(age / 60_000)}m`;
    const title = age === null ? 'waiting for the first frame' : `last frame ${Math.round(age / 1000)}s ago`;
    streamOut.title = `live event stream from the wall bus — ${title}`;
  }

  function paintStrip() {
    sceneOut.textContent = ratioState.lastScene || '—';
    forcingOut.textContent = ratioState.forcing ? `forces 16:9 (${(ratioState.forced || []).join(', ')})` : '';
    seqOut.textContent = `seq ${seq}`;
    paintLog();
  }

  function paintLog() {
    const frames = history.slice(-7).reverse();
    clear(logList);
    if (!frames.length) {
      logList.appendChild(el('li', { class: 'wall-log-empty dim', text: 'no commands yet' }));
      return;
    }
    for (const f of frames) {
      const when = new Date(Number(f.t) || 0);
      logList.appendChild(el('li', { class: 'wall-log-row', dataset: { seq: String(f.seq ?? '') } },
        el('span', { class: 'wall-log-seq mono dim', text: f.seq ? `#${f.seq}` : '—' }),
        el('span', { class: 'wall-log-cmd mono', text: f.cmd || '—' }),
        f.view ? el('span', { class: 'wall-log-view mono dim', text: f.view }) : '',
        el('span', { class: 'wall-log-t mono dim', text: Number.isFinite(when.getTime()) ? when.toTimeString().slice(0, 8) : '' }),
      ));
    }
  }

  /* -------------------------------------------------------------- preview */

  let previewScale = 1;

  /**
   * The wall pane's bridge to the shared preview component (public/src/preview.js).
   *
   * The component owns the geometry: a 16:9 frame with the 9:16 window inside it, sized from the
   * frame's width. This bridge owns the wall's meaning: which fence is committed, which cells it
   * covers, and the commands a drag produces. Fence positions are pushed to the component as
   * fractions of the frame's WIDTH (x) and of the wall's own height (y), and the window's height
   * comes from its width through 9:16 — the component refuses to derive it from anything else.
   */
  function mountWallPreview() {
    if (preview) return preview;
    preview = mountPreview(previewHost, {
      title: 'Wall preview',
      hint: `${WALL_W} × ${WALL_H} · drag the window · corner grip · arrows nudge`,
      interactive: true,
      dim: Number(lookValue('fenceOutDim') ?? 0.18),
      look: previewLook(),
      // set by wirePreviewDrag(); guarded so a resize during boot cannot throw
      onFence: (f) => {
        preview?.onFenceChange?.(f);
      },
    });
    preview.setLayer(null);
    preview.host = previewHost;
    // the pane's fence is only meaningful on the 9:16 wall; a drag on a whole wall is ignored
    // there instead of silently creating a window the engine will not honour
    preview.onFenceChange = (f) => {
      if (ratioSelection !== '9:16') return;
      const raw = fenceToRect({ ...f, y: fencePx?.y ?? f.y });
      fencePx = snapToCells(raw);
      fenceCells = cellsFor(fencePx);
      paintPreview();
      paintFenceFieldsLive();
      commitFence(fencePx);
    };
    // a live push on every pointer move (the component calls this only while dragging), so the
    // open pages follow the window without waiting for the release to commit
    preview.onFenceMove = (f) => {
      if (ratioSelection !== '9:16') return;
      fencePx = snapToCells(fenceToRect({ ...f, y: fencePx?.y ?? f.y }));
      fenceCells = cellsFor(fencePx);
      paintPreview();
      paintFenceFieldsLive();
      pushFenceLive();
    };
    return preview;
  }

  function previewLook() {
    // The ramp the wall is running: the shared store's name when it knows one, else the pane's own
    // page answer, else the engine default. A store fed from the document (which has no palette
    // key) reports `neonwave`; a store fed by the column's `loadLook` reports the live name.
    const palette = (shared && shared.get().palette) || DEFAULT_PALETTE;
    return {
      palette: PALETTES[palette] || PALETTES.neonwave,
      brightness: clamp(Number(lookValue('brightness') ?? 1), 0, 2),
      saturation: clamp(Number(lookValue('saturation') ?? 1), 0, 2),
      speed: Number(lookValue('speed') ?? 1),
      pattern: String(lookValue('pattern') || 'wave'),
      blackout,
    };
  }

  // pixel rect (wall px, 2560×1440 picture) → the component's fence fractions
  function rectToFence(r) {
    // The rect is in WALL space: 2560 wide, and 2560·16/9 = 4551 tall (OUTER_H) for the 9:16
    // window, of which only the top WALL_H = 1440 is the lit 16:9 picture. `y` is consumed by the
    // component as a fraction of the PICTURE's height, so it divides by WALL_H; a rect whose top
    // sits below the picture cannot be expressed by the fence at all, and is pinned to 0 rather
    // than sliding the window out of the frame.
    const y = r.y <= 0 ? 0 : Math.min(r.y / WALL_H, 1);
    return { x: r.x / WALL_W, w: r.w / WALL_W, y };
  }

  // the component's fence fractions → a pixel rect, keeping 9:16 through the cell grid
  function fenceToRect(f) {
    const w = clamp(f.w * WALL_W, 0, WALL_W);
    const h = clamp((w * 16) / 9, 0, OUTER_H);
    const x = clamp(f.x * WALL_W, 0, WALL_W - w);
    const y = f.y != null ? clamp(((f.y * WALL_H) - (h - WALL_H) / 2), 0, WALL_H - Math.min(h, WALL_H)) : fencePx?.y ?? 0;
    return { x, y, w, h };
  }

  function paintPreviewLook() {
    // `palette` is not a schema key (the engine reads `paletteWeight`); the component paints the
    // default palette the engine uses, so the preview and the stream agree on the look.
    mountWallPreview().setLook(previewLook());
    // the layer keeps the wall's own lattice: dots read as cells at the drawn scale
    const drawnW = previewHost.getBoundingClientRect().width || 0;
    if (drawnW > 0) layerEl.style.setProperty('--w-dot', `${clamp((drawnW / 112) * 1.6, 3, 7).toFixed(1)}px`);
  }

  function paintPreview() {
    const pv = mountWallPreview();
    // the mode is decided from the wall's RATIO, not from whether a rect happens to be cached:
    // a 9:16 wall with no rect yet still shows a window (the server supplies the rect on the next
    // frame), and a 16:9 wall shows the whole picture even if a rect is remembered for later
    // `null` = no live frame yet: the pane booted and this paint is the first, so keep the
    // windowed default rather than guessing 'whole wall' and flashing the full picture
    const shown = ratioSelection === null ? true : ratioSelection === '9:16';
    pv.setFenceVisible(shown);
    // the component republishes the frame's own size so a pane-scale fallback is never needed
    if (pv.frame) frameEl = pv.frame;
    if (shown && !pv.fenceReady) {
      // no rect to place yet: the component draws its default window rather than nothing
      pv.setLook(previewLook());
      previewPanel.dataset.fence = 'on';
      surfaceTag.textContent = '9:16 window';
      return;
    }
    pv.setLook(previewLook());
    previewPanel.dataset.fence = shown ? 'on' : 'off';
    surfaceTag.textContent = shown ? '9:16 window' : 'whole wall · 16:9';
    if (shown && fencePx) {
      const r = fencePx;
      pv.setFence(rectToFence(r));
      const c = fenceCells || cellsFor(r);
      cellsOut.lastChild.textContent = `${c.x}, ${c.y} · ${c.w}×${c.h}`;
      pxOut.lastChild.textContent = `${fmtPx(r.x)}, ${fmtPx(r.y)} · ${fmtPx(r.w)}×${fmtPx(r.h)}`;
    } else {
      cellsOut.lastChild.textContent = '—';
      pxOut.lastChild.textContent = ratioSelection === '16:9' ? 'wall is whole' : 'no window';
    }
    // rulers on both edges: ticks are in wall px, so the rect has a frame of reference
    clear(gutter);
    clear(axis);
    const stepY = WALL_H / 8;
    for (let i = 0; i <= 8; i++) {
      gutter.appendChild(el('span', { class: 'wall-gutter-tick mono dim', style: { top: `${(i * stepY / WALL_H) * 100}%` }, text: String(Math.round(i * stepY)) }));
    }
    const stepX = WALL_W / 8;
    for (let i = 0; i <= 8; i++) {
      axis.appendChild(el('span', { class: 'wall-axis-tick mono dim', style: { left: `${(i * stepX / WALL_W) * 100}%` }, text: String(Math.round(i * stepX)) }));
    }
    if (shown && fencePx) {
      const r = fencePx;
      axis.appendChild(el('span', { class: 'wall-axis-window', style: { left: `${(r.x / WALL_W) * 100}%`, width: `${(r.w / WALL_W) * 100}%` } }));
      gutter.appendChild(el('span', { class: 'wall-gutter-window', style: { top: `${(r.y / WALL_H) * 100}%`, height: `${(Math.min(r.h, WALL_H) / WALL_H) * 100}%` } }));
    }
    applyDimLocal(Number(lookValue('fenceOutDim') ?? 0.18));
  }

  function applyDimLocal(v) {
    if (!preview) return;
    // the component's own ring dims the picture outside the window; the pane keeps the operator's
    // saved fenceOutDim as the starting value and lets the slider override it for this session
    if (!preview.userDimTouched) preview.setDim(clamp(v, 0, 1));
  }


  function paintFenceFields() {
    // "on" is the window being the live mode: a 9:16 wall with a rect. A rect kept for later
    // while the wall is whole must not leave the switch reading "on".
    const on = Boolean(fencePx) && ratioSelection === '9:16';
    fenceToggle.checked = on;
    fenceStateOut.textContent = on ? `${Math.round(fencePx.w)}×${Math.round(fencePx.h)} px` : 'whole wall';
    fencePanel.dataset.fence = on ? 'on' : 'off';
    const r = fencePx || centredFence();
    for (const k of ['x', 'y', 'w', 'h']) {
      if (document.activeElement !== numFields[k]) numFields[k].value = String(Math.round(r[k]));
      numFields[k].disabled = !on;
    }
    resetBtn.disabled = false;
    dimRange.value = String(Number(lookValue('fenceOutDim') ?? 0.18));
    if (document.activeElement !== dimNum) dimNum.value = Number(lookValue('fenceOutDim') ?? 0.18).toFixed(2);
  }

  /* ------------------------------------------------------------- grid math */

  function gridInfo() {
    // Prefer the server's pitch/cols/rows; fall back to the module defaults (112 cols).
    const c = pitch && cols ? cols : 112;
    const px = pitch && pitch.x ? pitch.x : WALL_W / c;
    const r = pitch && rows ? rows : Math.max(4, Math.round(WALL_H / px));
    const py = pitch && pitch.y ? pitch.y : WALL_H / r;
    return { cols: c, rows: r, px, py };
  }

  function cellsFor(rect) {
    const g = gridInfo();
    const x = Math.round(rect.x / g.px);
    const y = Math.round(rect.y / g.py);
    const h = Math.max(2, Math.round(rect.h / g.py));
    const w = Math.max(2, Math.min(g.cols - x, Math.round(h * (9 / 16) * (g.py / g.px))));
    return { x: clamp(x, 0, g.cols - 2), y: clamp(y, 0, g.rows - 2), w, h: Math.min(h, g.rows - y) };
  }

  /** Snap a px rect to whole cells; width follows height (9:16) unless `drive` says otherwise. */
  function snapToCells(rect, drive = null) {
    const g = gridInfo();
    let h = clamp(rect.h, 2 * g.py, WALL_H);
    if (drive === 'w') {
      // the operator typed a width: derive the height that keeps 9:16 on this grid
      const wCells = Math.max(2, Math.round(rect.w / g.px));
      h = (wCells * g.px * 16) / 9;
    }
    h = Math.min(h, WALL_H);
    const hCells = clamp(Math.round(h / g.py), 8, g.rows);
    let wCells = Math.max(2, Math.round((hCells * (9 / 16) * g.py) / g.px));
    wCells = Math.min(wCells, g.cols);
    const w = wCells * g.px;
    const hh = hCells * g.py;
    const maxX = Math.max(0, WALL_W - w);
    const x = clamp(round(rect.x, g.px), 0, maxX);
    const y = clamp(round(rect.y, g.py), 0, Math.max(0, WALL_H - hh));
    return { x, y, w, h: hh };
  }

  function centredFence() {
    const h = Math.min(WALL_H, 2560);
    const w = (h * 9) / 16;
    return { x: (WALL_W - w) / 2, y: (WALL_H - h) / 2, w, h };
  }

  /* ---------------------------------------------------------------- drag */

  /**
   * The drag itself lives in the preview component now: it owns the 16:9 frame, the 9:16 window
   * and the pointer→fraction maths for both. The pane subscribes to the component's `onFence`
   * and turns the resulting fractions back into wall pixels through the same cell grid the
   * numeric fields use, so a drag and a typed value cannot disagree.
   *
   * What stays here is the semantic bit the component must not know: a fence is only meaningful
   * on the 9:16 wall. On a whole 16:9 wall a drag is ignored rather than silently creating a
   * window that the engine will not honour.
   */

  function paintFenceFieldsLive() {
    const r = fencePx;
    if (!r) return;
    for (const k of ['x', 'y', 'w', 'h']) {
      if (document.activeElement !== numFields[k]) numFields[k].value = String(Math.round(r[k]));
    }
  }

  /* ---- live push, throttled to ~10 Hz; the final value is PATCHed on release */

  let lastPush = 0;
  let pushTimer = null;
  let pushQueued = false;

  function pushFenceLive() {
    if (!fencePx) return;
    pushQueued = true;
    if (pushTimer) return;
    const send = () => {
      pushTimer = null;
      if (!pushQueued) return;
      pushQueued = false;
      lastPush = Date.now();
      // A drag is a preview: the frame reaches every page but is never persisted, so a crash
      // mid-drag cannot leave the operator's last real choice replaced by a half-dragged rect.
      api.post('/api/wall/broadcast', { patch: { fence: { ...fencePx } }, note: 'drag', live: true }).catch(() => {});
      if (pushQueued) pushTimer = setTimeout(send, 100);
    };
    const wait = Math.max(0, 100 - (Date.now() - lastPush));
    pushTimer = setTimeout(send, wait);
  }
  timers.push(() => clearTimeout(pushTimer));

  /* ---- keyboard nudge: the wall is focusable, arrows move one cell */

  previewHost.addEventListener('keydown', (e) => {
    if (ratioSelection !== '9:16' || !fencePx) return;
    const g = gridInfo();
    const page = e.shiftKey ? 8 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -g.px * page;
    else if (e.key === 'ArrowRight') dx = g.px * page;
    else if (e.key === 'ArrowUp') dy = -g.py * page;
    else if (e.key === 'ArrowDown') dy = g.py * page;
    else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      growFence(1);
      return;
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      growFence(-1);
      return;
    } else if (e.key === 'Home') {
      e.preventDefault();
      fencePx = snapToCells(centredFence());
      paintPreview();
      commitFence(fencePx);
      return;
    } else return;
    e.preventDefault();
    fencePx = snapToCells({ ...fencePx, x: fencePx.x + dx, y: fencePx.y + dy });
    fenceCells = cellsFor(fencePx);
    paintPreview();
    paintFenceFieldsLive();
    commitFence(fencePx);
  });

  function growFence(dir) {
    const g = gridInfo();
    const c = cellsFor(fencePx);
    const hCells = clamp(c.h + dir, 8, g.rows);
    const h = hCells * g.py;
    fencePx = snapToCells({ ...fencePx, h });
    fenceCells = cellsFor(fencePx);
    paintPreview();
    paintFenceFieldsLive();
    commitFence(fencePx);
  }

  /* --------------------------------------------------------------- writes */

  async function commitFence(rect) {
    if (signal.aborted) return;
    previewPanel.dataset.busy = 'true';
    try {
      // Commit through the fence route: a drag preview never persisted, so this is what makes
      // the rect survive a restart.
      const out = await api.put('/api/wall/fence', { fence: rect });
      const saved = out && out.fence;
      if (saved) applyFenceDoc(saved);
      if (out && out.render) renderDoc = out.render;
      if (out && out.ratio) ratioState = out.ratio;
      // re-read the canonical shape (cells/pitch) — this is what "saved" means
      const r = await api.get('/api/wall/render');
      if (r && r.settings) {
        renderDoc = r.settings;
        applyFenceDoc(r.settings.fence);
        look = r.settings.look || look;
        if (r.online) online = r.online;
      }
      paintFenceFields();
      paintPreview();
      paintOnline();
    } catch (err) {
      toast(`window not saved: ${err.message}`, 'error');
      // snap back to what the server actually holds
      try {
        const r = await api.get('/api/wall/render');
        applyFenceDoc(r?.settings?.fence);
      } catch {
        /* keep the local rect, the toast already said it failed */
      }
      paintFenceFields();
      paintPreview();
    } finally {
      delete previewPanel.dataset.busy;
    }
  }

  /** One settings key through PATCH (which also broadcasts). Honest on failure. */
  async function patchSettings(patch, { optimistic = null } = {}) {
    if (signal.aborted) return null;
    try {
      const out = await api.patch('/api/wall/settings', patch);
      if (out && out.settings) settingsMeta = out.settings;
      if (out && out.render) renderDoc = out.render;
      if (out && out.ratio) ratioState = out.ratio;
      if (optimistic) optimistic(out);
      // refresh the look the preview draws from
      const r = await api.get('/api/wall/render').catch(() => null);
      if (r && r.settings) {
        renderDoc = r.settings;
        look = r.settings.look || look;
        if ('fence' in patch) applyFenceDoc(r.settings.fence);
      }
      paintAll();
      return out;
    } catch (err) {
      toast(`not saved: ${err.message}`, 'error');
      paintAll();
      return null;
    }
  }

  async function cmd(name, args = undefined) {
    if (signal.aborted) return null;
    try {
      const out = await api.post('/api/wall/cmd', args ? { cmd: name, args } : { cmd: name });
      // A dispatcher answer of ok:false is a refusal, not a delivery: show its own words.
      if (out && out.ok === false) {
        toast(`${name}: ${out.note || 'refused'}`, 'error');
        if (out.ratio) { ratioSelection = out.ratio; paintRatio(); }
        return out;
      }
      if (out && out.ratio) {
        ratioSelection = out.ratio;
        paintRatio();
        paintPreview();
      }
      // `look.palette` / `look.pattern` / `preset.set` are page commands: the answer names what
      // the page now runs, and that is the only word on a dimension the settings document does
      // not hold. Adopt it so the dropdowns follow a deck press as well as a pick.
      if (out && typeof out === 'object') {
        if (cleanLookName(out.palette)) synth = { ...synth, palette: out.palette };
        if (cleanLookName(out.pattern)) synth = { ...synth, pattern: out.pattern };
        if (cleanLookName(out.preset) && name === 'preset.set') synth = { ...synth, preset: out.preset };
        if (out.presets) adoptPresets(out.presets);
        if (cleanLookName(out.palette) || cleanLookName(out.pattern) || cleanLookName(out.preset)) paintQuick();
      }
      // the bus answers `delivered`; the frame itself arrives over SSE and refreshes the log.
      // A settings.patch is applied by the store here as well, so it lands with no page open.
      if (out && typeof out.delivered === 'number' && out.delivered === 0 && name !== 'ratio.force16x9' && name !== 'ratio.toggle' && name !== 'settings.patch') {
        toast(`${name}: no render page connected`, 'warn');
      }
      if (name === 'settings.patch') {
        if (out && out.ok === false) toast(`settings not saved: ${out.note || 'refused'}`, 'error');
        else {
          await pull();
          toast('look saved', 'ok');
        }
      }
      return out;
    } catch (err) {
      // the api layer puts the server's `error` into `.message`; its `body.note` carries the
      // command dispatcher's own explanation when the two differ (e.g. a refused ratio toggle)
      const why = (err.body && (err.body.note || err.body.message)) || err.message;
      toast(`${name}: ${why}`, 'error');
      return null;
    }
  }

  async function chooseRatio(next) {
    if (next === ratioSelection) return;
    // the seg is never disabled: inside a forcing scene a click must still answer with why
    const out = await cmd('ratio.toggle');
    // the server decides: a forcing scene refuses, and its message is already on screen
    if (out && out.ratio) {
      ratioSelection = out.ratio === '9:16' ? '9:16' : '16:9';
      // Name the value that actually settled, not the one that was asked for: "stayed 9:16"
      // after clicking 9:16 inside a forcing scene reads as success.
      if (ratioSelection !== next) toast(`ratio stayed ${ratioSelection} — ${out.note || 'the server refused'}`, 'warn');
    }
    paintRatio();
    paintPreview();
  }

  /* ---------------------------------------------------------------- data */

  let quietTimer = 0;
  function refreshQuiet() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => pull(), 120);
  }

  async function pull() {
    try {
      const data = await api.get('/api/wall/live', { signal });
      applyLive(data);
    } catch (err) {
      if (signal.aborted) return;
      clear(settingsSlot);
      settingsSlot.appendChild(el('div', { class: 'live-error', text: `could not read the wall: ${err.message}` }));
    }
  }

  // the look form: every key except the ones with a dedicated control above
  const formSettings = () => lookRows(settingsMeta);
  let form = null;

  // `pattern` and `preset` were render-only schema keys (the page reads them, nothing wrote them
  // back), so they do not reach this form today; they are listed anyway so a schema that starts
  // accepting one cannot grow a second, weaker control (a text box naming a pattern) beside the
  // dropdown that owns it.
  const PANE_OWNED_KEYS = new Set(['ratio', 'fence', 'fenceOutDim', 'pattern', 'preset']);
  const LABELS = {
    pattern: 'Pattern',
    preset: 'Preset',
    brightness: 'Brightness',
    speed: 'Speed',
    saturation: 'Saturation',
  };

  function mountForm() {
    clear(settingsSlot);
    const shown = formSettings();
    // a schema key is a fine id; the operator reads a name
    for (const [k, meta] of Object.entries(shown || {})) {
      if (LABELS[k] && (!meta.label || meta.label === k)) meta.label = LABELS[k];
    }
    if (!shown || !Object.keys(shown).length) {
      settingsSlot.appendChild(el('div', { class: 'wall-empty dim', text: 'This module declares no look settings beyond the quick controls.' }));
      return;
    }
    // hand the form the keys in the order the schema came in, and let it own saving
    form = renderSettingsForm(settingsSlot, {
      settings: shown,
      title: 'Look',
      signal,
      onSave: async (patch) => {
        const out = await api.patch('/api/wall/settings', patch);
        if (out && out.settings) {
          settingsMeta = out.settings;
          ctx.settings = { ...out.settings };
        }
        // pull the look back so the preview follows the same document OBS gets
        const r = await api.get('/api/wall/render').catch(() => null);
        if (r && r.settings) {
          look = r.settings.look || look;
          renderDoc = r.settings;
          if (r.settings.presets) adoptPresets(r.settings.presets);
        }
        paintQuick();
        paintPreview();
        return out;
      },
    });
    // The pane owns ratio (its 16:9/9:16 seg), the window (switch + fields), the outside dim
    // (its own slider, live while sliding) and the scene list with the restore picker beside it.
    // Their schema rows would repeat those controls and PATCH the same keys from a second place.
    form?.omitRows?.((key) => PANE_OWNED_KEYS.has(key));
    // one heading: the group is renamed, its settings row is not repeated
    form?.renameGroup?.('general', 'Look');
    form?.omitGroupRow?.('general');
  }

  /* ---------------------------------------------------------------- live */

  // One subscription for everything. Two subscriptions means one frame arrives twice: the
  // second handler would see the first's markStream() as "already received", and a quiet bus
  // (no traffic for 90 s) would then mislabel a fresh frame. Route by shape in one place.
  // The shell hands a frame to every subscriber of the bus; this pane may be subscribed twice
  // (a remount, a drawer refresh). Stamp each frame once so a second delivery cannot reset
  // "last frame" to now and hide a genuinely quiet bus.
  let lastStamp = 0;
  function onBusFrame(frame) {
    if (!frame || frame.reset || frame.hello) {
      if (frame?.reset) pull();
      return;
    }
    const stamp = `${frame.channel}|${frame.seq ?? ''}|${frame.event ?? frame.cmd ?? ''}|${frame.t ?? frame.data?.t ?? ''}`;
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    // any frame proves the transport: command, state or settings
    markStream();
    paintStream();
    if (frame.channel === 'wall-state') {
      onBusState(frame.cmd === 'snapshot' ? frame.args : frame.data);
      return;
    }
    if (frame.channel !== 'wall') return;
    // the core pushes the settings document on the module's channel when it changes — from the
    // deck, another pane, a scene, or this pane's own PATCH. Adopt it before anything else: the
    // generic knobs are the pane's only read-out of that document.
    if (frame.event === 'settings' && frame.data && frame.data.settings) {
      adoptSettings(frame.data.settings);
      return;
    }
    // `state.snapshot` (a settings/look push) and page snapshots both carry `look`
    const snap = frame.event === 'state.snapshot' || (frame.data && frame.data.look !== undefined) ? frame.data || {} : null;
    if (snap) {
      onStateFrame({ data: snap });
      return;
    }
    // a command frame: {seq, channel:'wall', cmd, args, view}
    const cmdName = frame.cmd || (frame.data && frame.data.cmd);
    if (!cmdName || cmdName === 'snapshot') return;
    const v = frame.view ?? frame.data?.view ?? null;
    seq = Number(frame.seq ?? frame.data?.seq) || seq;
    history = [...history.filter((h) => h.seq !== frame.seq), { seq: frame.seq ?? frame.data?.seq, cmd: cmdName, view: v, t: Date.now() }].slice(-200);
    // pattern / preset / blackout keys land on the page, not in settings; read the page's word
    // from the next snapshot, but keep the log moving now
    paintStrip();
  }

  function onBusState(snap) {
    if (!snap || typeof snap !== 'object') return;
    // a bus snapshot is the whole wall view: online gates, seq, history — and the same settings
    // document a state push carries in `snapshot`
    if (snap.online) online = { landscape: !!snap.online.landscape, portrait: !!snap.online.portrait };
    if (Number.isFinite(Number(snap.seq))) seq = Number(snap.seq);
    if (Array.isArray(snap.history)) history = snap.history;
    if (snap.snapshot) onStateFrame({ data: snap.snapshot });
    // ...and a settings push (broadcastState) is that same record flat: `{rev, look, ratio,
    // fence}`. Only the nested view snapshot was read, so every push was dropped and the switch
    // and the still showed the wall from before the change until the 4 s poll caught up.
    else if (snap.rev !== undefined) onStateFrame({ data: snap });
    paintOnline();
    paintStrip();
  }

  function onStateFrame(frame) {
    const snap = frame.data || {};
    if (snap.rev === undefined) return;
    // look frame: adopt the look the server just pushed, so the still is the wall's still
    if (snap.look) look = { ...look, ...snap.look };
    // what the page reports it is running (see `echo` in server.js). The settings document has
    // no palette and only a guessed pattern, so this is the pane's live word after a deck press:
    // the page hands back the pattern it settled on and the preset name it is showing.
    const echo = snap.echo && typeof snap.echo === 'object' ? snap.echo : null;
    if (echo) {
      if (cleanLookName(echo.palette)) synth = { ...synth, palette: echo.palette };
      if (cleanLookName(echo.pattern)) synth = { ...synth, pattern: echo.pattern };
      if (cleanLookName(echo.preset)) synth = { ...synth, preset: echo.preset };
    }
    // the pushed document carries the ratio too: a forcing scene (or the fence switch) flips
    // it without a click. Adopt it and re-read /live, which carries the ratio *state* — that
    // is where the forcing lock lives, and the preview needs both to agree
    if (snap.ratio === '16:9' || snap.ratio === '9:16') {
      ratioSelection = snap.ratio;
      refreshQuiet();
    }
    // a state frame never overrides the rect under the operator's pointer
    if (snap.fence !== undefined && !(preview && preview.isDragging && preview.isDragging())) applyFenceDoc(snap.fence);
    paintQuick();
    paintPreview();
    paintFenceFields();
  }

  // One subscription for everything: `onBusFrame` already routes `wall-state` (a published
  // `{cmd:'snapshot', args}` record) to the state handlers. A second subscription to that
  // channel ran them twice per frame and stamped the dedupe key from whichever ran first.
  unsubs.push(ctx.events.subscribe(null, onBusFrame));

  // A slow poll is the backstop for the online dots, the scene and the ratio document. It reads
  // /live and not /render: a bus frame can be missed (a park/unpark, a dropped SSE write), and
  // /render carries neither the ratio *state* nor the forcing lock.
  function runPoll() {
    if (document.hidden || signal.aborted) return;
    paintStream();
    api.get('/api/wall/live', { signal }).then((r) => {
      if (!r) return;
      // While a drag is in flight neither the rect nor the ratio may follow the server: the
      // operator's pointer owns both until the PATCH lands. Keep them, take the rest.
      const holding = preview && preview.isDragging && preview.isDragging();
      const keep = holding ? { ratio: ratioSelection, px: fencePx && { ...fencePx }, cells: fenceCells && { ...fenceCells } } : null;
      applyLive(r);
      if (keep) {
        ratioSelection = keep.ratio;
        if (keep.px) {
          fencePx = keep.px;
          fenceCells = keep.cells;
        }
        paintRatio();
        paintPreview();
        paintFenceFields();
      }
    }).catch(() => {});
  };
  const poll = setInterval(runPoll, 4000);
  void (() => {
    api.get('/api/wall/render', { signal }).then((r) => {
      if (!r) return;
      if (r.online) {
        online = r.online;
        paintOnline();
      }
      if (Number.isFinite(Number(r.seq))) {
        seq = Number(r.seq);
        paintStrip();
      }
    }).catch(() => {});
  })();
  timers.push(() => clearInterval(poll));
  // A page command's outcome (`look.palette`, `look.pattern`, `preset.set`) is written back by
  // the page's own report, and a snapshot does not always follow it; the 4 s `runPoll` already
  // adopts it, and a pane with no OBS page open must still settle within a beat. So a look
  // command schedules one extra pull, folded into one timer.
  let lookPullTimer = null;
  function scheduleLookPull() {
    if (lookPullTimer) return;
    lookPullTimer = setTimeout(() => {
      lookPullTimer = null;
      runPoll();
    }, 900);
  }
  timers.push(() => clearTimeout(lookPullTimer));

  // the wall's own heartbeat: a resize can change the preview's scale
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paintPreview()) : null;
  ro?.observe(previewHost);
  timers.push(() => ro?.disconnect());

  /* -------------------------------------------------------------- boot */

  // Mount the preview BEFORE the first await: the pane is not the pane until its frame exists, and
  // the shell paints right after this module returns. It reads `look` and `ratioSelection`, both
  // declared above, so this is the earliest point it can go up.
  mountWallPreview();
  paintPreview();
  await pull();
  mountForm();

  return () => {
    clearTimeout(quietTimer);
    for (const u of unsubs) {
      try {
        u?.();
      } catch {
        /* ignore */
      }
    }
    for (const t of timers) {
      try {
        t();
      } catch {
        /* ignore */
      }
    }
  };
}
