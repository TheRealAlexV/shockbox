// Generic settings form, generated from a module's `settings` metadata.
//
//   describe() shape per key: {type,label,group,min,max,step,values,help,value}
//   type: 'enum' | 'number' | 'boolean' | 'string' | 'array' | 'object' | 'text'
//
// Behaviour:
//   • controls apply on change (enum/boolean) or on blur/Enter (number/string)
//   • a range slider pairs with a number box for bounded numeric values
//   • the header toggle disables silent apply, adding an explicit Save
//   • failures are shown on the row that caused them, never swallowed
//   • values are validated locally first (min/max/enum)
//
// Layout is a two-column grid on wide panes (label | control); each group gets a full-width
// heading row so the settings read as sections, not one long list.

import { el, clear, actionButton } from './ui.js';
import { toast } from './toast.js';

const GROUP_ORDER = ['general', 'look', 'behaviour', 'timing', 'audio', 'advanced', 'obs', 'ratio', 'compat'];
const GROUP_LABEL = {
  general: 'General',
  look: 'Look',
  behaviour: 'Behaviour',
  timing: 'Timing',
  audio: 'Audio',
  advanced: 'Advanced',
  obs: 'OBS',
  ratio: 'Scenes & ratio',
  compat: 'Compatibility',
};

export function groupLabel(g) {
  return GROUP_LABEL[g] || (g ? `${g[0].toUpperCase()}${g.slice(1)}` : 'General');
}

/**
 * Render a settings form.
 * @param {HTMLElement} container
 * @param {{settings:object, onSave:Function, signal?:AbortSignal, title?:string, compact?:boolean}} opts
 *   onSave(patch) -> Promise of the PATCH response ({ok, changed, settings}).
 * @returns {{refresh(settings:object):void, omitRows(predicate):void, dispose():void}}
 */
