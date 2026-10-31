import type { EditorController } from "./controller";
import type { Annotation, Snapshot } from "./types";
export function AttachmentControl({
  edit,
  state,
  controller,
}: {
  edit: Annotation;
  state: Snapshot;
  controller: EditorController;
}) {
  const actors = controller
    .sceneActors()
    .sort(
      (a, b) =>
        Number(b.type === "Player") - Number(a.type === "Player") ||
        a.name.localeCompare(b.name),
    );
  return (
    <fieldset className="edit-attachment">
      <legend>Follow an actor</legend>
      <select
        aria-label="Attach edit to actor"
        disabled={edit.locked}
        value={edit.actor ?? ""}
        onChange={(e) => controller.attachEdit(edit.id, e.target.value || null)}
      >
        <option value="">Fixed to terrain</option>
        {edit.actor && !actors.some((a) => a.key === edit.actor) && (
          <option value={edit.actor}>Actor unavailable · {edit.actor}</option>
        )}
        {["Player", "Pet", "NPC"].map((type) => (
          <optgroup
            label={
              type === "Player"
                ? "Players"
                : type === "Pet"
                  ? "Pets"
                  : "Enemies"
            }
            key={type}
          >
            {actors
              .filter((a) => a.type === type)
              .map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                  {a.type === "NPC" &&
                  actors.filter((other) => other.name === a.name).length > 1
                    ? ` · ${actors.filter((other) => other.name === a.name).findIndex((other) => other.key === a.key) + 1}`
                    : ""}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <div className="planning-actions">
        {edit.actor && (
          <button
            disabled={edit.locked}
            onClick={() => controller.attachEdit(edit.id, null)}
          >
            Detach
          </button>
        )}
      </div>
    </fieldset>
  );
}
