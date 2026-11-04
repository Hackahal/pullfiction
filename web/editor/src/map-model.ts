import { BROWSER_ASSETS, schematicIcon } from "./browser-mode";
import type { Actor } from "./types";
export type MapPoint = [number, number];
export interface MapCamera {
  x: number;
  y: number;
  scale: number;
}
export interface MapManifest {
  map: number;
  bounds: [number, number, number, number];
  areas: { id: string; name: string; height: number }[];
  tiles: {
    src: string;
    corners: MapPoint[];
    area: string;
    cell?: [number, number];
  }[];
  floors?: MapFloor[];
}
export interface MapFloor {
  area: string;
  interior?: boolean;
  vertices: [number, number, number][];
  indices: number[];
}
// North up: +WoW X is screen up; +WoW Y is screen left.
export const mapPoint = (x: number, y: number): MapPoint => [-y, -x];
export const worldPoint = (x: number, y: number): MapPoint => [-y, -x];
export type MapBounds = [
  left: number,
  top: number,
  right: number,
  bottom: number,
];

export function mapBounds(points: readonly MapPoint[]): MapBounds | undefined {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (left !== Infinity) return [left, top, right, bottom];
}

export function intersectsMapViewport(
  bounds: MapBounds | undefined,
  topLeft: MapPoint,
  bottomRight: MapPoint,
  padding: number,
) {
  return (
    !bounds ||
    (bounds[2] + padding >= topLeft[0] &&
      bounds[3] + padding >= topLeft[1] &&
      bounds[0] - padding <= bottomRight[0] &&
      bounds[1] - padding <= bottomRight[1])
  );
}
export function mapScreen(
  p: MapPoint,
  camera: MapCamera,
  width: number,
  height: number,
): MapPoint {
  return [
    (p[0] - camera.x) * camera.scale + width / 2,
    (p[1] - camera.y) * camera.scale + height / 2,
  ];
}
export function screenMap(
  p: MapPoint,
  camera: MapCamera,
  width: number,
  height: number,
): MapPoint {
  return [
    (p[0] - width / 2) / camera.scale + camera.x,
    (p[1] - height / 2) / camera.scale + camera.y,
  ];
}
export function fitMap(
  bounds: number[],
  width: number,
  height: number,
): MapCamera {
  return {
    x: (bounds[0] + bounds[2]) / 2,
    y: (bounds[1] + bounds[3]) / 2,
    scale: Math.max(
      0.01,
      Math.min(
        (Math.max(1, width) - 40) / Math.max(1, bounds[2] - bounds[0]),
        (Math.max(1, height) - 80) / Math.max(1, bounds[3] - bounds[1]),
      ),
    ),
  };
}
// Frame selected geometry with enough surrounding ground to retain context.
export function frameMapSelection(
  points: MapPoint[],
  width: number,
  height: number,
): MapCamera | null {
  if (!points.length || points.some((p) => !p.every(Number.isFinite)))
    return null;
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  const halfWidth = Math.max(40, (right - left) * 0.6),
    halfHeight = Math.max(40, (bottom - top) * 0.6);
  return fitMap(
    [cx - halfWidth, cy - halfHeight, cx + halfWidth, cy + halfHeight],
    width,
    height,
  );
}
export function zoomMap(
  camera: MapCamera,
  pixel: MapPoint,
  factor: number,
  width: number,
  height: number,
): MapCamera {
  const anchor = screenMap(pixel, camera, width, height),
    scale = Math.max(0.01, Math.min(20, camera.scale * factor));
  return {
    scale,
    x: anchor[0] - (pixel[0] - width / 2) / scale,
    y: anchor[1] - (pixel[1] - height / 2) / scale,
  };
}
export const CLASS_CELLS: Record<string, [number, number]> = {
  Warrior: [0, 0],
  Mage: [1, 0],
  Rogue: [2, 0],
  Druid: [3, 0],
  Hunter: [0, 1],
  Shaman: [1, 1],
  Priest: [2, 1],
  Warlock: [3, 1],
  Paladin: [0, 2],
};

export function mapActorIsBoss(actor: Pick<Actor, "type" | "class">) {
  return actor.type === "NPC" && actor.class === "Boss";
}

export function mapActorDrawOrder<
  T extends Pick<Actor, "key" | "type" | "class">,
>(actors: readonly T[], selected: string | null) {
  const other: T[] = [],
    players: T[] = [],
    bosses: T[] = [],
    focused: T[] = [];
  for (const actor of actors) {
    if (actor.key === selected) focused.push(actor);
    else if (mapActorIsBoss(actor)) bosses.push(actor);
    else if (actor.type === "Player") players.push(actor);
    else other.push(actor);
  }
  return other.concat(players, bosses, focused);
}

export function mapActorZoom(zoom: number) {
  return Math.max(0.75, Math.min(2, Math.sqrt(Math.max(0.01, zoom))));
}

export function mapActorRadius(
  type: Actor["type"],
  boss: boolean,
  factor: number,
) {
  return (
    factor * (type === "Player" ? 9 : boss ? 20 : type === "Pet" ? 10 : 12)
  );
}

export function mapActorToken(
  actor: Pick<Actor, "type" | "class" | "icon">,
  zoom = 1,
) {
  const boss = mapActorIsBoss(actor);
  const factor = mapActorZoom(zoom);
  const radius = mapActorRadius(actor.type, boss, factor);
  const raw = actor.icon?.replace(/^custom-icon-/i, "");
  const stem = raw?.split(/[\\/]/).pop()?.split(".")[0];
  const icon =
    stem && /^(ability|spell|inv|achievement|trade)_/i.test(stem)
      ? stem.toLowerCase()
      : boss
        ? "inv_misc_head_dragon_01"
        : actor.type === "Pet"
          ? "ability_hunter_pet_wolf"
          : "inv_misc_monsterhead_02";
  return {
    boss,
    radius,
    factor,
    icon: BROWSER_ASSETS ? schematicIcon : `/game-ui/icons/${icon}.png`,
  };
}
