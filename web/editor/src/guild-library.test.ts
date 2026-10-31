import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyGuildLibrary,
  readGuildLibrary,
  writeGuildLibrary,
  saveGuild,
  removeGuild,
  selectedGuild,
  GUILD_LIBRARY_KEY,
  type SavedGuild,
} from "./guild-library";

const guild = (
  id: number,
  gameVersion: SavedGuild["gameVersion"] = "vanilla",
): SavedGuild => ({
  id,
  gameVersion,
  name: `Guild ${id}`,
  server: { name: "Firemaw", slug: "firemaw", region: { slug: "eu" } },
});
test("saved guilds survive reload and keep separate last selections for Era and SoD", () => {
  let raw = "";
  const storage = {
    getItem: (key: string) => {
      assert.equal(key, GUILD_LIBRARY_KEY);
      return raw || null;
    },
    setItem: (_: string, value: string) => {
      raw = value;
    },
  };
  let library = saveGuild(emptyGuildLibrary(), guild(1));
  library = saveGuild(library, guild(2));
  library = saveGuild(library, guild(1, "sod"));
  writeGuildLibrary(storage, library);
  const reopened = readGuildLibrary(storage);
  assert.equal(reopened.guilds.length, 3);
  assert.equal(selectedGuild(reopened, "vanilla")?.id, 2);
  assert.equal(selectedGuild(reopened, "sod")?.id, 1);
  const removed = removeGuild(reopened, guild(1, "sod"));
  assert.equal(selectedGuild(removed, "sod"), null);
  assert.equal(selectedGuild(removed, "vanilla")?.id, 2);
});
test("resaving canonical guild updates metadata without duplicating it; removal preserves other saves", () => {
  let library = saveGuild(emptyGuildLibrary(), guild(1));
  library = saveGuild(library, guild(2));
  library = saveGuild(library, { ...guild(2), name: "Updated name" });
  assert.equal(library.guilds.length, 2);
  assert.equal(selectedGuild(library, "vanilla")?.name, "Updated name");
  const removed = removeGuild(library, guild(2));
  assert.equal(selectedGuild(removed, "vanilla")?.id, 1);
});
test("corrupt guild entries are ignored and storage failures remain observable", () => {
  const read = (data: unknown) =>
    readGuildLibrary({ getItem: () => JSON.stringify(data) });
  assert.equal(
    read({
      guilds: [
        guild(1),
        guild(1),
        { ...guild(2), server: null },
        { ...guild(3), gameVersion: "retail" },
      ],
      selected: { vanilla: 999 },
    }).guilds.length,
    1,
  );
  assert.equal(selectedGuild(read({ guilds: [guild(1)] }), "vanilla")?.id, 1);
  assert.throws(() => readGuildLibrary({ getItem: () => "not json" }));
  assert.throws(
    () =>
      writeGuildLibrary(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        saveGuild(emptyGuildLibrary(), guild(1)),
      ),
    /quota/,
  );
  assert.throws(
    () => saveGuild(emptyGuildLibrary(), { ...guild(1), id: -1 }),
    /Invalid/,
  );
});
