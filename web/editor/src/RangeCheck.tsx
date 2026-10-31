import { useEffect, useState } from "react";
import { EditorIcon } from "./EditorIcon";
import { CLASS_COLORS } from "./domain";
import { rangePlayers, rangePlayerRole, type RangeGroup } from "./range-check";
import type { Snapshot } from "./types";
import type { EditorController } from "./controller";

export function RangeCheck({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const [search, setSearch] = useState("");
  useEffect(
    () => setSearch(""),
    [state.replay?.report.code, state.gameVersion],
  );
  const settings = state.rangeCheck;
  const players = state.replay
    ? rangePlayers(state.replay).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return (
    <section className="range-check" aria-label="Range check">
      <label className="range-check-toggle">
        <EditorIcon name="circle" />
        <span>Range check</span>
        <input
          type="checkbox"
          aria-label="Enable range check"
          checked={settings.enabled}
          onChange={(e) =>
            controller.setRangeCheck({ enabled: e.target.checked })
          }
        />
      </label>
      {settings.enabled && (
        <div className="range-check-controls">
          <label className="range-check-radius">
            Radius
            <span>
              <input
                aria-label="Range radius in yards"
                type="number"
                min="1"
                max="100"
                step="0.5"
                value={settings.radius}
                onChange={(e) => {
                  if (e.target.value)
                    controller.setRangeCheck({
                      radius: Number(e.target.value),
                    });
                }}
              />{" "}
              yd
            </span>
          </label>
          <select
            aria-label="Range check players"
            value={settings.group}
            onChange={(e) =>
              controller.setRangeCheck({ group: e.target.value as RangeGroup })
            }
          >
            <option value="all">All players</option>
            <option value="ranged">Ranged DPS</option>
            <option value="melee">Melee DPS</option>
            <option value="dps">All DPS</option>
            <option value="healers">Healers</option>
            <option value="tanks">Tanks</option>
            <option value="individuals">Choose players</option>
          </select>
          {settings.group === "individuals" && (
            <>
              <input
                type="search"
                aria-label="Find range check player"
                placeholder="Find player…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div
                className="range-check-roster"
                role="group"
                aria-label="Players with range circles"
              >
                {players
                  .filter((a) =>
                    a.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((actor) => (
                    <label key={actor.key}>
                      <input
                        type="checkbox"
                        checked={settings.players.includes(actor.key)}
                        onChange={(e) =>
                          controller.setRangeCheck({
                            players: e.target.checked
                              ? [...settings.players, actor.key]
                              : settings.players.filter(
                                  (key) => key !== actor.key,
                                ),
                          })
                        }
                      />
                      <span style={{ color: CLASS_COLORS[actor.class] }}>
                        {actor.name}
                      </span>
                    </label>
                  ))}
                {!players.length ? (
                  <p>Load a run to choose players.</p>
                ) : (
                  !players.some((a) =>
                    a.name.toLowerCase().includes(search.toLowerCase()),
                  ) && <p>No matching players.</p>
                )}
              </div>
            </>
          )}
          <div className="range-check-legend">
            <span className="range-clear" />
            Clear
            <span className="range-crowded" />
            Player inside
          </div>
          {state.replay &&
            settings.group !== "all" &&
            settings.group !== "individuals" &&
            players.some(
              (a) => rangePlayerRole(state.replay!, a).role === "unknown",
            ) && (
              <p className="range-check-note">
                Some roles are unrecorded. Use Choose players to include them.
              </p>
            )}
        </div>
      )}
    </section>
  );
}
