import {
  enrichCombatSteps as combatSteps,
  normalizeReplaySteps as trackSteps,
} from "../../planner/replay.mjs";
import type { RawReplay, Replay } from "./types";

export const SLICED_IMPORT_MIN_EVENTS = 50_000;
const SLICE_MS = 5;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function drainReplayTasks<T>(
  steps: Generator<unknown, T>,
  check: () => void,
) {
  await yieldTask();
  let started = performance.now();
  while (true) {
    check();
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - started >= SLICE_MS) {
      await yieldTask();
      started = performance.now();
    }
  }
}

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
  const check = () => signal.throwIfAborted();
  phase("Preparing movement tracks…");
  const ordering: { eventOrder?: Uint32Array } = {};
  const tracks = (await drainReplayTasks(
    trackSteps(raw, models, undefined, ordering),
    check,
  )) as Replay;
  signal.throwIfAborted();
  phase("Reconstructing combat events…");
  return drainReplayTasks(
    combatSteps(tracks, items, spells, undefined, ordering.eventOrder),
    check,
  ) as Promise<Replay>;
}
