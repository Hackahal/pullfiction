import type { MapFloor, MapManifest } from "./map-model";

type Point = [number, number, number];
type Triangle = {
  a: Point;
  ab: Point;
  ac: Point;
  nz: number;
  interior: boolean;
  structure: boolean;
  room?: number;
};
const CELL = 32;

/** Seek-safe floor context from local client geometry, independent of 3D streaming.
 * Index once per map; actor updates inspect only their column's nearby triangles.
 */
export class ReplayFloorGeometry {
  private triangles: Triangle[] = [];
  private columns = new Map<string, number[]>();
  private broad: number[] = [];
  constructor(floors: MapFloor[], areas: MapManifest["areas"] = []) {
    const rooms = new Map(
      areas
        .filter((a) => Number.isFinite(a.height))
        .map((a) => [a.id, a.height]),
    );
    for (const floor of floors) {
      for (let i = 0; i < floor.indices.length; i += 3) {
        const [a, b, c] = floor.indices
          .slice(i, i + 3)
          .map((j) => floor.vertices[j]);
        if (
          ![a, b, c].every((p) => p?.length === 3 && p.every(Number.isFinite))
        )
          throw new Error("Invalid replay floor geometry");
        const ab = b.map((v, j) => v - a[j]) as Point;
        const ac = c.map((v, j) => v - a[j]) as Point;
        const n = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ];
        if (n[2] / Math.hypot(...n) < 0.45 || !n[2]) continue;
        const id =
          this.triangles.push({
            a,
            ab,
            ac,
            nz: n[2],
            interior: floor.interior === true,
            structure: floor.area !== "terrain",
            room: rooms.get(floor.area),
          }) - 1;
        const minX = Math.floor(Math.min(a[0], b[0], c[0]) / CELL),
          maxX = Math.floor(Math.max(a[0], b[0], c[0]) / CELL);
        const minY = Math.floor(Math.min(a[1], b[1], c[1]) / CELL),
          maxY = Math.floor(Math.max(a[1], b[1], c[1]) / CELL);
        if ((maxX - minX + 1) * (maxY - minY + 1) > 256) {
          this.broad.push(id);
          continue;
        }
        for (let x = minX; x <= maxX; x++)
          for (let y = minY; y <= maxY; y++) {
            const key = `${x}:${y}`,
              list = this.columns.get(key) ?? [];
            list.push(id);
            this.columns.set(key, list);
          }
      }
    }
  }
  height(
    x: number,
    y: number,
    hint: number,
    preferInterior: boolean,
  ): number | undefined {
    if (![x, y, hint].every(Number.isFinite)) return;
    let best: number | undefined,
      inside: number | undefined,
      structure: number | undefined;
    let roomFloor: { z: number; level: number; depth: number } | undefined;
    const ids =
      this.columns.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? [];
    for (const id of [...ids, ...this.broad]) {
      const {
        a,
        ab,
        ac,
        nz,
        interior,
        structure: built,
        room,
      } = this.triangles[id];
      const u = ((x - a[0]) * ac[1] - (y - a[1]) * ac[0]) / nz;
      const v = (ab[0] * (y - a[1]) - ab[1] * (x - a[0])) / nz;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      const z = a[2] + u * ab[2] + v * ac[2];
      // With no observed/seeded Z, the entrance altitude can select a basement
      // underneath a stage. Cast down from the containing client's room level.
      // A roof above that level is not a floor inside the room. Explicit floor
      // hints bypass this inference, including lower storeys in stacked rooms.
      if (
        preferInterior &&
        interior &&
        room !== undefined &&
        z <= room + 0.01
      ) {
        const level = Math.abs(room - hint),
          depth = room - z;
        if (
          !roomFloor ||
          level < roomFloor.level ||
          (level === roomFloor.level && depth < roomFloor.depth)
        )
          roomFloor = { z, level, depth };
      }
      if (best === undefined || Math.abs(z - hint) < Math.abs(best - hint))
        best = z;
      if (
        interior &&
        (inside === undefined || Math.abs(z - hint) < Math.abs(inside - hint))
      )
        inside = z;
      if (
        built &&
        (structure === undefined ||
          Math.abs(z - hint) < Math.abs(structure - hint))
      )
        structure = z;
    }
    // Open cloisters and decks are authored exterior groups, but still carry
    // the walkable floor above or below the terrain. Never treat them as terrain.
    return preferInterior
      ? (roomFloor?.z ?? inside ?? structure ?? best)
      : best;
  }

  /** Approximate map pins can fall just outside a room boundary. Keep their XY,
   * but use a nearby structural edge's height instead of unrelated terrain.
   * Exact structural intersections always retain the normal room-floor query.
   */
  nearbyStructureHeight(x: number, y: number, hint: number, radius: number) {
    if (![x, y, hint, radius].every(Number.isFinite) || radius <= 0) return;
    const ids = new Set(this.broad);
    for (
      let cx = Math.floor((x - radius) / CELL);
      cx <= Math.floor((x + radius) / CELL);
      cx++
    )
      for (
        let cy = Math.floor((y - radius) / CELL);
        cy <= Math.floor((y + radius) / CELL);
        cy++
      )
        for (const id of this.columns.get(`${cx}:${cy}`) ?? []) ids.add(id);
    let best: { distance: number; z: number; score: number } | undefined;
    for (const id of ids) {
      const { a, ab, ac, nz, structure, interior, room } = this.triangles[id];
      if (!structure) continue;
      const u = ((x - a[0]) * ac[1] - (y - a[1]) * ac[0]) / nz;
      const v = (ab[0] * (y - a[1]) - ab[1] * (x - a[0])) / nz;
      if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001) return;
      const b = a.map((value, i) => value + ab[i]) as Point,
        c = a.map((value, i) => value + ac[i]) as Point;
      for (const [from, to] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const dx = to[0] - from[0],
          dy = to[1] - from[1];
        const length = dx * dx + dy * dy;
        if (!length) continue;
        const t = Math.max(
          0,
          Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / length),
        );
        const distance = Math.hypot(x - from[0] - t * dx, y - from[1] - t * dy);
        const z = from[2] + t * (to[2] - from[2]);
        if (
          distance > radius ||
          (interior && room !== undefined && z > room + 0.01)
        )
          continue;
        const score =
          interior && room !== undefined ? room - z : Math.abs(z - hint);
        if (
          !best ||
          distance < best.distance - 1e-5 ||
          (Math.abs(distance - best.distance) <= 1e-5 && score < best.score)
        )
          best = { distance, z, score };
      }
    }
    return best?.z;
  }
}
