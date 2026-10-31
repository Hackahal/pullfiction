import type { GameVersion } from "./types";

export interface KillRequirement {
  name: string;
  ids: number[];
  count: number;
  penaltyPool?: number;
  distinct?: boolean;
}
export interface SpeedrunRules {
  version: GameVersion;
  map: number;
  source: string;
  checked: string;
  coverage: "published" | "unverified";
  note: string;
  start: string[];
  startKind: "combat" | "boss";
  finish: string[];
  bossCount: number;
  requirements: KillRequirement[];
  penalty: boolean;
}
const era =
  "https://www.archon.gg/classic-mop/articles/help/vanilla-speed-run-rules";
const sod = "https://www.archon.gg/classic-sod/articles/";
const r = (name: string, count: number, ...ids: number[]): KillRequirement => ({
  name,
  count,
  ids,
});
const aq = [
  r("Obsidian Eradicator", 3, 15262),
  r("Anubisath Sentinel", 8, 15264),
  r("Qiraji Brainwasher", 6, 15247),
  r("Vekniss Warrior", 6, 15230),
  r("Vekniss Guardian", 29, 15233),
  r("Vekniss Hive Crawler", 6, 15240),
  r("Vekniss Stinger", 6, 15235),
  r("Qiraji Champion", 8, 15252),
  r("Anubisath Warder", 4, 15311),
];
const naxx = [
  r("Patchwork Golem", 10, 16017),
  r("Embalming Slime", 20, 16024),
  r("Bile Retcher / Sludge Belcher", 11, 16018, 16029),
  r("Living Monstrosity", 5, 16021),
  r("Infectious Skitterer", 81, 15977),
  r("Venom Stalker", 2, 15976),
  r("Crypt Reaver", 1, 15978),
  r("Necro Stalker", 4, 16453),
  r("Tomb Horror", 2, 15979),
  r("Deathknight", 14, 16146),
  r("Deathknight Captain", 12, 16145),
  r("Deathknight Cavalier", 9, 16163),
  r("Skeletal Smith", 4, 16193),
  r("Shade of Naxxramas", 2, 16164),
  r("Necro Knight", 6, 16165),
  r("Unholy weapons", 8, 16194, 16215, 16216),
  r("Stoneskin Gargoyle", 8, 16168),
  r("Plague Slime", 4, 16243),
  r("Plagued Gargoyle", 4, 16446),
  r("Plagued Ghoul", 16, 16447),
  r("Spirit of Naxxramas", 2, 16449),
  r("Necropolis Acolyte", 12, 16368),
];
const naxxStart = [
  "Dread Creeper",
  "Carrion Spinner",
  "Venom Stalker",
  "Infectious Skitterer",
  "Patchwork Golem",
  "Deathknight Captain",
  "Deathknight",
  "Risen Deathknight",
  "Necro Knight",
  "Stoneskin Gargoyle",
  "Infectious Ghoul",
];
function profile(
  version: GameVersion,
  map: number,
  source: string,
  start: string[],
  finish: string[],
  bossCount: number,
  requirements: KillRequirement[],
  note = "",
  coverage: SpeedrunRules["coverage"] = "published",
  startKind: SpeedrunRules["startKind"] = "combat",
): SpeedrunRules {
  return {
    version,
    map,
    source,
    start,
    finish,
    bossCount,
    requirements,
    note,
    coverage,
    startKind,
    checked: "2026-10-31",
    penalty: version === "sod" && coverage === "published",
  };
}
// Do not borrow Fresh Anniversary or Season of Mastery rules for Era. The
// currently accessible Era article documents AQ/Naxx only; other coverage is explicit.
export const SPEEDRUN_RULES: SpeedrunRules[] = [
  profile(
    "vanilla",
    531,
    era,
    [],
    ["C'Thun"],
    9,
    aq,
    "Era trash requirements. Start anchor is not specified in this source; clock uses the first recorded combat as an estimate.",
  ),
  profile(
    "vanilla",
    533,
    era,
    [],
    ["Kel'Thuzad"],
    15,
    naxx,
    "Era trash requirements. Five minutes per roster swap; maximum 50 raiders. Start anchor is not specified in this source; clock is an estimate.",
  ),
  ...([409, 469, 249, 309, 509] as const).map((map) =>
    profile(
      "vanilla",
      map,
      era,
      [],
      [],
      0,
      [],
      "Current Era requirements could not be verified from WCL's published article. Its MC/BWL tables are under Season of Mastery, and Fresh rules differ. Recorded splits remain available.",
      "unverified",
    ),
  ),
  profile(
    "sod",
    48,
    sod + "help/blackfathom-deeps-speedrun-rules",
    ["Baron Aquanis"],
    ["Aku'mai"],
    7,
    [
      r("Murkshallow Snapclaw / Blindlight Murloc", 4, 4815, 4818),
      r("Aku'mai Fisher", 8, 214612),
      r("Blackfathom Elite", 3, 204645),
      r("Blindlight Muckdweller / Oracle", 10, 4819, 4820),
      {
        ...r(
          "Blackfathom / Fallenroot / Twilight trash",
          68,
          4807,
          4805,
          4799,
          4798,
          4809,
          4811,
          4814,
          4812,
          4810,
          4813,
        ),
        penaltyPool: 1200000,
      },
      r("Aku'mai Snapjaw", 5, 215108),
    ],
    "The 68-mob group uses a 1,200-second penalty pool. WCL also describes this as 20s per missing mob; the formula is used here.",
    "published",
    "boss",
  ),
  profile(
    "sod",
    90,
    sod + "help/gnomeregan-speedrun-rules",
    ["Grubbis"],
    ["Mekgineer Thermaplugg"],
    6,
    [
      r("Irradiated Slime / Horror / Corrosive Lurker", 6, 6218, 6219, 6220),
      r("Leprous Defender / Mechanized Sentry", 14, 6223, 6233),
      r("Peacekeeper Security Suit", 1, 6230),
      r("Leprous Assistant", 28, 7603),
      r("Leprous Technician", 3, 6222),
      r("Leprous Machinesmith", 11, 6224),
      r("Mechano-Frostwalker / Flamewalker", 6, 6226, 6227),
      r(
        "Arcane Nullifier / Mechanized Guardian / Dark Iron Agent",
        20,
        6212,
        6232,
        6234,
      ),
    ],
    "",
    "published",
    "boss",
  ),
  profile(
    "sod",
    109,
    sod + "help/sunken-temple-speedrun-rules",
    ["Atal'arion"],
    ["Avatar of Hakkar"],
    8,
    [
      r("Atal'ai Witch Doctor / Unliving Atal'ai", 8, 224263, 224262),
      r("Saturated Ooze", 5, 224242),
      r("Atal'ai Corpse Eater", 17, 224260),
      r("Atal'ai Deathwalker", 34, 224259),
      r("Atal'ai High Priest", 15, 224258),
      r("Nightmare Scalebane / Wanderer / Wyrmkin", 29, 224255, 224253, 224254),
      r("Atal'ai Warrior", 4, 224250),
      r("Hakkari Frostwing", 4, 5291),
      r("Hakkari Sapper", 4, 8336),
    ],
    "Top 10 runs require a video beginning with an instance reset.",
    "published",
    "boss",
  ),
  profile(
    "sod",
    409,
    sod + "help/molten-core-speedrun-rules",
    ["Molten Giant"],
    ["The Molten Core", "Ragnaros"],
    10,
    [
      r("Molten Giant / Destroyer", 10, 11658, 11659),
      r("Ancient Core Hound", 14, 11673),
      r("Firewalker", 4, 11666),
      r("Flameguard", 4, 11667),
      r("Flame Imp", 10, 11669),
      r("Lava Elemental", 8, 12076),
      r("Lava Reaver", 3, 12100),
      r("Lava Surger", 8, 12101),
      r("Lava Annihilator / Firelord", 14, 11665, 11668),
      r("Core Hound", 25, 11671),
    ],
    "Start at the entrance giants. All Core Hound packs required. Heat 3 ends at The Molten Core; Heat 1/2 at Ragnaros. Select the heat below. Top 10 requires reset video.",
  ),
  profile(
    "sod",
    469,
    sod + "help/sod-blackwing-lair-speedrun-rules",
    ["Grethok the Controller"],
    ["Nefarian"],
    8,
    [
      r("Death Talon Captain", 1, 12467),
      r("Blackwing Taskmaster", 9, 12458),
      r("Death Talon Hatcher", 11, 12468),
      r("Blackwing Warlock", 10, 12459),
      r("Death Talon Wyrmguard", 7, 12460),
    ],
    "Top 10 runs require a video beginning with an instance reset.",
  ),
  profile(
    "sod",
    531,
    sod + "help/temple-of-ahn-qiraj-speedrun-rules",
    ["Obsidian Eradicator", "Anubisath Sentinel"],
    ["C'Thun"],
    9,
    [
      ...aq.filter((x) => x.name !== "Qiraji Champion"),
      r("Anubisath Defender", 5, 234830),
      r("Qiraji Slayer", 14, 234800),
      r("Qiraji Mindslayer", 6, 234762),
      r("Qiraji Champion", 6, 234798),
      r("Qiraji Warlord", 1, 234814),
    ],
  ),
  profile(
    "sod",
    533,
    sod + "help/sod-naxxramas-speedrun-rules",
    naxxStart,
    ["Kel'Thuzad"],
    15,
    [
      ...naxx.map((x) => ({
        ...x,
        count:
          (
            {
              "Infectious Skitterer": 91,
              "Deathknight Captain": 14,
              "Shade of Naxxramas": 3,
              "Plagued Gargoyle": 8,
              "Plagued Ghoul": 24,
              "Spirit of Naxxramas": 4,
            } as Record<string, number>
          )[x.name] ?? x.count,
      })),
      r("Stitched Spewer", 7, 16025),
      r("Naxxramas Acolyte / Cultist", 48, 15981, 15980),
      r("Death Lord", 1, 16861),
      r("Risen Deathknight", 8, 16154),
      r("Plague Beast", 2, 16034),
    ],
    "Five minutes added if fewer than 12 Deathknight Captains die before Razuvious. Top 5 requires all trash on HM4. Loatheb spores on other bosses invalidate the run.",
  ),
  profile(
    "sod",
    2856,
    sod + "news/scarlet-enclave-parsing-and-speedrun-rules",
    ["Balnazzar"],
    ["Caldoran"],
    8,
    [
      {
        ...r(
          "Scarlet lieutenants (2 distinct)",
          2,
          242224,
          242296,
          242310,
          242308,
          242304,
          242301,
        ),
        distinct: true,
      },
      r("First Mate Kip", 1, 242113),
      r("Archmagus Nilas Arcanister", 1, 241665),
      r("Commander Granis Darkhammer", 1, 240803),
      r("Scarlet Thaumaturgist", 3, 241778),
      r("Scarlet Spellbreaker", 2, 240789),
      r("Scarlet Knight", 8, 240798),
      r("Scarlet Myrmidon", 3, 243737),
      r("Scarlet Spellbinder", 1, 240788),
      r("Scarlet Medic", 1, 240786),
      r(
        "Scarlet Priest",
        1,
        240787,
        243159,
        244005,
        244014,
        244019,
        244069,
        244102,
        244131,
      ),
      r("Scarlet Battle Mage", 5, 241406),
      r("Scarlet Praetorian", 1, 240781),
      r("Scarlet Cleric", 1, 240782),
      r(
        "Scarlet Mage",
        4,
        244132,
        244103,
        244068,
        244020,
        244013,
        244006,
        240801,
      ),
      r("Scarlet Paladin", 3, 240802),
      r("Scarlet Rifleman", 2, 241411),
      r("Scarlet Invoker", 2, 240800),
      r("Scarlet Soldier", 4, 240793),
      r("Scarlet Alchemist", 7, 240785),
      r("Scarlet Armorer", 1, 241409),
      r("Manath Magesinger", 1, 241895),
      r("Scarlet Trainee", 28, 241828),
      r("Scarlet Footman", 4, 241120),
      r("Scarlet Executioner", 1, 240797),
    ],
    "Balnazzar pull to Caldoran death. Two different lieutenants required.",
    "published",
    "boss",
  ),
  ...([249, 309, 509] as const).map((map) =>
    profile(
      "sod",
      map,
      sod + "help",
      [],
      [],
      0,
      [],
      "No raid-specific WCL speedrun requirement table was found in the published SoD articles. Recorded splits are shown without a rules verdict.",
      "unverified",
    ),
  ),
];
export function speedrunRules(version: GameVersion, map: number) {
  return SPEEDRUN_RULES.find((x) => x.version === version && x.map === map);
}
