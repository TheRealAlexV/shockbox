/**
 * LED Wall v2 — defaults + palettes (single source of truth)
 * ==========================================================
 * Classic script (no ES modules): `file://` blocks `type="module"` imports, and the
 * page is loaded by OBS CEF from `file:///C:/OBS/LEDWall/display.html`.
 *
 * Exposes:
 *   window.LEDWALL_DEFAULTS   — every field control.html builds a control for
 *   window.LEDWALL_PALETTES   — name -> [hex, ...]  (duplicates are weights)
 *   window.LEDWALL_META       — ranges/labels for the admin UI (advisory only)
 *
 * Tuning: change a value here and every page that has no preset/URL override
 * picks it up. Presets (presets/presets.js) are merged over this object.
 */
(function () {
  'use strict';

  // ── Render mode ─────────────────────────────────────────────────────────────
  // `?source=shockbox` (or an /api/wall/render/ on the same host) means the page is served by
  // the ShockBox server instead of file://. Two things change:
  //   · the live settings come from the server (GET /api/wall/render), not from a URL/preset
  //     baked into the OBS source, so the control pane is the only place settings live;
  //   · the OBS browser source keeps its URL across restarts, so nothing has to be re-entered.
  // Every other entry point (file://, the bench harness) keeps the old behaviour.
  window.LEDWALL_SERVER_MODE = (function () {
    try {
      if (/(^|[?&])source=shockbox(&|$)/.test(location.search)) return true;
      if (location.protocol === 'file:') return false;
      return /^\/(wall|api)\/render(\/|$)/.test(location.pathname);
    } catch (e) {
      return false;
    }
  })();

  // ── Defaults ────────────────────────────────────────────────────────────────
  // Types/ranges are the contract with control.html: every field must be here.

  /**
   * The text object (ENGINE-API §Settings schema → TEXT).  Both views carry an
   * independent one; this builds a fresh object so they never share arrays.
   */
  function makeText() {
    return {
      enabled: false,
      title: '',
      source: { kind: 'inline' },
      paras: [{ align: 'center', runs: [{ t: '', b: false, i: false }] }],
      style: {
        size: 0.8,
        font: '"Courier New", monospace',
        tracking: 0,
        uppercase: false,
        scroll: 0,
        reveal: 0,
        colour: 'palette',
        // 'auto' shrinks the whole block to fit the box (size = maximum);
        // 'none' keeps `size` and lets the box clip, as before.
        fit: 'auto',
        // Cell coverage that lights an LED.  0 (default) keeps the graded,
        // antialiased cell values - the look the wall shipped with.  A value
        // above it (0.5 = at least half a cell inked) binarises every cell so
        // stroke weight is uniform; measured, that is a clear win at 10-12
        // cell heights and loses stroke weight at 9 (see README §Cell
        // quantisation), so it stays opt-in per message.
        cellThreshold: 0
      },
      safeArea: 'off'
    };
  }

  var LEDWALL_DEFAULTS = {
    // grid
    gridCols: 112,            // 16–200   LED columns (16:9 page)
    gridColsPortrait: 63,     // 16–120   LED columns (9:16 page; same pitch as 112)
    gridRows: 0,              // 0 = auto (keeps cells square); else 8–160
    cellShape: 1.0,           // 0.5–2.0  cell height / width (non-square panels)
    ledSize: 1.0,             // 0.3–2.5  LED disc diameter as a fraction of cell pitch

    // motion
    mode: 'pattern',          // 'pattern' | 'text'
    pattern: 'random',        // random | wave | bottomCenter | sweep | bars | ripple |
                              // plasma | chase | sweepMirror | comet
    speed: 1.0,               // 0.1–4.0
    transitionSpeed: 1.0,     // 0.1–4.0  fade between per-LED target and current
    flashDensity: 0.15,       // 0.0–0.6  random pattern
    waveFrequency: 3.0,       // 0.5–10   wave / ripple / plasma / bars
    persistence: 0.0,         // 0.0–0.95 afterglow / trails

    // text mode lives in views.<view>.text (v2.1) — no top-level text fields

    // colour
    palette: 'neonwave',      // key of LEDWALL_PALETTES
    paletteWeight: 1.0,       // 0.0–1.0  saturation pull of the LUT
    bgColor: '#05050f',       // canvas background (also the wall's unlit area)
    hdrGain: 2.2,             // 1.0–8.0  over-1.0 headroom written for hot LEDs

    // look
    streakOpacity: 0.10,      // 0.0–0.5  vertical light bleed between LEDs
    flareIntensity: 0.20,     // 0.0–1.0  cross flare
    flareLength: 1.0,         // 0.2–3.0
    flareRotation: 0,         // 0–45 deg
    bloom: 0.55,              // 0.0–2.0
    bloomThreshold: 0.70,     // 0.0–1.0
    bloomRadius: 1.0,         // 0.5–2.0  mip offset multiplier
    exposure: 1.0,            // 0.2–3.0
    saturation: 1.0,          // 0.0–2.0
    contrast: 1.0,            // 0.5–1.8
    lift: 0.0,                // -0.2–0.2 black lift before tonemap
    vignette: 0.35,           // 0.0–1.0
    grain: 0.03,              // 0.0–0.3
    dither: 1.0,              // 0 = off, 1 = on
    acsTonemap: 1.0,          // 0 = plain clamp, 1 = ACES filmic

    // deck / OBS (read by control.html, written into the source URL)
    deckDefault: { preset: 'neonwave', scale: 2, ratio: '9:16' },

    // kill switch — LEDs and background render black, the page keeps running
    blackout: 0,

    // ── text ─────────────────────────────────────────────────────────────────
    // Family keys a rich run may name (`f`), and that `style.font` may name as
    // a key instead of a CSS string.  `mono` is the string every release so far
    // has rasterised with, so a message whose runs name nothing is unchanged.
    text: {
      fonts: {
        mono:   '"Courier New", monospace',
        cond:   'Consolas, "Lucida Console", monospace',
        black:  '"Arial Black", "Segoe UI Black", sans-serif',
        impact: 'Impact, Haettenschweiler, sans-serif',
        serif:  'Georgia, "Times New Roman", serif',
        sans:   'Tahoma, Verdana, sans-serif'
      }
    },

    // per-view gates and text. The page honours ONLY its own view's block.
    views: {
      landscape: { enabled: true, inheritLook: true, look: {}, text: makeText() },
      portrait:  { enabled: true, inheritLook: true, look: {}, text: makeText() }
    }
  };

  // ── Palettes ───────────────────────────────────────────────────────────────
  // The first three are the v1 arrays from _v1-mjpeg/shared.js, verbatim.
  // Repetition is weight: a colour listed twice occupies twice the ramp.

  // synthwave — cyan / blue / magenta / pink
  var PALETTE_SYNTHWAVE = [
    '#ff006e', '#ff006e',
    '#8338ec',
    '#3a86ff', '#3a86ff',
    '#00f5d4',
    '#00bbf9', '#00bbf9',
    '#f15bb5',
    '#9b5de5',
    '#00d4ff',
    '#ff4da6',
    '#7b2ff7'
  ];

  // arctic — cool cyan / ice blues
  var PALETTE_ARCTIC = [
    '#00f5d4', '#00f5d4',
    '#00bbf9',
    '#90e0ef', '#90e0ef',
    '#0077b6',
    '#00b4d8',
    '#caf0f8',
    '#48cae4', '#48cae4',
    '#023e8a'
  ];

  // lava — fire orange / red / yellow
  var PALETTE_LAVA = [
    '#ff4800', '#ff4800',
    '#ff5400',
    '#ff6d00',
    '#ff9100', '#ff9100',
    '#ffb700',
    '#dc2f02',
    '#e85d04',
    '#faa307',
    '#ffba08',
    '#9d0208'
  ];

  // neonwave — the house look: cyan → electric blue → violet → hot pink
  var PALETTE_NEONWAVE = [
    '#00e5ff', '#00e5ff',
    '#00b3ff',
    '#3a86ff',
    '#7b2ff7',
    '#c026d3',
    '#ff2d95', '#ff2d95',
    '#ff5ec4',
    '#00f5d4'
  ];

  // ember — deep embers, less yellow than lava (source of the `ember` preset)
  var PALETTE_EMBER = [
    '#8c0f00',
    '#b80000',
    '#e01b00', '#e01b00',
    '#ff3c00',
    '#ff6a00',
    '#ff8c1a',
    '#ffae00',
    '#ffd166'
  ];

  // candy — sugar pink / violet / mint
  var PALETTE_CANDY = [
    '#ff5ec4', '#ff5ec4',
    '#ff9ecd',
    '#b14aff',
    '#6f5bff',
    '#4de1ff',
    '#7bffd4',
    '#ffd166'
  ];

  // mono — cold white, for text / signage
  var PALETTE_MONO = [
    '#ffffff', '#ffffff',
    '#e6f2ff',
    '#c8dcff',
    '#9fb8d8',
    '#e6fbff',
    '#f2f7ff'
  ];

  window.LEDWALL_DEFAULTS = LEDWALL_DEFAULTS;
  window.LEDWALL_MAKE_TEXT = makeText;
  window.LEDWALL_PALETTES = {
    synthwave: PALETTE_SYNTHWAVE,
    arctic: PALETTE_ARCTIC,
    lava: PALETTE_LAVA,
    neonwave: PALETTE_NEONWAVE,
    ember: PALETTE_EMBER,
    candy: PALETTE_CANDY,
    mono: PALETTE_MONO
  };

  // Advisory metadata for control.html: numeric ranges + stepped/enum fields.
  // Nothing in the renderer reads this; it only keeps the UI honest.
  window.LEDWALL_META = {
    version: '2.1',
    ranges: {
      gridCols: [16, 200, 1], gridColsPortrait: [16, 120, 1],
      gridRows: [0, 160, 1], cellShape: [0.5, 2.0, 0.05],
      ledSize: [0.3, 2.5, 0.05], speed: [0.1, 4.0, 0.05], transitionSpeed: [0.1, 4.0, 0.05],
      flashDensity: [0, 0.6, 0.01], waveFrequency: [0.5, 10, 0.1], persistence: [0, 0.95, 0.01],
      paletteWeight: [0, 1, 0.01], hdrGain: [1, 8, 0.1], streakOpacity: [0, 0.5, 0.01],
      flareIntensity: [0, 1, 0.01], flareLength: [0.2, 3, 0.1], flareRotation: [0, 45, 1],
      bloom: [0, 2, 0.05], bloomThreshold: [0, 1, 0.01], bloomRadius: [0.5, 2, 0.05],
      exposure: [0.2, 3, 0.05], saturation: [0, 2, 0.05], contrast: [0.5, 1.8, 0.05],
      lift: [-0.2, 0.2, 0.01], vignette: [0, 1, 0.01], grain: [0, 0.3, 0.01],
      dither: [0, 1, 1], acsTonemap: [0, 1, 1], blackout: [0, 1, 1],
      // TEXT.style
      'text.style.size': [0.1, 2, 0.05], 'text.style.tracking': [-0.2, 1, 0.01],
      'text.style.scroll': [-600, 600, 5], 'text.style.reveal': [0, 4000, 10],
      'text.style.cellThreshold': [0, 1, 0.01]
    },
    enums: {
      mode: ['pattern', 'text'],
      pattern: ['random', 'wave', 'bottomCenter', 'sweep', 'bars', 'ripple',
                'plasma', 'chase', 'sweepMirror', 'comet',
                'matrix', 'spectrum', 'orbits', 'rain', 'equalizer', 'static',
                'heartbeat'],
      palette: Object.keys(window.LEDWALL_PALETTES),
      ratio: ['16:9', '9:16'],
      view: ['landscape', 'portrait'],
      'text.safeArea': ['off', '9x16'],
      'text.paras[].align': ['left', 'center', 'right']
    }
  };
})();
