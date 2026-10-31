# Pull Fiction

Pull Fiction lets Warcraft raid leaders, speedrunners and players analyse recorded runs and plan future ones in the same environment. A run's actual scene and timeline are the working material.

## Core jobs

- Find a guild's runs, open a report link, or resume a locally saved project.
- Analyse a full run or encounter with 3D/2D playback, actors, native nameplates and raid frames, casts, resources, buffs, targets and configurable data panes.
- Pause at a useful moment and create a plan from the recorded scene. Reposition actors, attach range drawings and markers, add comments, and organise edits by named pages and timeline rows.
- Save and reopen plans and run context locally, and export portable project backups.

The audience knows Warcraft and should recognise its actors, class colours, spell icons, raid markers and spatial measurements. They should learn a few basic controls and discover editing options in the interface.

## Two modes

**Analyse** answers what happened, when, where and to whom. Selection ties scene actors, native raid frames, charts, Focus and ability timelines together. Focus belongs to analysis.

**Plan** answers what should happen next time. It exposes drawing tools, selected-object properties, actor placement, edits, pages and timed visibility. A plan can start from a paused run or from an unloaded encounter environment without logs.

The modes share a workspace and interaction vocabulary. Right-drag controls the camera. A single click selects. A drag draws the active marking; routes and polygons use deliberate click-to-place points with a preview of the next segment. Freehand drawing remains continuous. Ordinary selection remains available without learning a large set of shortcuts. Existing selection and camera behavior is the implementation reference for any redesign.

## Design constraints already established by the user

- The game scene is the main surface. The first working view is sparse; analytical panes can be opened when useful.
- Keep the interface recognisably Warcraft, with class colours and game icons where they describe gameplay. Editing actions use clear ordinary icons and text.
- Avoid decorative cards, repeated subtitles, gratuitous explanations and a generic dashboard full of headline metrics.
- Retain native raid frames, nameplates, spell effects and the original 3D renderer. Static controls and editor chrome belong to the web interface.
- Panes are movable and resizable. The left docking zone extends the full workspace height, so the bottom timeline starts beside it. Named pages live on the Run timeline; page properties and their edits use the Edits inspector. There is no separate Pages pane.
- Focus is a compact unit-and-target display with buffs and debuffs above its bars. Its Inspect action opens a separate floating equipment window, with the equipped character model and surrounding gear slots. Show the recorded talent distribution on Equipment, without a separate Talents tab. SoD gear shows recorded rune engravings and a compact slot/name list; ordinary temporary weapon buffs remain distinct from runes.
- Workspace customisation is a core product capability. Preserve all existing pane placement, resizing, visibility, layout persistence, chart configuration and timeline options through visual changes. Layout studies show possible arrangements, not mandatory layouts.
- The requested overhaul is comprehensive polish across the existing interface: consistent components, readable hierarchy, useful icons, clear interaction states and better affordances. It does not authorize reducing the product to a fixed or simplified workspace.
- Keep one time coordinate system: a compact full-run encounter navigator and detailed lanes for casts and named plan rows. Rows can be added, named and selected over a time interval.
- Show selection, dragging, resizing and attachment affordances in the UI. Preserve dependable mouse behavior across 2D/3D and Analyse/Plan.
- Show missing or estimated replay information honestly. A loading or unloaded range is different from a measured zero.

## Technical and delivery boundaries

The existing React/TypeScript editor wraps a Rust/Bevy/WASM client. Keep that division and reuse working components. Hosting preparation targets Cloudflare static assets. Every user supplies their own modern client files through the browser; game models, textures, icons, fonts, map data and interface assets remain local. Project-local design skills and any design tooling are development resources, not part of the published site.

Forever compatibility and rulesets must not assume raid-only content. Do not hardcode the product's navigation around one raid or client version.

## Current design work

The owner requested project-local design skills and an overhaul proposal on 2026-10-29, then clarified that all existing customisation must remain and every UI surface needs polish. The owner approved implementation on 2026-10-29 as an evidence-driven capture, independent judge, improve and recheck loop. The working proposal remains at `.agent/design/overhaul-proposal.md`; the repeatable workflow is documented in `docs/UI-QUALITY-LOOP.md`. Preserve existing customization and the original renderer/native UI throughout.

The owner further clarified the Warcraft character and control budget: Warcraft Logs and Wowhead are visual references. Borrow established editor interaction patterns without copying a generic grey desktop skin. Use actual game entities and meaningful icons, selective local game typography and restrained warm accents. Every control needs a purpose, a justified location and a relevant state; fewer simultaneous controls can be better. Keep secondary options findable in the UI and preserve all customization.

The Equipment character preview is a single captured still per inspected character. It does not rotate or recapture during playback, scrubbing, panel movement or resizing. Changing the inspected character or report captures a new still; closing inspection releases the image.

Equipment, aura and rune link hovers use the supported hosted Wowhead tooltip widget with its own styling. Existing game icons, labels and click actions remain ours. Pass the game environment, aura mode, recorded item enchant and equipped set pieces; do not rebuild its popup in React or add an opening delay. Timeline cast/aura hovers and spell-details panels use the same widget inline renderer, with escaped recorded cast facts appended through its render callback. There is no separate raw-HTML reference renderer. Free camera passes through terrain and walls; obstacle handling is limited to Follow and Orbit.
