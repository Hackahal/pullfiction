# Prepare the static browser release

`scripts/browser-static-build.sh` prepares Pull Fiction for Cloudflare Workers Static Assets. It builds application code and browser conversion tools in a fresh temporary directory. The command does not deploy or change a Cloudflare account.

The `browser-static` feature runs the original planner renderer, native raid frames,
nameplates, camera, and editor. Browser-local preparation replaces the game-data
server. The earlier replacement-scene experiment is excluded from this feature.

The browser reads the user's selected modern Classic client directory. The release contains no client archives, extracted models, textures, map art, report caches, credentials, or native helper. Existing files in `web/dist` are not packaging inputs. The explicit metadata exception is a prefetched Wowhead NPC name and numeric display-reference index at `/metadata/npc-models.json`, with its source and attribution notices.

## Build a release

Use the toolchains already prepared for the browser archive reader. The build requires the Rust `wasm32-unknown-unknown` target, `wasm-bindgen` CLI `0.2.122`, Node dependencies from `web/editor/package-lock.json`, and Emscripten `6.0.13`. It also requires the pinned CascLib and Pyodide inputs described in [BROWSER-ASSETS.md](BROWSER-ASSETS.md).

Run from the repository root:

```bash
	bash scripts/browser-static-build.sh
```

The default output is `.agent/work/browser-static/release`. Its SHA-256 inventory is `.agent/work/browser-static/release.audit.json`, outside the public directory. The build refuses an existing output directory. For a second build, select a new output path:

```bash
	bash scripts/browser-static-build.sh .agent/work/browser-static/release-next
```

The command runs these builds:

1. `cargo build --locked --release --target wasm32-unknown-unknown -p pullfiction-viewer --no-default-features --features browser-static`.
2. `wasm-bindgen --target web` with CLI version `0.2.122`.
3. The editor production build with browser-local assets enabled by default, `--manifest`, and an explicit empty Vite output directory.
4. `scripts/browser-assets-build.sh` and `scripts/browser-codec-build.sh` into a fresh archive runtime directory.
5. `scripts/static-package.py pack`, which copies an explicit application allowlist and audits the result.

Supply `VITE_WCL_CLIENT_ID` and `VITE_WCL_REDIRECT_URI` only when a public Warcraft Logs browser client is available. These values are public configuration. Never pass a client secret through a `VITE_` variable. Preparing a local release does not establish that the provider has enabled public-client authorization for the eventual origin.

## Preview the prepared release locally

This command is for a developer preview, separate from the existing development
site. It is not an end-user requirement and does not deploy:

```bash
python3 scripts/static-preview.py .agent/work/browser-static/release
```

Open `http://127.0.0.1:8096` in a desktop Chromium browser with WebGPU. Select the
World of Warcraft root folder, wait for the local catalogs, then import a replay
JSON or connect the configured public Warcraft Logs client. The 3D view reads
the selected raid environment locally; the 2D tactical view uses local minimap
tiles and floor geometry. The folder reader can
use retained Classic 1.15.9 data when a Forever installation has replaced the
top-level product metadata; full Forever 1.60 asset compatibility remains
unverified. See [BROWSER-ASSETS.md](BROWSER-ASSETS.md).

The preview command serves the code-only release. It has no route that serves
the selected game directory. The existing local site on port 8090 and its
importer on port 8091 are independent.

## Check the output

Run the artifact tests and audit from the repository root:

```bash
	python3 scripts/static-package-test.py
	node --test scripts/static-viewer-loader.test.mjs
	python3 scripts/static-package.py audit .agent/work/browser-static/release
	node scripts/static-viewer-smoke.mjs .agent/work/browser-static/release
```

The packaging fixtures intentionally contaminate the editor, renderer, and archive input directories. The resulting release excludes those contaminants, including stale JavaScript with a valid Vite filename. The packager follows the fresh Vite entry manifest instead of copying every bundle in the directory. Additional cases reject output contamination, symlinks, altered converter code, manifest traversal, local endpoints, secret signatures, and files at or above 25 MiB.

The NPC index has a separate fixed schema. The audit rejects model bytes, texture references, coordinates, spawns, extra fields, invented scale overrides, and metadata that differs from the reviewed repository copy. See [the Wowhead metadata source record](../third_party/wowhead-npcs/SOURCE.md) for regeneration and coverage limits. Page bodies and local report data never enter the release.

The current index is partial: 205 vanilla and 152 SoD NPC references. Its source record documents prefetch coverage and unavailable entries. Missing references continue through the application's explicit unavailable-appearance behavior; imported report model references retain precedence. A successful static build does not establish complete NPC model coverage.

The audit reads every published file, including decompressed viewer WebAssembly, and emits a hash and byte count for each file. It compares converter sources with the current repository and requires the reviewed viewer loader and Cloudflare headers. The signature scan detects specific credential and local-endpoint patterns. It does not prove the absence of every possible secret or verify browser rendering.

The production build also runs `static-viewer-smoke.mjs` before publishing the local output directory. That check initializes the actual WebAssembly module through its packaged gzip loader. It permits only the gzip file read, checks the exported memory and `start` function, and leaves the renderer stopped. It requires Node with `DecompressionStream` support.

## Use the Cloudflare configuration

`wrangler.static.jsonc` points only at `.agent/work/browser-static/release`. It declares Workers Static Assets and a single-page application fallback. It contains no Worker script, bindings, secrets, route, domain, or account identifier. Change `assets.directory` locally if you selected another release path.

Cloudflare serves custom headers from the release's `_headers` file. Hashed Vite bundles receive an immutable cache policy. The page, archive runtime, and viewer files revalidate on use. Missing application routes fall back to `index.html`; missing runtime files must still be treated as load failures by their consumers.

Cloudflare documents a [25 MiB limit per static asset](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) and supports [an assets directory without a Worker script](https://developers.cloudflare.com/workers/static-assets/). The packager requires every uploaded file to be strictly smaller than 25 MiB and limits the release to 20,000 files. The prepared configuration and local audit do not verify a hosted origin.

Deployment requires a separate explicit authorization. No packaging command invokes Wrangler deployment or any account operation.

## Keep the compressed viewer loader contract

The release exposes `/pullfiction_viewer.js` as a module with the original wasm-bindgen named exports and an asynchronous default initializer. The editor can keep calling `engine.default()` followed by `engine.start()`. The packager also follows wasm-bindgen's generated imports and includes their referenced JavaScript snippets. Unreferenced snippets do not ship.

The initializer fetches `/pullfiction_viewer_bg.wasm.gz`, streams it through `DecompressionStream("gzip")`, then passes the decoded bytes to wasm-bindgen. The release includes `pullfiction_viewer.bindgen.js` and the gzip file. It excludes the raw viewer WebAssembly file, which may exceed Cloudflare's upload limit.

Serve the gzip file as `Content-Type: application/gzip` without `Content-Encoding: gzip`. `_headers` supplies that content type. HTTP content decoding would otherwise remove the gzip layer before the explicit browser decompressor reads it. The archive reader and codec WebAssembly files remain ordinary `application/wasm` resources under `/archive/`.

The archive worker entry point is `/archive/worker.mjs`. Its client module is `/archive/client.mjs`. The directory includes only pinned CascLib, Pyodide, the asset codec, converter source, format definitions, and their licenses. The isolated proof page and its expected hashes do not ship.

Current desktop Chromium is the initial browser target. Local packaging checks do not replace hosted browser acceptance for folder permissions, WebGPU, conversion, replay behavior, or Warcraft Logs authorization.
