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
const MAX_PROJECTED_CELLS = 4096;
export interface FloorAnchor {
  entry: number;
  point: Point;
}
type ValidAnchor = FloorAnchor & { id: number };
type FloorCatalog = Record<string, { floorSeeds: number[][] }>;

/** Seek-safe floor context from local client geometry, independent of 3D streaming.
 * Index once per map; actor updates inspect only their column's nearby triangles.
 */
export class ReplayFloorGeometry {
  private triangles: Triangle[] = [];
  private columns = new Map<string, number[]>();
  private broad: number[] = [];
  private anchors: ValidAnchor[] = [];
  private anchorColumns = new Map<string, ValidAnchor[]>();
  private projected = new Map<string, number | undefined>();
  private candidateColumns = new Map<string, readonly number[]>();
  private catalogs = new WeakMap<object, Map<number, FloorCatalog>>();
  constructor(
    floors: MapFloor[],
    areas: MapManifest["areas"] = [],
    anchors: FloorAnchor[] = [],
  ) {
    for (const _ of this.index(floors, areas, anchors)) {
      // Small callers build synchronously with the same indexing rules.
    }
  }

  static async prepare(
    floors: MapFloor[],
    areas: MapManifest["areas"],
    anchors: FloorAnchor[],
    progress: (completed: number, total: number) => void,
    current: () => boolean,
  ): Promise<ReplayFloorGeometry | undefined> {
    const total = floors.reduce(
      (sum, floor) => sum + Math.ceil(floor.indices.length / 3),
      0,
    );
    if (!current()) return undefined;
    if (total < 50_000) return new ReplayFloorGeometry(floors, areas, anchors);

    const geometry = new ReplayFloorGeometry([]);
    const steps = geometry.index(floors, areas, anchors, true);
    const yieldTask = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0));
    progress(0, total);
    await yieldTask();
    let started = performance.now();
    while (current()) {
      const step = steps.next();
      if (step.done) {
        progress(total, total);
        return geometry;
      }
      if (performance.now() - started >= 5) {
        if (step.value !== undefined) progress(step.value, total);
        await yieldTask();
        started = performance.now();
      }
    }
    return undefined;
  }

  private *index(
    floors: MapFloor[],
    areas: MapManifest["areas"],
    anchors: FloorAnchor[],
    sliced = false,
  ): Generator<number | undefined, void> {
    let completed = 0;
    const rooms = new Map(
      areas
        .filter((a) => Number.isFinite(a.height))
        .map((a) => [a.id, a.height]),
    );
    const validPoint = (point: Point | undefined) =>
      point?.length === 3 && point.every(Number.isFinite);
    for (const floor of floors) {
      const { indices, vertices } = floor;
      const interior = floor.interior === true,
        structure = floor.area !== "terrain",
        room = rooms.get(floor.area);
      for (let i = 0; i < indices.length; i += 3) {
        if (sliced) {
          if (completed && (completed & 511) === 0) yield completed;
          completed++;
        }
        const a = vertices[indices[i]],
          b = vertices[indices[i + 1]],
          c = vertices[indices[i + 2]];
        if (!validPoint(a) || !validPoint(b) || !validPoint(c))
          throw new Error("Invalid replay floor geometry");
        const ab: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = ab[1] * ac[2] - ab[2] * ac[1],
          ny = ab[2] * ac[0] - ab[0] * ac[2],
          nz = ab[0] * ac[1] - ab[1] * ac[0];
        if (nz / Math.hypot(nx, ny, nz) < 0.45 || !nz) continue;
        const id =
          this.triangles.push({ a, ab, ac, nz, interior, structure, room }) - 1;
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
            const key = `${x}:${y}`;
            const list = this.columns.get(key);
            if (list) list.push(id);
            else this.columns.set(key, [id]);
          }
      }
    }
    // A reference from another client/layout is useful only if this client's
    // walkable geometry actually supports it. Snap away NPC placement offsets.
    for (let i = 0; i < anchors.length; i++) {
      if (sliced && (i & 15) === 0) yield;
      const anchor = anchors[i];
      if (
        !Number.isInteger(anchor.entry) ||
        anchor.entry <= 0 ||
        anchor.point.length !== 3 ||
        !anchor.point.every((v) => Number.isFinite(v) && Math.abs(v) <= 20000)
      )
        continue;
      const [x, y, z] = anchor.point,
        supported = this.height(x, y, z, false);
      if (supported === undefined || Math.abs(supported - z) > 1) continue;
      const valid: ValidAnchor = {
        entry: anchor.entry,
        point: [x, y, supported],
        id: this.anchors.length,
      };
      this.anchors.push(valid);
      const key = `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
      const list = this.anchorColumns.get(key) ?? [];
      list.push(valid);
      this.anchorColumns.set(key, list);
    }
  }
  /** Floor context is independent of the display/spawn catalog and creates no actors. */
  contextCatalog(map: number, original: Record<string, unknown>): FloorCatalog {
    let maps = this.catalogs.get(original);
    if (!maps) {
      maps = new Map();
      this.catalogs.set(original, maps);
    }
    const cached = maps.get(map);
    if (cached) return cached;
    const result: FloorCatalog = {};
    for (const anchor of this.anchors) {
      const row = (result[anchor.entry] ??= { floorSeeds: [] });
      row.floorSeeds.push([map, ...anchor.point]);
    }
    // Authored/catalog floor overrides remain authoritative, including zero.
    for (const [entry, value] of Object.entries(original)) {
      const seeds = (value as { floorSeeds?: number[][] })?.floorSeeds;
      if (!seeds) continue;
      const hasCurrentMap = seeds.some(
        (seed) =>
          seed.length === 4 && seed.every(Number.isFinite) && seed[0] === map,
      );
      result[entry] = {
        floorSeeds:
          seeds.length === 0 || hasCurrentMap
            ? seeds
            : [...(result[entry]?.floorSeeds ?? []), ...seeds],
      };
    }
    maps.set(map, result);
    return result;
  }
  private calibratedHeight(
    x: number,
    y: number,
    hint: number,
  ): number | undefined {
    // Query exact coordinates. A shared cell's centre can lie over a different
    // storey at a ledge or a narrow platform, even less than one yard away.
    const px = x,
      py = y;
    const ax = Math.floor(px / CELL),
      ay = Math.floor(py / CELL);
    const candidates: { anchor: ValidAnchor; distance: number }[] = [];
    for (let dx = -4; dx <= 4; dx++)
      for (let dy = -4; dy <= 4; dy++) {
        for (const anchor of this.anchorColumns.get(`${ax + dx}:${ay + dy}`) ??
          []) {
          const distance = Math.hypot(
            anchor.point[0] - px,
            anchor.point[1] - py,
          );
          if (distance <= 100) candidates.push({ anchor, distance });
        }
      }
    // Empty/scripted rooms may lack a local placed NPC. Keep the nearest map
    // calibration as altitude context, but do not trace a long cross-room chord.
    if (!candidates.length)
      for (const anchor of this.anchors)
        candidates.push({
          anchor,
          distance: Math.hypot(anchor.point[0] - px, anchor.point[1] - py),
        });
    candidates.sort(
      (a, b) => a.distance - b.distance || a.anchor.id - b.anchor.id,
    );
    // XY cannot identify overlapping storeys. Within the same local footprint,
    // use the encounter's height context to choose between calibrated levels.
    const nearest = candidates[0]?.distance;
    const nearby = candidates.filter((c) => c.distance <= nearest + 1);
    nearby.sort(
      (a, b) =>
        Math.abs(a.anchor.point[2] - hint) -
          Math.abs(b.anchor.point[2] - hint) ||
        a.distance - b.distance ||
        a.anchor.id - b.anchor.id,
    );
    const primary = nearby[0]?.anchor;
    if (!primary) return;
    const key = `${x}:${y}:${primary.id}`;
    if (!this.projected.has(key)) {
      let height: number | undefined;
      const distance = Math.hypot(primary.point[0] - px, primary.point[1] - py);
      if (distance <= 100) {
        let z = primary.point[2],
          valid = true;
        const steps = Math.max(1, Math.ceil(distance / 0.5));
        for (let j = 1; j <= steps; j++) {
          const u = j / steps,
            h = this.stepHeight(
              primary.point[0] + (px - primary.point[0]) * u,
              primary.point[1] + (py - primary.point[1]) * u,
              z,
            );
          if (h === undefined || h - z > 1.1 || z - h > 2) {
            valid = false;
            break;
          }
          z = h;
        }
        if (valid) height = z;
      }
      // Keep the selected level even if another storey offers an easier chord.
      // A real drop/jump need not have a continuously walkable chord. Retain
      // the nearby validated altitude as context, never a room-wide mean.
      height ??= this.height(px, py, primary.point[2], false);
      if (this.projected.size >= MAX_PROJECTED_CELLS)
        this.projected.delete(this.projected.keys().next().value!);
      this.projected.set(key, height);
    }
    const context = this.projected.get(key);
    return context === undefined
      ? undefined
      : this.height(x, y, context, false);
  }
  private visitCrossings(
    x: number,
    y: number,
    visit: (z: number, triangle: Triangle) => void,
  ): void {
    const ids = this.columns.get(
      `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`,
    );
    const localCount = ids?.length ?? 0;
    const count = localCount + this.broad.length;
    for (let i = 0; i < count; i++) {
      const id = i < localCount ? ids![i] : this.broad[i - localCount];
      const tri = this.triangles[id],
        { a, ab, ac, nz } = tri;
      const dx = x - a[0],
        dy = y - a[1];
      const u = (dx * ac[1] - dy * ac[0]) / nz;
      const v = (ab[0] * dy - ab[1] * dx) / nz;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      visit(a[2] + u * ab[2] + v * ac[2], tri);
    }
  }
  private stepHeight(x: number, y: number, from: number): number | undefined {
    let best: number | undefined;
    // A walking down-ray finds the highest support within step-up reach, not
    // the numerically closest floor below a ramp laid over a lower surface.
    this.visitCrossings(x, y, (z) => {
      if (z <= from + 1.1 && z >= from - 2 && (best === undefined || z > best))
        best = z;
    });
    return best;
  }

  /** Alternative structural supports, never evidence that an actor occupied them. */
  heightCandidates(x: number, y: number): readonly number[] {
    if (![x, y].every(Number.isFinite)) return [];
    const key = `${x}:${y}`;
    const cached = this.candidateColumns.get(key);
    if (cached) return cached;
    const levels: number[] = [];
    this.visitCrossings(x, y, (z, triangle) => {
      if (triangle.structure) levels.push(z);
    });
    levels.sort((a, b) => a - b);
    const unique: number[] = [];
    for (const z of levels)
      if (!unique.length || z - unique[unique.length - 1] > 0.05)
        unique.push(z);
    const result = Object.freeze(unique);
    if (this.candidateColumns.size >= MAX_PROJECTED_CELLS)
      this.candidateColumns.delete(this.candidateColumns.keys().next().value!);
    this.candidateColumns.set(key, result);
    return result;
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
    if (preferInterior && this.anchors.length) {
      const calibrated = this.calibratedHeight(x, y, hint);
      if (calibrated !== undefined) return calibrated;
    }
    this.visitCrossings(x, y, (z, { interior, structure: built }) => {
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
    });
    // Open cloisters and decks are authored exterior groups, but still carry
    // the walkable floor above or below the terrain. Never treat them as terrain.
    return preferInterior ? (inside ?? structure ?? best) : best;
  }

  /** Preserve room context for unlogged reference pins, independently of replay inference. */
  readonly referenceFloors = {
    height: (
      x: number,
      y: number,
      hint: number,
      preferInterior: boolean,
    ): number | undefined => {
      if (![x, y, hint].every(Number.isFinite)) return;
      if (!preferInterior) return this.height(x, y, hint, false);
      let best: { z: number; level: number; depth: number } | undefined;
      this.visitCrossings(x, y, (z, { interior, room }) => {
        if (!interior || room === undefined || z > room + 0.01) return;
        const level = Math.abs(room - hint),
          depth = room - z;
        if (
          !best ||
          level < best.level ||
          (level === best.level && depth < best.depth)
        )
          best = { z, level, depth };
      });
      return best?.z ?? this.height(x, y, hint, true);
    },
  };

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
