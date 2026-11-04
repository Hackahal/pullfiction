import { preciseTime } from "./domain";
import { EditorIcon } from "./EditorIcon";
import type { EditorController } from "./controller";
import type { RecordedEventDetail, Replay } from "./types";

export function SceneEventContext({
  event,
  replay,
  selected,
  controller,
}: {
  event: RecordedEventDetail;
  replay: Replay;
  selected: string | null;
  controller: EditorController;
}) {
  function participant(role: "Source" | "Target", key: string | undefined) {
    const actor = replay.actors.find((candidate) => candidate.key === key);
    if (!actor)
      return (
        <span className="scene-event-unknown">
          {role === "Source" && !key ? "Environment" : "Unknown"}
        </span>
      );
    const available = controller.canFocusRecordedActor(actor.key);
    return (
      <button
        type="button"
        data-current={selected === actor.key || undefined}
        aria-label={`Frame event ${role.toLowerCase()}: ${actor.name}`}
        aria-disabled={!available}
        title={
          available
            ? `Frame ${actor.name} at the current playhead`
            : `${actor.name} has no position at the current playhead`
        }
        onClick={() => {
          if (available) controller.focusRecordedActor(actor.key);
        }}
      >
        <span>{actor.name}</span>
        <EditorIcon name="focus" />
      </button>
    );
  }
  return (
    <div
      className="scene-event-context"
      role="group"
      aria-label="Event in scene"
    >
      <span className="scene-event-caption" title={event.name}>
        <i aria-hidden="true" />
        <span>{event.name}</span>
        <time>{preciseTime(event.t)}</time>
      </span>
      <span className="scene-event-actors">
        {participant("Source", event.source)}
        <span aria-hidden="true">→</span>
        {participant("Target", event.target)}
      </span>
    </div>
  );
}
