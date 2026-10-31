import { CLASS_COLORS } from "./domain";
import { resourcePercent } from "./BrowserRaidFrames";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";

export function BrowserNameplates({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  if (!state.options.nameplates) return null;
  const actors = new Map(
    (state.replay?.actors ?? []).map((actor) => [actor.key, actor]),
  );
  const friendlyPlayers = new Set(state.replay?.fight.friendlyPlayers ?? []);
  const plates = state.browserPlates.filter((plate) => {
    const actor = actors.get(plate.key);
    const friendly =
      actor?.type === "Player" ? friendlyPlayers.has(actor.id) : plate.friendly;
    return friendly
      ? state.options.friendlyNameplates
      : state.options.enemyNameplates;
  });
  if (!plates.length) return null;
  return (
    <div className="browser-nameplates" role="group" aria-label="Nameplates">
      {plates.map((plate) => {
        const actor = actors.get(plate.key);
        const health = resourcePercent(plate.health, plate.maxHealth);
        const color =
          actor?.type === "Player"
            ? CLASS_COLORS[actor.class]
            : plate.friendly
              ? "#6db580"
              : "#bc6258";
        return (
          <button
            key={plate.key}
            className="browser-nameplate"
            aria-label={`Select ${plate.name}`}
            aria-pressed={state.selected === plate.key}
            title={
              health == null
                ? `${plate.name}, health unavailable`
                : `${plate.name}, ${Math.round(health)}% health`
            }
            style={{ left: plate.x, top: plate.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              controller.select(plate.key);
            }}
          >
            <span style={{ color }}>{plate.name}</span>
            {health != null && (
              <span
                className="browser-nameplate-health"
                role="meter"
                aria-label={`${plate.name} health`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={health}
              >
                <span style={{ width: `${health}%`, background: color }} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
