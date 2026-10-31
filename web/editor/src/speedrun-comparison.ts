import type { Chapter } from "./types";
import type { SpeedrunWorldRecord } from "./speedrun-world-record";
import type { indexSpeedrun, speedrunAt } from "./speedrun-model";

export function compareSpeedrun(
  index: ReturnType<typeof indexSpeedrun>,
  run: ReturnType<typeof speedrunAt>,
  reference: SpeedrunWorldRecord | null,
) {
  const expectedDifficulty =
    index.replay.gameVersion === "sod" && index.replay.map === 409
      ? index.options.heat + 2
      : index.replay.fight.difficulty;
  const categoryMatches =
    !reference ||
    (!index.replay.fight.categoryMixed &&
      (expectedDifficulty === undefined ||
        expectedDifficulty === reference.category.difficulty) &&
      (index.replay.fight.size === undefined ||
        reference.category.size === null ||
        index.replay.fight.size === reference.category.size));
  const targets = reference?.splits ?? [];
  const referenceByBoss = new Map<number, Chapter>();
  for (const split of targets)
    if (split.encounterID) referenceByBoss.set(split.encounterID, split);
  const kills = run.splits.filter((s) => s.completed);
  const routeMatches = kills.every(
    (s, i) => targets[i]?.encounterID === s.encounterID,
  );
  const latest = kills.at(-1);
  const previous = kills.at(-2);
  const latestTarget = latest?.encounterID
    ? referenceByBoss.get(latest.encounterID)
    : null;
  const previousTarget = previous?.encounterID
    ? referenceByBoss.get(previous.encounterID)
    : null;
  const delta =
    latest?.elapsed !== null &&
    latest?.elapsed !== undefined &&
    latestTarget &&
    run.coverage &&
    run.fullRun &&
    !index.estimated &&
    categoryMatches
      ? latest.elapsed - latestTarget.end
      : null;
  const previousSegment =
    delta !== null && latest && latestTarget && (!previous || previousTarget)
      ? latest.elapsed! -
        (previous?.elapsed ?? 0) -
        (latestTarget.end - (previousTarget?.end ?? 0))
      : null;
  const projected =
    reference && delta !== null && !run.finished
      ? Math.max(run.elapsed, reference.duration + delta)
      : null;
  return {
    categoryMatches,
    referenceByBoss,
    routeMatches,
    delta,
    previousSegment,
    projected,
    rows: run.splits.map((s) => {
      const target = s.encounterID ? referenceByBoss.get(s.encounterID) : null;
      return {
        ...s,
        target: target?.end ?? null,
        delta:
          s.completed &&
          s.elapsed !== null &&
          target &&
          run.coverage &&
          run.fullRun &&
          !index.estimated &&
          categoryMatches
            ? s.elapsed - target.end
            : null,
      };
    }),
  };
}
