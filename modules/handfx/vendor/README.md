# handfx vendor

Everything the overlay loads for hand tracking lives here or is fetched once and cached. Nothing
is installed with npm: the server has zero dependencies and this module is served by the core
HTTP server like any other module asset (`/api/handfx/vendor/…`).

## What is vendored, from where, under what licence

| file | bytes | source URL | licence |
|---|---|---|---|
| `vision/vision_bundle.mjs` | 2 493 025 | `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz` (file `package/vision_bundle.mjs`) — also published as `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs` | Apache-2.0 |
| `vision/wasm-nosimd/vision_wasm_nosimd_internal.js` | 209 735 | same tarball, `package/wasm/vision_wasm_nosimd_internal.js` — also `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js` | Apache-2.0 |
| `vision/wasm-nosimd/vision_wasm_nosimd_internal.wasm` | 9 294 247 | same tarball, `package/wasm/vision_wasm_nosimd_internal.wasm` | Apache-2.0 |
| `vision/simd-wasm/vision_wasm_internal.wasm` | 9 423 986 | same tarball, `package/wasm/vision_wasm_internal.wasm` | Apache-2.0 |
| `vision/wasm/vision_wasm_internal.js` | written here — see below (not used by the default path) | wrapper around `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js` (210 826 bytes, Apache-2.0) | Apache-2.0 (the wrapped file) |
| `../../models/hand_landmarker.task` | 7 819 105 | `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | Apache-2.0 |

`@mediapipe/tasks-vision@0.10.14` `package.json` states `"license": "Apache-2.0"`; the package ships
no `LICENSE` file, and no copyright header survives in the minified bundle. The licence text is at
<https://www.apache.org/licenses/LICENSE-2.0>.

The model is **not** committed — `.gitignore` ignores `modules/handfx/models/*` (licensed per
machine, large). `GET /api/handfx/model` serves it when the file is present; otherwise the overlay
downloads the URL above into Cache Storage (`handfx:models-v1`) once and reuses it.

## Why the SIMD loader is a shim

MediaPipe 0.10.14's `FilesetResolver.forVisionTasks(dir)` returns
`{wasmLoaderPath: dir + '/vision_' + (simd ? 'wasm_internal' : 'wasm_nosimd_internal') + '.js',
wasmBinaryPath: dir + '/vision_' + (simd ? 'wasm_internal' : 'wasm_nosimd_internal') + '.wasm'}`
and then appends both as classic `<script>` URLs (`wasmLoaderPath`) and as a fetch
(`wasmBinaryPath`). Three things were measured in headless Chrome 130 on 2026-10-29
(`crossOriginIsolated === true`), not assumed:

1. `<script src=wasm_nosimd_internal.js>` does **define** `self.ModuleFactory` and the SDK boots
   from it (`HandLandmarker.createFromOptions` resolves).
2. The SIMD **binary** is needed only when the SIMD loader is used, and the SIMD loader cannot be
   `eval`'d from page script (it is an ES module with top-level `await`: `SyntaxError` in an
   indirect eval). It only works when the SDK loads it as a classic script.
3. A wrapper served in its place (a classic script that evals the CDN loader) dies with
   `ModuleFactory not set` — the factory an indirect eval defines is not the binding the SDK reads,
   so the wrapper cannot be swapped in for the loader file.

The overlay therefore always starts the **no-SIMD** runtime, which is vendored whole and needs no
network at all. After the first successful boot it asynchronously sets `simd.testing`, the SDK
loads `{dir}/vision_wasm_internal.js` classically (`wasmLoaderPath`), and the route table serves
the official wrapper above; that has not been made to work as a swap of a working runtime, so the
SIMD path stays behind the `simd` setting (default off) and the module reports which runtime is in
use (`/api/handfx/ack`, `model.runtime`) rather than claiming acceleration it does not have.

`vision/wasm/vision_wasm_internal.js` is kept because it is small and it documents the port; the
default path does not request it.

## URLs the overlay uses, if it is ever pointed at the CDN instead of the vendored copy

- runtime: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs`
- wasm loader (SIMD): `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js`
- wasm binary (SIMD): `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm`
- wasm loader (no-SIMD): `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js`
- wasm binary (no-SIMD): `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm`
- model: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`

With the default (no-SIMD) runtime the page fetches nothing from a CDN: `vision_bundle.mjs`, the
no-SIMD loader and binary, the model and the whole wasm set are served by this module. Only the
optional SIMD path (`vision/wasm/vision_wasm_internal.js`) touches the CDN.

## Reproducing this directory

```bash
cd /tmp/opencode && npm pack @mediapipe/tasks-vision@0.10.14
tar xzf mediapipe-tasks-vision-0.10.14.tgz     # writes package/
mod=/home/alex/OBS/shockbox/modules/handfx
cp package/vision_bundle.mjs                       $mod/vendor/vision/
mkdir -p $mod/vendor/vision/wasm $mod/vendor/vision/wasm-nosimd $mod/vendor/vision/simd-wasm
cp package/wasm/vision_wasm_nosimd_internal.{js,wasm} $mod/vendor/vision/wasm-nosimd/
cp package/wasm/vision_wasm_internal.wasm             $mod/vendor/vision/simd-wasm/
# vendor/vision/wasm/vision_wasm_internal.js is written by hand (the shim, above)
curl -fsSL -o $mod/models/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```
