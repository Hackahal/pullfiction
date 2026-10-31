interface HeightGeometry {
  height(
    x: number,
    y: number,
    hint: number,
    preferInterior: boolean,
  ): number | undefined;
}
interface HeightEntry {
  geometry: HeightGeometry;
  x: number;
  y: number;
  hint: number;
  preferInterior: boolean;
  value: number | undefined;
}

/** One exact last query per actor; held poses do not need another triangle walk. */
export class ReplayHeightCache {
  private entries = new WeakMap<object, HeightEntry>();

  height(
    actor: object,
    geometry: HeightGeometry,
    x: number,
    y: number,
    hint: number,
    preferInterior: boolean,
  ) {
    const entry = this.entries.get(actor);
    if (
      entry &&
      entry.geometry === geometry &&
      Object.is(entry.x, x) &&
      Object.is(entry.y, y) &&
      Object.is(entry.hint, hint) &&
      entry.preferInterior === preferInterior
    )
      return entry.value;
    const value = geometry.height(x, y, hint, preferInterior);
    this.entries.set(actor, { geometry, x, y, hint, preferInterior, value });
    return value;
  }
}
