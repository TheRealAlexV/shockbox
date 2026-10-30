// What the browser's GL stack actually is: one line, for a gate that needs WebGL2.
//
// A `webgl2` context that comes back null says nothing about why. This reports the same context the
// engine asks for (identical attributes), the renderer string it resolves to (SwiftShader/ANGLE
// when there is no device), and whether a context that refuses software rendering would exist —
// so a runner-side "WebGL2 unavailable" names the backend instead of just the failure.

const PROBE = `(() => {
  const attrs = { alpha: false, depth: false, stencil: false, antialias: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    desynchronized: false, failIfMajorPerformanceCaveat: false };
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2', attrs);
  const out = { webgl2: Boolean(gl), renderer: null, vendor: null, caveat: null };
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }
  // a second context asking the browser to refuse software rendering, to name the caveat
  const c2 = document.createElement('canvas');
  out.caveat = Boolean(c2.getContext('webgl2', { ...attrs, failIfMajorPerformanceCaveat: true }));
  return out;
})()`;

/**
 * @param {{ send: Function }} c   a gate's CDP client, already on the page of interest
 * @returns {Promise<{webgl2: boolean, renderer: string|null, vendor: string|null, caveat: boolean, maxTexture?: number, error?: string}>}
 */
export async function probeGl(c) {
  let out = { webgl2: false, renderer: null, vendor: null, caveat: false };
  try {
    const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    if (r?.exceptionDetails) out.error = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    else if (r?.result?.value) out = { ...out, ...r.result.value };
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** Format a probeGl result as the single line a gate prints on failure. */
export function glLine(p) {
  if (!p) return 'gl: unknown';
  const bits = [`webgl2=${p.webgl2}`];
  if (p.renderer) bits.push(`renderer=${p.renderer}`);
  bits.push(`caveat=${p.caveat}`);
  if (p.maxTexture) bits.push(`maxTexture=${p.maxTexture}`);
  if (p.error) bits.push(`error=${p.error}`);
  return bits.join(' · ');
}
