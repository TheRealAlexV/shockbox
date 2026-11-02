/**
 * LED Wall v2.1 — shared page boot
 * =================================
 * One page, one classic script: `engine/display.html` sets `LEDWALL_PAGE` and loads this file.
 * The 9:16 picture is not a second page — it is the fence block inside that page's 16:9
 * canvas, selected by `?view=portrait` or by the render settings.
 *
 * WHY classic script: the production page is loaded from
 * `file:///C:/OBS/LEDWall/display.html` inside OBS CEF.  `file://` blocks ES
 * modules and blocks `fetch()` of local files, so there is no bundler, no
 * `import`, and no module-level code anywhere in this rig.
 *
 * Responsibilities, in the order they matter:
 *   1. read the URL (preset, every schema field, `text`, `view`, `agent`, …)
 *   2. mount the engine at the page's ratio
 *   3. report diag / bench / shots to the harness sink (`?report=1`)
 *   4. give the agent client a page it can drive (engine.js owns the transport)
 */
(function () {
  'use strict';

  var PAGE = window.LEDWALL_PAGE || {};
  var RATIO = PAGE.ratio === '9:16' ? '9:16' : '16:9';
  var VIEW = PAGE.view === 'portrait' ? 'portrait' : 'landscape';
  // The 16:9 page draws BOTH view blocks: landscape is the whole picture, portrait is the 9:16
  // fence inside it (2026-10-29). So the serving page reports as landscape; a ?view=portrait
  // on this page means 'start with the fence layout', which the render settings carry because
  // the window is a mod-8 fence rectangle. A `?view=` on the URL overrides it further down.

  var qs = new URLSearchParams(location.search);
  var DEFAULTS = window.LEDWALL_DEFAULTS || {};
  var PRESETS = window.LEDWALL_PRESETS || {};

  function qNum(name, dflt) { var v = qs.get(name); return v === null ? dflt : Number(v); }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // ── 1. Settings from the URL ───────────────────────────────────────────────
  // Precedence: engine defaults < preset < explicit URL fields.  Views are
  // never merged from a preset unless the preset really carries them, so a
  // `?text=` on the URL survives the preset lookup below.

  var requested = qs.get('preset');
  var settings = {};
  if (requested && PRESETS[requested]) {
    for (var k in PRESETS[requested]) {
      if (Object.prototype.hasOwnProperty.call(PRESETS[requested], k)) {
        settings[k] = PRESETS[requested][k];
      }
    }
  } else if (requested) {
    console.warn('LEDWall: unknown preset "' + requested + '"');
  }

  var RESERVED = {
    preset: 1, scale: 1, diag: 1, bench: 1, report: 1, endpoint: 1, shot: 1,
    shotEvery: 1, ratio: 1, view: 1, agent: 1, text: 1
  };
  var ALIAS = { cols: 'gridCols', rows: 'gridRows' };
  Object.keys(ALIAS).forEach(function (alias) {
    var raw = qs.get(alias);
    if (raw !== null) settings[ALIAS[alias]] = Number(raw);
  });
  Object.keys(DEFAULTS).forEach(function (field) {
    if (RESERVED[field]) return;
    var raw = qs.get(field);
    if (raw === null) return;
    var dflt = DEFAULTS[field];
    if (isObj(dflt)) return;                    // views / deckDefault stay code-side
    if (typeof dflt === 'number') settings[field] = Number(raw);
    else if (typeof dflt === 'boolean') settings[field] = raw === '1' || raw === 'true';
    else settings[field] = raw;
  });

  // ── ?textJson= — a whole TEXT object (diagnostics / shot harness only) ────
  // `?text=` above covers the one-line case; rich runs (paragraphs, b/i,
  // tracking, safeArea, fit) need the real object, and file:// pages cannot
  // POST settings.  URL-encoded JSON keeps that inspection path dependency-free.
  var urlTextJson = qs.get('textJson');
  if (urlTextJson) {
    try {
      var jt = JSON.parse(urlTextJson);
      if (jt && typeof jt === 'object' && jt.paras) {
        var jviews = settings.views || {};
        var jblock = jviews[VIEW] || {};
        jblock.text = {
          enabled: true,
          title: String(jt.title || ''),
          source: jt.source || { kind: 'inline' },
          paras: jt.paras,
          style: jt.style || {},
          safeArea: jt.safeArea === '9x16' ? '9x16' : 'off'
        };
        jviews[VIEW] = jblock;
        settings.views = jviews;
        settings.mode = 'text';
      }
    } catch (e) { /* a malformed sample must not stop the wall */ }
  }

  // ── ?text= — plain text into *this view's* block, one paragraph, one run ──
  var urlText = qs.get('text');
  if (urlText !== null && urlText !== '') {
    var views = settings.views || {};
    var block = views[VIEW] || {};
    var style = { size: 0.8, tracking: 0, uppercase: false, scroll: 0, reveal: 0, colour: 'palette' };
    var stKeys = ['size', 'tracking', 'uppercase', 'scroll', 'reveal', 'colour', 'font', 'fit'];
    if (qs.get('fit')) style.fit = qs.get('fit') === 'none' ? 'none' : 'auto';
    stKeys.forEach(function (f) {
      var raw = qs.get('text' + f.charAt(0).toUpperCase() + f.slice(1)) || qs.get('t_' + f);
      if (raw === null) return;
      style[f] = (f === 'uppercase')
        ? (raw === '1' || raw === 'true')
        : ((f === 'font' || f === 'colour' || f === 'fit') ? raw : Number(raw));
    });
    var safe = qs.get('safeArea') || qs.get('safe');
    block.text = {
      enabled: true,
      title: urlText.slice(0, 40),
      source: { kind: 'inline' },
      paras: [{ align: qs.get('align') || 'center', runs: [{ t: urlText }] }],
      style: style,
      safeArea: (safe === '9x16') ? '9x16' : 'off'
    };
    block.enabled = block.enabled !== false;
    block.inheritLook = block.inheritLook !== false;
    views[VIEW] = block;
    settings.views = views;
    settings.mode = 'text';
  }

  var scale = qNum('scale', (DEFAULTS.deckDefault && DEFAULTS.deckDefault.scale) || 2);
  if (scale !== 0.5 && scale !== 1 && scale !== 2 && scale !== 3) scale = 2;

  var wantDiag = qs.get('diag') === '1';
  var benchFrames = qs.get('bench') ? Math.max(30, Number(qs.get('bench')) || 600) : 0;
  var wantReport = qs.get('report') === '1';
  var wantShot = qs.get('shot') === '1';
  var shotEvery = Math.max(500, qNum('shotEvery', 3000));
  var endpoint = (qs.get('endpoint') || 'http://127.0.0.1:8971').replace(/\/+$/, '');

  // `?agent=off` disables the bus; otherwise the default is the ShockBox server itself — same
  // origin, so an OBS source and the control pane share one host and no port is hard-coded.
  // The old standalone service (127.0.0.1:8972) is gone; `?agent=http://…` still overrides.
  var agentQ = qs.get('agent');
  var agentUrl = (agentQ === null) ? (window.LEDWALL_SERVER_MODE ? location.origin : 'http://127.0.0.1:8972') : agentQ;

  var presetLabel = (requested && PRESETS[requested])
    ? requested
    : ((DEFAULTS.deckDefault && DEFAULTS.deckDefault.preset) || 'default');

  var viewOverride = qs.get('view');
  if (viewOverride === 'portrait' || viewOverride === 'landscape') VIEW = viewOverride;

  // ── 2. Mount ──────────────────────────────────────────────────────────────
  var canvas = document.getElementById('wall');
  var diagEl = document.getElementById('diag');
  var benchEl = document.getElementById('bench');

  var inst;
  try {
    inst = window.LEDWall.mount(canvas, settings, {
      scale: scale,
      ratio: RATIO,
      view: VIEW,
      label: presetLabel,
      agent: agentUrl,
      onStats: wantDiag ? paintDiag : null,
      onCommand: wantDiag ? function () { paintDiag(inst.diag()); } : null
    });
  } catch (e) {
    document.body.style.color = '#f66';
    document.body.style.font = '14px monospace';
    document.body.textContent = 'LEDWall failed: ' + (e && e.message ? e.message : e);
    console.error(e);
    return;
  }
  window.LEDWALL_INSTANCE = inst;

  // ── Server mode: settings live on the ShockBox server ──────────────────────
  // The OBS source URL is fixed (`/wall/render`), so the page pulls the live settings once and
  // then follows `state.snapshot` frames over the wall SSE channel — the same frames the
  // control pane publishes when the operator changes anything. A failed pull is not fatal: the
  // URL/preset look keeps rendering and the next snapshot applies.
  // `setSettings` merges over the engine defaults, so a look is applied as the *whole* look: a
  // key the operator set back to its default must land too, or the page keeps the old one.
  var applyLook = function (d) {
    if (!d) return false;
    var applied = false;
    // Saved presets arrive with every snapshot: the page must know a preset by name before a
    // `preset.set` for it can land, and a missed frame must not leave the wall unable to
    // resolve one the pane is showing.
    if (d.presets && d.presets.saved && window.LEDWall && window.LEDWall.applySavedPresets) {
      inst.savedPresets = window.LEDWall.applySavedPresets(d.presets.saved);
      applied = true;
    }
    // A frame is the document's word on the look, but the page writes a preset to that document
    // as it applies it. Applying a frame that was in flight while that write landed would put the
    // pre-load values straight back, so a load marks the window and the look is skipped until it
    // closes — by then the document carries the preset and its own frame is the one applied.
    var loadingPreset = inst.presetLoadingUntil && Date.now() < inst.presetLoadingUntil;
    // The picture's geometry is the server's (it read the file's real dimensions): the engine
    // needs it to draw the picture at its own proportions, and it arrives on every state frame,
    // so a placement restored from a preset has the same aspect as a fresh upload. Assigned
    // outside the `look` branch: a frame that carries geometry but no look (an upload that only
    // moved the revision) still has to reach the shader, or the picture is drawn at the wall's
    // aspect until the next settings change.
    if (d.imageGeometry && typeof d.imageGeometry === 'object') inst.imageGeometry = d.imageGeometry;
    if (d.look && typeof d.look === 'object' && !loadingPreset) {
      inst.setSettings(d.look, { source: 'server' });
      applied = true;
    }
    // `fence` is a whole-cell window from the server, or null when the wall is whole. Both
    // cases are handed over: a null is how the pane turns the window off.
    if (inst.setFence && Object.prototype.hasOwnProperty.call(d, 'fence')) {
      inst.setFence(d.fence || null);
      applied = true;
    }
    return applied;
  };
  if (window.LEDWALL_SERVER_MODE) {
    fetch('/api/wall/render', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) { applyLook(body && body.settings); })
      .catch(function () { /* keep rendering the URL look */ });
    window.addEventListener('ledwall:server-settings', function (ev) { applyLook(ev && ev.detail); });
  }
  // Re-apply the server's look on demand: the same path a `state.snapshot` frame takes. The
  // picture probe steps frames by hand, so the SSE handler cannot run between two writes.
  inst.reapplyServerLook = function () {
    return fetch('/api/wall/render', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) { applyLook(body && body.settings); return true; });
  };
  // A duration timer must not outlive the page: cancel it before the reload
  // from the admin UI's `reload` command tears the document down.
  if (window.addEventListener) {
    window.addEventListener('pagehide', function () {
      try { inst.cancelHolds(); } catch (e) { /* ignore */ }
    });
  }
  document.title = (PAGE.title || 'LED Wall') + ' — ' + presetLabel;

  // ── 3. Reporting ──────────────────────────────────────────────────────────
  // `file://` is an opaque origin and the harness answers with
  // `Access-Control-Allow-Origin: *`, so a plain fetch works; an <img> GET is
  // the fallback if fetch is refused outright.

  function report(obj) {
    if (!wantReport) return;
    var url = endpoint + '/report?d=' + encodeURIComponent(JSON.stringify(obj));
    try {
      fetch(url, { method: 'POST', mode: 'cors', cache: 'no-store', body: '' })
        .catch(function () { beacon(url); });
    } catch (e) {
      beacon(url);
    }
  }

  function beacon(url) {
    try { var im = new Image(); im.src = url + '&_=' + Date.now(); } catch (e) { /* quiet */ }
  }

  function payload(kind, extra) {
    var d = inst.diag();
    var out = {
      kind: kind, ts: Date.now(),
      view: d.view, ratio: d.ratio,
      renderer: d.renderer, vendor: d.vendor,
      webgl2: d.webgl2, floatCB: d.floatCB,
      canvas: d.canvas, cols: d.cols, rows: d.rows,
      fps: d.fps, gpuMs: d.gpuMs, cpuMs: d.cpuMs,
      timerQuery: d.timerQuery,
      textMs: d.textMs,
      textFit: d.textFit,
      mode: d.mode,
      blackout: d.blackout,
      hold: d.hold,
      preset: inst.label || presetLabel,
      url: location.href
    };
    if (extra) for (var k2 in extra) out[k2] = extra[k2];
    return out;
  }

  report(payload('boot'));

  if (wantReport || wantDiag) {
    setInterval(function () { report(payload('diag')); }, 5000);
  }

  // Report the moment a command lands.  The 5 s heartbeat alone left anything
  // reading the report stream (the harness, and any remote view of `textFit`)
  // showing the *previous* text's fit until the next tick.  Coalesced: a burst
  // of commands sends one report, 150 ms after the last one.  Nothing about the
  // rendered state changes here — this only moves the report forward.
  if (wantReport) {
    var applyReportTimer = 0;
    var rawApply = inst.applyCommand;
    inst.applyCommand = function (cmd, args) {
      var res = rawApply.call(inst, cmd, args);
      if (applyReportTimer) clearTimeout(applyReportTimer);
      applyReportTimer = setTimeout(function () {
        applyReportTimer = 0;
        report(payload('apply', { cmd: cmd }));
      }, 150);
      return res;
    };
    if (window.addEventListener) {
      window.addEventListener('pagehide', function () {
        if (applyReportTimer) clearTimeout(applyReportTimer);
        applyReportTimer = 0;
      });
    }
    // A duration revert is not a command, so it gets its own report: the harness
    // can then time the revert from the page's clock instead of polling state.
    inst.onHoldRevert = function (h) {
      report(payload('hold', { hold: h }));
    };
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  function paintDiag(d) {
    if (!wantDiag) return;
    d = d || inst.diag();
    diagEl.style.display = 'block';
    var a = inst.agent ? inst.agent.status() : null;
    var lines = [
      'LED Wall v' + window.LEDWall.version + '  ' + (inst.label || presetLabel) + '  ' + d.view + ' ' + d.ratio,
      d.canvas[0] + '×' + d.canvas[1] + '  grid ' + d.cols + '×' + d.rows +
        '  ' + d.fps.toFixed(1) + ' fps',
      'gpu ' + d.gpuMs.toFixed(2) + ' ms   cpu ' + d.cpuMs.toFixed(2) + ' ms' +
        '   text ' + (d.textMs || 0).toFixed(2) + ' ms' + (d.timerQuery ? '' : '  (sync probe)'),
      d.floatCB ? 'RGBA16F  floatCB' : 'RGBA8  no floatCB',
      a ? ('agent ' + (a.connected ? 'up' : 'down') + '  seq ' + a.seq +
        '  ' + a.applied + '/' + a.received + ' applied') : 'agent off',
      String(d.renderer).slice(0, 64)
    ];
    diagEl.textContent = lines.join('\n');
  }

  // ── Screenshots ───────────────────────────────────────────────────────────

  function sendShot() {
    var dataUrl;
    try { dataUrl = inst.captureDataURL(960); } catch (e) { return; }
    var d = inst.diag();
    var body = JSON.stringify({
      png: dataUrl,
      meta: {
        view: d.view, ratio: d.ratio, preset: inst.label || presetLabel,
        fps: d.fps, gpuMs: d.gpuMs, canvas: d.canvas,
        grid: [d.cols, d.rows], url: location.href,
        mode: d.mode, textMs: d.textMs, textFit: d.textFit,
        blackout: d.blackout, agent: d.agent
      }
    });
    try {
      // text/plain keeps this a CORS "simple request": no preflight, so the body
      // reaches the harness from the opaque file:// origin.
      fetch(endpoint + '/shot', {
        method: 'POST', mode: 'cors', cache: 'no-store',
        headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: body
      }).catch(function () { /* best-effort */ });
    } catch (e) { /* ignore */ }
  }

  if (wantShot) {
    setTimeout(sendShot, 2000);
    setInterval(sendShot, shotEvery);
  }

  // ── Bench ─────────────────────────────────────────────────────────────────
  // Warm up first: first-use pipeline compiles and texture uploads would land in
  // the first samples and poison p95.

  if (benchFrames) {
    setTimeout(function () {
      inst.bench(benchFrames).then(function (res) {
        benchEl.style.display = 'block';
        benchEl.textContent =
          'bench ' + res.frames + 'f  p50 ' + res.p50.toFixed(3) +
          '  p95 ' + res.p95.toFixed(3) + '  mean ' + res.mean.toFixed(3) +
          '  (' + res.fps.toFixed(1) + ' fps, cpu ' + res.cpuMs.toFixed(2) + ' ms)';
        report(payload('bench', { bench: res }));
        document.title = 'bench p50=' + res.p50 + ' p95=' + res.p95 + ' fps=' + res.fps;
      });
    }, 1500);
  }
})();
