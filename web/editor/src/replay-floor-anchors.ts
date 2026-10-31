import reference from "../../../third_party/raid-spawns/vanilla.json";
import dungeons from "../../../third_party/raid-spawns/classic-dungeons.json";
import type { FloorAnchor } from "./replay-floor-geometry";

/** Numeric geometry calibration only; never a source of replay actors. */
export function replayFloorAnchors(map: number): FloorAnchor[] {
  const maps = { ...dungeons.maps, ...reference.maps } as Record<
    string,
    { entry: number; position: number[] }[]
  >;
  return (maps[String(map)] ?? []).flatMap((row) =>
    Number.isInteger(row.entry) &&
    row.entry > 0 &&
    row.position.length === 3 &&
    row.position.every((v) => Number.isFinite(v) && Math.abs(v) <= 20000)
      ? [
          {
            entry: row.entry,
            point: [...row.position] as [number, number, number],
          },
        ]
      : [],
  );
}
