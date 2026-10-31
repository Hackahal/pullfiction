# Maintain the upstream engine

Pull Fiction starts with a single source-snapshot commit. Its engine derives from [Arnesen/wenilla](https://github.com/Arnesen/wenilla), which builds on [samwhosung/benilla](https://github.com/samwhosung/benilla). Source licences, notices and attribution remain in the repository.

## Recorded source baseline

The last shared Wenilla revision before the history squash was [`3426fd28c55b1d3dad22459d1a80e72a05a8006c`](https://github.com/Arnesen/wenilla/commit/3426fd28c55b1d3dad22459d1a80e72a05a8006c). Pull Fiction includes its own changes on top of that source, including browser-local asset loading, renderer fixes, native raid UI integration and the React editor. The baseline is the last integrated revision, not a claim that it is the newest available upstream commit.

The single initial commit has no Git parent. Wenilla is therefore no longer a merge ancestor of Pull Fiction's main branch. A normal upstream merge or rebase cannot use the former common history automatically.

## Inspect future updates

On a fresh clone, configure the upstream remote once:

```sh
git remote add upstream https://github.com/Arnesen/wenilla.git
git remote set-url --push upstream DISABLED
```

Fetch updates without changing the application:

```sh
git fetch upstream
git log --oneline 3426fd28c55b1d3dad22459d1a80e72a05a8006c..upstream/main
git switch -c sync-wenilla main
```

Use the recorded baseline to compare upstream changes. Apply relevant engine changes through reviewed three-way patches or selected cherry-picks, resolving them against Pull Fiction's current code. Record the source revision and scope of each integration. Do not merge unrelated histories wholesale; the single-commit reset intentionally removed the previous merge ancestry.

## Preserve the application

The entry points are `web/editor`, `web/archive`, `crates/pullfiction-viewer` and `crates/pullfiction-asset-codec`. The shared `benilla-*` crates supply engine, formats and native UI. Original native launchers, realm/host services, the prototype web shell and the experimental replacement renderer were retired. Keep them excluded when importing engine changes.

Review workspace membership and dependencies. Replace a local engine fix only when upstream provides equivalent browser behavior. Preserve native raid frames, nameplates, camera controls and the original rendering path. Keep Pull Fiction's CI and static packaging boundary; upstream pin bots, realm deployment hooks, game-data servers and account-login workflows are not part of this application.

## Verify an integration

Run `bash scripts/check.sh` and compile retained native targets with `cargo check --workspace --all-targets`. Build a complete release into a new directory with `scripts/browser-static-build.sh`. The production renderer target is `pullfiction-viewer` with `--no-default-features --features browser-static`.

Open the isolated static preview with browser-local client files. Check startup, 3D and 2D views, native raid UI, analysis/playback, drawing/planning and saved-project reopening. Use the renderer workbench for representative world, character and effect captures. Compiler and decoder checks alone cannot detect every visual regression.

Publish the verified integration through the project's normal Git workflow. An upstream update is not a deployment.
