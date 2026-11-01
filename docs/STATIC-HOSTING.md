# Build and release the static application

Pull Fiction runs at `https://pullfiction.com` on Cloudflare Workers Static Assets. The deployment contains application code and the browser conversion runtime. Prepared game files are served by the separate, locally deployed asset service described in [hosted assets](HOSTED-ASSETS.md).

`scripts/browser-static-build.sh` prepares a release in a fresh temporary directory. Building does not deploy or change a Cloudflare account.

The `browser-static` feature runs the original planner renderer, native raid frames,
nameplates, camera, and editor. Downloaded prepared assets replace browser-local archive extraction. The earlier replacement-scene experiment is excluded from this feature.

The browser downloads prepared assets automatically. The game asset service is deployed directly from the owner's machine and never passes through GitHub. The release contains no client archives, extracted models, textures, map art, report caches, credentials, or native helper. Existing files in `web/dist` are not packaging inputs. The explicit metadata exception is a prefetched Wowhead NPC name and numeric display-reference index at `/metadata/npc-models.json`, with its source and attribution notices.

## Build a release

Use Node 22 or newer, Python 3.12 or newer, and Rust 1.98.1. Prepare the pinned developer tools once:

```bash
bash scripts/web-setup.sh
bash scripts/browser-assets-setup.sh
npm ci --prefix web/editor
```

The setup pins Emscripten `6.0.13`, CascLib, CMake `4.4.4`, Pyodide `314.0.7`, and Wrangler `4.156.0`. It preserves existing tool checkouts and refuses modified or mismatched sources. Downloads and installed tools remain outside the published package.

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

For production, set `VITE_GAME_ASSET_URL` to the prepared asset service URL, default `https://assets.pullfiction.com/`, and set the public `VITE_WCL_CLIENT_ID` and `VITE_WCL_REDIRECT_URI=https://pullfiction.com/`. Never pass a client secret through a `VITE_` variable. Register that exact callback with Warcraft Logs while retaining the localhost callback for development.

Production builds exclude the renderer-lab screen and WASM diagnostics. Vite development can use `?renderer-lab=1`; its diagnostic WASM must be built with `--features browser-static,renderer-lab`. A separate Vite build can use `--mode renderer-lab`. The production packager rejects lab entries and diagnostic WASM exports.

## Publish a release

Pushes and pull requests do not start workflows. Publishing a release runs the source and renderer checks, builds the production package, and deploys only after those checks pass. Use either release entry point:

1. In GitHub, open **Releases → Draft a new release**, choose a version tag and target commit, and publish it. The **Release** workflow builds and deploys that commit.
2. For a direct deployment or an older version, open **Actions → Release → Run workflow** and enter the commit or tag in **ref**. The default is `main`.

The workflow builds on a clean GitHub-hosted runner, checks the packaging rules, and uploads only the audited production directory. A lightweight hosted health check confirms that the app references the expected bundles, the browser runtime is available, and WebAssembly and gzip responses have the right types. It reads small response prefixes and does not compare file hashes. Delivery checks retry briefly while a new deployment becomes visible. Build and deployment run in separate jobs. The Cloudflare credential is available only to the deployment step. Each run retains the static package and a separate audit inventory for 30 days.

The **Pull Fiction checks** workflow can also be started manually for a commit or tag. It is reused by the release workflow and has no push or pull-request trigger.

The repository requires these Actions settings:

| Setting | Type | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Scoped permission to deploy the production Worker and its domain connection |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account hosting `pullfiction` |
| `VITE_WCL_CLIENT_ID` | Variable | Public Warcraft Logs PKCE client ID |

Production uses the `pullfiction` Worker and the custom domain `pullfiction.com`. There is no Worker application server, database, game-data endpoint, or paid-service requirement.

