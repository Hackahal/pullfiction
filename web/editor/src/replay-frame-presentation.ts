import type { Aura, Gear, NativeFrame, Replay } from "./types";

type AuraRows = Pick<NativeFrame, "plate_auras" | "auras" | "self_auras">;

/** Recorded rows are replaced by normalization; frame consumers only read them. */
export class ReplayFramePresentation {
  private gear = new WeakMap<readonly Gear[], NativeFrame["gear"]>();
  private auraRows = new WeakMap<readonly Aura[], AuraRows>();
  private abilities?: Replay["abilities"];

  equipment(gear: readonly Gear[]): NativeFrame["gear"] {
    let rows = this.gear.get(gear);
    if (!rows) {
      rows = gear
        .filter((g) => g.model)
        .map((g) => ({
          id: g.id,
          slot: g.slot,
          ...g.model,
          name: g.name ?? g.model?.name ?? `Item ${g.id}`,
          quality: g.quality ?? g.model?.quality ?? 0,
          enchant: g.permanentEnchant ?? 0,
          temporary: g.temporaryEnchant ?? 0,
        }));
      this.gear.set(gear, rows);
    }
    return rows;
  }

  auras(auras: readonly Aura[], abilities: Replay["abilities"]): AuraRows {
    if (this.abilities !== abilities) {
      this.abilities = abilities;
      this.auraRows = new WeakMap();
    }
    let rows = this.auraRows.get(auras);
    if (!rows) {
      const plate_auras: NativeFrame["plate_auras"] = [],
        spells: number[] = [],
        self_auras: number[] = [];
      for (let i = 0; i < Math.min(48, auras.length); i++) {
        const a = auras[i],
          ability = abilities.get(a.spell);
        plate_auras.push({
          spell: a.spell,
          name: ability?.name ?? a.name ?? `Spell ${a.spell}`,
          icon: ability?.icon ?? a.icon ?? "",
          stack: a.stack ?? 1,
          debuff: !!a.debuff,
        });
        spells.push(a.spell);
        if (a.selfCast) self_auras.push(a.spell);
      }
      rows = { plate_auras, auras: spells, self_auras };
      this.auraRows.set(auras, rows);
    }
    return rows;
  }
}
