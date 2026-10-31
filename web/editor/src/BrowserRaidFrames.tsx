import { CLASS_COLORS, combatStateAt, poseAt } from "./domain";
import { POWER_COLORS, POWER_NAMES } from "./focus-model";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";

export function resourcePercent(
  current: number | null | undefined,
  max: number | null | undefined,
) {
  return current != null &&
    Number.isFinite(current) &&
    max != null &&
    Number.isFinite(max) &&
    max > 0
    ? Math.max(0, Math.min(100, (current / max) * 100))
    : null;
}
export function BrowserRaidFrames({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const replay = state.replay;
  if (!replay) return null;
  const friendly = new Set(replay.fight.friendlyPlayers);
  const players = replay.actors.filter(
    (actor) => actor.type === "Player" && friendly.has(actor.id),
  );
  if (!players.length) return null;
  return (
    <section
      className="browser-raid-frames"
      aria-label="Raid frames"
      style={{
        width: state.raidFrameSize.width,
        maxHeight: state.raidFrameSize.height,
      }}
    >
      {players.map((actor) => {
        const unit = combatStateAt(actor, state.time),
          dead = poseAt(actor, state.time)?.dead ?? false;
        const health = resourcePercent(unit.health?.current, unit.health?.max);
        const power = resourcePercent(unit.power?.current, unit.power?.max);
        const healthText = dead
          ? "Dead"
          : health == null
            ? "Health unavailable"
            : `${Math.round(health)}% health`;
        return (
          <button
            key={actor.key}
            className="browser-raid-unit"
            data-selected={state.selected === actor.key}
            data-dead={dead}
            title={`${actor.name}, ${healthText}`}
            aria-label={`${actor.name}, ${actor.class}, ${healthText}`}
            aria-pressed={state.selected === actor.key}
            onClick={() => controller.focusActorFromRaidFrame(actor.key)}
          >
            <span
              className="browser-raid-health"
              style={{
                width: `${dead ? 0 : (health ?? 0)}%`,
                background: CLASS_COLORS[actor.class] ?? "#8b969f",
              }}
            />
            <span className="browser-raid-name">{actor.name}</span>
            <span className="browser-raid-value">
              {dead ? "Dead" : health == null ? "?" : `${Math.round(health)}%`}
            </span>
            {power != null && (
              <span
                className="browser-raid-power"
                aria-label={`${POWER_NAMES[unit.power?.type ?? 0] ?? "Power"} ${Math.round(power)}%`}
                style={{
                  width: `${power}%`,
                  background: POWER_COLORS[unit.power?.type ?? 0] ?? "#888",
                }}
              />
            )}
          </button>
        );
      })}
    </section>
  );
}
