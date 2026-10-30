// Toast notifications for the shell itself (command outcomes, connection trouble).
// Not to be confused with the Notifications *module*, which draws on the stream.

import { el, clear } from './ui.js';

let host = null;

export function installToasts(node) {
  host = node;
}

/**
 * tone: 'ok' | 'error' | 'warn' | 'info'
 * Shows a transient line in the bottom-right corner. Errors stay longer and carry a dismiss.
 */
export function toast(text, tone = 'info', { timeout } = {}) {
  if (!host) {
    console.log(`[${tone}] ${text}`);
    return;
  }
  const item = el('div', { class: 'toast', 'data-tone': tone });
  item.append(el('span', { class: 'toast-text', text }));
  item.addEventListener('click', () => item.remove());
  host.appendChild(item);
  // keep the stack short
  while (host.children.length > 4) host.firstElementChild.remove();
  const ms = timeout ?? (tone === 'error' ? 8000 : 2800);
  setTimeout(() => {
    item.classList.add('toast-leaving');
    setTimeout(() => item.remove(), 180);
  }, ms);
}

export function clearToasts() {
  if (host) clear(host);
}
