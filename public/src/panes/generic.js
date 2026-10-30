// Generic module pane: what a module gets when it has no hand-written pane in this shell
// (or when its ui.pane failed to load). It is a real pane, not a placeholder:
//
//   • live status strip polled from /health for this module
//   • the module's settings, generated from its `settings` metadata
//   • its pages as overlay links
//   • its HTTP routes, listed so the operator can see what it exposes
//
// Modules that later ship their own ui.pane simply get loaded instead of this.

import { el, clear, dot } from '../ui.js';
import { toast } from '../toast.js';
import { renderSettingsForm } from '../settings-form.js';

export async function render(container, ctx) {
  const { api, module: m, events, signal } = ctx;
  const unsubs = [];

  const header = el('div', { class: 'pane-head' });
  const headStatus = el('div', { class: 'pane-head-status' });
  header.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: m.title || m.id }),
      el('p', { class: 'pane-desc', text: m.description || 'This module does not ship its own control pane yet.' }),
    ),
    headStatus,
  );

  const strip = el('div', { class: 'gen-strip' });
  const sections = el('div', { class: 'pane-body' });

  const cards = el('div', { class: 'gen-cards' });

  // pages
  const pages = Array.isArray(m.pages) ? m.pages : [];
  const pagesCard = el('section', { class: 'gen-card' });
  pagesCard.append(el('h2', { class: 'gen-card-title', text: 'Overlay pages' }));
  if (pages.length) {
    const list = el('div', { class: 'gen-links' });
    for (const p of pages) {
      const route = typeof p === 'string' ? p : p.route;
      const title = typeof p === 'string' ? p : p.title || p.route;
      if (!route) continue;
      const link = el('a', { class: 'gen-link', href: route, target: '_blank', rel: 'noopener' });
      link.append(
        el('span', { class: 'gen-link-title', text: title }),
        el('span', { class: 'gen-link-go', text: 'open \u2197', 'aria-hidden': 'true' }),
      );
      const row = el('div', { class: 'gen-link-row' }, link,
        el('span', { class: 'gen-link-route mono dim', text: route }));
      list.appendChild(row);
    }
    pagesCard.appendChild(list);
  } else {
    pagesCard.appendChild(el('p', { class: 'gen-empty', text: 'No pages declared in module.json.' }));
  }

  // routes
  const routesCard = el('section', { class: 'gen-card' });
  routesCard.append(el('h2', { class: 'gen-card-title', text: 'API routes' }));
  const routesList = el('div', { class: 'gen-routes mono' });
  routesList.appendChild(el('div', { class: 'gen-empty', text: 'loading…' }));
  routesCard.appendChild(routesList);

  cards.append(pagesCard, routesCard);

  // a module's ui.style (if any) dresses its overlay pages; a settings form should not inherit it
  const settingsSlot = el('div', { class: 'pane-settings gen-settings' });

  sections.append(strip, cards, settingsSlot);
  clear(container);
  container.append(header, sections);

  /* ---------------------------------------------------------------- data */

  let form = null;
  const settings = { ...(m.settings || {}) };
  if (Object.keys(settings).length) {
    form = renderSettingsForm(settingsSlot, {
      settings,
      title: 'Settings',
      onSave: async (patch) => {
        const out = await api.patch(`/api/${m.id}/settings`, patch);
        if (out?.settings) Object.assign(ctx.settings, out.settings);
        return out;
      },
    });
  } else {
    settingsSlot.appendChild(el('div', { class: 'gen-card gen-card-quiet' },
      el('h2', { class: 'gen-card-title', text: 'Settings' }),
      el('p', { class: 'gen-empty', text: 'This module declares no settings.' }),
    ));
  }

  async function loadRoutes() {
    try {
      const r = await api.get(`/api/modules/${encodeURIComponent(m.id)}/routes`, { signal });
      clear(routesList);
      const routes = Array.isArray(r.routes) ? r.routes : [];
      if (!routes.length) {
        routesList.appendChild(el('div', { class: 'gen-empty', text: 'No routes.' }));
        return;
      }
      for (const rt of routes) {
        routesList.appendChild(el('div', { class: 'gen-route' },
          el('span', { class: 'gen-method', dataset: { m: rt.method || 'GET' }, text: rt.method || 'GET' }),
          el('span', { class: 'gen-path', text: rt.path || '' }),
        ));
      }
    } catch (err) {
      clear(routesList);
      routesList.appendChild(el('div', { class: 'gen-empty gen-empty-bad', text: `routes unavailable: ${err.message}` }));
    }
  }

  function paintStatus() {
    clear(headStatus);
    const up = m.status === 'up';
    headStatus.append(
      dot(up ? 'ok' : m.status === 'failed' ? 'bad' : 'warn'),
      el('span', { class: 'chip-label', text: m.status || 'unknown' }),
      m.version ? el('span', { class: 'mono dim', text: `v${m.version}` }) : '',
    );
    clear(strip);
    strip.append(
      stat('id', m.id),
      stat('status', m.status || '—'),
      stat('version', m.version || '—'),
      stat('channels', (m.channels || []).join(', ') || '—'),
      stat('pane', ctx.paneSource === 'fallback' ? 'generic' : String(ctx.paneSource || '—')),
    );
  }

  async function loadState() {
    try {
      const r = await api.get(`/api/modules/${encodeURIComponent(m.id)}/state`, { signal });
      const count = r?.state?.count ?? r?.state?.live?.length;
      if (count !== undefined) {
        strip.appendChild(stat('live', String(count)));
      }
    } catch {
      // modules without a state endpoint are normal; nothing to show
    }
  }

  paintStatus();
  await Promise.allSettled([loadRoutes(), loadState()]);

  // module status can change; the drawer polls /health, and `/health` includes module statuses,
  // so the strip is refreshed whenever the shell reports a new health poll.
  paintStatus();
  await Promise.allSettled([loadRoutes(), loadState()]);

  return () => {};
}

function stat(k, v) {
  return el('div', { class: 'gen-stat' },
    el('span', { class: 'gen-stat-k mono dim', text: k }),
    el('span', { class: 'gen-stat-v mono', text: String(v) }),
  );
}
