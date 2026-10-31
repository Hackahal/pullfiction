import test from "node:test";
import assert from "node:assert/strict";
import {
  referenceRaidActors,
  referenceNpcModels,
  referenceSpawnNotice,
  spawnStatus,
} from "./spawn-model";
import { poseAt } from "./domain";
import reference from "../../../third_party/raid-spawns/vanilla.json";

test("every Vanilla raid has stable reference actors with authored XYZ and facing", () => {
  for (const [map, rows] of Object.entries(reference.maps)) {
    const actors = referenceRaidActors(Number(map), "vanilla", {});
    assert.equal(actors.length, rows.length);
    assert.ok(actors.length > 0);
    assert.equal(new Set(actors.map((a) => a.key)).size, rows.length);
    for (const [i, actor] of actors.entries()) {
      assert.deepEqual(poseAt(actor, 0)?.pos, rows[i].position);
      assert.equal(poseAt(actor, 0)?.facing, rows[i].facing);
      assert.equal(poseAt(actor, 90000)?.dead, false);
      assert.deepEqual(actor.samples, []);
      assert.deepEqual(actor.deaths, []);
      assert.equal(spawnStatus(actor, 0), "Reference spawn");
    }
    assert.deepEqual(referenceRaidActors(Number(map), "vanilla", {}), actors);
  }
});

test("SoD and unsupported maps cannot silently use Vanilla placements", () => {
  for (const map of [48, 90, 109, 249, 309, 409, 469, 509, 531, 533, 2856]) {
    assert.deepEqual(referenceRaidActors(map, "sod", {}), []);
    assert.match(referenceSpawnNotice(map, "sod"), /not yet available/);
  }
  assert.deepEqual(referenceRaidActors(1, "vanilla", {}), []);
  assert.match(referenceSpawnNotice(409, "vanilla"), /reference spawns/);
});

test("reference display uses only an available authored local client model", () => {
  const row = reference.maps["249"][0];
  const creatures = {
    displays: { [row.displayID]: { modelID: 9, scale: 2 } },
    models: { 9: { fileDataID: 99, scale: 3 } },
  };
  const models = referenceNpcModels(creatures);
  assert.equal(models[row.entry].scale, 6);
  assert.equal(
    referenceRaidActors(249, "vanilla", models)[0].displayID,
    row.displayID,
  );
  assert.equal(referenceRaidActors(249, "vanilla", {})[0].displayID, null);
  assert.deepEqual(
    referenceNpcModels({ displays: creatures.displays, models: {} }),
    {},
  );
});
