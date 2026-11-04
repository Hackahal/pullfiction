import {
  enrichCombatSteps as combatSteps,
  normalizeReplaySteps as trackSteps,
} from "../../planner/replay.mjs";
import type { RawReplay, Replay } from "./types";

export const SLICED_IMPORT_MIN_EVENTS = 50_000;
const SLICE_MS = 5;

/** Derive a fresh whole-file replay without holding the event loop for the import. */
export async function prepareWholeReplay(
  raw: RawReplay,
  models: Record<string, unknown>,
  items: Record<string, unknown>,
  spells: Record<string, unknown>,
  signal: AbortSignal,
  phase: (message: string) => void,
): Promise<Replay> {
  signal.throwIfAborted();
  // Yield a task, so input and timers can run between preparation slices.
  const yieldTask = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function drain<T>(steps: Generator<unknown, T>): Promise<T> {
    let started = performance.now();
    while (true) {
      signal.throwIfAborted();
      const step = steps.next();
      if (step.done) return step.value;
      if (performance.now() - started >= SLICE_MS) {
        await yieldTask();
        started = performance.now();
      }
    }
  }

  phase("Preparing movement tracks…");
  await yieldTask();
  const ordering: { eventOrder?: Uint32Array } = {};
  const tracks = (await drain(
    trackSteps(raw, models, undefined, ordering),
  )) as Replay;
  signal.throwIfAborted();
  phase("Reconstructing combat events…");
  await yieldTask();
  return drain(
    combatSteps(tracks, items, spells, undefined, ordering.eventOrder),
  ) as Promise<Replay>;
}