Optional Cloudflare RUM is disabled under **Speed → Real user monitoring**. Cloudflare can otherwise [inject an analytics snippet outside the EU by default](https://blog.cloudflare.com/the-rum-diaries-enabling-web-analytics-by-default/). The hosted health check tolerates extra analytics markup. RUM is not required for the application.

## Deploy a local build

With the deployment credential in the process environment, run:

```bash
bash scripts/deploy-static.sh .agent/work/browser-static/release
python3 scripts/verify-deployment.py https://pullfiction.com .agent/work/browser-static/release
```

The deploy command audits the directory and initializes its packaged WASM before upload. It never uploads the checkout, audit report, tests, game files, or local tool directories. Keep credentials out of shell history, source files, and command output.

## Roll back

In Cloudflare, open **Workers & Pages → pullfiction → Deployments**, select a previous version, and choose **Rollback**. Cloudflare retains the 100 most recently published versions. This restores the deployed static assets without changing browser-local projects or client caches.

To rebuild an older source version, run the GitHub **Release** workflow with its commit or tag. Releases before the deployment tooling was introduced may not contain the required build scripts; use a retained Cloudflare version for those.

## Preview the prepared release locally

This command is for a developer preview, separate from the existing development
site. It is not an end-user requirement and does not deploy:

```bash
python3 scripts/static-preview.py .agent/work/browser-static/release
```

Open `http://127.0.0.1:8096` in a desktop Chromium browser with WebGPU. Select the
raid, wait for the hosted catalogs, then import a replay
JSON or connect the configured public Warcraft Logs client. The 3D and tactical
views download the selected raid's prepared geometry and minimap resources.

The preview serves application code only. For local asset-service testing, use
a loopback static server for the prepared asset directory and set
`VITE_GAME_ASSET_URL` when running the Vite development server. Production
requires an HTTPS asset URL. See [hosted assets](HOSTED-ASSETS.md).

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

The current index is partial: 359 vanilla and 224 SoD NPC references. Its source record documents prefetch coverage and unavailable entries. Missing references continue through the application's explicit unavailable-appearance behavior; imported report model references retain precedence. A successful static build does not establish complete NPC model coverage.

The audit reads every published file, including decompressed viewer WebAssembly, and emits a hash and byte count for each file. It compares converter sources with the current repository and requires the reviewed viewer loader and Cloudflare headers. The signature scan detects specific credential and local-endpoint patterns. It does not prove the absence of every possible secret or verify browser rendering.

The production build also runs `static-viewer-smoke.mjs` before publishing the local output directory. That check initializes the actual WebAssembly module through its packaged gzip loader. It permits only the gzip file read, checks the exported memory and `start` function, and leaves the renderer stopped. It requires Node with `DecompressionStream` support.

## Use the Cloudflare configuration

`wrangler.static.jsonc` points only at `.agent/work/browser-static/release`. It declares Workers Static Assets, a single-page application fallback, and the production custom domain. It has no Worker script, game-data binding, or credential. `workers.dev` and version-preview URLs are disabled. The local deploy command can select a different audited output directory.

Cloudflare serves custom headers from the release's `_headers` file. Hashed Vite bundles receive an immutable cache policy. The page, archive runtime, and viewer files revalidate on use. Missing application routes fall back to `index.html`; missing runtime files must still be treated as load failures by their consumers.

Cloudflare documents a [25 MiB limit per static asset](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) and supports [an assets directory without a Worker script](https://developers.cloudflare.com/workers/static-assets/). The packager requires every uploaded file to be strictly smaller than 25 MiB and limits the release to 20,000 files. The prepared configuration and local audit do not verify a hosted origin.

No packaging command invokes Wrangler deployment or any account operation. Deployment happens only through the explicit release workflow or `scripts/deploy-static.sh`.

## Keep the compressed viewer loader contract

The release exposes `/pullfiction_viewer.js` as a module with the original wasm-bindgen named exports and an asynchronous default initializer. The editor can keep calling `engine.default()` followed by `engine.start()`. The packager also follows wasm-bindgen's generated imports and includes their referenced JavaScript snippets. Unreferenced snippets do not ship.

The initializer fetches `/pullfiction_viewer_bg.wasm.gz`, streams it through `DecompressionStream("gzip")`, then passes the decoded bytes to wasm-bindgen. The release includes `pullfiction_viewer.bindgen.js` and the gzip file. It excludes the raw viewer WebAssembly file, which may exceed Cloudflare's upload limit.

Serve the gzip file as `Content-Type: application/gzip` without `Content-Encoding: gzip`. `_headers` supplies that content type. HTTP content decoding would otherwise remove the gzip layer before the explicit browser decompressor reads it. The archive reader and codec WebAssembly files remain ordinary `application/wasm` resources under `/archive/`.

The archive worker entry point is `/archive/worker.mjs`. Its client module is `/archive/client.mjs`. The directory includes only pinned CascLib, Pyodide, the asset codec, converter source, format definitions, and their licenses. The isolated proof page and its expected hashes do not ship.

Current desktop Chromium is the initial browser target. Local packaging checks do not replace hosted browser acceptance for folder permissions, WebGPU, conversion, replay behavior, or Warcraft Logs authorization.
