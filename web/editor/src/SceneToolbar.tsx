import { EditorIcon } from "./EditorIcon";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
export function SceneToolbar({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const selected = state.selectedMarks.length + state.selectedActors.length > 0;
  return (
    <div className="scene-editor-toolbar" aria-label="Scene editing controls">
      {selected && (
        <div role="group" aria-label="Selection and transforms">
          {(["move", "rotate", "scale"] as const).map((tool, i) => (
            <button
              key={tool}
              aria-pressed={state.transformActive && state.transform === tool}
              onClick={() => controller.setTransform(tool)}
            >
              <EditorIcon name={tool} />
              {["Move", "Rotate", "Resize"][i]}
            </button>
          ))}
        </div>
      )}
      <select
        aria-label="Selection filter"
        value={state.selectionFilter}
        onChange={(e) =>
          controller.setSelectionFilter(
            e.target.value as Snapshot["selectionFilter"],
          )
        }
      >
        <option value="both">All objects</option>
        <option value="drawings">Drawings</option>
        <option value="actors">Actors</option>
      </select>
    </div>
  );
}
