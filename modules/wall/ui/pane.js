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
 * preview's still can be tinted like the wall without running WebGL. */
const PALETTES = {
  synthwave: ['#7b2ff7', '#c026d3', '#ff2d95'],
  arctic: ['#9fb8d8', '#e6fbff', '#3a86ff'],
  lava: ['#8c0f00', '#e01b00', '#ff8c1a'],
  neonwave: ['#00f5d4', '#3a86ff', '#ff2d95'],
  ember: ['#b80000', '#ff3c00', '#ffd166'],
  candy: ['#ff5ec4', '#6f5bff', '#7bffd4'],
  mono: ['#ffffff', '#c8dcff', '#9fb8d8'],
};

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

  let live = null; // last /live body
  let renderDoc = null; // last /render settings doc
  let online = { landscape: false, portrait: false };
  let history = [];
  let seq = 0;

  let fencePx = null; // committed fence px, or null = whole wall
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

  /* --- quick controls: pattern / preset / blackout / ratio ----------------- */

  const patternName = el('span', { class: 'wall-chip-name mono', text: '—' });
  const presetName = el('span', { class: 'wall-chip-name mono', text: '—' });
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

  const prevPattern = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Previous pattern', title: 'Previous pattern', text: '‹' });
  const nextPattern = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Next pattern', title: 'Next pattern', text: '›' });
  const prevPreset = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Previous preset', title: 'Previous preset', text: '‹' });
  const nextPreset = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Next preset', title: 'Next preset', text: '›' });
  prevPattern.addEventListener('click', () => cmd('pattern.prev'));
  nextPattern.addEventListener('click', () => cmd('pattern.next'));
  prevPreset.addEventListener('click', () => cmd('preset.prev'));
  nextPreset.addEventListener('click', () => cmd('preset.next'));
  const blackoutBtn = el('button', { type: 'button', class: 'btn btn-sm wall-blackout', title: 'Kill switch: LEDs and background go black' });
  const blackoutLabel = el('span', { class: 'btn-label', text: 'Blackout' });
  blackoutBtn.append(blackoutLabel);
  blackoutBtn.addEventListener('click', () => cmd(blackout ? 'blackout.off' : 'blackout.on'));

  const quick = el('div', { class: 'look-bar wall-quick' },
    el('span', { class: 'look-label', text: 'Pattern' }),
    prevPattern, patternName, nextPattern,
    el('span', { class: 'look-sep' }),
    el('span', { class: 'look-label', text: 'Preset' }),
    prevPreset, presetName, nextPreset,
    el('span', { class: 'look-sep' }),
    blackoutBtn, blackoutBadge,
    el('span', { class: 'control-spacer' }),
    ratioWrap,
  );

  /* --- preview ------------------------------------------------------------ */

  const stage = el('div', { class: 'wall-stage' });
  const surface = el('div', {
    class: 'wall-surface',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Wall preview — drag the window, arrow keys nudge it',
  });
  // The whole wall's bounds are 9:16 (the portrait window is 2560 px tall; the 16:9 picture is
  // 1440 px tall inside it). Everything the engine maps is measured inside `frameEl` — the 16:9
  // picture — while the 9:16 window is positioned on `surface`, the whole-wall bounds. Without
  // that split a window 2560 px tall hung 1100 px below a 1440 px-tall box.
  const frameEl = el('div', { class: 'wall-frame' });
  const dotsLayer = el('div', { class: 'wall-dots', 'aria-hidden': 'true' });
  const surfaceTag = el('span', { class: 'wall-surface-tag mono' });
  // The window is a real cut-out: the wall's picture is reset inside it (fence-hole), so the
  // inside reads as the live surface, and the fence dims everything outside itself. Dimming the
  // whole surface instead would wash the inside of the window too, which is exactly what the
  // operator reads as "the 9:16 crop".
  const windowEl = el('div', { class: 'fence' });
  const holeEl = dotsLayer.cloneNode(true);
  holeEl.classList.add('fence-hole');
  holeEl.id = '';
  holeEl.removeAttribute('data-shape');
  // the clone keeps the wall's class too; inside the window it must not paint the base gradient
  holeEl.classList.remove('wall-dots');
  // Two zero-height boxes the window can overhang into: without them the surface is exactly the
  // picture's height, and the window's top/bottom (a 9:16 window is taller than the 16:9
  // picture) fall outside its bounds — unhittable and untouchable.
  const fenceName = el('span', { class: 'fence-label mono' });
  const gripEl = el('div', { class: 'fence-grip', 'aria-hidden': 'true' });
  windowEl.append(holeEl, fenceName, gripEl);
  frameEl.append(dotsLayer, surfaceTag);
  // The surface *is* the wall's outer bounds (9:16); the 16:9 picture is centred inside it by
  // CSS, so a window may hang above and below the picture and still be inside the drag plane.
  surface.append(frameEl, windowEl);
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
  stage.append(surface, gutter, axis);

  // the header states which mode the wall is in; the tag on the surface names the rect
  const previewMode = el('span', { class: 'wall-mode', text: 'whole wall' });
  const previewPanel = el('section', { class: 'panel wall-preview' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Wall preview' }),
      previewMode,
      el('span', { class: 'panel-hint mono dim', text: '2560 × 1440 · drag to move · corner grip to resize' }),
    ),
    stage,
    readout,
  );

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

  const textInput = el('input', { type: 'text', class: 'input', id: 'wall-text', placeholder: 'Message to the wall…', maxlength: '240', autocomplete: 'off' });
  const textSendBtn = actionButton({
    label: 'Send',
    variant: 'btn-primary',
    run: () => {
      const text = textInput.value.trim();
      if (!text) throw new Error('type a message first');
      return api.post('/api/wall/cmd', { cmd: 'text.send', args: { text } });
    },
    onDone: () => {
      textInput.value = '';
      toast('text sent', 'ok');
    },
    onError: (err) => toast(`text: ${err.message}`, 'error'),
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      textSendBtn.click();
    }
  });
  let textEnabled = false;
  const textToggle = el('button', { type: 'button', class: 'btn btn-sm', title: 'Show or hide the wall’s text layer' });
  const textToggleLabel = el('span', { class: 'btn-label', text: 'Text layer' });
  textToggle.append(textToggleLabel);
  textToggle.addEventListener('click', async () => {
    textToggle.disabled = true;
    try {
      await api.post('/api/wall/cmd', { cmd: 'text.enabled', args: { on: !textEnabled } });
      textEnabled = !textEnabled;
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
      textInput,
      textSendBtn,
      el('span', { class: 'look-sep' }),
      textToggle, textClearBtn, textRevealBtn,
    ),
  );
  function paintTextToggle() {
    textToggle.setAttribute('aria-pressed', String(textEnabled));
    textToggle.dataset.on = String(textEnabled);
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

  /* --- settings slot ------------------------------------------------------ */

  const settingsSlot = el('div', { class: 'pane-settings wall-settings' });

  const body = el('div', { class: 'wall-body' },
    el('div', { class: 'wall-main' },
      previewPanel,
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
  container.append(header, quick, body);

  /* ---------------------------------------------------------------- state */

  let settingsMeta = {}; // key -> describe meta
  let blackout = false;
  let look = {};
  let ratioSelection = '16:9';
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
    if (drag) return;
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

  function applyLive(data) {
    if (!data) return;
    live = data;
    seq = Number(data.seq) || seq;
    if (data.online) online = { landscape: !!data.online.landscape, portrait: !!data.online.portrait };
    if (Array.isArray(data.history)) history = data.history;
    if (data.settings) settingsMeta = data.settings;
    if (data.ratio) ratioState = data.ratio;
    if (data.render) {
      renderDoc = data.render;
      const s = data.render;
      look = s.look || {};
      if (!drag) applyFenceDoc(s.fence);
      ratioSelection = s.ratio === '9:16' ? '9:16' : '16:9';
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
  }

  function paintQuick() {
    const pattern = lookValue('pattern');
    patternName.textContent = pattern ? String(pattern) : '—';
    const preset = lookValue('preset');
    presetName.textContent = preset ? String(preset) : '—';
    blackout = Number(lookValue('blackout') || 0) > 0;
    blackoutBadge.textContent = blackout ? 'black' : 'live';
    blackoutBadge.dataset.tone = blackout ? 'bad' : 'ok';
    blackoutBtn.dataset.on = String(blackout);
    blackoutLabel.textContent = blackout ? 'Blackout ON' : 'Blackout';
    blackoutBtn.setAttribute('aria-pressed', String(blackout));
    paintPreviewLook();
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

  function applyDimLocal(v) {
    if (!surface) return;
    surface.style.setProperty('--out-dim', String(clamp(v, 0, 1)));
    // The dim ring is drawn by `.fence::before` (a 9999px border), so it lives on the window.
    windowEl.style.setProperty('--out-dim', String(clamp(v, 0, 1)));
  }

  function paintPreviewLook() {
    // `palette` is not a schema key (the engine reads `paletteWeight`); the preview still paints
    // a default palette, but a look key here would read a value the server never stores.
    const palette = 'neonwave';
    const stops = PALETTES[palette] || PALETTES.neonwave;
    const sat = Number(lookValue('saturation') ?? 1);
    const bright = clamp(Number(lookValue('brightness') ?? 1), 0, 2);
    const speed = Number(lookValue('speed') ?? 1);
    const p = String(lookValue('pattern') || 'wave');
    surface.dataset.pattern = p;
    surface.dataset.palette = palette;
    surface.style.setProperty('--w-a', stops[0]);
    surface.style.setProperty('--w-b', stops[1]);
    surface.style.setProperty('--w-c', stops[2]);
    surface.style.setProperty('--w-hue', '0deg');
    surface.style.setProperty('--w-sat', String(clamp(sat, 0, 2)));
    surface.style.setProperty('--w-bright', String(bright));
    surface.style.setProperty('--w-dur', `${clamp(18 / Math.max(0.15, speed), 4, 120)}s`);
    surface.dataset.blackout = String(blackout);
    // a different pattern index gives the still a different character (bars vs wave vs dots)
    surface.dataset.shape = String(['wave', 'bars', 'dots', 'sweep', 'plasma'].indexOf(p) >= 0
      ? p
      : ['wave', 'bars', 'dots', 'sweep', 'plasma'][hash(p) % 5]);
    dotsLayer.style.opacity = String(clamp(0.25 + bright * 0.5, 0.15, 1));
    // the window's copy shares the palette and grade, and reads the surface's lattices
    holeEl.style.setProperty('--w-hue', '0deg');
    holeEl.style.setProperty('--w-sat', String(clamp(sat, 0, 2)));
    holeEl.style.setProperty('--w-bright', String(bright));
    holeEl.style.opacity = dotsLayer.style.opacity;
    holeEl.removeAttribute('data-shape');
    // keep the lattice near its true cell size when the wall is drawn small
    const drawnW = surface.getBoundingClientRect().width || 0;
    if (drawnW > 0) surface.style.setProperty('--w-dot', `${clamp((drawnW / 112) * 1.6, 3, 7).toFixed(1)}px`);
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function paintPreview() {
    // The drag plane is the wall's outer bounds at ONE scale on both axes: 2560 wall px across
    // the picture's width, so the 9:16 plane is (16/9)·width tall and a wall px is
    // width/2560 screen px on either axis. The window's top/height are percentages of that
    // plane, which is what the pointer→wall mapping in beginDrag assumes.
    const width = surface.getBoundingClientRect().width || 0;
    if (width > 0) {
      const need = (width * 16) / 9;
      surface.style.setProperty('--wall-surface-h', `${Math.round(need)}px`);
    }
    const frameRect = frameEl.getBoundingClientRect();
    const surfRect = surface.getBoundingClientRect();
    previewScale = frameRect.width > 0 ? frameRect.width / WALL_W : 1;
    const shown = fencePx && ratioSelection === '9:16';
    surface.dataset.fence = shown ? 'on' : 'off';
    previewMode.textContent = shown ? '9:16 window' : 'whole wall';
    previewMode.dataset.mode = shown ? 'window' : 'whole';
    surface.dataset.blackout = String(blackout);
    surfaceTag.textContent = shown ? '9:16 window' : 'whole wall · 16:9';
    if (shown) {
      const r = fencePx;
      // x/w are fractions of the wall's width; y/h are fractions of the plane's height, which
      // is the wall's 9:16 outer height at the same scale (planeH = width · 16/9).
      const plane = surface.getBoundingClientRect();
      const planeH = plane.height || OUTER_H;
      const scale = (plane.width || WALL_W) / WALL_W;
      windowEl.style.left = `${(r.x / WALL_W) * 100}%`;
      windowEl.style.top = `${((r.y * scale) / planeH) * 100}%`;
      windowEl.style.width = `${(r.w / WALL_W) * 100}%`;
      windowEl.style.height = `${((r.h * scale) / planeH) * 100}%`;
      const c = fenceCells || cellsFor(r);
      // The cell rect is on the element as well as in the readout: a test (and the operator's
      // own eye) can read the number the pane drew, not the one it began from.
      windowEl.dataset.fenceCells = `${c.x},${c.y},${c.w},${c.h}`;
      windowEl.dataset.fencePx = `${r.x},${r.y},${r.w},${r.h}`;
      fenceName.textContent = `${c.w}×${c.h} cells`;
      cellsOut.lastChild.textContent = `${c.x}, ${c.y} · ${c.w}×${c.h}`;
      pxOut.lastChild.textContent = `${fmtPx(r.x)}, ${fmtPx(r.y)} · ${fmtPx(r.w)}×${fmtPx(r.h)}`;
    } else {
      delete windowEl.dataset.fenceCells;
      delete windowEl.dataset.fencePx;
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
    if (shown) {
      const r = fencePx;
      const dotL = el('span', { class: 'wall-axis-window', style: { left: `${(r.x / WALL_W) * 100}%`, width: `${(r.w / WALL_W) * 100}%` } });
      axis.appendChild(dotL);
      const span = el('span', { class: 'wall-gutter-window', style: { top: `${(r.y / WALL_H) * 100}%`, height: `${(r.h / WALL_H) * 100}%` } });
      gutter.appendChild(span);
    }
    applyDimLocal(Number(lookValue('fenceOutDim') ?? 0.18));
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

  let drag = null;
  // The rect the pointer last produced. Nothing else writes it: a canvas refresh (a /live poll
  // or a `state.snapshot` frame) rewrites `fencePx` from the server's old document, and
  // committing that on release is what made a real drag land back where it started.
  let dragRect = null;

  function beginDrag(e, mode) {
    if (!fencePx || ratioSelection !== '9:16' || e.button > 0) return;
    // The start rect is the operator's own commit, taken as-is: a move slides it, a resize
    // grows or shrinks it. Nothing here re-derives its size (a cell snap of a 2560-tall window
    // clamps to the 1440-px picture and halves its width, which made the first pixel of a drag
    // shrink a full 9:16 window to 800×1440).
    const start = { ...fencePx };
    // Pointer → wall in the plane's coordinate system, the one paintPreview places the window
    // in: x/w are fractions of the plane's width, y/h of its height, and the plane is
    // width·16/9 tall — so width/2560 is the screen-px-to-wall-px scale on both axes.
    const planeRect = surface.getBoundingClientRect();
    if (!planeRect.width) return;
    drag = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start,
      sx: WALL_W / planeRect.width,
      sy: WALL_W / planeRect.width,
    };
    dragRect = { ...start };
    fencePx = { ...start };
    surface.setPointerCapture?.(e.pointerId);
    surface.dataset.drag = mode;
    surface.focus({ preventScroll: true });
    e.preventDefault();
    e.stopPropagation();
  }

  // The surface handler below deliberately ignores presses inside `.fence` (it is the "move the
  // window here" gesture); the window's own body starts a drag. The event must not reach the
  // surface afterwards, or it would re-centre the window on the press point.
  windowEl.addEventListener('pointerdown', (e) => {
    beginDrag(e, e.target === gripEl || gripEl.contains(e.target) ? 'resize' : 'move');
    if (!drag) return;
    e.stopPropagation();
    // The move/resize listeners live on `surface`, but a pointer captured on the window element
    // retargets every later pointermove/up to it — which is the bug a real drag hit: the press
    // landed, nothing moved, and release never committed. Capture on the surface instead.
    surface.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });

  // pressing the dimmed wall outside the window moves the window's centre there
  surface.addEventListener('pointerdown', (e) => {
    if (!fencePx || ratioSelection !== '9:16' || e.button > 0 || e.target.closest('.fence') || drag) return;
    const rect = frameEl.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((e.clientX - rect.left) / rect.width) * WALL_W;
    const py = ((e.clientY - rect.top) / rect.height) * WALL_H;
    fencePx = snapToCells({ ...fencePx, x: px - fencePx.w / 2, y: py - fencePx.h / 2 });
    fenceCells = cellsFor(fencePx);
    paintPreview();
    paintFenceFieldsLive();
    commitFence(fencePx);
    e.preventDefault();
  });

  // A drag is captured on the surface, but browsers deliver plain mouse input as compatibility
  // mouse events; listen for both so a real mouse and a synthetic pointer stream both move it.
  function onDragMove(e) {
    if (window.__dbg && Math.random() < 0.5) window.__dbg('dragmove', { dragging: Boolean(drag), target: e.target && e.target.className, type: e.type });
    if (!drag) return;
    const dx = (e.clientX - drag.startX) * drag.sx;
    const dy = (e.clientY - drag.startY) * drag.sy;
    const g = gridInfo();
    if (drag.mode === 'move') {
      // A move slides the rect and keeps its size. Never re-derive the size from the pointer:
      // a 2560-tall window re-snapped from y clamps to the 1440-px picture and loses its width.
      dragRect = {
        ...drag.start,
        x: clamp(round(drag.start.x + dx, g.px), 0, Math.max(0, WALL_W - drag.start.w)),
        y: clamp(round(drag.start.y + dy, g.py), 0, Math.max(0, WALL_H - drag.start.h)),
      };
    } else {
      // The grip drags BOTH edges: dx and dy are two readings of the same corner, so the
      // larger one drives growth (dragging up grows the window). Height then sets the width
      // through the cell grid, which is what keeps the window at 9:16.
      const grow = Math.max(-dx, -dy);
      const h = clamp(drag.start.h + grow, 2 * g.py, OUTER_H - drag.start.y);
      const hCells = clamp(Math.round(h / g.py), 2, g.rows);
      const wCells = Math.max(2, Math.round((hCells * (9 / 16) * g.py) / g.px));
      dragRect = { ...drag.start, w: wCells * g.px, h: hCells * g.py };
    }
    fencePx = dragRect;
    fenceCells = cellsFor(fencePx);
    paintPreview();
    paintFenceFieldsLive();
    pushFenceLive();
  }
  surface.addEventListener('pointermove', onDragMove);
  surface.addEventListener('mousemove', onDragMove);
  window.addEventListener('pointermove', (e) => {
    if (drag) onDragMove(e);
  });

  function endDrag(e) {
    if (!drag) return;
    const committed = dragRect;
    drag = null;
    dragRect = null;
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('mouseup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    delete surface.dataset.drag;
    try {
      surface.releasePointerCapture?.(e.pointerId);
    } catch {
      /* capture already gone */
    }
    // Commit what the pointer produced, never `fencePx`: a refresh may have replaced it with
    // the server's old rect while the drag was in flight.
    if (committed) commitFence(committed);
  }
  surface.addEventListener('pointerup', endDrag);
  surface.addEventListener('pointercancel', endDrag);
  surface.addEventListener('mouseup', endDrag);

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

  surface.addEventListener('keydown', (e) => {
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
    surface.dataset.busy = 'true';
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
      delete surface.dataset.busy;
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

  // settings this pane edits with its own controls; the generated form leaves them out
  const PANE_OWNED_KEYS = new Set(['ratio', 'fence', 'fenceOutDim']);
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
    paintOnline();
    paintStrip();
  }

  function onStateFrame(frame) {
    const snap = frame.data || {};
    if (snap.rev === undefined) return;
    // look frame: adopt the look the server just pushed, so the still is the wall's still
    if (snap.look) look = { ...look, ...snap.look };
    // the pushed document carries the ratio too: a forcing scene (or the fence switch) flips
    // it without a click. Adopt it and re-read /live, which carries the ratio *state* — that
    // is where the forcing lock lives, and the preview needs both to agree
    if (snap.ratio === '16:9' || snap.ratio === '9:16') {
      ratioSelection = snap.ratio;
      refreshQuiet();
    }
    // a state frame never overrides the rect under the operator's pointer
    if (snap.fence !== undefined && !drag) applyFenceDoc(snap.fence);
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
  const poll = setInterval(() => {
    if (document.hidden || signal.aborted) return;
    paintStream();
    api.get('/api/wall/live', { signal }).then((r) => {
      if (!r) return;
      // While a drag is in flight neither the rect nor the ratio may follow the server: the
      // operator's pointer owns both until the PATCH lands. Keep them, take the rest.
      const keep = drag ? { ratio: ratioSelection, px: fencePx && { ...fencePx }, cells: fenceCells && { ...fenceCells } } : null;
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
  }, 4000);
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

  // the wall's own heartbeat: a resize can change the preview's scale
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paintPreview()) : null;
  ro?.observe(surface);
  timers.push(() => ro?.disconnect());

  /* -------------------------------------------------------------- boot */

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
