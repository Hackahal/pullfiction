# Pull Fiction

Pull Fiction is a browser tool for analysing World of Warcraft runs and planning future ones. It combines Warcraft Logs data with a 3D encounter view, a 2D tactical map, live statistics and a timeline-based planning editor.

The renderer builds on [Wenilla](https://github.com/Arnesen/wenilla) and [Benilla](https://github.com/samwhosung/benilla). The application uses React and TypeScript around the Rust/Bevy WebAssembly renderer. Upstream engine source and its licence notices remain in this repository.

## Using the application

Use a desktop Chromium browser with WebGPU. Select your installed modern Classic client folder when prompted; preparation happens in the browser. Used assets can be cached in browser-local storage. The application does not require a game-data server, a local helper installation or a connection to an official game server.

Game archives, models, textures, sounds and extracted assets are not included in this repository or its static release. They stay on the user's device. The included NPC index contains approved names and numeric references only.

Classic Era and accessible Season of Discovery assets are the current focus. The client reader can discover retained Classic data alongside a Forever installation. Full Forever compatibility and every modern rendering feature are still in development. Unsupported or unavailable assets must not be described as verified.

## Development

The source checkout needs Rust, the WebAssembly target, Node.js and Python. Building the full browser package also needs the pinned browser archive/conversion toolchains documented in [browser assets](docs/BROWSER-ASSETS.md). These are developer requirements, not end-user installations.

Install editor dependencies and run its checks:

```sh
npm ci --prefix web/editor
npm run check --prefix web/editor
npm test --prefix web/editor
```

Prepare a code-only static release in a new output directory:

```sh
bash scripts/browser-static-build.sh .agent/work/browser-static/release-new
python3 scripts/static-package.py audit .agent/work/browser-static/release-new
node scripts/static-viewer-smoke.mjs .agent/work/browser-static/release-new
```

Preview a prepared release with `python3 scripts/static-preview.py .agent/work/browser-static/release-new`. Follow [the editor guide](docs/EDITOR.md) for development and [static hosting](docs/STATIC-HOSTING.md) for toolchain versions and Cloudflare Static Assets preparation. Building does not deploy.

## Warcraft Logs

The browser integration uses a public OAuth PKCE client. Copy `web/editor/.env.example` to `web/editor/.env` and fill in your public client ID and registered callback. Never use a client secret in a `VITE_` setting. The local environment file is ignored by Git. Without OAuth configuration, local replay JSON import remains available.

See [Warcraft Logs integration](docs/BROWSER-LOGS.md), [buffered replay loading](docs/BUFFERED-REPLAY.md) and [local saves and exports](docs/LOCAL-PROJECTS.md).

## Project map

- `web/editor/`: React editor, analysis panels, local client reader and renderer workbench.
- `web/planner/`: replay normalization, data adapters and shared planning logic.
- `crates/pullfiction-viewer/`: browser renderer entry point and project-specific native integration.
- `crates/benilla-*`: upstream renderer, formats and client foundations, with browser carries.
- `scripts/`: asset adapters, checks and static packaging.
- `third_party/`: pinned dependencies, definitions and source/licence records.
- `cloudflare/` and `wrangler.static.jsonc`: static hosting configuration.

The retained engine crates support the browser renderer and native game UI. The original client launchers, realm services and prototype UI are removed. Source attribution and the recorded Wenilla baseline are documented in [upstream maintenance](docs/UPSTREAM.md).

## Verification

Use the [renderer workbench](web/editor/src/renderer-lab/README.md) for repeatable local GPU captures. It separates conversion checks, rendered pixels, visual review and frozen-frame regressions. Keep real game imagery and captures local.

Run `python3 scripts/repository-audit.py` to check the current source and reachable Git history for forbidden artifacts and known credential signatures. Use `--tree-only` to inspect the current source without history. These checks do not prove that every possible secret is absent. The static package has its own stricter allowlist and content audit.

Additional guides: [editor controls](docs/EDITOR-CONTROLS.md), [browser asset boundary](docs/BROWSER-ASSETS.md), [Forever client investigation](docs/FOREVER-CLIENT.md) and [upstream engine maintenance](docs/UPSTREAM.md).

## Licence

The upstream code is dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE). Third-party components retain their own notices. No Blizzard game assets are licensed or distributed by this project.
