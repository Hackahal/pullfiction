import { enrichCombat, normalizeReplay } from "./domain";
import {
  enrichCombatSteps,
  normalizeReplaySteps,
} from "../../planner/replay.mjs";
import { drainReplayTasks } from "./replay-preparation";
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
  private generation = 0;
  reset() {
    this.generation++;
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
    // Whole-file replays cannot reuse streamed actor derivations. Avoid
    // indexing every event or retaining the previous streamed snapshot.
    if (!raw.stream) {
      this.reset();
      return enrichCombat(normalizeReplay(raw, models), items, spells);
    }
    this.generation++;
    const steps = this.streamSteps(raw, models, items, spells, false);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }
  normalizeSliced(
    raw: RawReplay,
    models: Record<string, unknown>,
    items: Record<string, unknown>,
    spells: Record<string, unknown>,
    current: () => boolean,
  ): Promise<Replay> {
    const generation = ++this.generation;
    return drainReplayTasks(
      this.streamSteps(raw, models, items, spells, true),
      () => {
        if (!current() || this.generation !== generation)
          throw new DOMException("Replay preparation superseded", "AbortError");
      },
    );
  }
  private *streamSteps(
    raw: RawReplay,
    models: Record<string, unknown>,
    items: Record<string, unknown>,
    spells: Record<string, unknown>,
    sliced: boolean,
  ): Generator<unknown, Replay> {
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
      this.header === header &&
      metadata.every((value, i) => value === this.metadata[i]);
    const evidence = new Map<string, Evidence>();
    const global: Evidence = { events: [], indices: [] };
    const record = (
      value: unknown,
      i: number,
      id: number,
      instance: number,
    ) => {
      if (!(id > 0)) return;
      const key = `${id}:${instance || 1}`;
      let row = evidence.get(key);
      if (!row) evidence.set(key, (row = { events: [], indices: [] }));
      row.events.push(value);
      row.indices.push(i);
    };
    for (let i = 0; i < raw.events.length; i++) {
      if (sliced && (i & 511) === 0) yield;
      const value = raw.events[i];
      const event = value as Record<string, any>;
      switch (event.type) {
        case "zonechange":
        case "encounterstart":
        case "encounterend":
        case "combatantinfo":
          global.events.push(value);
          global.indices.push(i);
      }
      record(value, i, event.sourceID, event.sourceInstance);
      record(value, i, event.targetID, event.targetInstance);
    }
    const reused = new Map<string, Actor>();
    if (canReuse && sameEvidence(this.evidence.get("global"), global)) {
      for (const actor of this.previous!.actors) {
        if (sliced) yield;
        const row = evidence.get(actor.key) ?? { events: [], indices: [] };
        if (sameEvidence(this.evidence.get(actor.key), row))
          reused.set(actor.key, actor);
      }
      // A victim's source-free aura removal can change its caster's channel
      // endpoint without appearing in the caster's own event signature.
      const unchangedEvidence = new Set(reused.keys());
      for (const [key, actor] of reused)
        if (
          actor.casts.some(
            (cast) =>
              cast.channel &&
              cast.target &&
              !unchangedEvidence.has(cast.target),
          )
        )
          reused.delete(key);
    }
    let replay: Replay;
    if (sliced) {
      const ordering: { eventOrder?: Uint32Array } = {};
      const tracks = yield* normalizeReplaySteps(raw, models, reused, ordering);
      replay = (yield* enrichCombatSteps(
        tracks,
        items,
        spells,
        reused,
        ordering.eventOrder,
      )) as Replay;
    } else {
      replay = enrichCombat(
        normalizeReplay(raw, models, reused),
        items,
        spells,
        reused,
      );
    }
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
