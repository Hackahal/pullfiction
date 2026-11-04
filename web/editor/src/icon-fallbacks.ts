function glyph(path: string, ink: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#24272d"/><path d="${path}" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Tactical symbols for missing game art, separate from the original raid marks. */
export const tacticalMarkers = {
  ability_warrior_defensivestance: {
    label: "Tank",
    fallback: glyph(
      "M10 25v-6l2-3V8h8v8l2 3v6zm2-13h8m-5 4v4m3-4v4",
      "#e7b17f",
    ),
  },
  spell_holy_flashheal: {
    label: "Heal",
    fallback: glyph("M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z", "#8edfbc"),
  },
  spell_fire_fireball: {
    label: "Fire",
    fallback: glyph(
      "M17 5c2 6-1 7 4 10l2-3c3 6 3 14-7 14-8 0-10-7-5-12 0 4 2 4 3 3 2-3-1-7 3-12z",
      "#ffad79",
    ),
  },
  ability_hunter_snipershot: {
    label: "Ranged",
    fallback: glyph(
      "M12 6c9 0 14 6 14 14M12 6l14 14M7 25 24 8m-6 0h6v6M7 20v5h5",
      "#cee88a",
    ),
  },
  spell_nature_sleep: {
    label: "Sleep",
    fallback: glyph("M10 9h12L10 23h12", "#bbadff"),
  },
  spell_holy_powerwordshield: {
    label: "Shield",
    fallback: glyph("m16 6 8 3v7c0 5-5 9-8 11-3-2-8-6-8-11V9z", "#a9caff"),
  },
};

export function tacticalMarker(icon: string) {
  return Object.hasOwn(tacticalMarkers, icon)
    ? tacticalMarkers[icon as keyof typeof tacticalMarkers]
    : undefined;
}

/** A recorded item exists. This glyph describes its slot, not the missing artwork. */
export const gearSlotIcon = (slot: number) =>
  slot === 1
    ? necklace
    : slot === 10 || slot === 11
      ? ring
      : slot === 12 || slot === 13
        ? charm
        : equipment;

const necklace = glyph(
  "M7 8c0 7 4 11 9 13 5-2 9-6 9-13m-9 11 4 4-4 4-4-4z",
  "#cad2e0",
);
const ring = glyph("M10 12a8 8 0 1 0 12 0M11 9l5-3 5 3-5 5z", "#cad2e0");
const charm = glyph(
  "M13 10V8a3 3 0 1 1 6 0v2m-3 0 8 6-8 10-8-10zM12 17h8",
  "#cad2e0",
);
const equipment = glyph(
  "m12 8-6 4 3 6 3-2v9h8v-9l3 2 3-6-6-4c0 4-8 4-8 0z",
  "#cad2e0",
);
