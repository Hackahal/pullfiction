import reference from "../../../third_party/raid-spawns/vanilla.json";
import dungeons from "../../../third_party/raid-spawns/classic-dungeons.json";
import sod from "../../../third_party/raid-spawns/sod.json";
import guides from "../../../third_party/raid-spawns/sod-guides.json";
import type { Actor, GameVersion } from "./types";
import type { NpcDisplayModel } from "./npc-models";
import type { ModernCatalog } from "./browser-assets";

type Model = { displayID?: number; scale?: number };
type ReferenceRow = {
  id: string;
  entry: number;
  name: string;
  displayID: number;
  boss: boolean;
  position: [number, number, number | null];
  facing: number | null;
  floor?: number;
  kind?: "sod-reference" | "portal-registered-reference" | "guide-reference";
  displaySourceURL?: string;
};
const maps = reference.maps as unknown as Record<string, ReferenceRow[]>;
const dungeonMaps = dungeons.maps as unknown as Record<string, ReferenceRow[]>;
const sodMaps = sod.maps as unknown as Record<
  string,
  {
    placements: ReferenceRow[];
    unplaced: unknown[];
    sourceCount: number;
    mappingVersion: number;
  }
>;

export function referenceCoverage(map: number, version: GameVersion) {
  if (version === "sod" && map === 48) {
    // All SoD BFD bosses have different identities. Remove the old bosses and
    // patrol alternatives before adding one current guide reference per boss.
    const replaced = new Set([
      12876, 4829, 4830, 4831, 4832, 4887, 6243, 12902,
    ]);
    const baseline = (dungeonMaps[map] ?? []).filter(
      (row) => !replaced.has(row.entry),
    );
    return {
      rows: [...baseline, ...(guides.maps["48"] as unknown as ReferenceRow[])],
      kind: "mixed-reference" as const,
      sourceURL: guides.sourceURL,
      unplaced: 0,
      approximate: guides.maps["48"].length,
    };
  }
  if (version === "sod" && sodMaps[map]) {
    const source = sodMaps[map];
    return {
      rows: source.placements,
      kind: "sod-reference" as const,
      sourceURL: sod.sourceURL,
      unplaced: source.unplaced.length,
      approximate: source.placements.filter(
        (row) => row.kind === "portal-registered-reference",
      ).length,
    };
  }
  const rows =
    maps[map] ?? (version === "sod" ? dungeonMaps[map] : undefined) ?? [];
  return {
    rows,
    kind:
      version === "sod"
        ? ("classic-baseline" as const)
        : ("classic-reference" as const),
    sourceURL: reference.sourceURL,
    unplaced: 0,
    approximate: 0,
  };
}

// Reference maps lack native Z. Reuse nearby Classic height only as a floor hint;
// actual placement is grounded against the selected client's walkable geometry.
function floorHints(map: number, rows: ReferenceRow[]) {
  const byEntry = new Map<number, ReferenceRow[]>();
  for (const row of maps[map] ?? dungeonMaps[map] ?? []) {
    const list = byEntry.get(row.entry) ?? [];
    list.push(row);
    byEntry.set(row.entry, list);
  }
  const hints = new Map<string, number>(),
    floors = new Map<number, number[]>();
  for (const row of rows) {
    const nearest = (byEntry.get(row.entry) ?? [])
      .map((candidate) => ({
        z: candidate.position[2],
        distance: Math.hypot(
          candidate.position[0] - row.position[0],
          candidate.position[1] - row.position[1],
        ),
      }))
      .filter((p) => p.z !== null && p.distance <= 40)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest?.z == null) continue;
    hints.set(row.id, nearest.z);
    if (row.floor !== undefined) {
      const values = floors.get(row.floor) ?? [];
      values.push(nearest.z);
      floors.set(row.floor, values);
    }
  }
  for (const values of floors.values()) values.sort((a, b) => a - b);
  for (const row of rows) {
    const values = row.floor === undefined ? undefined : floors.get(row.floor);
    if (!hints.has(row.id) && values?.length)
      hints.set(row.id, values[Math.floor(values.length / 2)]);
  }
  return hints;
}

