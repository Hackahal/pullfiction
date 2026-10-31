import test from "node:test";
import assert from "node:assert/strict";
import {
  referenceRaidActors,
  referenceNpcModels,
  referenceSpawnNotice,
  referenceCoverage,
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

test("SoD maps use explicit SoD data or a disclosed Classic baseline without identity collisions", () => {
  for (const map of [48, 90, 109, 249, 309, 409, 469, 509, 531, 533, 2856]) {
    const actors = referenceRaidActors(map, "sod", {});
    assert.ok(actors.length > 0, String(map));
    assert.equal(new Set(actors.map((a) => a.key)).size, actors.length);
    assert.ok(actors.every((a) => a.key.startsWith(`spawn:sod:${map}:`)));
    assert.ok(
      actors.every((a) => a.samples.length === 0 && a.deaths.length === 0),
    );
    if ([90, 531, 2856].includes(map)) {
      assert.equal(referenceCoverage(map, "sod").kind, "sod-reference");
      assert.ok(actors.every((a) => a.spawn?.position[2] === null));
    } else if (map === 48) {
      assert.equal(referenceCoverage(map, "sod").kind, "mixed-reference");
      const bosses = actors.filter((a) => a.class === "Boss");
      assert.equal(bosses.length, 7);
      assert.deepEqual(
        new Set(bosses.map((a) => a.gameID)),
        new Set([202699, 201722, 204068, 204921, 207356, 209678, 213334]),
      );
      assert.ok(
        !actors.some((a) =>
          [4829, 4830, 4831, 4832, 4887, 6243, 12902, 12876].includes(a.gameID),
        ),
      );
      assert.match(referenceSpawnNotice(map, "sod"), /guide bosses/);
    } else {
      assert.equal(referenceCoverage(map, "sod").kind, "classic-baseline");
      assert.match(referenceSpawnNotice(map, "sod"), /Classic baseline/);
    }
  }
  assert.equal(referenceRaidActors(90, "sod", {}).length, 292);
  assert.equal(referenceCoverage(90, "sod").approximate, 292);
  assert.ok(
    referenceRaidActors(90, "sod", {}).every(
      (a) =>
        a.spawn?.referenceKind === "map-registered-reference" &&
        a.spawn.confidence === "approximate",
    ),
  );
  assert.equal(referenceRaidActors(531, "sod", {}).length, 164);
  assert.equal(referenceRaidActors(2856, "sod", {}).length, 662);
  assert.equal(referenceCoverage(2856, "sod").unplaced, 0);
  assert.equal(referenceCoverage(2856, "sod").approximate, 288);
  assert.equal(
    referenceRaidActors(2856, "sod", {}).filter(
      (a) => a.spawn?.confidence === "approximate",
    ).length,
    288,
  );
  const rooms = referenceRaidActors(2856, "sod", {}).filter(
    (a) => a.spawn?.referenceKind === "map-registered-reference",
  );
  assert.equal(rooms.length, 68);
  assert.ok(rooms.every((a) => a.spawn?.confidence === "approximate"));
  assert.ok(rooms.every((a) => a.spawn?.position[2] === null));
  assert.match(
    referenceSpawnNotice(2856, "sod"),
    /662 placements, 288 approximate/,
  );
  assert.doesNotMatch(referenceSpawnNotice(2856, "sod"), /not mapped/);
  assert.deepEqual(referenceRaidActors(90, "vanilla", {}), []);
  assert.deepEqual(referenceRaidActors(1, "sod", {}), []);
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
