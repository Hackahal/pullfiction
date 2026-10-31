import type { BrowserAssetBridge, CatalogKind } from "./browser-assets";
import { LocalClientFiles } from "./local-client-files";
import {
  bodyAppearanceResource,
  readAppearanceAsset,
} from "./appearance-assets";

// Original native UI and world boot reads, prepared before the original runtime starts.
export const ORIGINAL_UI_FILES = [
  "Fonts/FRIZQT__.TTF",
  "Fonts/ARIALN.TTF",
  "Fonts/MORPHEUS.TTF",
  "Fonts/SKURRI.TTF",
  "Interface/Buttons/WHITE8X8.blp",
  "Interface/GLUES/CHARACTERCREATE/UI-CHARACTERCREATE-CLASSES.blp",
  "Interface/TargetingFrame/UI-RaidTargetingIcons.blp",
  "Interface/TargetingFrame/UI-TargetingFrame-BarFill.blp",
  "Interface/Tooltips/UI-Tooltip-Background.blp",
  "Interface/Tooltips/UI-Tooltip-Border.blp",
  "Interface/Icons/INV_Misc_QuestionMark.blp",
] as const;

export const ORIGINAL_WORLD_FILES = [
  ...[
    "suncenter",
    "sunglare",
    "moon",
    "moonglare",
    "moon02",
    "waterpoop02",
  ].map((name) => `textures/${name}.blp`),
  "environments/stars/stars.blp",
  "environments/stars/stars2.blp",
  "textures/weather/raindrop01.blp",
  "xtextures/splash/splash.blp",
  "xtextures/splash/wake.blp",
  ...(
    [
      ["river", "lake_a", 30],
      ["river", "fast_a", 16],
      ["ocean", "ocean_h", 30],
      ["lava", "lava", 30],
      ["slime", "slime", 30],
    ] as const
  ).flatMap(([directory, stem, count]) =>
    Array.from(
      { length: count },
      (_, index) => `xtextures/${directory}/${stem}.${index + 1}.blp`,
    ),
  ),
];

const CATALOG_FILES: Record<string, CatalogKind> = {
  "__classic/spell-effects.json": "spells",
  "__classic/item-appearances.json": "items",
  "__classic/world-catalog.json": "world",
  "__classic/lighting.json": "lighting",
  "__classic/creature-catalog.json": "creatures",
  "__classic/character-catalog.json": "characters",
};

export function originalClientFiles(
  bridge: BrowserAssetBridge,
): LocalClientFiles {
  const identity = `${bridge.build.product}-${bridge.build.version}-${bridge.build.buildKey}`;
  return new LocalClientFiles(
    {
      async read(name) {
        const kind = CATALOG_FILES[name];
        if (kind)
          return new TextEncoder().encode(
            JSON.stringify(await bridge.catalog(kind)),
          );
        const appearance = await readAppearanceAsset(bridge, name);
        if (appearance) return appearance;
        const bake = /^textures\/bakednpctextures\/pf_([1-9]\d*)\.blp$/.exec(
          name,
        );
        const cape =
          /^item\/objectcomponents\/cape\/__classic\/([1-9]\d*)\.blp\.blp$/.exec(
            name,
          );
        return bridge.read(
          bake || cape ? `__classic/${(bake ?? cape)![1]}.blp` : name,
        );
      },
    },
    identity,
  );
}

export async function prepareOriginalClient(
  files: LocalClientFiles,
  signal?: AbortSignal,
): Promise<void> {
  await files.prepare(
    [
      ...ORIGINAL_UI_FILES,
      ...Object.keys(CATALOG_FILES),
      ...ORIGINAL_WORLD_FILES,
    ],
    signal,
  );
  // Native actor shadows and selection rings load independently of raid assets.
  // Prepare them before starting; absent optional textures stay absent.
  for (const resource of [
    "textures/shadowblob.blp",
    "textures/unitselecttexture.blp",
    "interface/spellshadow/spell-shadow-acceptable.blp",
    "interface/spellshadow/spell-shadow-unacceptable.blp",
  ]) {
    try {
      await files.prepare([resource], signal);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NotFoundError")
        throw error;
    }
  }
}

export interface OriginalUnitAssets {
  player: boolean;
  race?: number | null;
  sex?: number | null;
  look?: readonly number[];
  display?: number | null;
  gear?: readonly { slot: number; display?: unknown }[];
}

export async function prepareOriginalUnits(
  files: LocalClientFiles,
  bridge: BrowserAssetBridge,
  units: readonly OriginalUnitAssets[],
  icons: readonly string[] = [],
  signal?: AbortSignal,
): Promise<void> {
  const [characters, creatures, items] = await Promise.all([
    bridge.catalog("characters"),
    bridge.catalog("creatures"),
    bridge.catalog("items"),
  ]);
  const resources = new Set<string>();
  const iconResources = new Set<string>();
  for (const unit of units) {
    if (unit.player) {
      const race = unit.race ?? 1,
        sex = unit.sex ?? 0,
        look = unit.look ?? [0, 0, 0, 0, 0];
      // Replay descriptors write every logged item in order. Repeated slots therefore
      // keep the last entry, and the prepared atlas must use that same equipment.
      const equipped = new Map(
        unit.gear?.map((gear) => [gear.slot, gear.display]),
      );
      const displays = [3, 4, 5, 6, 7, 8, 9, 18].map((slot) => {
        const value = equipped.get(slot);
        return typeof value === "number" && items.displays?.[value] ? value : 0;
      });
      resources.add(bodyAppearanceResource({ race, sex, look, displays }));
      const types = characters.sectionTextureTypes?.find(
        (row: any) => row.race === race && row.sex === sex,
      )?.types;
      if (!Array.isArray(types))
        throw new Error("Character texture capabilities are unavailable");
      if (types.includes(6))
        resources.add(
          `__classic/appearance/${race}-${sex}-${look[2]}-${look[3]}-hair.blp`,
        );
      if (types.includes(8))
        resources.add(
          `__classic/appearance/${race}-${sex}-${look[0]}-extra.blp`,
        );
    } else if (unit.display) {
      const display = creatures.displays?.[unit.display];
      for (const id of display?.textures?.slice(0, 3) ?? [])
        if (Number.isInteger(id) && id > 0)
          resources.add(`__classic/${id}.blp`);
      const bake = creatures.extras?.[display?.extraDisplayID]?.bakeFileDataID;
      if (Number.isInteger(bake) && bake > 0)
        resources.add(`textures/bakednpctextures/pf_${bake}.blp`);
    }
  }
  for (const icon of icons) {
    const stem = icon
      .replaceAll("\\", "/")
      .split("/")
      .pop()
      ?.replace(/\.(?:png|jpe?g|blp)$/i, "");
    if (stem && /^[a-z0-9_-]{1,160}$/i.test(stem))
      iconResources.add(`interface/icons/${stem.toLowerCase()}.blp`);
  }
  await files.prepare([...resources], signal);
  for (const icon of iconResources) {
    signal?.throwIfAborted();
    try {
      await files.read(icon);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NotFoundError")
        throw error;
    }
  }
}
