# Develop Pull Fiction

Pull Fiction runs a React editor around the Rust/Bevy browser renderer. Game files are selected and read in the browser. Development does not require a game server, a local asset service or a Warcraft Logs client secret.

## Prepare the application

Install the toolchain in [static hosting](STATIC-HOSTING.md) and [browser assets](BROWSER-ASSETS.md), then install the editor dependencies:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
npm ci --prefix web/editor
```

Build a complete code-only release into a new directory:

```sh
bash scripts/browser-static-build.sh .agent/work/browser-static/release-dev
python3 scripts/static-preview.py .agent/work/browser-static/release-dev
```

Open the displayed loopback URL in a desktop Chromium browser with WebGPU. Choose your modern client folder, or reopen the browser-local prepared asset cache. The game installation and extracted assets stay on the user's device.

Each build output directory must be new. Choose another directory for subsequent complete builds. Stop the preview with Ctrl+C. Use `--port` to run another preview without interrupting existing work.

## Work on the editor

Keep a prepared release served on port 8096 and start Vite:

```sh
npm run dev --prefix web/editor
```

Vite serves the current React source and forwards renderer, archive-reader and metadata requests to the static preview. If the preview uses another origin, set `PULLFICTION_RUNTIME_ORIGIN` when starting Vite. This proxy carries application code only. It has no game-data or WCL importer endpoint. When testing OAuth through Vite, register its callback origin as described in [browser logs](BROWSER-LOGS.md).

The application uses browser-local assets by default. A frontend-only build does not include the renderer or archive reader; use a complete release to verify startup.

## Connect logs and preserve edits

Configure the public PKCE client described in [browser logs](BROWSER-LOGS.md). Use guild browsing, saved guilds or a direct report link to find a run. Imported encounter metadata remains available while event ranges load as needed. Local replay JSON can be imported without connecting an account.

See [local projects](LOCAL-PROJECTS.md) for saving and exporting edits, [editor controls](EDITOR-CONTROLS.md) for the mouse contract, and [buffered replay](BUFFERED-REPLAY.md) for loading behavior. Analysis and planning share the same 2D/3D scene and timeline.

## Verify a change

```sh
bash scripts/check.sh
```

The check script runs source auditing, editor type checks/tests, shared replay tests, converter and packaging tests, and the production WebAssembly compile check. It does not deploy, start a game client or connect to a game server.

Use the [renderer workbench](../web/editor/src/renderer-lab/README.md) for actual GPU captures. A passing build or converter test does not establish visual correctness. Keep screenshots, client fixtures and test reports local.

After changing shared Rust types or pruning workspace code, also run `cargo check --workspace --all-targets` to compile retained native examples and test targets. Installed-client integration checks are separate and may need local fixtures.
