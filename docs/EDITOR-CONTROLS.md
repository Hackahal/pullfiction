# Analyse and Plan controls

Pull Fiction has two modes. **Analyse** inspects recorded runs. **Plan** authors future pulls, positioning and assignments, with or without a recording. Playback and the choice of 2D or 3D view belong to both modes.

## Workspace

The left rail contains marking tools, raid-marker icons, colour, size and stroke controls. These controls edit the selected drawing and supply the defaults for the next drawing. Focus belongs to Analyse and is hidden in Plan. A new plan can add named player placeholders with explicit class selection. Pages and Edits are separate dock panes. Pages holds page timing, layer assignment and notes; Edits holds the drawing and actor placement list and their properties. Each pane has its own title grip, close control and resizing dividers. Drag either title to any panel edge, or use its actions menu for left, right, top and bottom placement. The left dock spans the full workspace height, with the scene and timelines stacked beside it. Drag to the workspace's left edge or choose Dock in left zone to add a pane there; the preview covers the full column. Their positions are saved separately for Analyse and Plan. The rail toggles each pane independently. Both open by default in Plan; closing Pages is remembered. Analysis panels are optional and retain their layout. A focused panel has a visible outline. Shortcuts act on that panel; typing never edits the scene.

**Plan from this moment** pauses the recording and creates a step with a frozen copy of available actor positions, source report and time. Moving those actors changes the plan only. Recorded/Planned switches compare the source and proposed arrangement. Snapshot steps can be saved and reopened without fetching their source report; actor tokens retain names, classes, model identities and positions. Gear and live combat detail come from the loaded source replay.

## Selection and transformations

| Gesture | Result |
| --- | --- |
| Single left-click | Select an actor or edit, regardless of the marking tool |
| Left-drag with a marking selected | Draw that marking; release commits it |
| Shift-left-click / drag | Select while keeping the drawing tool; click toggles, drag adds |
| Left-drag with Select active | Move a selected edit, or marquee-select from empty space |
| Drag a visible grip | Move, resize, rotate or adjust a point, according to that grip |
| Move / Rotate / Resize buttons | Choose an explicit group transform |
| F | Frame selected object or player |
| Select an actor, then drag a marking | Draw from that actor's exact centre and attach it |
| Select an enemy, click a raid-marker icon | Apply that marker immediately |
| Duplicate button in Edits | Duplicate selected drawings |
| Ctrl/Cmd+A | Select editable objects in current step |
| Ctrl/Cmd+C / X / V | Copy / cut / paste drawings |
| Arrow keys | Nudge 1 yard in scene; Shift 10 yards, Alt 0.1 yard |
| Enter | Confirm current drawing or numeric field |
| Escape | Cancel current operation, then leave tool, then clear selection |
| Delete / Backspace | Delete selected drawings |
| Ctrl/Cmd+Z / Shift+Z | Undo / redo |

Recorded actors are never duplicated or deleted by drawing shortcuts. Transform operations preserve terrain height and use the group center as pivot. One drag is one undo entry. Cancel restores the entire operation. Selected drawings automatically show controls without choosing a transform tool. Range circles show a centre move grip and eight radius grips. Directional drawings expose point, rotation and size grips. Hovering shows the matching cursor and a short action label. With Select active, dragging a selected drawing moves it. Native and 2D handles keep a fixed screen hit area; locked drawings show no editable handles. Overlapping drawings can be selected from the Edits list. Actor placements appear there too; recorded players can also be selected through raid frames and analysis panels. Right-click opens no scene or map menu. Filters restrict selection to drawings, actors or both.

## Navigation

The 3D scene uses the client's native free-camera controller, including its mouse sensitivity and pitch settings. WASD moves the camera, Space moves up, C moves down, and right-drag locks the pointer and looks around. Releasing right-click returns the pointer; Escape releases the lock too. Middle-drag pans. Clicking the scene gives it keyboard focus; typing, command shortcuts, other panels and the map suspend free-camera movement.

Selecting a player makes **Orbit player** available. This toggle anchors the camera to that player's native grounded position and follows their movement. Right-drag orbits; middle-drag pans; the wheel changes distance within the configured maximum. **Free camera** returns to WASD movement. Drawing tools do not silently change the camera mode.

Right-drag and middle-drag pan the 2D map. A click selects. A drag uses the selected marking. Shift temporarily selects while a drawing tool is active; the Select tool selects without a modifier. Wheel/pinch zooms toward the pointer in 2D. F frames the selection. Manual camera movement disables automatic raid follow. Double-click a native raid frame to frame that player. Follow retargets and locks to them; Orbit keeps its mode and changes its pivot. Native raid-frame clicks do not select the scene behind them.

With a log, timeline Space plays or pauses and arrows seek. Without a log, those controls advance through ordered pages. The timeline ruler scrubs; right-drag pans time. Pages arrows select adjacent steps; Edits keeps a separate input context. Form controls keep their usual keyboard behavior.

