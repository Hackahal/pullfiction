import type { GameVersion } from "./types";
import {
  readGuildLibrary,
  writeGuildLibrary,
  saveGuild,
  removeGuild,
  validGuild,
} from "./guild-library";
import type { LogGuild } from "./wcl-browser";
import type { LogCharacter } from "./wcl-discovery";
export type FollowedSource = (LogGuild | LogCharacter) & {
  kind: "guild" | "character";
  gameVersion: GameVersion;
};
const KEY = "pullfiction.followedCharacters.v1";
export const sourceKey = (s: FollowedSource) =>
  `${s.gameVersion}:${s.kind}:${s.id}`;
export function readFollowed(
  storage: Pick<Storage, "getItem">,
): FollowedSource[] {
  const guilds = readGuildLibrary(storage).guilds.map((g) => ({
    ...g,
    kind: "guild" as const,
  }));
  const raw = JSON.parse(storage.getItem(KEY) ?? "[]");
  if (!Array.isArray(raw))
    throw new Error("Followed characters could not be read.");
  const chars = raw.filter(
    (c) =>
      c.kind === "character" &&
      Number.isSafeInteger(c.classID) &&
      c.classID > 0 &&
      validGuild(c),
  );
  return [...guilds, ...new Map(chars.map((c) => [sourceKey(c), c])).values()];
}
export function toggleFollowed(
  storage: Pick<Storage, "getItem" | "setItem">,
  source: FollowedSource,
): FollowedSource[] {
  const all = readFollowed(storage),
    found = all.some((s) => sourceKey(s) === sourceKey(source));
  if (source.kind === "guild") {
    const library = readGuildLibrary(storage);
    writeGuildLibrary(
      storage,
      found ? removeGuild(library, source) : saveGuild(library, source),
    );
  } else
    storage.setItem(
      KEY,
      JSON.stringify(
        found
          ? all.filter(
              (s) =>
                s.kind === "character" && sourceKey(s) !== sourceKey(source),
            )
          : [...all.filter((s) => s.kind === "character"), source],
      ),
    );
  return readFollowed(storage);
}
