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
  ) => {
    if (!inferred) return [height];
    const levels = [height, ...geometry.heightCandidates(point[0], point[1])]
      .filter((z) => Number.isFinite(z) && Math.abs(z - height) <= 32)
      .sort((a, b) => Math.abs(a - height) - Math.abs(b - height) || a - b);
    const unique: number[] = [];
    for (const z of levels) {
      if (unique.every((other) => Math.abs(z - other) > 0.05)) unique.push(z);
      if (unique.length === 8) break;
    }
    return unique;
  };
  const context = (fromHeight + toHeight) / 2;
  const score = ({ from, to }: MovementFloorPair) =>
    Math.abs(from - to) * 4 + Math.abs(from - context) + Math.abs(to - context);
  const destinationHeights = heights(to, toHeight, toInferred);
  return heights(from, fromHeight, fromInferred)
    .flatMap((from) => destinationHeights.map((to) => ({ from, to })))
    .filter(
      (pair) =>
        Math.abs(pair.from - fromHeight) > 0.05 ||
        Math.abs(pair.to - toHeight) > 0.05,
    )
    .sort((a, b) => score(a) - score(b) || a.from - b.from || a.to - b.to)
    .slice(0, 2);
}

/** Immutable geometry and exact endpoint queries; at most one retained result per actor. */
export class MovementFloorCache {
  private entries = new WeakMap<
    object,
    {
      geometry: FloorGeometry;
      inputs: readonly (number | boolean)[];
      result: readonly MovementFloorPair[];
    }
  >();

  candidates(
    actor: object,
    geometry: FloorGeometry,
    from: readonly number[],
    to: readonly number[],
    fromHeight: number,
    toHeight: number,
    fromInferred: boolean,
    toInferred: boolean,
  ): readonly MovementFloorPair[] {
    const inputs = [
      from[0],
      from[1],
      to[0],
      to[1],
      fromHeight,
      toHeight,
      fromInferred,
      toInferred,
    ];
    const previous = this.entries.get(actor);
    if (
      previous?.geometry === geometry &&
      inputs.every((v, i) => Object.is(v, previous.inputs[i]))
    )
      return previous.result;
    const result = Object.freeze(
      movementFloorCandidates(
        geometry,
        from,
        to,
        fromHeight,
        toHeight,
        fromInferred,
        toInferred,
      ).map((pair) => Object.freeze(pair)),
    );
    this.entries.set(actor, { geometry, inputs, result });
    return result;
  }
}
