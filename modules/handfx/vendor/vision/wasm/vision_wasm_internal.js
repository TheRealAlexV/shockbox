// Produced by the ShockBox handfx module: a port shim for MediaPipe's SIMD wasm loader.
//
// The SDK substitutes `{wasmDir}/{wasmLoaderPath}` and `{wasmDir}/{wasmBinaryPath}` into its
// fileset and loads BOTH as classic <script>/fetch URLs. On 0.10.14 the binary path it computes
// is `wasm_nosimd_internal.wasm` even when the loader it picked is the SIMD one, so a plain
// directory of the SDK files cannot boot (verified: "ModuleFactory not set"). This loader is the
// SDK's own loader fetched from the CDN by exact URL; the SDK still supplies the binary, and the
// module's route table sends that request to the SIMD binary instead. Range requests are not
// supported over the CDN, so the loader is read whole — it is 210 KB, fetched once per install
// and cached for a year.
//
// The SDK loader is Apache-2.0 (see ../README.md); this shim adds nothing to it.
const SDK_LOADER =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js';
try {
  const res = await fetch(SDK_LOADER, { credentials: 'omit', mode: 'cors', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  (0, eval)(await res.text());
} catch (err) {
  throw new Error(
    `handfx: MediaPipe wasm loader unavailable (${SDK_LOADER}: ${err.message}). ` +
      'The overlay normally falls back to the no-SIMD build it serves itself; this throw only ' +
      'fires when the SDK was given a fileset that points at the SIMD loader path.',
  );
}
