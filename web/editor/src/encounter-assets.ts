import type { Actor, Replay } from "./types";

export interface EncounterAssets {
  actors: Actor[];
  spells: number[];
  start: number;
  end: number;
  omittedActors: number;
  omittedSpells: number;
}
/** Preparation is optional and bounded; omitted assets keep ordinary demand loading. */
export function encounterAssets(
  replay: Replay,
  time: number,
  adjacent = 0,
): EncounterAssets {
  if (
    !Number.isFinite(time) ||
    !Number.isInteger(adjacent) ||
    adjacent < 0 ||
    adjacent > 1
  )
    throw new Error("Invalid encounter preparation window");
  const chapters = replay.chapters;
  let index = chapters.findIndex((chapter) => chapter.end >= time);
  if (index < 0) index = Math.max(0, chapters.length - 1);
  const selected = chapters.slice(
    Math.max(0, index - adjacent),
    index + adjacent + 1,
  );
  const start = selected[0]?.start ?? 0;
  const end = selected.at(-1)?.end ?? replay.duration;
  const keys = new Set<string>();
  const ids = new Set<number>(replay.fight.friendlyPlayers ?? []);
  for (const chapter of selected)
    for (const npc of chapter.enemyNPCs ?? []) ids.add(npc.id);
  const spells = new Set<number>();
  for (const event of replay.combat ?? []) {
    if (event.t < start || event.t > end) continue;
    if (event.source) keys.add(event.source);
    if (event.target) keys.add(event.target);
    if (event.spell > 0) spells.add(event.spell);
  }
  const actors = replay.actors.filter(
    (actor) => ids.has(actor.id) || keys.has(actor.key),
  );
  return {
    actors: actors.slice(0, 512),
    spells: [...spells].slice(0, 256),
    start,
    end,
    omittedActors: Math.max(0, actors.length - 512),
    omittedSpells: Math.max(0, spells.size - 256),
  };
}

/** Own one preparation lease per report/client session; close on source replacement. */
export class EncounterAssetWarmer {
  private job?: AbortController;
  private closed = false;
  cancel() {
    this.job?.abort();
    this.job = undefined;
  }
  close() {
    this.closed = true;
    this.cancel();
  }
  async prepare(
    replay: Replay,
    time: number,
    prepare: {
      geometry(map: number, signal: AbortSignal): Promise<void>;
      units(actors: Actor[], signal: AbortSignal): Promise<void>;
      spells(ids: number[], signal: AbortSignal): Promise<void>;
    },
    options: { adjacent?: number; signal?: AbortSignal } = {},
  ): Promise<EncounterAssets> {
    if (this.closed) throw new Error("Encounter preparation is closed");
    options.signal?.throwIfAborted();
    const assets = encounterAssets(replay, time, options.adjacent);
    this.cancel();
    const job = new AbortController();
    this.job = job;
    const cancel = () => job.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await prepare.geometry(replay.map, job.signal);
      job.signal.throwIfAborted();
      await prepare.units(assets.actors, job.signal);
      job.signal.throwIfAborted();
      await prepare.spells(assets.spells, job.signal);
      job.signal.throwIfAborted();
      return assets;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.job === job) this.job = undefined;
    }
  }
}
