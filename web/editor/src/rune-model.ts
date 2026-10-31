import type { Gear, GameVersion, Replay } from "./types";

// SoD engravings occupy the extra enchantment on these armor/ring slots.
// Weapon temporary enchants also contain oils, poisons and Wild Strikes.
const RUNE_SLOTS = new Set([0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 14]);
export interface GearRune {
  slot: number;
  enchant: number;
  name: string;
  spellId?: number;
  icon?: string;
}
type Reference = { id: number; name?: string; icon?: string };
const normalized = (name: string) => name.trim().toLocaleLowerCase();

export function gearRunes(
  gear: Gear[],
  version: GameVersion,
  actorId: number,
  replay: Replay | null,
): GearRune[] {
  if (version !== "sod") return [];
  const players = Object.values(
    replay?.raw.playerDetails?.data?.playerDetails ?? {},
  ).flatMap((group) => (Array.isArray(group) ? group : []));
  const recorded = players.find((p) => p.id === actorId)?.combatantInfo;
  const personal: Reference[] = (recorded?.artifact ?? []).map((a: any) => ({
    id: a.guid,
    name: a.name,
    icon: a.abilityIcon,
  }));
  const abilities: Reference[] = Array.from(
    replay?.abilities ?? [],
    ([id, meta]) => ({ id, ...meta }),
  );
  return gear.flatMap((item) => {
    const enchant = item.temporaryEnchant;
    if (
      !RUNE_SLOTS.has(item.slot) ||
      !Number.isInteger(enchant) ||
      !enchant ||
      enchant < 0
    )
      return [];
    const name = item.temporaryEnchantName?.trim() || `Rune ${enchant}`;
    const matches = (entries: Reference[]) =>
      entries.filter(
        (a) =>
          Number.isInteger(a.id) &&
          a.id > 0 &&
          typeof a.name === "string" &&
          normalized(a.name) === normalized(name),
      );
    const direct = matches(personal),
      candidates = direct.length ? direct : matches(abilities);
    const ids = new Set(candidates.map((a) => a.id));
    const icons = new Set(candidates.flatMap((a) => (a.icon ? [a.icon] : [])));
    return [
      {
        slot: item.slot,
        enchant,
        name,
        ...(ids.size === 1 ? { spellId: [...ids][0] } : {}),
        ...(icons.size === 1 ? { icon: [...icons][0] } : {}),
      },
    ];
  });
}
