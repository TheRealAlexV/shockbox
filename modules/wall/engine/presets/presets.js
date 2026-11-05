/**
 * LED Wall v2 — presets
 * =====================
 * Classic script: presets must not be fetched (file:// blocks fetch of local files),
 * so they ship as `window.LEDWALL_PRESETS` and are merged over whatever is loaded.
 *
 * Each preset is a *partial* settings object merged over LEDWALL_DEFAULTS
 * (config.js). `ember` is derived from the user's saved v1 look
 * (led-wall-state.json: lava, portrait 28×50, speed 1.35, flare 0.2, streak 0.1).
 */
(function () {
  'use strict';

  window.LEDWALL_PRESETS = {
    // House look. Slow horizontal neon sweep, broadcast-safe brightness.
    neonwave: {
      gridCols: 112, gridRows: 0,
      mode: 'pattern', pattern: 'sweep',
      speed: 0.55, transitionSpeed: 1.0,
      palette: 'neonwave', paletteWeight: 1.0, hdrGain: 2.2,
      ledSize: 1.05, cellShape: 1.0,
      streakOpacity: 0.14,
      flareIntensity: 0.12, flareLength: 1.1, flareRotation: 0,
      bloom: 0.45, bloomThreshold: 0.72, bloomRadius: 1.0,
      exposure: 1.0, saturation: 1.05, contrast: 1.02,
      lift: 0.0, vignette: 0.40, grain: 0.02, dither: 1.0, acsTonemap: 1.0
    },

    // The saved v1 look, GPU edition: fire embers, random flashes.
    // v1's state was orientation=portrait, 28 cols x 50 rows on 1080x1920. v2 ships the
    // landscape grid every other look uses (112 cols, matching gridColsPortrait 63 at the
    // same pitch), so a look applied on either ratio lands on the same size of dot.
    ember: {
      gridCols: 112, gridRows: 0,
      mode: 'pattern', pattern: 'random',
      speed: 1.35, transitionSpeed: 1.35,
      flashDensity: 0.12, waveFrequency: 3.0, persistence: 0.0,
      palette: 'lava', paletteWeight: 1.0, hdrGain: 2.0,
      ledSize: 2.10, cellShape: 1.0,
      streakOpacity: 0.10,
      flareIntensity: 0.20, flareLength: 1.0, flareRotation: 0,
      bloom: 0.55, bloomThreshold: 0.55, bloomRadius: 1.0,
      exposure: 1.0, saturation: 1.05, contrast: 1.02,
      lift: 0.0, vignette: 0.35, grain: 0.03, dither: 1.0, acsTonemap: 1.0,
      bgColor: '#05050f'
    },

    // Cold, slow, low-saturation.
    arctic: {
      gridCols: 112, gridRows: 0,
      mode: 'pattern', pattern: 'wave',
      speed: 0.50, transitionSpeed: 0.9,
      waveFrequency: 2.2, persistence: 0.12,
      palette: 'arctic', paletteWeight: 0.95, hdrGain: 1.9,
      ledSize: 1.0, cellShape: 1.0,
      streakOpacity: 0.12,
      flareIntensity: 0.15, flareLength: 1.0,
      bloom: 0.70, bloomThreshold: 0.62, bloomRadius: 1.1,
      exposure: 0.95, saturation: 0.85, contrast: 1.03,
      vignette: 0.40, grain: 0.025, bgColor: '#030a12'
    },

    // Bold segmented ring chasing the border. Most graphic preset.
    chase: {
      gridCols: 112, gridRows: 0,
      mode: 'pattern', pattern: 'chase',
      speed: 1.20, transitionSpeed: 1.4,
      palette: 'neonwave', paletteWeight: 1.0, hdrGain: 2.6,
      ledSize: 1.15, cellShape: 1.0,
      streakOpacity: 0.06,
      flareIntensity: 0.30, flareLength: 1.4,
      bloom: 0.45, bloomThreshold: 0.50, bloomRadius: 0.9,
      exposure: 1.0, saturation: 1.10, contrast: 1.10,
      vignette: 0.30, grain: 0.015
    },

    // Equaliser bars: hot, with trails.
    bassline: {
      gridCols: 112, gridRows: 0,
      mode: 'pattern', pattern: 'bars',
      speed: 1.0, transitionSpeed: 1.5,
      // `bars` is v1's formula: max(0, sin(row/waveFrequency*2 + t)). Low
      // frequencies give one lit band and a black void; 6.0 leaves ~4 bands.
      waveFrequency: 6.0, persistence: 0.25,
      palette: 'lava', paletteWeight: 1.0, hdrGain: 2.4,
      ledSize: 1.15, cellShape: 1.0,
      streakOpacity: 0.18,
      flareIntensity: 0.35, flareLength: 1.2,
      bloom: 0.80, bloomThreshold: 0.50, bloomRadius: 1.15,
      exposure: 1.0, saturation: 1.15, contrast: 1.05,
      vignette: 0.35, grain: 0.03
    },

    // Text / signage.
    sign: {
      gridCols: 112, gridRows: 0,
      // Text lives in the per-view blocks now (v2.1), so each page renders its
      // own layout: 16:9 is wide and roomy, 9:16 stacks shorter lines.
      views: {
        landscape: {
          enabled: true, inheritLook: true,
          text: {
            enabled: true, title: 'ON AIR',
            source: { kind: 'inline' },
            paras: [{ align: 'center', runs: [{ t: 'ON AIR' }] }],
            style: { size: 0.92, font: '"Arial", "Helvetica Neue", sans-serif',
                     tracking: 0.06, uppercase: true, scroll: 0, reveal: 0,
                     colour: 'palette' },
            safeArea: 'off'
          }
        },
        portrait: {
          enabled: true, inheritLook: true,
          text: {
            enabled: true, title: 'ON AIR',
            source: { kind: 'inline' },
            paras: [{ align: 'center', runs: [{ t: 'ON AIR' }] }],
            style: { size: 0.86, font: '"Arial", "Helvetica Neue", sans-serif',
                     tracking: 0.06, uppercase: true, scroll: 0, reveal: 0,
                     colour: 'palette' },
            safeArea: 'off'
          }
        }
      },
      mode: 'text',
      ledSize: 0.95, cellShape: 1.0,
      palette: 'mono', paletteWeight: 0.35, hdrGain: 2.4,
      streakOpacity: 0.08, persistence: 0.05,
      flareIntensity: 0.25, flareLength: 1.1,
      bloom: 0.90, bloomThreshold: 0.55, bloomRadius: 1.0,
      exposure: 1.0, saturation: 1.10, contrast: 1.05,
      vignette: 0.45, grain: 0.02, bgColor: '#04040c'
    }
  };
})();
