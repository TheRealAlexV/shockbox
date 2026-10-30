// Why a mount wait timed out: one probe the gates dump when `waitFor` fails.
//
// A bare `false` from a mount wait says nothing — it is the same answer for a shell that never
// booted, a pane whose stylesheet hung, and a page still being navigated. This asks the page what
// it knows: readyState, where it is, how much body there is, the shell's own door-bell
// (`window.__shell`), any request still outstanding (`duration === 0`), and the console errors the
// gate has collected so far. It never throws: a probe failure must not mask the check's failure.

const PROBE = `(() => {
  const origin = location.origin;
  const inflight = performance.getEntriesByType('resource').filter((e) => e.duration === 0);
  const pick = (sel) => document.querySelector(sel);
  return {
    readyState: document.readyState,
    href: location.href,
    title: document.title,
    bodyLength: document.body ? document.body.innerHTML.length : -1,
    appChildren: document.getElementById('app') ? document.getElementById('app').children.length : -1,
    pane: pick('#pane')
      ? { children: pick('#pane').children.length, text: pick('#pane').innerText.slice(0, 240) }
      : null,
    paneSlot: pick('#pane-slot') ? pick('#pane-slot').children.length : -1,
    loadingNote: pick('[data-pane-loading]') ? pick('[data-pane-loading]').innerText.trim() : null,
    partialNotes: [].map.call(document.querySelectorAll('[data-note="pane-partial"]'), (n) => n.innerText.trim()),
    rail: document.querySelectorAll('.rail-item').length,
    shell: window.__shell || null,
    scripts: [].map.call(document.querySelectorAll('script'), (s) => s.src || 'inline'),
    srcModule: (performance.getEntriesByType('resource').filter((e) => /\\/src\\//.test(e.name))[0] || null) &&
      (function (e) { return { name: e.name.replace(origin, ''), status: e.responseStatus || 0, transferSize: e.transferSize, duration: Math.round(e.duration) }; })(
        performance.getEntriesByType('resource').filter((e) => /\\/src\\//.test(e.name))[0],
      ),
    srcCount: performance.getEntriesByType('resource').filter((e) => /\\/src\\//.test(e.name)).length,
    loadFailure: document.getElementById('shell-load-failure') ? document.getElementById('shell-load-failure').textContent : null,
    hung: inflight.map((e) => e.name.replace(origin, '') + ' (' + e.initiatorType + ')' + (e.responseStatus ? ' HTTP ' + e.responseStatus : '')),
  };
})()`;

/**
 * @param {{ send: Function, eval?: Function }} c   a gate's CDP client
 * @param {Array} events                            CDP events the gate has collected
 * @param {string} [label]                          what was being waited for, for the first line
 * @returns {Promise<string>} a multi-line, human-readable report
 */
export async function mountDiagnostics(c, events = [], label = 'mount') {
  const lines = [`      ${label}: mount wait timed out at ${new Date().toISOString()}`];
  try {
    const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const d = r?.result?.value;
    if (r?.exceptionDetails) {
      lines.push(`      probe threw in the page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    } else if (d) {
      lines.push(`      readyState=${d.readyState} href=${d.href} title=${JSON.stringify(d.title)}`);
      lines.push(`      body=${d.bodyLength}B app.children=${d.appChildren} rail=${d.rail} pane.children=${d.paneSlot}`);
      lines.push(`      pane text: ${JSON.stringify(d.pane ? d.pane.text : null)}`);
      if (d.loadingNote) lines.push(`      shell still showing: ${JSON.stringify(d.loadingNote)}`);
      for (const n of d.partialNotes) lines.push(`      shell reported: ${n}`);
      lines.push(
        `      shell state: ${d.shell ? `phase=${d.shell.phase} route=${d.shell.route} since=${d.shell.since}${d.shell.notes?.length ? ` notes=${JSON.stringify(d.shell.notes)}` : ''}` : 'window.__shell is undefined — the shell never reached boot()'}`,
      );
      lines.push(d.hung.length ? `      hung requests (duration 0): ${d.hung.join(', ')}` : '      hung requests: none');
      if (d.loadFailure) lines.push(`      page load-failure notice: ${JSON.stringify(d.loadFailure)}`);
      lines.push(`      scripts: ${JSON.stringify(d.scripts)} · /src/ resources: ${d.srcCount}${d.srcModule ? ` · first: ${JSON.stringify(d.srcModule)}` : ''}`);
    }
  } catch (err) {
    lines.push(`      probe failed: ${err.message}`);
  }

  const consoleErrors = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description).join(' '))
    .slice(-5);
  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text)
    .slice(-5);
  const failedRequests = events
    .filter((e) => e.method === 'Network.loadingFailed')
    .map((e) => `${e.params.errorText || 'failed'}${e.params.blockedReason ? ` (${e.params.blockedReason})` : ''}`)
    .slice(-5);

  lines.push(`      console errors: ${consoleErrors.length ? JSON.stringify(consoleErrors, null, 0) : 'none'}`);
  if (exceptions.length) lines.push(`      page exceptions: ${JSON.stringify(exceptions, null, 0)}`);
  if (failedRequests.length) lines.push(`      failed requests: ${JSON.stringify(failedRequests, null, 0)}`);
  return lines.join('\n');
}

/** A `waitFor` with the diagnostics attached: same return value, one line of evidence on false. */
export async function waitForOrReport(c, expr, ms, { events = [], label = 'mount' } = {}) {
  const ok = await c.waitFor(expr, ms);
  if (!ok) console.log(await mountDiagnostics(c, events, label));
  return ok;
}
