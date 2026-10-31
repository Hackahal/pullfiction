import { MarkIcon } from "./Planning";
import { MARK_ICONS, RAID_ICONS } from "./annotation-model";
import type { Annotation } from "./types";
import { ExactNumber } from "./ExactNumber";
import { EditorIcon } from "./EditorIcon";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
export function DrawingDefaults({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const edit = state.plan.steps
    .flatMap((s) => s.annotations)
    .find((a) => a.id === state.selectedMark);
  const style = edit ?? state.markStyle,
    locked = !!edit?.locked && state.selectedMarks.length < 2;
  const update = (change: Partial<Annotation>) => {
    controller.setMarkStyle(change);
    if (edit) controller.updateMark(change);
  };
  const actorKey = controller.selectedActorForDrawing(),
    actor = controller.sceneActors().find((a) => a.key === actorKey);
  const marker = actorKey
    ? state.plan.steps
        .flatMap((s) => s.annotations)
        .find((a) => a.type === "marker" && a.actor === actorKey)
    : edit?.type === "marker"
      ? edit
      : undefined;
  return (
    <div className="drawing-defaults">
      <div className="toolbox-label">{edit ? edit.name : "Markings"}</div>
      {actor && (
        <div className="drawing-anchor-context">
          <EditorIcon name="actors" />
          <span>
            Draw from <strong>{actor.name}</strong>
          </span>
        </div>
      )}
      <div className="raid-marker-palette" aria-label="Raid markers">
        {RAID_ICONS.map((name, i) => (
          <button
            key={name}
            title={actor ? `${name} on ${actor.name}` : name}
            aria-label={
              actor ? `Mark ${actor.name}: ${name}` : `${name} marker`
            }
            aria-pressed={marker?.icon === String(i + 1)}
            onClick={() => controller.applyMarker(String(i + 1))}
          >
            <MarkIcon icon={String(i + 1)} />
          </button>
        ))}
      </div>
      <details className="extra-marker-icons">
        <summary>More icons</summary>
        <div className="plan-icon-grid">
          {MARK_ICONS.filter((icon) => !/^\d$/.test(icon)).map((icon) => (
            <button
              key={icon}
              title={icon.replaceAll("_", " ")}
              onClick={() => controller.applyMarker(icon)}
            >
              <MarkIcon icon={icon} />
            </button>
          ))}
        </div>
      </details>
      {(edit || !["explore", "marker"].includes(state.tool)) && (
        <div className="drawing-style-row">
          <input
            type="color"
            aria-label="Drawing color"
            value={style.color}
            disabled={locked}
            onChange={(e) => update({ color: e.target.value })}
          />
          <label>
            {["circle", "cone"].includes(edit?.type ?? state.tool)
              ? "Radius · yd"
              : "Size · yd"}
            <ExactNumber
              label={
                edit
                  ? `${["circle", "cone"].includes(edit.type) ? "Radius" : "Size"} in yards`
                  : "Default drawing size"
              }
              value={style.size}
              min={0.5}
              max={100}
              disabled={locked}
              onCommit={(size) => update({ size })}
            />
          </label>
          <label>
            Stroke
            <ExactNumber
              label="Default stroke"
              value={style.width}
              min={1}
              max={8}
              disabled={locked}
              onCommit={(width) => update({ width })}
            />
          </label>
        </div>
      )}
      {controller.numericDrawingAvailable() && (
        <div className="drawing-dimension">
          <label>
            {["circle", "cone"].includes(state.tool) ? "Radius" : "Distance"}
            <input
              aria-label="Drawing dimension"
              inputMode="decimal"
              value={state.dimensionInput}
              placeholder="Type yards"
              onChange={(e) => controller.setDrawingDimension(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  state.dimensionInput
                    ? controller.confirmDrawingDimension()
                    : controller.finishDrawing();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  state.dimensionInput
                    ? controller.cancelDrawingDimension()
                    : controller.cancelDrawing();
                }
              }}
            />
            <span>yd</span>
          </label>
          <button
            onClick={() =>
              state.dimensionInput
                ? controller.confirmDrawingDimension()
                : controller.finishDrawing()
            }
          >
            Confirm
          </button>
          <button onClick={() => controller.cancelDrawing()}>Cancel</button>
        </div>
      )}
      <details className="drawing-snaps">
        <summary>
          <EditorIcon name="snap" /> Snapping
        </summary>
        {(
          [
            ["position", "Position"],
            ["size", "Size"],
            ["angle", "Angle"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={state.snap[key]}
              onChange={(e) => controller.setSnap({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <label>
          Grid
          <select
            aria-label="Position snapping"
            value={state.snap.mode}
            onChange={(e) =>
              controller.setSnap({
                mode: e.target.value as "grid" | "relative",
              })
            }
          >
            <option value="relative">Relative increments</option>
            <option value="grid">World grid</option>
          </select>
        </label>
        <label>
          Yards
          <ExactNumber
            label="Snap yards"
            value={state.snap.yards}
            min={0.1}
            max={100}
            onCommit={(yards) => controller.setSnap({ yards })}
          />
        </label>
        <label>
          Degrees
          <ExactNumber
            label="Snap degrees"
            value={state.snap.degrees}
            min={1}
            max={180}
            onCommit={(degrees) => controller.setSnap({ degrees })}
          />
        </label>
      </details>
      <details className="drawing-help">
        <summary>Basic controls</summary>
        <p>
          Click to select. Drag to draw with the chosen marking. A selected
          actor is the drawing's origin. Its move grip repositions it.
          Right-drag turns the camera; WASD moves it. Shift adds to a selection.
        </p>
        <p>
          Type a distance while drawing. Enter confirms; Escape cancels. Select
          an edit in the Edits panel to change it later.
        </p>
      </details>
    </div>
  );
}
