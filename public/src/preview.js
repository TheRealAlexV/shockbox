/* ShockBox module previews — one component, every module, one live picture.
 *
 * WHY THIS FILE EXISTS
 * Panes used to redraw their module's look in plain DOM, so wall gradients, dialog skins and
 * HandFX never appeared. This component mounts the module's real page in an iframe and gives it
 * the one shape every pane shares.
 *
 * THE RULE IS GEOMETRY
 * One frame, one aspect: the preview cell's full width, aspect-ratio 16/9. The page fills that
 * frame at 100% x 100%, so it scales with the cell instead of sitting in a fixed pixel box and
 * nothing is stretched. The 9:16 window is an app-side crop guide drawn over the page (the wall's
 * OBS window); it never changes the page's own size.
 *
 * The iframe is inert: no pointer, no focus, no scrollbars. It is created once per pane and
 * re-attached or resized, never recreated per tick.
 *
 * USAGE (module panes)
 *
 *   import { mountPreview } from '/src/preview.js';   // shell resolves the URL
 *
 *   const pv = mountPreview(container, {
 *     title: 'Wall preview',
 *     hint: '2560 × 1440',
 *     src: '/wall/render?scale=1',     // the module's real page, in an iframe
 *     shape: 'frame',                  // 'frame' = the 16:9 wall picture; 'window' = the 9:16 crop
 *     fence: { x: 0.41, w: 0.18 },     // optional: window left/width as fractions of the frame
 *     interactive: true,               // optional: enables pointer drag of the fence
 *     onFence(rect) {},                // optional: called on drag end with {x, w}
 *   });
 *   pv.setBadge('live');               // small status word in the header, e.g. online/offline
 *   const stop = pv.start();           // start the heartbeat; returns a cleanup
 *
 * The iframe is the whole point: the module draws itself, and this component never guesses its
 * look. The component owns shape, scale, fencing, dimming and the header.
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

/** Pattern names still map to a stable shape word; the show preview reads it for its wall tag. */
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
    // The module's real page. It is the preview: nothing here redraws the module's look.
    src = '',
    // 'frame' fills the 16:9 wall picture; 'window' fills the 9:16 crop an overlay page draws in.
    shape = 'frame',
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
  // The module's own page, in an iframe: the preview is the real document, not a redrawing of it.
  // Created once per mount; the paint path below never touches it, so a pane repaint cannot
  // reload the page underneath the operator. Inert by construction — no pointer, no focus, no
  // scrollbars — so every drag and press comes from the pane's own controls.
  const iframe = src
    ? el('iframe', {
        class: 'pv-iframe',
        src,
        title: `${title} — live page`,
        scrolling: 'no',
        tabindex: '-1',
        inert: '',
        'aria-hidden': 'true',
        sandbox: 'allow-scripts allow-same-origin allow-forms',
        allow: 'camera; microphone; autoplay',
      })
    : null;
  if (iframe) iframe.setAttribute('loading', 'eager');
  const frameTag = el('span', { class: 'pv-tag mono', text: '16:9' });
  frame.append(frameTag);

  // The window is a crop guide drawn over the live page: the shade veils everything outside it,
  // so "what leaves the crop" is obvious at full page strength inside.
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

  // `shape: 'window'` means the page itself is the 9:16 crop (an overlay at 405×720), so it goes
  // inside the window; the wall's 16:9 page fills the frame and the window is the OBS crop drawn
  // over it. The shade hangs on the frame, above the iframe and below the window ring.
  if (iframe) (shape === 'window' ? win : frame).append(iframe);
  frame.append(shade, win);
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
    // The frame itself is CSS: width:100%; aspect-ratio:16/9. No pixel box is written here, so
    // the picture is the preview cell's full canvas and the iframe scales with it. The stage is
    // the only independent measurement, and it never depends on anything inside the frame.
    const frameW = Math.max(80, Math.floor(stage.clientWidth || 0));
    const w = fenceRect.w ?? DEFAULT_FENCE.w;
    const x = clamp(fenceRect.x ?? DEFAULT_FENCE.x, 0, 1 - w);
    // The fence overlay is the only px geometry: percentages would include the frame hairline in
    // the wall→screen mapping. The iframe below it is 100% × 100%.
    win.style.left = `${(x * 100).toFixed(3)}%`;
    win.style.width = `${(w * 100).toFixed(3)}%`;
    // height in px from that width, so the window never asks the frame for its height
    const winH = frameW > 0 ? Math.floor((frameW * w) / WINDOW_ASPECT) : 0;
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

  /**
   * Replace the previewed page (a rare, explicit choice: Hand FX's underlay, for instance). The
   * iframe is the same node; only its `src` changes, so a pane that repaints is not rebuilding it.
   */
  function setSrc(next) {
    if (!iframe || !next || iframe.getAttribute('src') === next) return;
    iframe.setAttribute('src', next);
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

  /** Hush the frame's chrome for a pane whose page is not an LED wall. */
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

  setBadge(badge, opts.badgeTone || '');

  // `api` is the live surface the module may mutate after mount (onFenceChange/onFenceMove…) —
  // returning it here keeps later subscribers assignable without re-mounting the component
  api = { el: panel, frame, window: win, iframe, setSrc, setBadge, setFence, setFenceVisible, hasFence, setDim, quiet, layout, start, stop };
  // a plain read, kept in sync with the API so callers can branch without re-deriving the rect
  Object.defineProperty(api, 'fenceReady', { get: () => hasFence() });
  if (typeof onFence === 'function') api.onFenceChange = onFence;

  return api;
}
