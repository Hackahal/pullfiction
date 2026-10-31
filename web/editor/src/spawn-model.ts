import reference from "../../../third_party/raid-spawns/vanilla.json";
import type { Actor, GameVersion } from "./types";
import type { NpcDisplayModel } from "./npc-models";
import type { ModernCatalog } from "./browser-assets";

type Model = { displayID?: number; scale?: number };
const maps = reference.maps as Record<string, (typeof reference.maps)["409"]>;

/** Resolve only the authored reference display in the selected local client. */
export function referenceNpcModels(creatures: ModernCatalog) {
  const models: Record<string, NpcDisplayModel> = {};
  for (const row of Object.values(maps).flat()) {
    const display = creatures.displays?.[row.displayID];
    const model = creatures.models?.[display?.modelID];
    const scale = display?.scale * model?.scale;
    if (model?.fileDataID > 0 && Number.isFinite(scale) && scale > 0)
      models[row.entry] = {
        name: row.name,
        displayID: row.displayID,
        scale,
        displaySource: reference.sourceURL,
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
  if (version !== reference.ruleset) return [];
  return (maps[String(map)] ?? []).map((row, index) => {
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
        position: [...row.position] as [number, number, number],
        facing: row.facing,
        distance: null,
        confidence: "unobserved",
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
  if (version !== reference.ruleset)
    return "SoD default spawn locations are not yet available from a verified source.";
  return maps[String(map)]?.length
    ? "Classic reference spawns. Patrols and random packs may differ."
    : "Default spawn locations are not available for this map.";
}

export function spawnStatus(actor: Actor, time: number): string | null {
  if (!actor.spawn) return null;
  if (actor.spawn.synthetic || time < actor.firstSeen) return "Reference spawn";
  const dead = actor.deaths.filter(([t]) => t <= time).at(-1)?.[1] ?? false;
  return dead ? "Killed in log" : "Observed in log";
}
