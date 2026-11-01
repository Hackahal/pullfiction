import { useState } from "react";
import { raidByMap } from "./domain";
import { raidZoneImages } from "./library-model";
import type { GameVersion } from "./types";
export function RaidArt({
  map,
  version,
}: {
  map: number;
  version: GameVersion;
}) {
  const [failedZone, setFailedZone] = useState<number | null>(null);
  const raid = raidByMap(map, version),
    zone = raidZoneImages[map];
  return (
    <span className="raid-art">
      {zone && failedZone !== zone ? (
        <img
          src={`https://assets.rpglogs.com/img/warcraft/zones/zone-${zone}.png`}
          alt={raid?.name ?? "Raid"}
          onError={() => setFailedZone(zone)}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span aria-label={raid?.name ?? "Raid"}>{raid?.short ?? "Raid"}</span>
      )}
    </span>
  );
}
