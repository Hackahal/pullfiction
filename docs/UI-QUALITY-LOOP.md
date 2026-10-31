# UI quality loop

This is a development workflow, not a background scheduler or a deployment tool. It improves the existing configurable Warcraft editor through real captures, independent review, small changes and repeated checks. The original renderer, native raid frames/nameplates, tactical map, saved layouts and mouse contract remain product requirements.

## Establish the comparison

1. Make a source checkpoint and retain the current local preview. Keep client assets, credentials, replay caches and generated output outside Git.
2. Duplicate a populated local project for testing. Freeze the same client/ruleset, source encounter, playhead, camera, mode, selection, tool and pane layout for each capture. Record those conditions in `--state`. Do not edit a user's original plan.
3. Use `docs/ui-quality-protocol.json` unchanged across the campaign. Its screenshot and interaction inventories are separate: pixels cannot prove that a control works.
4. Start a round:

```sh
python3 scripts/ui-quality-loop.py init .agent/work/ui-polish-loop/round-00 \
  --fixture 'Classic Era / MC / Lucifron / disposable local plan'
```

## Capture through the supported browser

Use Codex's browser tools, their screenshot/local-development documentation and the current tab binding. Keep tests in an agent-owned tab. Do not use a separate browser driver or mutate application globals/storage to manufacture a state. After UI actions, inspect the current accessible state. After rebuilding a static preview, reload and inspect it before acceptance.

Save actual JPEG screenshots at the existing viewport, with a full accessible tree next to each image. Take a full workspace capture first; add native panel clips for small details. Never upscale or redesign a capture. Test compact widths when judging responsive behaviour; restore viewport overrides afterward.

Example in the persistent CUA REPL, after binding the tab with the documented entry point:

```js
var capture = (await import('/absolute/project/scripts/ui-quality-capture.mjs')).capture;
await capture(tab, '/absolute/project/.agent/work/ui-polish-loop/round-00',
  'plan-3d', 'UI polish QA');
```

The helper takes one combined accessible-state/screenshot observation and refuses sealed rounds, duplicate files and unfinished OAuth callbacks. Await a visible semantic outcome before capture, then inspect the actual image before registering it. A filename is not proof of the state pictured. Pass each new directory explicitly; a persistent REPL closure can retain an old round path. Attach rejection handlers immediately to pending file-chooser promises.

For asset-heavy views, a loaded name does not establish that its images are ready. Wait for the loaded minimap indicator and the expected visible talent/item images before accepting a settled capture. Keep intermediate loading captures separately. Reject a responsive capture when its actual image/DOM dimensions do not match the requested viewport; restore temporary viewport overrides afterward.

Keep sealed campaigns and protocols immutable. When an explicit product change retires a pane or moves inspection into a new window, start a revised protocol for the next full campaign. A targeted follow-up can retain its own evidence and independent reviews, but must not claim a comparable full-campaign score.

Record current behaviour accurately: seeking playback intentionally pauses it. Check Play, wait for Pause, then seek and verify the changed playhead and paused state.

Register evidence rather than assigning scores automatically:

```sh
python3 scripts/ui-quality-loop.py capture .agent/work/ui-polish-loop/round-00 \
  --id plan-3d --image plan-3d.jpg \
  --state 'Plan; paused 0:08.000; selected healer; default custom layout; 3D'
python3 scripts/ui-quality-loop.py interaction .agent/work/ui-polish-loop/round-00 \
  --id camera-3d-plan --status pass --evidence camera-3d-plan.txt \
  --notes 'Right drag changes view; release stops; selection retained; no context menu'
```

The tool checks actual JPEG signatures/dimensions and hashes captures. It never takes screenshots or drives the app. Missing, blocked and failed checks remain explicit. Record loading, empty, error, long-content and tooltip states when reachable; never present a fabricated fixture as a live import.

## Independent judges

Use three fresh, isolated judges after the capture set is ready. Give them the same product brief, protocol, screenshot paths and actual interaction evidence. Do not show them previous/desired scores or each other's opinions. They inspect images, not filenames alone. Each writes `judge-<role>.json` in the round:

| Role | Fixed criteria | Useful project-local skills |
| --- | --- | --- |
| consistency | component_consistency, state_clarity, icon_semantics, warcraft_identity | frontend-design, Emil, Impeccable Operate |
| layout | hierarchy_readability, density_alignment, scene_panel_composition, adaptive_layout | Taste app screens, Impeccable |
| interaction | selection_direct_manipulation, camera_navigation, timeline_control, discoverability_recovery | UI/UX Pro Max, Emil |

Score every criterion from 0–10 using the same anchors: **3** broken or unclear; **5** usable but rough; **7** coherent with notable defects; **9** polished and trustworthy; **10** exceptional with no observed issue. Every score needs image-specific evidence. Behaviour needs actual interaction evidence; screenshot-only inferences must be labelled. Include `role`, `scores`, `evidence`, `blockers`, `top_fixes` and `limitations`. Keep a read-only independent assessment separate from implementation.

Scores are equally weighted, advisory and subjective. Removing controls, hiding hard cases, shrinking the coverage set or changing weights cannot count as improvement. A high appearance score does not excuse a broken camera, lost edits or a clipped menu. The reporter labels incomplete coverage as provisional and withholds a benchmark delta unless required contexts and checks match.

## Improve and repeat

1. Reproduce and rank findings by user impact. Prefer a shared component or interaction fix over one-off CSS patches. Use the incumbent Warcraft identity; keep gameplay icons local, and use normal icons/text for editor actions.
2. Fix a coherent group, run focused checks, then build an isolated static candidate. Retain the old preview. No upload or deployment occurs in this workflow.
3. Repeat the same captures/checks into a new round. Freeze the protocol; document added exploratory cases separately.
4. Obtain new independent judgements. Generate the report:

```sh
python3 scripts/ui-quality-loop.py report .agent/work/ui-polish-loop/round-01 \
  --compare .agent/work/ui-polish-loop/round-00
```

5. Run up to three meaningful improvement rounds per campaign. Stop for a major blocker, two rounds without useful improvement, or checked results with no essential interaction failures. An unfinished surface remains unfinished regardless of the mean score. Keep the next-pass backlog in the report.

Useful established patterns: [After Effects workspaces, docking and visible drop zones](https://helpx.adobe.com/after-effects/desktop/get-started/get-familiar-with-the-interface/workspaces-panels-viewers.html), [Photoshop visible transform handles](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/resize-reposition-and-rotate-images-in-the-collage.html). Adopt predictable affordances; retain Pull Fiction's right-drag camera and UI-led editing rather than importing an incompatible shortcut scheme.
