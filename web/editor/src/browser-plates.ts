export interface BrowserPlate {
  key: string;
  name: string;
  x: number;
  y: number;
  class: number;
  friendly: boolean;
  health: number | null;
  maxHealth: number | null;
}
export function parseBrowserPlates(json: string): BrowserPlate[] {
  if (json.length > 2000000) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value) || value.length > 5000) return [];
    return value.filter(
      (plate): plate is BrowserPlate =>
        plate &&
        typeof plate === "object" &&
        typeof plate.key === "string" &&
        plate.key.length > 0 &&
        plate.key.length <= 160 &&
        typeof plate.name === "string" &&
        plate.name.length <= 160 &&
        Number.isFinite(plate.x) &&
        Number.isFinite(plate.y) &&
        typeof plate.class === "number" &&
        typeof plate.friendly === "boolean" &&
        (plate.health === null || Number.isFinite(plate.health)) &&
        (plate.maxHealth === null || Number.isFinite(plate.maxHealth)),
    );
  } catch {
    return [];
  }
}
