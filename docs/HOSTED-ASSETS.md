# Prepare and deploy hosted assets

Prepare game data on the owner's machine and upload it directly to Cloudflare Workers Static Assets. Keep the application release on GitHub separate. End users download prepared assets automatically; there is no game-client import option.

## Prepare a generation locally

Use an offline Classic 1.15.9 installation and the native CascLib library. The producer reuses the application's model, world, catalog and appearance adapters. Run the producer's `--help` for installation and library options.

Choose a new output under `.agent/work/`. This directory is ignored by Git. Never move generated data into the source tree, GitHub releases, Actions artifacts or Actions caches. The producer and deployment script reject CI execution.

```sh
python3 scripts/prepare-hosted-assets.py --help
python3 scripts/prepare-hosted-assets.py --install /path/to/Classic --library /path/to/native/CascLib --output .agent/work/hosted-assets-next
python3 scripts/prepare-hosted-assets.py audit .agent/work/hosted-assets-next
python3 scripts/optimize-hosted-assets.py --input .agent/work/hosted-assets-next --output .agent/work/hosted-assets-ready --install /path/to/Classic --library /path/to/native/CascLib
```

Preparation produces `manifest.json` and content-addressed `chunks/*.bin.gz` files. Each resource has a SHA-256 digest and a list of byte ranges within independently compressed chunks. Large resources can span chunks. The producer targets 16 MiB of uncompressed bytes per chunk and enforces Cloudflare's 25 MiB upload ceiling. Read the preparation inventory for unavailable or unsupported resources before publishing.

Models, world geometry and catalogs are prepared locally. Player appearance recipes and texture blending remain dynamic in the browser, using the prepared input tables and textures. This preserves combinations of skin, hair and equipment without publishing every possible finished atlas.

Optimization removes raw archive inputs that were only needed during conversion and deduplicates identical payloads. It preserves the raw tables and character model inputs needed by dynamic appearance composition. For Naxxramas and Blackwing Lair it extracts the authored raid buildings at their original transforms, retains all groups and their minimaps, and omits surrounding terrain and props. It also removes unused WMO collision-search tables and validated duplicate triangle metadata. Shared buildings referenced by other raids or spell effects remain available. A sibling optimization report records before/after sizes, source placements and decisions for every raid. See [Hosted asset optimization](HOSTED-ASSET-OPTIMIZATION.md) for retained geometry and measured savings.

## Deploy directly to Cloudflare

Install the pinned CLI and authenticate locally:

```sh
npm ci --prefix tools/release --ignore-scripts
./tools/release/node_modules/.bin/wrangler login --use-keyring --scopes account:read user:read workers_scripts:write workers_routes:write zone:read
bash scripts/deploy-game-assets.sh .agent/work/hosted-assets-ready
```

The pinned Wrangler CLI supports `--use-keyring`. On Linux, install `secret-tool` before login, provided by `libsecret-tools` on Debian/Ubuntu or `libsecret` on Fedora/Arch. Check Wrangler output to confirm keyring storage; do not accept a plaintext fallback unnoticed.

`wrangler.game-assets.jsonc` deploys the `pullfiction-assets` service at `assets.pullfiction.com`. The script audits the local directory and adds the reviewed CORS and cache headers. Assets are public static responses. Requests do not invoke a Worker script. The `.gz` files use `application/gzip` without `Content-Encoding`; the browser verifies the compressed hash and decompresses them explicitly.

The deployment script retains old content-addressed chunks in `.agent/work/hosted-assets/deployed` and includes them in subsequent deployments so open sessions can finish. Preserve that directory between releases and restore it when using a fresh checkout or another machine. Deployment fails before staging or upload if retention is missing or invalid. For the first generation of a new, empty asset service only, run `HOSTED_ASSETS_FIRST_DEPLOY=1 bash scripts/deploy-game-assets.sh .agent/work/hosted-assets-ready`. The override must be exactly `1` and is rejected when a retained generation already exists. The auditor accepts retained chunks only after validating their names, compressed hashes, decompression limits and file sizes.

Before upload, the deployer saves and syncs the complete old-plus-new chunk union and a transaction journal beneath `.agent/work/hosted-assets/`. It serializes deployment and recovery with a POSIX file lock on macOS or Linux. After upload, it installs retention through directory renames and keeps the previous generation in a `previous.*` directory. A pending transaction blocks later uploads, including the first-generation override.

If an upload reports an uncertain failure or local finalization fails, preserve the entire `.agent/work/hosted-assets/` directory and run:

```sh
bash scripts/deploy-game-assets.sh --recover
```

Recovery verifies the saved manifest, headers and complete chunk inventory, then finishes the local retention transaction. It never contacts Cloudflare. If recovery reports missing or altered bytes, restore those bytes from the saved generation or a backup before retrying. Do not delete `pending.json` to bypass recovery. After an uncertain upload, check the actual Cloudflare version separately; local recovery preserves chunks for both possible outcomes. Keep previous manifests locally. Cloudflare deployment rollback restores the previous asset version.

## Release application code

The existing GitHub workflow builds and uploads only the audited application package. It does not run the asset producer, fetch hosted game data or upload game packs. `VITE_GAME_ASSET_URL` is a public build setting, defaulting to `https://assets.pullfiction.com/`. Configure the repository variable only when using another asset service URL.

Deploy a compatible asset generation first, then release the application code. Application and asset releases can happen independently when the manifest schema and renderer inputs remain compatible. A new manifest affects new sessions; each running reader pins the manifest it opened.

## Preview locally

First [build and audit an application package](STATIC-HOSTING.md). Start its runtime in one terminal; Vite needs the archive modules and viewer files from this server:

```sh
python3 scripts/static-preview.py .agent/work/browser-static/release --port 8096
```

In a second terminal, serve a completed asset generation on loopback:

```sh
python3 scripts/preview-game-assets.py .agent/work/hosted-assets-ready --port 8312
```

In a third terminal, start Vite:

```sh
VITE_GAME_ASSET_URL=http://127.0.0.1:8312/ npm run dev --prefix web/editor
```

Vite proxies `/archive`, `/metadata`, `/snippets` and `/pullfiction_viewer` to port 8096. Set `PULLFICTION_RUNTIME_ORIGIN` when the runtime uses another origin. The Vite development build permits loopback HTTP asset URLs. Production builds require HTTPS. The asset preview audits its directory before serving and supplies CORS headers.

## Download recovery

Each request uses a 60-second inactivity timeout while waiting for headers or the next nonempty body bytes. Progress refreshes the timer for both manifests and compressed chunks, so a healthy slow transfer can exceed 60 seconds overall. A stalled transfer retries within the bounded attempt budget. User cancellation stops the request without retrying.

## Verify delivery

Audit locally before upload. After deployment, verify the manifest, chunk CORS headers and `application/gzip` MIME type at the actual public origin. Exercise a fresh browser session through automatic startup, raid selection, replay import, character equipment, effects and tactical maps. Retry a failed chunk download and reload from the browser cache. A local pack audit establishes byte integrity; it does not establish Cloudflare delivery or rendered fidelity.
