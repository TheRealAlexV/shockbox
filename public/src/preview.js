/* ShockBox module previews — one component, every module, one shape.
 *
 * WHY THIS FILE EXISTS
 * Every module pane used to draw its own idea of "preview": the wall pane built a 9:16 drag
 * plane plus a cut-out window; the handfx, notifications and dialogs panes each guessed. The
 * operator reported the wall's preview as "far too tall, looks like three 16:9s stacked" — which
 * is exactly what a 9:16 portrait box drawn at its natural height inside a pane does.
 *
 * THE FIX IS GEOMETRY, NOT A HEIGHT CAP
 * One frame, one aspect: every module preview renders into a 16:9 box (the LED wall's real
 * picture). Inside that box the *content layer* — the module's own look — is drawn as a
 * **9:16 window**: the portrait strip that actually reaches the phone/TikTok crop. The frame is
 * never taller than 0.5625 × its width, so no pane can grow a portrait column that scrolls off
 * the screen, and every module is the same shape at the same size in the same place.
 *
 *   ┌─ frame (16:9, the wall picture) ────────────────┐
 *   │  ╎━━━━━━━━┃━━━━━━━━━━━━╎                        │
 *   │  ╎ portrait ┃ 9:16 window ╎  ← the fence        │
 *   │  ╎  content  ┃ (what OBS shows)                 │
 *   └─────────────────────────────────────────────────┘
 *
 * The window is a real cut-out: content inside it is drawn at full strength, everything outside
 * is dimmed (and can be more dimmed with the dim slider), so "what leaves the crop" is obvious
 * without a second thumbnail.
 *
 * USAGE (module panes)
 *
 *   import { mountPreview } from '/public/src/preview.js';   // shell resolves the URL
 *
 *   const pv = mountPreview(container, {
 *     title: 'Wall preview',
 *     hint: '2560 × 1440 · drag to move',
 *     fence: { x: 0.41, w: 0.18 },     // optional: window left/width as fractions of the frame
 *     interactive: true,               // optional: enables pointer drag of the fence
 *     onFence(rect) {},                // optional: called on drag end with {x, w}
 *   });
 *   pv.setLook({ palette: ['#0ff', '#f0f', '#ff0'], brightness: 1, speed: 1, pattern: 'wave' });
 *   pv.setLayer(el('div', …));         // the module's own preview markup, drawn in the window
 *   pv.setBadge('live');               // small status word in the header, e.g. online/offline
 *   const stop = pv.start();           // start the heartbeat; returns a cleanup
 *
 * `setLayer` is the whole point: a module keeps its own drawing code and hands the element over.
 * The component owns shape, scale, fencing, dimming and the header — never the module's look.
 *
 * Path note: pane modules are served from /mod/<id>/, and this file from /public/src/preview.js,
 * so import it with the absolute-relative URL the shell uses for shared helpers.
 */

import { el, clear } from './ui.js';

/** Frame aspect: the LED wall's real picture. Never changes — that is the contract. */
export const FRAME_ASPECT = 16 / 9;
/** The portrait crop every module must survive. */
export const WINDOW_ASPECT = 9 / 16;

const DEFAULT_FENCE = { x: 0.41015625, w: 0.1796875 }; // 9:16 · 720px of 1280, centred

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Patterns get a *shape* class so plain-CSS previews still read differently per pattern. Keeping
 * the mapping here (not per pane) is what makes the look comparable across modules.
 */
const PATTERN_SHAPES = ['wave', 'bars', 'dots', 'sweep', 'plasma'];

export function shapeFor(pattern) {
  const p = String(pattern || 'wave');
  return PATTERN_SHAPES.includes(p) ? p : PATTERN_SHAPES[hashStr(p) % PATTERN_SHAPES.length];
}

