import { normalizeReplay, RAIDS } from "./domain";
import type { RawReplay, Replay } from "./types";
export function fixture(map = 48, version: "sod" | "vanilla" = "sod"): Replay {
  const raid = RAIDS.find((r) => r.map === map)!;
  return normalizeReplay(
    {
      gameVersion: version,
      report: { code: "synthetic-test", title: "Synthetic speedrun" },
      fight: {
        id: "run",
        name: raid.name,
        completeRaid: true,
        startTime: 1000,
        endTime: 21000,
        friendlyPlayers: [1],
        gameZone: { name: raid.name },
        chapters: [
          {
            id: 1,
            name: "Baron Aquanis",
            encounterID: 1,
            startTime: 2000,
            endTime: 4000,
            kill: true,
          },
          {
            id: 2,
            name: "Ghamoo-ra",
            encounterID: 2,
            startTime: 5000,
            endTime: 7000,
            kill: false,
          },
          {
            id: 3,
            name: "Ghamoo-ra",
            encounterID: 2,
            startTime: 8000,
            endTime: 10000,
            kill: true,
          },
          {
            id: 4,
            name: "Aku'mai",
            encounterID: 7,
            startTime: 14000,
            endTime: 16000,
            kill: true,
          },
        ],
      },
      actors: [
        { id: 1, type: "Player", name: "Mage", subType: "Mage" },
        { id: 2, type: "NPC", name: "Murkshallow Snapclaw", gameID: 4815 },
        { id: 3, type: "NPC", name: "Blindlight Murloc", gameID: 4818 },
      ],
      events: [
        { timestamp: 1100, type: "applybuff", sourceID: 1, targetID: 2 },
        {
          timestamp: 2000,
          type: "damage",
          sourceID: 1,
          targetID: 2,
          amount: 1,
        },
        { timestamp: 6000, type: "death", targetID: 2, targetInstance: 1 },
        { timestamp: 6000, type: "death", targetID: 2, targetInstance: 1 },
        { timestamp: 6500, type: "death", targetID: 3, targetInstance: 1 },
        { timestamp: 16000, type: "death", targetID: 2, targetInstance: 2 },
        { timestamp: 17000, type: "death", targetID: 2, targetInstance: 3 },
      ],
    } as unknown as RawReplay,
    {},
  );
}
