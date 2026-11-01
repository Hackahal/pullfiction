# Prepare and deploy hosted assets

Prepare game data on the owner's machine and upload it directly to Cloudflare Workers Static Assets. Keep the application release on GitHub separate. End users download prepared assets automatically; there is no game-client import option.

## Prepare a generation locally

Run local preparation on macOS or Linux with an offline Classic 1.15.9 installation and the native CascLib library. The producer reuses the application's model, world, catalog and appearance adapters. Run the producer's `--help` for installation and library options.

Choose a new output under `.agent/work/`. This directory is ignored by Git. Never move generated data into the source tree, GitHub releases, Actions artifacts or Actions caches. The producer and deployment script reject CI execution.

```sh
python3 scripts/prepare-hosted-assets.py --help
python3 scripts/prepare-hosted-assets.py --install /path/to/Classic --library /path/to/native/CascLib --output .agent/work/hosted-assets-next
python3 scripts/prepare-hosted-assets.py audit .agent/work/hosted-assets-next
python3 scripts/optimize-hosted-assets.py --input .agent/work/hosted-assets-next --output .agent/work/hosted-assets-ready --install /path/to/Classic --library /path/to/native/CascLib
```

Checkpoints flush pending chunks before writing the checkpoint. Chunk bytes are synced before their directory entries, then checkpoint bytes are synced before atomic replacement and parent-directory sync. Resuming an older checkpoint also syncs its referenced chunks before publishing newer state. For these chunk and checkpoint writes on macOS, the file helper requests `F_FULLFSYNC` when Python exposes it. These operations request filesystem and drive-cache persistence; fixture ordering checks are not evidence of actual machine power-loss durability. Interrupted temporary writes remain outside the public pack directory.

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

The deployment script retains old content-addressed chunks in `.agent/work/hosted-assets/deployed` and includes them in subsequent deployments so open sessions can finish. Preserve that directory between releases and restore it when using a fresh checkout or another machine. Deployment fails before staging or upload if retention is missing or invalid. The normal deployer always requires a complete retained generation. `HOSTED_ASSETS_FIRST_DEPLOY` is unsupported and is rejected even when set to `1`. Missing local files, an unauthenticated 404, or the current public manifest cannot establish that the remote service is empty. For the existing `pullfiction-assets` service, restore the complete retained directory from the deployment machine or a verified backup; a newly prepared pack is not a substitute for that history. The auditor accepts retained chunks only after validating their names, compressed hashes, decompression limits and file sizes.

Before upload, the deployer saves and syncs the complete old-plus-new chunk union and a transaction journal beneath `.agent/work/hosted-assets/`. It serializes deployment and recovery with a POSIX file lock on macOS or Linux. After upload, it installs retention through directory renames and keeps the previous generation in a `previous.*` directory. A pending transaction blocks later uploads, including attempts using the obsolete first-generation override.

If an upload reports an uncertain failure or local finalization fails, preserve the entire `.agent/work/hosted-assets/` directory and run:

```sh
bash scripts/deploy-game-assets.sh --recover
```

Recovery verifies the saved manifest, headers and complete chunk inventory, then finishes the local retention transaction. It never contacts Cloudflare. If recovery reports missing or altered bytes, restore those bytes from the saved generation or a backup before retrying. Do not delete `pending.json` to bypass recovery. After an uncertain upload, check the actual Cloudflare version separately; local recovery preserves chunks for both possible outcomes. Keep previous manifests locally. For an asset rollback, deploy the desired previous manifest through the normal deployer, for example `bash scripts/deploy-game-assets.sh .agent/work/hosted-assets/previous.<uuid>`. It combines that audited previous generation with the complete current retained chunk union, preserving chunks used by sessions that opened the newer manifest. Resolve any pending transaction first and verify delivery afterward. Selecting an earlier Cloudflare version alone restores its older asset set and can remove newer-session chunks, so it is not the asset rollback procedure.

## Bootstrap a separate new service

The configured `pullfiction-assets` service already exists. Use restoration and recovery for that service. Bootstrap is a separate operator procedure for a newly created service, with no environment-variable bypass in the deployer.

1. Through the authenticated Cloudflare control plane, create a never-used service with a distinct name and an unused hostname. Record the account and new resource identity, and reserve it against other deployments during bootstrap. A public URL or manifest check is not proof of a new service.
2. Use an isolated checkout and configure `wrangler.game-assets.jsonc` for that exact new service. Review the account, service name and route before proceeding; preserve the existing service's checkout and retained state.
3. Prepare and audit the initial pack locally. In the isolated checkout only, seed `.agent/work/hosted-assets/deployed` with a complete copy of that initial audited generation. This is valid only because the authenticated resource creation established a new service with no earlier asset generations. Do not seed an existing service's missing retention with a new pack.
4. Audit the seeded retention and invoke the normal deployer. Its durable staging, journal and recovery rules apply to this first upload too. Verify actual Cloudflare delivery, then keep a verified backup of the complete retained directory for every subsequent deployment.

## Prune local recovery copies manually

Each successful deployment keeps a complete `previous.<uuid>` directory. These recovery copies can be large. Keep at least the most recent verified previous generation; older copies can be removed manually after the following checks. The deployer never prunes them automatically.

1. Confirm that the current Cloudflare generation is healthy and that its manifest revision matches local `deployed/manifest.json`. Keep a verified backup of the complete `deployed` directory on separate storage, plus the manifests and headers needed for any rollback you still support.
2. Stop deployment work for the maintenance window. Hold the same POSIX lock for the entire inspection and removal operation, using `hosted_asset_deployment.locked(state)` with `state` set to `.agent/work/hosted-assets`. Do not delete `deployment.lock` to bypass a busy lock. If `pending.json` exists, preserve the state directory and complete recovery first; do not prune any generation or staging directory.
3. Audit `deployed` and each candidate backup with `python3 scripts/prepare-hosted-assets.py audit DIRECTORY`. Compare the full sets of chunk filenames, including extra retained chunks: every chunk in the candidate must also exist in audited `deployed`. Both audits verify that chunk names match their content hashes. Comparing only the current manifest's chunk list does not establish that older sessions' chunks remain available.
4. Identify the most recent known-good previous generation from its manifest revision and deployment records, not from UUID sorting. Keep that generation and any additional rollback copy you need. Preserve a candidate's manifest and headers separately before removing its full directory.
5. While still holding the lock, manually remove only one explicitly reviewed older `previous.<uuid>` directory at a time. Avoid wildcard deletion. Preserve `deployed`, its complete chunk union, the lock file, and any pending journal or journal-owned stage. Then re-audit `deployed` before releasing the lock.

An orphan `upload.*` directory from an abrupt process termination or failed cleanup can also be reviewed manually during that locked maintenance window. Remove it only when no pending transaction exists, no deployment CLI is running, and it is not a recovery copy you need. This procedure reclaims duplicate local directories; retiring old chunk hashes from `deployed` or Cloudflare needs a separate policy for sessions pinned to older manifests.

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
