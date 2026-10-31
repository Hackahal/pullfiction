# Pull Fiction interface

Pull Fiction is an operating tool for analysing runs and planning future ones. Preserve the original native 3D renderer, raid frames, nameplates, tactical map and customizable workspace. Improving presentation must not replace those systems.

Warcraft Logs and Wowhead guide its Warcraft web character. Photoshop and After Effects guide selection, properties, visible handles, docking, layers and timelines. Copy the familiar interaction pattern when it fits; retain right-drag camera control and the existing basic controls.

## Visual language

Use compact dark neutral surfaces, small corner radii, subdued borders and clear hover, selected, disabled and keyboard-focus states. Separate neighbouring groups by spacing and lightness. Keep the scene dominant. Avoid decorative cards, heavy fantasy frames, arbitrary spell icons and explanatory subtitles under every heading.

Avenir/Segoe UI/Arial provide readable controls and dense data. Client-local Friz is used selectively for the product and pane headings, with Georgia as a fallback. No game font is distributed with the static site. Keep timestamps and quantities tabular; do not make all text monospace or all controls Friz.

Game entities supply the character: class identity, boss portraits, spells, gear quality, raid marks and native health/power bars. Use local game icons where their meaning is the game object. Use consistent SVG utility icons with labels for editing, docking, saving and navigation. Gold identifies an editing selection or action; class and equipment colours retain their game meanings.

## Control placement

Global project actions belong in the project bar. Analyse and Plan stay in a stable place. Playback and time navigation belong beside the run timeline. Chart settings belong with their chart. Marking tools, stroke, range and numeric draft dimensions belong on the left. Selected-object properties belong above the Edits list, with attachment and exact measurements available there.

Show transforms when there is a selection. Use one camera-mode control with contextual distance settings, Frame beside it, and a stable 3D/Map switch. Put secondary bulk edit actions beside the Edits list. All pane destinations remain available through a compact destination/position form as well as pointer docking. Keep the full-height left docking zone.

Before adding a control, establish its scope, where a user would look for it, whether it duplicates an action, and whether it is useful in the current state. Removing a duplicate must retain a visible route to its capability. Customization includes pane visibility, docking, resizing, persistence and chart configuration.

## Interaction invariants

Click selects. Drag draws with the chosen marking; routes and polygons use click-to-place points and a live preview, while Freehand remains continuous. Visible grips edit existing objects. Right-drag controls the camera in both modes. Keep modifiers supplementary and basic actions discoverable through UI. A selected actor is a drawing origin; actor attachment is explicit in selected properties. Undo must restore the whole edit.

Analyse and Plan share the same toolbox width. Pages belong to the Run timeline, with properties in Edits. Focus stays compact near the scene's lower edge: a focused unit and target, auras above, and a visible Inspect action. Equipment belongs in a separate movable window. Arrange gear around the original renderer's equipped character model, with the recorded talent distribution in its summary row. SoD rune badges belong to their gear slots; a compact disclosure lists their recorded names.

Keep scene geometry stable during gestures. Draft properties must not change viewport height mid-drag. Manual map framing survives pane resizing. Frame includes selected drawing extent, labels/markers and surrounding ground. Range resizing measures horizontal yards even over empty ground; placing or moving an origin still uses floor information.

## Verification

Use [the UI quality loop](docs/UI-QUALITY-LOOP.md), its frozen capture/interaction inventory and independent judges. Inspect actual screenshots. Record behavioural checks separately and report incomplete coverage honestly. Preserve prior evidence, the source checkpoint and a runnable preview. A numerical score is advisory; a broken essential interaction remains a failure.

The Equipment character preview is a single captured still per inspected character. It does not rotate or recapture during playback, scrubbing, panel movement or resizing. Changing the inspected character or report captures a new still; closing inspection releases the image.

Equipment, aura and rune link hovers use the supported hosted Wowhead tooltip widget with its own styling. Existing game icons, labels and click actions remain ours. Pass the game environment, aura mode, recorded item enchant and equipped set pieces; do not rebuild its popup in React or add an opening delay. Timeline cast/aura hovers and spell-details panels use the same widget inline renderer, with escaped recorded cast facts appended through its render callback. There is no separate raw-HTML reference renderer. Free camera passes through terrain and walls; obstacle handling is limited to Follow and Orbit.
