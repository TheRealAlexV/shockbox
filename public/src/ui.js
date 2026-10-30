// DOM helpers. Everything that takes server text goes through textContent (el({text})).
// No innerHTML with interpolation anywhere in this app.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  node.append(frag(...children));
  return node;
}

/** "14:02:11" for today, "Oct 3 14:02" otherwise. */
export function fmtWhen(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() === 0) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toTimeString().slice(0, 8);
  if (sameDay) return t;
  return `${d.toLocaleString(undefined, { month: 'short', day: 'numeric' })}, ${t.slice(0, 5)}`;
}

/** small relative "3s ago" for live lists */
export function fmtAgo(ts) {
  const t = Number(ts);
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** timestamps that tick: keep a live "ago" column fresh without re-rendering rows */
export function every(ms, fn) {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

export function debounce(fn, ms = 180) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/**
 * A button that runs an async action and reports pending -> ok/failed inline.
 * Never reports success unless the promise resolved.
 */
export function actionButton({ label, run, onDone, onError, variant = '', title = '', confirm: confirmText = '' }) {
  const btn = el('button', { type: 'button', class: `btn ${variant}`.trim(), title });
  const labelNode = el('span', { class: 'btn-label', text: label });
  const stateNode = el('span', { class: 'btn-state', 'aria-hidden': 'true' });
  btn.append(labelNode, stateNode);
  let busy = false;
  btn.addEventListener('click', async () => {
    if (busy) return;
    if (confirmText) {
      // Destructive: first click arms (label swaps to confirmText), second click fires.
      if (btn.dataset.armed !== 'true') {
        btn.dataset.armed = 'true';
        labelNode.textContent = confirmText;
        clearTimeout(btn._disarm);
        btn._disarm = setTimeout(() => {
          if (btn.dataset.armed === 'true') {
            delete btn.dataset.armed;
            labelNode.textContent = label;
          }
        }, 2500);
        return;
      }
      clearTimeout(btn._disarm);
      delete btn.dataset.armed;
      labelNode.textContent = label;
    }
    busy = true;
    btn.dataset.state = 'pending';
    btn.disabled = true;
    try {
      const out = await run();
      btn.dataset.state = 'ok';
      stateNode.textContent = '✓';
      onDone?.(out);
      setTimeout(() => {
        if (btn.dataset.state === 'ok') delete btn.dataset.state;
        stateNode.textContent = '';
      }, 1200);
    } catch (err) {
      btn.dataset.state = 'fail';
      stateNode.textContent = '✕';
      onError?.(err);
      setTimeout(() => {
        if (btn.dataset.state === 'fail') delete btn.dataset.state;
        stateNode.textContent = '';
      }, 2500);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
  return btn;
}

export function dot(tone = 'idle', title = '') {
  return el('span', { class: 'dot', 'data-tone': tone, title: title || null });
}

/** Inline spinner for a control that is busy but has no button state to show. */
export function spinner() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
}