## Measurements and snapping

World coordinates and distances use WoW yards. The ground plane is XY. A circle's measurement is its radius, so entering 40 creates a 40-yard range. Exact numeric controls are available for radius, coordinates, angle and scale.

Position, dimensions and angles have separate snap settings. Position supports a fixed world grid or relative increments. Relative mode rounds displacement and preserves imported formation offsets. Default increments are 1 yard and 15 degrees; snapping starts disabled. Hold Alt/Option to bypass timeline snapping. Shift constrains movement to the dominant ground axis. Snapping never rounds terrain height.

Range circles can attach to an actor. Moving that actor moves the range. The display describes geometric distance only; range does not establish line of sight, spell eligibility, collision or a guaranteed heal. Terrain and missing recorded height can limit the accuracy of an inferred position.

## Drawing and time

Choose a marking, then drag to draw without a modifier. A single click always selects. Circles, cones and arrows preview their range and direction during the drag; release commits them. Routes, polygons and freehand sample the stroke while dragging. Markers and text can be dropped by dragging. Escape cancels. Type yards while drawing, or enter a value in the toolbar measurement field, then confirm. Terrain projection uses approximate fills and sampled centerlines for responsiveness. Soft line edges reuse that centerline height. Hover changes highlights without rebuilding geometry. Cliffs and missing terrain still break the drawing; small surface details can intersect it.

Every drawing has a persistent editable name in Edits. Its properties include placement, dimensions, appearance, notes, comments, visibility, locking, and an actor attachment selector. Selecting an actor makes it the origin for the next marking, so pressing slightly away from it still centres the drawing on the actor. With no marking active, actor move grips appear automatically. Starting a move in a recording pauses and captures that moment as a plan; recorded data remains unchanged. Drag the bottom-right native raid-frame grip to resize the formation; rows, columns and cell scale adjust to fit.

The run timeline is a docked pane. Drag its title grip to move it and a divider to resize it. Its rows scroll vertically while the ruler, bosses and mobs stay pinned at the top. Layers are named rows on the normal run timeline, beneath bosses and mobs. They share one ruler, zoom, pan and playhead. Each layer contains pages with drawings, comments and optional actor placements. This is the main visibility model.

With a log loaded, a page has an optional start and end. All pages active at the playhead are visible together across rows. Start is inclusive and end is exclusive. Untimed pages are marked Always. A hidden row contributes no content. Later rows take priority when two active pages place the same actor.

Dragging empty row space selects a period. Dragging over an Always page gives that page a period. A clip body moves its period, its edges trim it, and vertical dragging moves it to another row. Snapping aligns clips to the playhead, encounter boundaries and other clip edges. Alt bypasses snapping. Escape cancels a pending drag. Each committed drag is one undo operation.

Without a log, pages appear in explicit numbered step order instead of on a fabricated time scale. Selecting a page shows that step's content. Dragging a page reorders it or changes its row; Previous and Next advance through the visible steps. Saved time links are retained for reuse when a log is loaded.

The row header contains its editable name, visibility toggle, ordering controls and delete button. Deleting a row also removes its pages; Undo restores them together. New rows start with a page. The Pages pane edits page names, notes, row assignment and recorded timing. Existing plans migrate into one default row. The source recording stays immutable.

## Sources and adaptation

The controls adapt patterns from these official references:

- [Figma selection](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects): direct selection, marquee, object list and overlap selection.
- [Figma copying](https://help.figma.com/hc/en-us/articles/4409078832791-Copy-and-paste-objects): copy/paste and duplicate commands; duplication is available through the properties UI.
- [Unity transform tools](https://docs.unity.cn/Manual/PositioningGameObjects.html): explicit transform tools. Pull Fiction exposes these as toolbar buttons and preserves WASD camera movement.
- [SketchUp measurements](https://help.sketchup.com/en/managing-units-measurement) and [movement](https://help.sketchup.com/en/sketchup/moving-entities-around): units, exact values, increments and axis constraints.
- [SketchUp tool guidelines](https://developer.sketchup.com/article-ux-guidelines): both drag-release and click-move-click creation.
- [Blender navigation](https://docs.blender.org/UATEST/manual/en/4.5/editors/3dview/navigate/navigation.html): orbit, pan and frame-interest navigation.
- [Premiere keyboard navigation](https://helpx.adobe.com/premiere/desktop/get-started/set-up-accessibility-features/navigate-premiere-using-the-keyboard.html): shortcuts follow the focused panel.
- [Premiere workspaces](https://helpx.adobe.com/ca/premiere/desktop/get-started/tour-the-workspace/change-create-reset-workspaces.html): persistent panel arrangements.
- [Premiere timeline snapping](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/snap-clips.html): edges, markers and playhead alignment.
- [Photoshop snapping](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/position-elements-with-snapping.html): visible toggle, selectable targets and temporary override.

