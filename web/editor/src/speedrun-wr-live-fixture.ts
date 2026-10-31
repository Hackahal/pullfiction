import type { RawReplay } from "./types";
import { normalizeReplay } from "./domain";
import { fixture } from "./speedrun-test-fixture";
// Public WCL report metadata captured 2026-10-31 from the authenticated v2 API
// and official /reports/fights-and-participants/4aMcj6kb7TwAN9vq/0 response.
// The website's completeRaids[0] is 6097280..9409000; v2 returns no such fight.
export const praxisCategory = {
  zoneID: 2017,
  encounterID: 2983,
  partitions: [{ id: 1, name: "Discovery P7", default: true }],
  difficulties: [{ id: 5, name: "Mythic", sizes: [20] }],
};
export const praxisWinner = {
  startTime: 1744051807963,
  duration: 3311720,
  size: 20,
  guild: { name: "Praxis" },
  report: {
    code: "4aMcj6kb7TwAN9vq",
    fightID: 10000,
    startTime: 1744045710683,
  },
};
const kills: [number, number, string, number, number][] = [
  [3, 1161, "Instructor Razuvious / Gothik the Harvester", 6405343, 6735037],
  [5, 201121, "The Four Horsemen", 6861830, 7028588],
  [8, 201117, "Noth the Plaguebringer", 7153346, 7200301],
  [10, 201112, "Heigan the Unclean", 7255497, 7311729],
  [12, 201115, "Loatheb", 7356449, 7476025],
  [14, 201118, "Patchwerk", 7660815, 7711131],
  [17, 201111, "Grobbulus", 7764023, 7830147],
  [19, 201108, "Gluth", 7857798, 7920912],
  [21, 201120, "Thaddius", 7956466, 8098881],
  [23, 201107, "Anub'Rekhan", 8171169, 8214068],
  [26, 201110, "Grand Widow Faerlina", 8366983, 8427701],
  [28, 201116, "Maexxna", 8589850, 8698057],
  [29, 201119, "Sapphiron", 8723795, 8839475],
  [31, 201114, "Kel'Thuzad", 9136703, 9409000],
];
export const praxisReport = {
  code: praxisWinner.report.code,
  startTime: 1744045710683,
  fights: [
    {
      id: 1,
      encounterID: 0,
      name: "Sewage Slime",
      startTime: 6097280,
      endTime: 6317985,
      kill: false,
      completeRaid: false,
      gameZone: { id: 533, name: "Naxxramas" },
    },
    ...kills.map(([id, encounterID, name, startTime, endTime]) => ({
      id,
      encounterID,
      name,
      startTime,
      endTime,
      kill: true,
      completeRaid: false,
      difficulty: 5,
      size: 20,
      gameZone: { id: 533, name: "Naxxramas" },
    })),
  ],
};

export function patchwerkFirstReplay() {
  const seed = fixture(533);
  return normalizeReplay(
    {
      ...seed.raw,
      actors: seed.raw.actors.map((value) => {
        const a = value as Record<string, unknown>;
        return a.id === 2
          ? { ...a, name: "Patchwork Golem", gameID: 16017 }
          : a;
      }),
      fight: {
        ...seed.raw.fight,
        difficulty: 5,
        size: 20,
        endTime: 4000000,
        chapters: [
          {
            id: 0,
            name: "Trash",
            encounterID: 0,
            startTime: 1000,
            endTime: 2000,
            enemyNPCs: [{ id: 2 }],
          },
          {
            id: 1,
            name: "Patchwerk",
            encounterID: 201118,
            startTime: 270000,
            endTime: 290300,
            kill: true,
          },
          {
            id: 2,
            name: "Grobbulus",
            encounterID: 201111,
            startTime: 400000,
            endTime: 447300,
            kill: true,
          },
          {
            id: 3,
            name: "Gluth",
            encounterID: 201108,
            startTime: 500000,
            endTime: 546700,
            kill: true,
          },
          {
            id: 4,
            name: "Kel'Thuzad",
            encounterID: 201114,
            startTime: 3000000,
            endTime: 3312720,
            kill: true,
          },
        ],
      },
    } as RawReplay,
    {},
  );
}