export function mountPreview(host, opts = {}) {
  if (!host) throw new Error('mountPreview: host element required');
  const {
    title = 'preview',
    hint = '',
    fence = DEFAULT_FENCE,
    interactive = false,
    dim = 0.55,
    onFence = null,
    badge = '',
  } = opts;

  // start as 'unknown' rather than 16:9: the module tells us on the first paint, and defaulting
  // to windowed keeps a briefly-visible wrong mode from flashing the whole picture first
  let fenceRect = { ...(fence || DEFAULT_FENCE) };
  let dimValue = clamp(Number(dim) || 0, 0, 1);
  let userDim = dimValue; // what the slider remembers before a blackout forces 1
  let running = false;
  let raf = 0;
  // whether the window is part of the picture at all: false = the module shows its whole surface
  // (a whole 16:9 wall), so there is no crop to fence and nothing to dim
  let fenceOn = opts.fence !== false && opts.windowed !== false;
  // the pane paints 'windowed' until told otherwise: a whole-wall flash on mount reads as the
  // bug being reported, so the safe default is the window''
  // false until the module supplies a rect: the default window is drawn so the pane is never
  // blank, but callers can tell 'default' from 'placed'
  // 'placed' means the owning module supplied the rect. A 9:16 wall opens windowed before its
  // first frame arrives, and the pane still needs a window to drag, so the default rect counts
  // as placed unless the module says otherwise.
  let fenceReady = opts.placed !== false && Number.isFinite(fence?.w) && fence.w > 0;

  const frame = el('div', { class: 'pv-frame', 'aria-label': 'module preview' });
  const lookEl = el('div', { class: 'pv-look', 'aria-hidden': 'true' });
  const dotsEl = el('div', { class: 'pv-dots', 'aria-hidden': 'true' });
  const layer = el('div', { class: 'pv-layer' });
  const frameTag = el('span', { class: 'pv-tag mono', text: '16:9' });
  frame.append(lookEl, dotsEl, layer, frameTag);

  // The window is a cut-out ring drawn OVER the frame, and the module's layer is lifted INTO the
  // window's area by a second layer placed after the shade — so the inside of the window reads at
  // full strength while everything outside it is veiled. The frame's own layer is the veil target.
  // The shade hangs on the frame, above the frame's layer and BELOW the lit copy. A child of the
  // window would be clipped to the hole it is meant to cut.
  const shade = el('div', { class: 'pv-shade', 'aria-hidden': 'true' });
  const win = el('div', { class: 'pv-window' });
  const winLabel = el('span', { class: 'pv-winlabel mono', text: '9:16' });
  const grip = el('div', { class: 'pv-grip', 'aria-hidden': 'true' });
  // an overlay module (notifications, dialogs) has no crop to offer: the label says so and the
  // grip is absent, so nobody drags a window that the module will not honour
  if (opts.windowed === false) {
    winLabel.textContent = 'overlay';
    win.append(winLabel);
  } else {
    win.append(winLabel, grip);
  }

  // `.pv-layer` is the module's content and lives INSIDE the window, sized to it — that is where
  // "what the stream shows" is drawn. The copy outside it is the same content drawn to the whole
  // frame and veiled, so the operator still sees what is being cut off, just at reduced strength.
  const layerIn = el('div', { class: 'pv-layer pv-layer-in' });
  const layerOut = el('div', { class: 'pv-layer pv-layer-out', 'aria-hidden': 'true' });
  frame.append(layerOut, shade);

  // the lit layer is parented to the window so the module's content is positioned in the crop's
  // own coordinates (0..w, 0..h), not the frame's — a module that draws a text block 'centred'
  // then draws it centred in the window, which is what the stream actually renders
  win.append(layerIn);
  frame.append(win);
  // the stage is a query container: its own size drives the frame's, and a container whose size
  // depends on its content re-enters layout (a ResizeObserver loop). See `container-type` in
  // preview.css.
  const stage = el('div', { class: 'pv-stage' }, frame);

  const badgeEl = el('span', { class: 'pv-badge' });
  const dimOut = el('span', { class: 'pv-dimout mono dim', text: '' });
  const dimSlider = el('input', { type: 'range', min: '0', max: '100', step: '1', class: 'pv-dim', 'aria-label': 'dim outside the window' });
  dimSlider.value = String(Math.round(dimValue * 100));

  const headRight = el('div', { class: 'pv-headright' });
  if (interactive) {
    headRight.append(
      el('label', { class: 'pv-dimwrap mono', title: 'how dark everything outside the 9:16 window reads' },
        el('span', { class: 'dim', text: 'dim' }),
        dimSlider,
        dimOut,
      ),
    );
  }
  if (badge) {
    badgeEl.textContent = badge;
    headRight.append(badgeEl);
  }

  const panel = el('section', { class: 'pv panel', 'data-compact': 'true' },
    el('div', { class: 'pv-head panel-head' },
      el('span', { class: 'panel-title', text: title }),
      hint ? el('span', { class: 'panel-hint mono dim', text: hint }) : null,
      headRight,
    ),
    stage,
  );
  clear(host);
  host.append(panel);

  /* ---------------------------------------------------------------- geometry */

  // The frame's border, in CSS px: the picture is the frame's inner box and the geometry below is
  // written for the picture, so this is the one number that turns one into the other.
  const FRAME_HAIR = 1;

  function layout() {
    // The frame is ALWAYS 16:9 and as wide as the stage allows. Every child's size is written in
    // px here from ONE number: the width the frame is about to get, so neither the pane's height
    // nor the fence's position can make the component taller than 0.5625·width.
    // Nothing may depend on the frame's own measured width or height, because the window is a
    // child of the frame — reading it back is circular, and a cap on the frame under
    // `aspect-ratio` makes the engine resolve the frame's width FROM the frame's height, which the
    // window controls. That loop is what pinned the frame at a stale width (two pixels narrow, or
    // frozen entirely once the pane grew past the cap). The stage's width is the only independent
    // measurement: it is never derived from anything inside the frame.
    const avail = stage.clientWidth || 0;
    // Cap: 64vw, i.e. a 16:9 frame under ~36vh. A share of the viewport, matching the old CSS.
    const cap = (window.innerWidth || avail) * 0.64;
    // whole pixels: the frame's width sets the window's height, so a fractional width (921.6px)
    // lands the two boxes on different sub-pixel rows and every measurement drifts by a fraction
    const frameW = Math.max(80, Math.floor(avail ? Math.min(avail, cap) : cap));
    // `frameW` is the PICTURE's width — the inner box, inside the two hairlines. The frame is
    // border-box, so its own width is that plus the border; capping it at the picture width would
    // shrink the picture by the border and drift every screen-px → wall-px conversion.
    const hair = FRAME_HAIR;
    frame.style.maxWidth = `${(frameW + 2 * hair).toFixed(2)}px`;
    const w = fenceRect.w ?? DEFAULT_FENCE.w;
    const x = clamp(fenceRect.x ?? DEFAULT_FENCE.x, 0, 1 - w);
    // left/width in px off frameW, like the height: a percentage of the frame is fine in CSS but
    // `height` is already px here, and mixing the two made the ratio drift by the border width
    // the frame's picture is its width minus the two hairlines, so a percentage of the frame
    // overflows the picture by the border; the window is sized off the inner box instead, and the
    // window's border is outside its size (`box-sizing: content-box`) so the picture it crops is
    // exactly the width/height written here
    const innerW = Math.max(1, frameW);
    win.style.left = `${(x * innerW).toFixed(2)}px`;
    win.style.width = `${(w * innerW).toFixed(2)}px`;
    // height in px from that width, so the window never asks the frame for its height
    const winH = frameW > 0 ? Math.floor((innerW * w) / WINDOW_ASPECT) : 0;
    if (winH > 0) win.style.height = `${winH.toFixed(2)}px`;
    win.style.setProperty('--pv-dim', String(dimValue.toFixed(3)));
    // vertical placement: `top` is the wall-space top of the window as a fraction of the PICTURE's
    // height. The picture is the wall's own 16:9 frame (WALL_H = 1440 px) while the window is the
    // wall's height spread over its 9:16 width — 16/9 of the picture — so the window's height has
    // to be scaled back to the picture's before `y` (a wall fraction) is applied to it. Without
    // that, `y` moved the window 3.2× too far and pushed it out of the frame's bottom edge.
    const frameH = (frameW * 9) / 16;
    if (frameH > 0) {
      const topPx = (fenceRect.y ?? 0) * frameH;
      win.style.top = `${topPx.toFixed(2)}px`;
      win.style.translate = 'none';
    }
    // A 9:16 window is taller than the 16:9 picture it is cut from: only the strip inside the
    // picture is lit, the rest of the window would sit over the frame's own crop. The frame clips
    // it, so the component reserves that hidden height below the frame — the frame itself keeps
    // its 16:9 box, and the pane's layout doesn't have to know about the crop at all.
    const hiddenH = Math.max(0, winH - (frameW * 9) / 16);
    stage.style.setProperty('--pv-crop', `${Math.round(hiddenH)}px`);
    win.dataset.overhang = hiddenH > 0.5 ? '1' : '0';
    if (!fenceOn) {
      // No window: nothing to cut out, so the whole picture is undimmed. A ring with a hole in
      // it still reads as a frame-wide veil, which is not what "whole wall" means.
      shade.style.display = 'none';
      win.style.display = 'none';
      dimOut.textContent = '';
      return;
    }
    shade.style.display = 'block';
    // explicit, not the empty string: clearing it falls back to the stylesheet, where the window
    // defaults to hidden, and the next layout pass would blank it
    win.style.display = 'block';
    // the shade's polygon is expressed in the FRAME's coordinates, so the window's left/width
    // and its overhang are converted once here instead of being duplicated in CSS
    const stageRect = frame.getBoundingClientRect();
    const winRect = win.getBoundingClientRect();
    if (stageRect.width > 0 && winRect.width > 0) {
      const x0 = ((winRect.left - stageRect.left) / stageRect.width) * 100;
      const x1 = ((winRect.right - stageRect.left) / stageRect.width) * 100;
      const y0 = ((winRect.top - stageRect.top) / stageRect.height) * 100;
      const y1 = ((winRect.bottom - stageRect.top) / stageRect.height) * 100;
      shade.style.setProperty('--pv-x0', `${x0.toFixed(3)}%`);
      shade.style.setProperty('--pv-x1', `${x1.toFixed(3)}%`);
      shade.style.setProperty('--pv-y0', `${y0.toFixed(3)}%`);
      shade.style.setProperty('--pv-y1', `${y1.toFixed(3)}%`);
      layerIn.style.setProperty('--pv-lit-w', `${winRect.width.toFixed(2)}px`);
      layerIn.style.setProperty('--pv-lit-h', `${winRect.height.toFixed(2)}px`);
    }
    dimOut.textContent = `${Math.round(dimValue * 100)}%`;
  }

  // ONE observer, coalesced: the layout writes px onto the frame and the window, and a loop that
  // re-reads those boxes synchronously can trip the "undelivered notifications" error. Deferring
  // the lay out to the next task means a burst of size changes is one pass, and the pass always
  // runs after the current one finished — no loop, by construction.
  let roQueued = false;
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (roQueued) return;
          roQueued = true;
          queueMicrotask(() => {
            roQueued = false;
            layout();
          });
        })
      : null;
  ro?.observe(stage);

  /* -------------------------------------------------------------------- drag */

  let drag = null;

  function fenceToFractions(px, frameRect) {
    return {
      x: clamp(px.x / Math.max(1, frameRect.width), 0, 1),
      w: clamp(px.w / Math.max(1, frameRect.width), 0.02, 1),
    };
  }

  function onPointerDown(e) {
    if (!interactive || e.button !== 0) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width) return;
    const x = (e.clientX - rect.left) / rect.width;
    const grabbing = interactive && (e.target === grip || e.target === win || win.contains(e.target));
    drag = {
      kind: grabbing ? 'move' : 'create',
      startX: x,
      startRect: { ...fenceRect },
      rect,
      pointerId: e.pointerId,
    };
    // A pointer capture keeps the drag alive over the shade (which is pointer-events:none) and
    // past the frame's edge; without it a fast drag loses the pointer and sticks mid-move.
    try { frame.setPointerCapture(e.pointerId); } catch { /* not critical */ }
    frame.dataset.dragging = 'true';
    e.preventDefault();
  }

  // late-bound so a module can attach onFenceMove after mount
  let api = null;

  /** True while the pointer is down on the frame — modules use this to ignore server echoes. */
  function isDragging() {
    return Boolean(drag);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { rect } = drag;
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    // report every move so a module can live-preview the wall while the operator drags; the
    // release still calls onFence once with the final rect (the commit boundary)
    if (drag.kind === 'create') {
      // drag out a new window from the press point; width drives the 9:16 height
      const a = drag.startX;
      const left = Math.min(a, x);
      const w = Math.max(0.04, Math.abs(x - a));
      fenceRect = { x: clamp(left, 0, 1 - w), w };
    } else {
      const dx = x - drag.startX;
      fenceRect = {
        x: clamp(drag.startRect.x + dx, 0, 1 - drag.startRect.w),
        w: drag.startRect.w,
      };
    }
    layout();
    // report only once the rect is final for this move, so a module never sees a half-built
    // fence (the wall's commit path reads x/y/w/h together)
    if (typeof api?.onFenceMove === 'function') api.onFenceMove({ ...fenceRect });
  }

  function onPointerUp(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    try { frame.releasePointerCapture(drag.pointerId); } catch { /* already gone */ }
    frame.dataset.dragging = 'false';
    const moved = drag.kind === 'create' || Math.abs((fenceRect.x ?? 0) - (drag.startRect.x ?? 0)) > 0.0004;
    const out = { ...fenceRect };
    drag = null;
    if (moved && typeof onFence === 'function') onFence(out);
  }

  if (interactive) {
    frame.tabIndex = 0;
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('pointermove', onPointerMove);
    frame.addEventListener('pointerup', onPointerUp);
    frame.addEventListener('pointercancel', onPointerUp);
    // arrow keys nudge by one cell-width so the fence is placeable without a fine drag
    frame.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.005;
      let dx = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // height is derived from width, so up/down resizes the window like the grip does
        const grow = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? 1 : -1;
        fenceRect.w = clamp((fenceRect.w ?? DEFAULT_FENCE.w) + grow * step, 0.04, 1);
        fenceRect.x = clamp(fenceRect.x ?? DEFAULT_FENCE.x, 0, 1 - fenceRect.w);
        layout();
        if (typeof onFence === 'function') onFence({ ...fenceRect });
        e.preventDefault();
        return;
      }
      if (!dx) return;
      fenceRect.x = clamp((fenceRect.x ?? DEFAULT_FENCE.x) + dx, 0, 1 - (fenceRect.w ?? DEFAULT_FENCE.w));
      layout();
      if (typeof onFence === 'function') onFence({ ...fenceRect });
      e.preventDefault();
    });
    dimSlider.addEventListener('input', () => {
      userDim = clamp(Number(dimSlider.value) / 100, 0, 1);
      dimValue = userDim;
      layout();
    });
  }
  layout();

  /** Whether a real rect has been placed yet (vs. the default window shown before the first doc). */
  function hasFence() {
    // a refusably-windowed component (an overlay) never claims a fence
    if (opts.windowed === false) return false;
    return Boolean(fenceReady);
  }

  /* ---------------------------------------------------------------- look */

  /**
   * Paint the module's look into the frame: palette (array of CSS colours), brightness, speed and
   * pattern. This is a preview, not the engine — it is a graded gradient, a dot lattice, and a
   * drift whose period follows `speed`, which is enough to read "which look is this" and matches
   * the wall pane's visual language so the two cannot disagree about what a pattern looks like.
   */
  function setLook(look = {}) {
    const pal = Array.isArray(look.palette) && look.palette.length >= 2
      ? look.palette
      : ['#6ff7ff', '#b18cff', '#ff7ad9'];
    lookEl.style.setProperty('--pv-a', pal[0]);
    lookEl.style.setProperty('--pv-b', pal[Math.min(1, pal.length - 1)]);
    lookEl.style.setProperty('--pv-c', pal[Math.min(2, pal.length - 1)]);
    const bright = clamp(Number(look.brightness ?? 1), 0, 2);
    const sat = clamp(Number(look.saturation ?? 1), 0, 2);
    const speed = Number(look.speed ?? 1);
    lookEl.style.setProperty('--pv-bright', String(bright));
    lookEl.style.setProperty('--pv-sat', String(sat));
    lookEl.style.setProperty('--pv-dur', `${clamp(18 / Math.max(0.15, speed), 4, 120)}s`);
    dotsEl.style.opacity = String(clamp(0.25 + bright * 0.5, 0.12, 1));
    if (look.blackout) {
      panel.dataset.blackout = 'true';
      dimValue = 1;
    } else {
      delete panel.dataset.blackout;
      dimValue = userDim;
    }
    stage.dataset.shape = shapeFor(look.pattern);
    layout();
  }

  /** Hand the module's own markup over to be drawn inside the 9:16 window. */
  function setLayer(node) {
    clear(layer);
    clear(layerIn);
    clear(layerOut);
    if (!node) return;
    layerIn.append(node);
    if (node.cloneNode) {
      const copy = node.cloneNode(true);
      copy.classList?.add('pv-dim-copy');
      layerOut.append(copy);
    }
  }

  /** A status word in the header: 'live', 'offline', 'not connected'… */
  function setBadge(text, tone = '') {
    badgeEl.textContent = text || '';
    if (tone) badgeEl.dataset.tone = tone;
    else delete badgeEl.dataset.tone;
    badgeEl.hidden = !text;
  }

  /** Show or hide the 9:16 window (and its dim ring) — the whole-wall vs windowed mode. */
  function setFenceVisible(on) {
    fenceOn = Boolean(on);
    layout();
    // the window's display flips here, and layout() runs in the same frame as the flip, so the
    // window can still measure 0 — settle it on the next frame instead of trusting one pass
    requestAnimationFrame(layout);
  }

  /** Move the window programmatically (fractions of the frame's width). */
  function setFence(next) {
    fenceRect = { ...fenceRect, ...(next || {}) };
    if (Number.isFinite(fenceRect.w) && fenceRect.w > 0) fenceReady = true;
    layout();
  }

  /**
   * Heartbeat: recompute the window's pixel height on every frame for a moment after mount, so a
   * pane that styles the frame after the first layout (fonts, a scrollbar appearing) cannot leave
   * the window at a stale height. Cheap and self-cancelling: two frames.
   */
  function start() {
    if (running) return stop;
    running = true;
    let ticks = 2;
    const tick = () => {
      if (!running) return;
      layout();
      if (ticks-- > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return stop;
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    if (interactive) {
      frame.removeEventListener('pointerdown', onPointerDown);
      frame.removeEventListener('pointermove', onPointerMove);
      frame.removeEventListener('pointerup', onPointerUp);
      frame.removeEventListener('pointercancel', onPointerUp);
    }
  }

  /**
   * Turn the wall's grade off, leaving only the module's own layer.
   *
   * A pane whose picture is not an LED wall (hand fx draws hands on a black stage) still mounts
   * this component for its frame and crop, and must not get a palette gradient behind its content:
   * the slot would read as "the wall" while showing something else. Quiet mode keeps the frame,
   * the window, the crop and the layer, and drops the look and the lattice.
   */
  function quiet(on = true) {
    panel.dataset.quiet = on ? 'true' : 'false';
    layout();
  }

  /** Restore the user's dim after a blackout lifted. */
  function setDim(v) {
    userDim = clamp(Number(v) || 0, 0, 1);
    dimValue = panel.dataset.blackout ? 1 : userDim;
    dimSlider.value = String(Math.round(userDim * 100));
    layout();
  }

  setLook(opts.look || {});
  setBadge(badge, opts.badgeTone || '');

  // `api` is the live surface the module may mutate after mount (onFenceChange/onFenceMove…) —
  // returning it here keeps later subscribers assignable without re-mounting the component
  api = { el: panel, frame, window: win, layer, setLook, setLayer, setBadge, setFence, setFenceVisible, hasFence, setDim, quiet, layout, start, stop };
  // a plain read, kept in sync with the API so callers can branch without re-deriving the rect
  Object.defineProperty(api, 'fenceReady', { get: () => hasFence() });
  if (typeof onFence === 'function') api.onFenceChange = onFence;

  return api;
}

/**
 * The merged overview: every module's preview in one composite, drawn as one wall with every
 * module's layer stacked in the window. This is what the "all modules" view renders — it answers
 * "what will the stream actually look like", which no single module pane can.
 *
 * @param {HTMLElement} host
 * @param {object} opts  { layers: [{id,title,tone}], onToggleLayer }
 */
export function mountMergedPreview(host, opts = {}) {
  const layers = opts.layers || [];
  const enabled = new Set(layers.map((l) => l.id));
  const pv = mountPreview(host, {
    title: 'all modules · merged',
    hint: 'every effect and overlay in one 16:9 frame',
    dim: 0.72,
  });

  const stack = el('div', { class: 'pv-stack' });
  pv.setLayer(stack);

  const chips = el('div', { class: 'pv-chips' });
  const nodeFor = new Map();

  function paintStack() {
    clear(stack);
    for (const l of layers) {
      if (!enabled.has(l.id)) continue;
      const node = el('div', { class: 'pv-slot', 'data-layer': l.id, 'data-tone': l.tone || '' });
      nodeFor.set(l.id, node);
      stack.append(node);
    }
    opts.onPaintLayer?.(nodeFor, enabled);
  }

  for (const l of layers) {
    const chip = el('button', { class: 'pv-chip', type: 'button', 'aria-pressed': 'true' }, l.title || l.id);
    chip.addEventListener('click', () => {
      if (enabled.has(l.id)) enabled.delete(l.id);
      else enabled.add(l.id);
      chip.setAttribute('aria-pressed', String(enabled.has(l.id)));
      paintStack();
      opts.onToggleLayer?.(l.id, enabled.has(l.id));
    });
    chips.append(chip);
  }
  pv.el.querySelector('.pv-head')?.append(chips);
  paintStack();
  return { ...pv, nodeFor, enabled, repaint: paintStack, isDragging, window: win, frame };
}
