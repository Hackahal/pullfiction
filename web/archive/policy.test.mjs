import test from "node:test";
import assert from "node:assert/strict";
import {
  archivePath,
  isStorageFile,
  clientBuild,
  resourceName,
  cacheIdentity,
} from "./policy.mjs";

const info =
  "Active!DEC:1|Build Key!HEX:16|Version!STRING:0|Product!STRING:0\n1|2417084b8b041ee120d02d4adf31b0bc|1.15.9.70003|wow_classic_era\n";

test("Forever requires explicit selection and cannot share a Classic cache", () => {
  const forever = info
    .replace("wow_classic_era", "wowf")
    .replace("1.15.9.70003", "1.60.1.70658");
  const both = info + forever.split("\n")[1] + "\n";
  const selected = clientBuild(both, "wowf");
  assert.equal(selected.product, "wowf");
  assert.equal(clientBuild(both).product, "wow_classic_era");
  assert.throws(() => clientBuild(forever), /Classic/);
  assert.throws(() => clientBuild(info, "wowf"), /Forever/);
  assert.throws(() => clientBuild(both, "toString"), /Unsupported/);
  assert.throws(
    () => clientBuild(forever.replace("1.60.1", "1.60.2"), "wowf"),
    /Unsupported/,
  );
  assert.notEqual(
    cacheIdentity(selected, "test"),
    cacheIdentity(clientBuild(info), "test"),
  );
  assert.throws(
    () => cacheIdentity({ ...selected, product: "wow_classic_era" }, "test"),
    /Invalid/,
  );
});

test("selects the active modern client without treating its ruleset as the asset build", () => {
  assert.deepEqual(clientBuild(info), {
    product: "wow_classic_era",
    version: "1.15.9.70003",
    buildKey: "2417084b8b041ee120d02d4adf31b0bc",
  });
  assert.throws(
    () => clientBuild(info.replace("1.15.9.70003", "1.12.1.5875")),
    /Unsupported client/,
  );
  assert.throws(() => clientBuild(info + info.split("\n")[1]), /one active/);
  assert.throws(
    () =>
      clientBuild(info.replace("2417084b8b041ee120d02d4adf31b0bc", "invalid")),
    /build key/,
  );
});

test("only exposes CASC storage files, never executables, account data or game logs", () => {
  for (const path of [
    ".build.info",
    "Data/data/000000000e.idx",
    "Data/data/data.023",
    "Data/config/24/17/2417084b8b041ee120d02d4adf31b0bc",
  ])
    assert.equal(isStorageFile(path), true, path);
  for (const path of [
    "_classic_era_/WoW.app/Contents/MacOS/WoW",
    "_classic_era_/WTF/Config.wtf",
    "_classic_era_/Logs/WoWCombatLog.txt",
    "Data/data/shmem",
    "Data/data/unexpected.idx",
  ])
    assert.equal(isStorageFile(path), false, path);
  for (const path of [
    "../Data/data/data.001",
    "/Data/data/data.001",
    "Data/./data/data.001",
    "Data\\data\\data.001",
    "Data/a\0b",
  ])
    assert.throws(() => archivePath(path));
});

test("resource requests include local raid worlds and native overlay assets while excluding decorative maps", () => {
  assert.deepEqual(resourceName("id:135846"), {
    name: "",
    fileId: 135846,
    key: "id:135846",
  });
  assert.equal(
    resourceName("Creature\\Ragnaros\\Ragnaros.m2").name,
    "creature\\ragnaros\\ragnaros.m2",
  );
  assert.equal(
    resourceName("Interface/TargetingFrame/UI-RaidTargetingIcons.blp").key,
    "interface/targetingframe/ui-raidtargetingicons.blp",
  );
  for (const path of [
    "World/Maps/MoltenCore/MoltenCore.wdt",
    "World/Maps/Stratholme Raid/Stratholme Raid_30_25.adt",
    "World/Wmo/Dungeon/Test.wmo",
    "World/Generic/Test.m2",
    "Tileset/Generic/stone.blp",
    "XTextures/Lava/Lava.1.blp",
    "Textures/Minimap/md5translate.trs",
    "Textures/Minimap/wmo/test_000_00_00.blp",
    "Fonts/FRIZQT__.TTF",
    "Fonts/ARIALN.TTF",
    "Textures/ShadowBlob.blp",
    "Textures/UnitSelectTexture.blp",
    "Textures/SpellChainEffects/Lightning.blp",
    "Interface/SpellShadow/Spell-Shadow-Acceptable.blp",
    "Interface/TargetingFrame/other.blp",
    "Interface/Buttons/WHITE8X8.blp",
    "Interface/GLUES/CHARACTERCREATE/UI-CHARACTERCREATE-CLASSES.blp",
    "Interface/Tooltips/UI-Tooltip-Background.blp",
    "Interface/Tooltips/UI-Tooltip-Border.blp",
  ])
    assert.equal(resourceName(path).key, path.toLowerCase());
  assert.deepEqual(resourceName("__classic/108286.wmo"), {
    name: "",
    fileId: 108286,
    key: "__classic/108286.wmo",
  });
  assert.equal(
    resourceName("__classic/108286_000.wmo").key,
    "__classic/108286_000.wmo",
  );
  assert.equal(resourceName("__classic/108286.m2").fileId, 108286);
  assert.equal(resourceName("__classic/108286.blp").fileId, 108286);
  for (const path of [
    "Interface/FrameXML/UIParent.lua",
    "Interface/WorldMap/Azeroth/Azeroth.blp",
    "Interface/WorldMap/Azeroth/Azeroth.wmo",
    "__classic/108286_000.m2",
    "__classic/4294967295.wmo",
    "Fonts/unneeded.ttf",
    "Sound/foo.wav",
    "id:4294967295",
    "id:-1",
    "Creature/../secret.m2",
    "dbfilesclient/a.db2?b",
  ])
    assert.throws(() => resourceName(path), undefined, path);
});

test("cache identities separate client builds and converter revisions", () => {
  const build = clientBuild(info);
  assert.notEqual(cacheIdentity(build, "v1"), cacheIdentity(build, "v2"));
  assert.notEqual(
    cacheIdentity(build, "v1"),
    cacheIdentity({ ...build, buildKey: "a".repeat(32) }, "v1"),
  );
  assert.throws(() => cacheIdentity(build, "../v1"));
});
