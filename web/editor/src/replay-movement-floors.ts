interface FloorGeometry {
  heightCandidates(x: number, y: number): readonly number[];
}
export interface MovementFloorPair {
  from: number;
  to: number;
}

/** Bounded hypotheses for native collision validation after the primary route fails. */
export function movementFloorCandidates(
  geometry: FloorGeometry,
  from: readonly number[],
  to: readonly number[],
  fromHeight: number,
  toHeight: number,
  fromInferred: boolean,
  toInferred: boolean,
): MovementFloorPair[] {
  if (
    (!fromInferred && !toInferred) ||
    ![...from.slice(0, 2), ...to.slice(0, 2), fromHeight, toHeight].every(
      Number.isFinite,
    ) ||
    Math.hypot(from[0] - to[0], from[1] - to[1]) > 40
  )
    return [];
  const heights = (
    point: readonly number[],
    height: number,
    inferred: boolean,
  ) =>
    inferred
      ? [...new Set([height, ...geometry.heightCandidates(point[0], point[1])])]
          .filter((z) => Number.isFinite(z) && Math.abs(z - height) <= 32)
          .sort((a, b) => Math.abs(a - height) - Math.abs(b - height) || a - b)
          .slice(0, 8)
      : [height];
  const context = (fromHeight + toHeight) / 2;
  const score = ({ from, to }: MovementFloorPair) =>
    Math.abs(from - to) * 4 + Math.abs(from - context) + Math.abs(to - context);
  return heights(from, fromHeight, fromInferred)
    .flatMap((from) =>
      heights(to, toHeight, toInferred).map((to) => ({ from, to })),
    )
    .filter(
      (pair) =>
        Math.abs(pair.from - fromHeight) > 0.05 ||
        Math.abs(pair.to - toHeight) > 0.05,
    )
    .sort((a, b) => score(a) - score(b) || a.from - b.from || a.to - b.to)
    .slice(0, 2);
}
