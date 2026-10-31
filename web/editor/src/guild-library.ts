import type { GameVersion } from "./types";
import type { LogGuild } from "./wcl-browser";

export type SavedGuild = LogGuild & { gameVersion: GameVersion };
export type GuildLibrary = {
  guilds: SavedGuild[];
  selected: Partial<Record<GameVersion, number>>;
};
export const GUILD_LIBRARY_KEY = "pullfiction.savedGuilds.v1";
export const emptyGuildLibrary = (): GuildLibrary => ({
  guilds: [],
  selected: {},
});

export function validGuild(g: any): g is SavedGuild {
  return (
    g &&
    (g.gameVersion === "vanilla" || g.gameVersion === "sod") &&
    Number.isSafeInteger(g.id) &&
    g.id > 0 &&
    typeof g.name === "string" &&
    g.name.length > 0 &&
    g.name.length <= 100 &&
    typeof g.server?.name === "string" &&
    g.server.name.length <= 100 &&
    typeof g.server?.slug === "string" &&
    g.server.slug.length > 0 &&
    g.server.slug.length <= 100 &&
    /^(eu|us|kr|tw|cn)$/.test(g.server?.region?.slug)
  );
}
export function readGuildLibrary(
  storage: Pick<Storage, "getItem">,
): GuildLibrary {
  const raw = storage.getItem(GUILD_LIBRARY_KEY);
  if (!raw) return emptyGuildLibrary();
  const data = JSON.parse(raw);
  if (!Array.isArray(data?.guilds))
    throw new Error("Saved guilds could not be read.");
  const guilds: SavedGuild[] = [];
  for (const g of data.guilds) {
    if (!validGuild(g)) continue;
    if (
      !guilds.some(
        (old) => old.id === g.id && old.gameVersion === g.gameVersion,
      )
    )
      guilds.push(g);
  }
  const selected: GuildLibrary["selected"] = {};
  for (const version of ["vanilla", "sod"] as const) {
    if (
      guilds.some(
        (g) => g.gameVersion === version && g.id === data.selected?.[version],
      )
    )
      selected[version] = data.selected[version];
  }
  return { guilds, selected };
}
export function writeGuildLibrary(
  storage: Pick<Storage, "setItem">,
  library: GuildLibrary,
) {
  storage.setItem(GUILD_LIBRARY_KEY, JSON.stringify(library));
}
export function saveGuild(
  library: GuildLibrary,
  guild: SavedGuild,
): GuildLibrary {
  if (!validGuild(guild)) throw new Error("Invalid saved guild.");
  return {
    guilds: [
      ...library.guilds.filter(
        (g) => g.id !== guild.id || g.gameVersion !== guild.gameVersion,
      ),
      guild,
    ],
    selected: { ...library.selected, [guild.gameVersion]: guild.id },
  };
}
export function removeGuild(
  library: GuildLibrary,
  guild: SavedGuild,
): GuildLibrary {
  const guilds = library.guilds.filter(
    (g) => g.id !== guild.id || g.gameVersion !== guild.gameVersion,
  );
  const selected = { ...library.selected };
  if (selected[guild.gameVersion] === guild.id)
    selected[guild.gameVersion] = guilds.find(
      (g) => g.gameVersion === guild.gameVersion,
    )?.id;
  return { guilds, selected };
}
export function selectedGuild(library: GuildLibrary, version: GameVersion) {
  return (
    library.guilds.find(
      (g) => g.gameVersion === version && g.id === library.selected[version],
    ) ??
    library.guilds.find((g) => g.gameVersion === version) ??
    null
  );
}
