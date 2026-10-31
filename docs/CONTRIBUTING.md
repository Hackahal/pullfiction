# Contribute to Pull Fiction

Start with [the editor development guide](EDITOR.md). Pull Fiction is a browser-local analysis and planning application, built on the Benilla/Wenilla engine. Changes should preserve its 3D view, tactical map, native raid UI, analysis tools and saved plans.

## Keep the source boundary clear

Commit application code, tests, reusable development tools, format definitions and licence/provenance records. Keep installed game data, extracted assets, replay/report caches, credentials, generated releases, personal assistant tooling and investigation notes out of Git. Document required local fixtures instead of committing client files.

The NPC metadata snapshot contains approved names and numeric references only. Models, textures, sounds and client tables come from the user's installation. Browser OAuth uses a public PKCE client; never put a client secret in frontend configuration.

## Make a focused change

Use a branch with a descriptive name and no slashes. Keep product code in `web/editor`, shared replay logic in `web/planner`, browser asset code in `web/archive`, format adapters in `scripts/classic_*.py`, and project renderer integration in `crates/pullfiction-viewer`.

Keep engine changes small and easy to compare with upstream. Prefer a project-owned helper or an existing browser-specific hook over restructuring shared engine code. See [upstream maintenance](UPSTREAM.md). Preserve third-party licences and attribution.

Retain compatibility for saved plans and replay files unless a migration is provided. Do not change the visible interface or controls as a side effect of hosting, packaging or dependency work.

## Check the result

Run `bash scripts/check.sh`. Add focused checks for the changed behavior. A UI change needs observed interaction evidence; a renderer change needs actual rendered pixels as well as format and compiler checks. Use disposable local projects when testing edits.

Describe what changed, why, the checks that ran and any remaining limitation in the commit or pull request. Keep task transcripts and generated evidence in ignored local working directories.
