export const CLASS_NAMES: Record<number, string> = {
  1: "Warrior",
  2: "Paladin",
  3: "Hunter",
  4: "Rogue",
  5: "Priest",
  6: "DeathKnight",
  7: "Shaman",
  8: "Mage",
  9: "Warlock",
  10: "Monk",
  11: "Druid",
  12: "DemonHunter",
  13: "Evoker",
};
export function characterClass(value: unknown): string | null {
  if (typeof value === "number") return CLASS_NAMES[value] ?? null;
  if (typeof value !== "string") return null;
  return (
    Object.values(CLASS_NAMES).find(
      (name) => name.toLowerCase() === value.replace(/\s/g, "").toLowerCase(),
    ) ?? null
  );
}
export type Faction = "Alliance" | "Horde";
/** WCL's faction images and ranking JSON use 0 for Alliance and 1 for Horde. */
export function factionName(value: unknown): Faction | null {
  if (typeof value === "object" && value !== null) {
    const named = (value as { name?: unknown }).name;
    return typeof named === "string" ? factionName(named) : null;
  }
  if (value === 0 || value === "Alliance") return "Alliance";
  if (value === 1 || value === "Horde") return "Horde";
  return null;
}
