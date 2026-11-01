import test from "node:test";
import assert from "node:assert/strict";
import { readFollowed, toggleFollowed } from "./followed-sources";
import { GUILD_LIBRARY_KEY } from "./guild-library";
test("following characters preserves legacy guilds and remains scoped to game version", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
  const server = {
    name: "Living Flame",
    slug: "living-flame",
    region: { slug: "eu" },
  };
  map.set(
    GUILD_LIBRARY_KEY,
    JSON.stringify({
      guilds: [{ id: 1, name: "Guild", server, gameVersion: "sod" }],
      selected: { sod: 1 },
    }),
  );
  const player = {
    kind: "character" as const,
    gameVersion: "sod" as const,
    id: 2,
    name: "Player",
    classID: 8,
    server,
  };
  assert.equal(toggleFollowed(storage, player).length, 2);
  assert.equal(
    readFollowed(storage).filter((s) => s.kind === "guild").length,
    1,
  );
  assert.equal(
    toggleFollowed(storage, { ...player, gameVersion: "vanilla" }).length,
    3,
  );
  assert.equal(toggleFollowed(storage, player).length, 2);
  assert.equal(
    readFollowed(storage).find((s) => s.kind === "character")?.gameVersion,
    "vanilla",
  );
});