export function renderSettingsForm(container, opts) {
  let current = { ...(opts.settings || {}) };
  let manual = false;
  clear(container);

  const rowsByKey = new Map();
  const body = el('div', { class: 'settings-rows' });
  const form = el('form', { class: 'settings-form', autocomplete: 'off' });
  form.addEventListener('submit', (e) => e.preventDefault());
  const head = el('div', { class: 'settings-head' });
  const autoToggle = el('label', { class: 'switch-inline', title: 'Apply changes immediately, or collect them and press Save' });
  const autoBox = el('input', { type: 'checkbox', checked: true });
  autoBox.addEventListener('change', () => {
    manual = !autoBox.checked;
    form.dataset.manual = manual ? 'true' : 'false';
    if (manual) head.appendChild(saveBtn);
    else saveBtn.remove();
  });
  autoToggle.append(autoBox, el('span', { text: 'apply immediately' }));

  let pendingPatch = {};
  const saveBtn = actionButton({
    label: 'Save',
    variant: 'btn-primary',
    run: async () => {
      const patch = pendingPatch;
      pendingPatch = {};
      return opts.onSave(patch);
    },
    onDone: (out) => {
      if (out && out.settings) applyValues(out.settings);
      for (const r of rowsByKey.values()) delete r.dataset.dirty;
      toast(out && Array.isArray(out.changed) && out.changed.length ? `saved: ${out.changed.join(', ')}` : 'settings saved', 'ok');
    },
    onError: (err) => toast(`save failed: ${err.message}`, 'error'),
  });

  head.append(
    el('span', { class: 'settings-title', text: opts.title || 'Settings' }),
    el('span', { class: 'settings-spacer' }),
    autoToggle,
  );

  const groups = new Map();
  for (const [key, meta] of Object.entries(current)) {
    const g = meta.group || 'general';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([key, meta]);
  }
  const order = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  let skip = () => false;
  const groupNames = new Map();
  const bareGroups = new Set();

  function build() {
    clear(body);
    rowsByKey.clear();
    if (!order.length) {
      body.appendChild(el('p', { class: 'pool-empty', text: 'This module declares no settings.' }));
      return;
    }
    for (const g of order) {
      const pairs = groups.get(g);
      if (!pairs || !pairs.length) continue;
      // a group whose every row the host draws itself is not a heading with nothing under it
      if (bareGroups.has(g) && !pairs.some(([key, meta]) => !skip(key, meta))) continue;
      body.appendChild(el('div', { class: 'settings-group' },
        el('span', { class: 'settings-group-title', text: groupNames.get(g) || groupLabel(g) })));
      for (const [key, meta] of pairs) {
        if (skip(key, meta)) continue;
        const row = makeRow(key, meta);
        rowsByKey.set(key, row);
        body.appendChild(row);
      }
    }
  }

  function applyValues(settings) {
    current = { ...current, ...(settings || {}) };
    for (const [key, meta] of Object.entries(settings || {})) {
      rowsByKey.get(key)?._setValue(meta.value ?? meta);
    }
  }

  async function commit(key, meta, value) {
    const row = rowsByKey.get(key);
    const shown = validate(meta, value);
    if (shown.error) {
      row._fail(shown.error);
      return;
    }
    row._clearError();
    if (manual) {
      pendingPatch[key] = shown.value;
      row.dataset.dirty = 'true';
      return;
    }
    row.dataset.busy = 'true';
    try {
      const out = await opts.onSave({ [key]: shown.value });
      delete row.dataset.dirty;
      if (out && out.settings && out.settings[key]) {
        current[key] = out.settings[key];
        row._setValue(out.settings[key].value);
      }
      row._ok();
    } catch (err) {
      row._fail(err.message || String(err));
      // snap back to the value the server last gave us
      row._setValue(current[key]?.value);
    } finally {
      delete row.dataset.busy;
    }
  }

  function makeRow(key, meta) {
    const row = el('div', { class: 'setting' });
    row.dataset.key = key;
    row.dataset.type = meta.type || 'string';
    const labelWrap = el('div', { class: 'setting-label-wrap' });
    const labelText = el('span', { class: 'setting-label', text: meta.label || key });
    const label = el('label', { for: `set-${key}` }, labelText, el('span', { class: 'setting-key', text: key }));
    labelWrap.appendChild(label);
    if (meta.help) labelWrap.appendChild(el('div', { class: 'setting-help', text: meta.help }));

    const control = el('div', { class: 'setting-control' });
    const errLine = el('div', { class: 'setting-error', role: 'alert' });
    row.append(labelWrap, control, errLine);

    let setValue = () => {};
    const type = meta.type || (typeof meta.value === 'number' ? 'number' : typeof meta.value === 'boolean' ? 'boolean' : 'string');

    if (type === 'enum') {
      const values = Array.isArray(meta.values) ? meta.values : [];
      const many = values.length > 5;
      const pick = many
        ? el('select', { class: 'input', id: `set-${key}` })
        : el('div', { class: 'segmented', role: 'radiogroup', id: `set-${key}` });
      if (many) {
        for (const v of values) pick.appendChild(el('option', { value: String(v), text: String(v) }));
        pick.addEventListener('change', () => commit(key, meta, pick.value));
      } else {
        for (const v of values) {
          const b = el('button', { type: 'button', class: 'seg', role: 'radio', text: String(v) });
          b.dataset.value = String(v);
          b.setAttribute('aria-checked', 'false');
          b.addEventListener('click', () => {
            for (const x of pick.children) x.setAttribute('aria-checked', String(x === b));
            commit(key, meta, v);
          });
          pick.appendChild(b);
        }
      }
      control.appendChild(pick);
      setValue = (val) => {
        if (many) {
          pick.value = String(val ?? '');
          return;
        }
        for (const x of pick.children) x.setAttribute('aria-checked', String(x.dataset.value === String(val)));
      };
      setValue(meta.value);
    } else if (type === 'boolean') {
      const wrap = el('label', { class: 'switch', for: `set-${key}` });
      const box = el('input', { type: 'checkbox', id: `set-${key}` });
      wrap.append(box, el('span', { class: 'switch-track', id: `set-${key}-track`, 'aria-hidden': 'true' }));
      box.addEventListener('change', () => commit(key, meta, box.checked));
      control.appendChild(wrap);
      setValue = (val) => {
        box.checked = !!val;
      };
      setValue(meta.value);
    } else if (type === 'number') {
      const min = meta.min;
      const max = meta.max;
      const step = meta.step ?? (meta.integer ? 1 : 'any');
      const hasRange = min !== undefined && max !== undefined && Number.isFinite(Number(min)) && Number.isFinite(Number(max));
      const box = el('input', { type: 'number', id: `set-${key}`, class: 'input input-num', inputmode: 'decimal' });
      if (min !== undefined) box.min = String(min);
      if (max !== undefined) box.max = String(max);
      box.step = String(step);
      let range = null;
      if (hasRange) {
        range = el('input', { type: 'range', 'aria-label': `${meta.label || key} slider` });
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        range.addEventListener('input', () => {
          box.value = range.value;
        });
        range.addEventListener('change', () => commit(key, meta, Number(range.value)));
        control.appendChild(range);
      }
      box.addEventListener('change', () => commit(key, meta, box.value === '' ? '' : Number(box.value)));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          box.blur();
        }
      });
      control.appendChild(box);
      setValue = (val) => {
        const v = val ?? '';
        box.value = String(v);
        if (range) range.value = String(v);
      };
      setValue(meta.value);
    } else if (type === 'array') {
      // A list of scalars (the wall's forced-scene names). Comma separated in the field, committed
      // as a real array: the schema validates element type, and a string here would 400.
      const input = el('input', { type: 'text', id: `set-${key}`, class: 'input' });
      const asList = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
      input.value = asList(meta.value);
      input.placeholder = meta.items === 'string' ? 'name, name, name' : 'a, b, c';
      input.addEventListener('change', () => {
        const items = input.value
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
        const v = meta.items === 'number' ? items.map(Number) : items;
        if (meta.items === 'number' && v.some((x) => Number.isNaN(x))) {
          row._fail('every entry must be a number');
          return;
        }
        commit(key, meta, v);
      });
      control.appendChild(input);
      setValue = (val) => {
        input.value = asList(val);
      };
      setValue(meta.value);
    } else {
      // only free-form text earns a textarea: an object or long string (a URL, a JSON blob)
      // renders as one tidy input instead of a two-line box inside a settings row
      const isLong = type === 'text';
      const input = isLong
        ? el('textarea', { id: `set-${key}`, class: 'input', rows: '2' })
        : el('input', { type: 'text', id: `set-${key}`, class: 'input' });
      const raw = (val) => (typeof val === 'string' ? val : JSON.stringify(val ?? null, null, type === 'string' ? 0 : 2));
      input.value = raw(meta.value);
      input.addEventListener('change', () => {
        let v = input.value;
        if (type === 'object' || type === 'json') {
          try {
            v = JSON.parse(v);
          } catch (err) {
            row._fail(`not valid JSON: ${err.message}`);
            return;
          }
        }
        commit(key, meta, v);
      });
      if (input.tagName === 'TEXTAREA') {
        control.style.alignItems = 'stretch';
        control.style.gridColumn = 'auto';
      }
      control.appendChild(input);
      setValue = (val) => {
        input.value = raw(val);
      };
      setValue(meta.value);
    }

    row._setValue = setValue;
    row._fail = (msg) => {
      row.dataset.error = 'true';
      errLine.textContent = msg;
    };
    row._clearError = () => {
      delete row.dataset.error;
      errLine.textContent = '';
    };
    row._ok = () => {
      row.dataset.saved = 'true';
      setTimeout(() => delete row.dataset.saved, 900);
    };
    return row;
  }

  build();
  form.append(head, body);
  container.appendChild(form);

  return {
    refresh(settings) {
      current = { ...(settings || {}) };
      for (const [key, meta] of Object.entries(current)) {
        rowsByKey.get(key)?._setValue(meta.value);
      }
    },
    /** Hide rows the host draws itself (a module can own a key's control and keep the schema row out). */
    omitRows(predicate) {
      skip = typeof predicate === 'function' ? predicate : () => false;
      build();
    },
    /** Retitle a schema group without touching the schema. */
    renameGroup(group, label) {
      groupNames.set(group, label);
      build();
    },
    /** Draw a group's heading only when it still has rows (a host that owns every key of it). */
    omitGroupRow(group) {
      bareGroups.add(group);
      build();
    },
    dispose() {},
  };
}

function validate(meta, value) {
  const type = meta.type || typeof value;
  if (type === 'number') {
    const n = Number(value);
    if (value === '' || value === null || Number.isNaN(n)) return { error: 'not a number' };
    if (meta.integer && !Number.isInteger(n)) return { error: 'must be a whole number' };
    if (meta.min !== undefined && n < meta.min) return { error: `minimum is ${meta.min}` };
    if (meta.max !== undefined && n > meta.max) return { error: `maximum is ${meta.max}` };
    return { value: n };
  }
  if (type === 'enum' && Array.isArray(meta.values) && !meta.values.includes(value)) {
    return { error: `must be one of ${meta.values.join(', ')}` };
  }
  if (type === 'boolean') return { value: !!value };
  if (type === 'json') {
    try {
      return { value: JSON.parse(value) };
    } catch (err) {
      return { error: `not valid JSON: ${err.message}` };
    }
  }
  return { value };
}
