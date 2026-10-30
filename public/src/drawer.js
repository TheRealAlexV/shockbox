// Right-side Debug drawer: /health polled every 5 s (module statuses, SSE clients per channel,
// OBS state/scene, uptime) and the log tail from /api/log, coloured by level, filterable by scope.
//
// The drawer only polls while it is open; the top bar keeps its own /health poll for the status
// chips, so closing the drawer costs nothing.

import { el, clear, fmtWhen, dot } from './ui.js';

const POLL_MS = 5000;
const LOG_LIMIT = 200;
const LOG_SHOWN = 160;

export function startDrawer({ api, bus, onHealth }) {
  const body = document.getElementById('drawer-body');
  const ageEl = document.getElementById('drawer-age');
  const refreshBtn = document.getElementById('drawer-refresh');
  const drawerDot = document.getElementById('drawer-dot');

  let timer = null;
  let logTick = null;
  let lastAt = 0;
  let scopeFilter = 'all';
  let lastLines = [];
  let logError = null; // reported once; Refresh clears and retries
  let running = false;

  const healthBox = el('section', { class: 'dbg-section' });
  const logBox = el('section', { class: 'dbg-section dbg-log-section' });
  body.append(healthBox, logBox);
  renderHealthError({ message: 'waiting for the first poll…' });

  async function poll() {
    if (!running) return;
    // health and log are independent: a broken log endpoint must not blank the health block
    const [health, log] = await Promise.allSettled([
      api.get('/health'),
      logError ? Promise.reject(Object.assign(new Error(logError), { cached: true })) : api.get(`/api/log?limit=${LOG_LIMIT}`),
    ]);
    if (health.status === 'fulfilled') {
      lastAt = Date.now();
      onHealth?.(health.value);
      renderHealth(health.value);
      updateDot(health.value);
    } else {
      renderHealthError(health.reason);
      updateDot(null);
    }
    if (log.status === 'fulfilled') {
      lastLines = Array.isArray(log.value.lines) ? log.value.lines : [];
      renderLog();
    } else if (log.reason?.cached) {
      // already drawn; do not re-render every 5 s
    } else {
      logError = log.reason?.message || String(log.reason);
      renderLogError(logError);
    }
  }

  function updateDot(health) {
    if (!drawerDot) return;
    if (!health) {
      drawerDot.dataset.tone = 'bad';
      return;
    }
    const failed = Object.values(health.modules || {}).filter((s) => s !== 'up').length;
    drawerDot.dataset.tone = failed ? 'bad' : 'ok';
    drawerDot.title = failed ? `${failed} module(s) not up` : 'all modules up';
  }

  function renderHealth(h) {
    clear(healthBox);
    const mods = Object.entries(h.modules || {});
    const chans = Object.entries(h.channels || {});
    const obs = h.obs || {};
    const obsTone = obs.state === 'open' || obs.state === 'connected' ? 'ok'
      : obs.state === 'off' || obs.state === 'closed' || !obs.state ? 'idle' : 'warn';

    healthBox.append(
      el('div', { class: 'dbg-head' },
        el('span', { class: 'dbg-title', text: 'health' }),
        el('span', { class: 'drawer-spacer' }),
        el('span', { class: 'dbg-time mono dim', text: fmtWhen(Date.now()) }),
      ),
      el('div', { class: 'dbg-body' },
        el('dl', { class: 'dbg-kv' },
          el('dt', { text: 'uptime' }), el('dd', { text: fmtUptime(h.uptime) }),
          el('dt', { text: 'sse' }), el('dd', { text: `${h.clients ?? 0} client${h.clients === 1 ? '' : 's'}` }),
          el('dt', { text: 'obs' }),
          el('dd', {},
            el('span', { class: 'dot', 'data-tone': obsTone }),
            el('span', { text: ` ${obs.state || 'unknown'}` }),
            obs.scene ? el('span', { text: ' · ' }) : null,
            obs.scene ? el('span', { text: String(obs.scene) }) : null,
          ),
          el('dt', { text: 'pid' }), el('dd', { text: String(h.pid ?? '—') }),
          el('dt', { text: 'version' }), el('dd', { text: String(h.version ?? '—') }),
        ),
      ),
      el('div', { class: 'dbg-head dbg-sub' }, el('span', { class: 'dbg-title', text: 'modules' })),
      mods.length
        ? el('div', { class: 'dbg-body dbg-modules' }, mods.map(([id, status]) => el('div', { class: 'dbg-module', dataset: { status } },
          dot(status === 'up' ? 'ok' : status === 'failed' ? 'bad' : 'warn'),
          el('span', { class: 'dbg-module-name', text: id }),
          el('span', { class: 'dbg-module-state', text: status }),
        )))
        : el('div', { class: 'dbg-empty', text: 'no modules reported' }),
      el('div', { class: 'dbg-head dbg-sub' }, el('span', { class: 'dbg-title', text: 'sse clients' })),
      el('div', { class: 'dbg-body' },
        chans.length
          ? el('div', { class: 'dbg-ch' }, chans.map(([ch, n]) => el('span', { class: 'dbg-ch-chip' },
            el('span', { text: ch }), el('b', { text: String(n) }),
          )))
          : el('div', { class: 'dbg-empty', text: 'this page is the only client' }),
      ),
    );
  }

  function renderHealthError(err) {
    clear(healthBox);
    healthBox.append(
      el('div', { class: 'dbg-head' }, el('span', { class: 'dbg-title', text: 'health' })),
      el('div', { class: 'dbg-error', text: `poll failed: ${err?.message || err}` }),
    );
  }

  function renderLogError(msg) {
    clear(logBox);
    logBox.append(
      el('div', { class: 'dbg-head' }, el('span', { class: 'dbg-title', text: 'log' })),
      el('div', { class: 'dbg-error', text: `GET /api/log failed: ${msg}` }),
      el('div', { class: 'dbg-note', text: 'The server could not list its log buffer. Refresh retries; the health block above is unaffected.' }),
    );
  }

  function renderLog() {
    const lines = lastLines;
    const scopes = new Set();
    for (const l of lines) if (l && l.scope) scopes.add(l.scope);
    const scopeList = [...scopes].sort();
    if (scopeFilter !== 'all' && !scopeList.includes(scopeFilter)) scopeFilter = 'all';
    const shown = lines.filter((l) => scopeFilter === 'all' || l.scope === scopeFilter);

    clear(logBox);
    const head = el('div', { class: 'dbg-head' },
      el('span', { class: 'dbg-title', text: 'log' }),
      el('span', { class: 'drawer-spacer' }),
      el('span', { class: 'mono dim dbg-time', text: `${shown.length}/${lines.length}` }),
    );
    logBox.appendChild(head);

    const filter = el('div', { class: 'log-filter' });
    const sel = el('select', { class: 'input', 'aria-label': 'Filter log by scope' });
    sel.append(el('option', { value: 'all', text: 'all scopes' }));
    for (const s of scopeList) sel.append(el('option', { value: s, text: s }));
    sel.value = scopeFilter;
    sel.addEventListener('change', () => {
      scopeFilter = sel.value;
      renderLog();
    });
    filter.appendChild(sel);

    const list = el('ul', { class: 'log-list', role: 'log', 'aria-label': 'Server log' });
    for (const l of shown.slice(-LOG_SHOWN)) {
      list.appendChild(el('li', { class: 'log-line', dataset: { level: l.level || 'info' } },
        el('span', { class: 'log-time', text: String(l.at || '').slice(11, 19) }),
        el('span', { class: 'log-scope', text: l.scope || 'core', title: l.scope || 'core' }),
        el('span', { class: 'log-msg', text: l.msg || '' }),
      ));
    }
    if (!shown.length) filter.appendChild(el('span', { class: 'dbg-empty', text: 'nothing logged for this scope' }));
    logBox.append(filter, list);
    const scroller = document.querySelector('.drawer-body');
    if (scroller && scroller.scrollHeight - scroller.clientHeight < 80) scroller.scrollTop = scroller.scrollHeight;
  }

  function tickAge() {
    if (!ageEl) return;
    if (!lastAt) {
      ageEl.textContent = '';
      return;
    }
    const s = Math.max(0, Math.round((Date.now() - lastAt) / 1000));
    ageEl.textContent = `${s}s ago`;
  }

  refreshBtn?.addEventListener('click', () => {
    logError = null;
    lastAt = 0;
    tickAge();
    poll();
  });

  function start() {
    running = true;
    poll();
    clearInterval(timer);
    clearInterval(logTick);
    timer = setInterval(poll, POLL_MS);
    logTick = setInterval(tickAge, 1000);
    tickAge();
  }
  function stop() {
    running = false;
    clearInterval(timer);
    clearInterval(logTick);
    timer = null;
    logTick = null;
  }

  // a fresh SSE stream means the server came (back) up: poll immediately
  const unsub = bus.subscribe((p) => {
    if (p && p.hello && running) poll();
  });

  return { start, stop, poll, dispose: () => { stop(); unsub?.(); } };
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
