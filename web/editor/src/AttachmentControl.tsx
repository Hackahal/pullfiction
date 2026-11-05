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
  const plannedActor =
    state.workspaceMode === "plan"
      ? controller
          .displaySnapshot()
          ?.actors.find((actor) => actor.key === edit.actor)
      : undefined;
  const replayActor =
    edit.actorReport === (state.replay?.report.code ?? "")
      ? actors.find((actor) => actor.key === edit.actor)
      : undefined;
  const attachedActor = plannedActor ?? replayActor;
  const unavailable = "__unavailable-attachment__";
  return (
    <fieldset className="edit-attachment">
      <legend>Attachment</legend>
      {edit.actor && (
        <span className="edit-attachment-status">
          {attachedActor
            ? `Attached to ${attachedActor.name}${!plannedActor && replayActor && !controller.actorPose(replayActor) ? " · no position at playhead" : ""}`
            : "Attached actor unavailable"}
        </span>
      )}
      <select
        aria-label="Attach edit to actor"
        disabled={edit.locked}
        value={edit.actor && !attachedActor ? unavailable : (edit.actor ?? "")}
        onChange={(e) => controller.attachEdit(edit.id, e.target.value || null)}
      >
        <option value="">Fixed to terrain</option>
        {edit.actor && !attachedActor && (
          <option value={unavailable} disabled>
            Actor unavailable · {edit.actor}
          </option>
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
