import { enrichCombat, normalizeReplay } from "./domain";
import type { Actor, RawReplay, Replay } from "./types";

type Evidence = { events: unknown[]; indices: number[] };
const sameEvidence = (a: Evidence | undefined, b: Evidence) =>
  !!a &&
  a.events.length === b.events.length &&
  a.events.every(
    (event, i) => event === b.events[i] && a.indices[i] === b.indices[i],
  );

/**
 * Reuses actor derivations across immutable streamed chunk snapshots. Events and
 * metadata must not be mutated in place. A source revision or metadata replacement
 * resets reuse. reset() releases the previous source, including its event references.
 * Event positions are evidence because cast IDs use the original event-array index.
 */
export class IncrementalReplayNormalizer {
  private previous?: Replay;
  private evidence = new Map<string, Evidence>();
  private header = "";
  private metadata: unknown[] = [];
  reset() {
    this.previous = undefined;
    this.evidence.clear();
    this.header = "";
    this.metadata = [];
  }
  normalize(
    raw: RawReplay,
    models: Record<string, unknown>,
    items: Record<string, unknown>,
    spells: Record<string, unknown>,
  ): Replay {
    // Coverage changes do not change recorded actor content. The caller installs
    // current bufferedRanges independently, as in the ordinary normalization path.
    const header = JSON.stringify([
      raw.gameVersion,
      raw.report,
      raw.fight,
      raw.actors,
      raw.abilities,
      raw.playerDetails,
      raw.stream?.id,
      raw.stream?.revision,
    ]);
    const metadata = [models, items, spells];
    const canReuse =
      !!raw.stream &&
      this.header === header &&
      metadata.every((value, i) => value === this.metadata[i]);
    const evidence = new Map<string, Evidence>();
    const global: Evidence = { events: [], indices: [] };
    raw.events.forEach((value, i) => {
      const event = value as Record<string, any>;
      if (
        [
          "zonechange",
          "encounterstart",
          "encounterend",
          "combatantinfo",
        ].includes(event.type)
      ) {
        global.events.push(value);
        global.indices.push(i);
      }
      for (const side of ["source", "target"]) {
        const id = event[`${side}ID`];
        if (!(id > 0)) continue;
        const key = `${id}:${event[`${side}Instance`] || 1}`;
        let row = evidence.get(key);
        if (!row) evidence.set(key, (row = { events: [], indices: [] }));
        row.events.push(value);
        row.indices.push(i);
      }
    });
    const reused = new Map<string, Actor>();
    if (canReuse && sameEvidence(this.evidence.get("global"), global))
      for (const actor of this.previous!.actors) {
        const row = evidence.get(actor.key) ?? { events: [], indices: [] };
        if (sameEvidence(this.evidence.get(actor.key), row))
          reused.set(actor.key, actor);
      }
    const replay = enrichCombat(
      normalizeReplay(raw, models, reused),
      items,
      spells,
      reused,
    );
    // Seeded roster/NPC actors can have no events at all.
    for (const actor of replay.actors)
      if (!evidence.has(actor.key))
        evidence.set(actor.key, { events: [], indices: [] });
    evidence.set("global", global);
    this.previous = replay;
    this.evidence = evidence;
    this.header = header;
    this.metadata = metadata;
    return replay;
  }
}