/** Resolve only the authored reference display in the selected local client. */
export function referenceNpcModels(
  creatures: ModernCatalog,
  version: GameVersion = "vanilla",
) {
  const models: Record<string, NpcDisplayModel> = {};
  const mapIds =
    version === "vanilla"
      ? Object.keys(maps)
      : [
          ...new Set([
            ...Object.keys(maps),
            ...Object.keys(dungeonMaps),
            ...Object.keys(sodMaps),
          ]),
        ];
  for (const map of mapIds)
    for (const row of referenceCoverage(Number(map), version).rows) {
      const display = creatures.displays?.[row.displayID];
      const model = creatures.models?.[display?.modelID];
      const scale = display?.scale * model?.scale;
      if (model?.fileDataID > 0 && Number.isFinite(scale) && scale > 0)
        models[row.entry] = {
          name: row.name,
          displayID: row.displayID,
          scale,
          displaySource:
            row.displaySourceURL ??
            (referenceCoverage(Number(map), version).kind ===
              "mixed-reference" && !row.kind
              ? reference.sourceURL
              : referenceCoverage(Number(map), version).sourceURL),
        };
    }
  return models;
}

/** Defaults exist only without a log. No reference slots are mixed into replays. */
export function referenceRaidActors(
  map: number,
  version: GameVersion,
  models: Record<string, unknown>,
): Actor[] {
  const source = referenceCoverage(map, version),
    hints = floorHints(map, source.rows);
  return source.rows.map((row, index) => {
    const model = models[row.entry] as Model | undefined;
    return {
      key: `spawn:${version}:${map}:${row.id}`,
      id: -index - 1,
      instance: 1,
      name: row.name,
      type: "NPC",
      class: row.boss ? "Boss" : "NPC",
      gameID: row.entry,
      displayID: model?.displayID ?? null,
      scale: model?.scale ?? 1,
      spawn: {
        key: `spawn:${version}:${map}:${row.id}`,
        position: [...row.position],
        facing: row.facing ?? 0,
        floorHint: row.position[2] ?? hints.get(row.id),
        referenceKind:
          row.kind ??
          (source.kind === "mixed-reference"
            ? "classic-baseline"
            : source.kind),
        distance: null,
        confidence:
          row.kind === "portal-registered-reference" ||
          row.kind === "guide-reference"
            ? "approximate"
            : "unobserved",
        visibleFrom: 0,
        synthetic: true,
      },
      samples: [],
      deaths: [],
      firstSeen: Infinity,
      lastSeen: -Infinity,
      runLifetime: false,
      facings: [],
      headings: [],
      gear: [],
      health: [],
      power: [],
      resourceChanges: [],
      casts: [],
      auras: [],
      initialAuras: [],
    };
  });
}

export function referenceSpawnNotice(
  map: number,
  version: GameVersion,
): string {
  const source = referenceCoverage(map, version);
  if (!source.rows.length)
    return "No reference placements are mapped for this area.";
  if (source.kind === "mixed-reference")
    return `SoD guide bosses with Classic trash: ${source.rows.length} references. Boss map pins are approximate.`;
  if (source.kind === "classic-baseline")
    return `Classic baseline: ${source.rows.length} placements. SoD changes are not fully mapped.`;
  if (source.kind === "sod-reference")
    return `SoD reference: ${source.rows.length} placements${source.approximate ? `, ${source.approximate} approximate` : ""}.${source.unplaced ? ` ${source.unplaced} interior positions are not mapped.` : ""}`;
  return "Classic reference spawns. Patrols and random packs may differ.";
}

export function spawnStatus(actor: Actor, time: number): string | null {
  if (!actor.spawn) return null;
  if (actor.spawn.synthetic || time < actor.firstSeen) return "Reference spawn";
  const dead = actor.deaths.filter(([t]) => t <= time).at(-1)?.[1] ?? false;
  return dead ? "Killed in log" : "Observed in log";
}
