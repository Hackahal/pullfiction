import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedProjectStore,
  newProject,
  parseProjectBackup,
  replaySource,
  validateProject,
} from "./project-store";
import { emptyPlan } from "./domain";
import type { RawReplay } from "./types";
const raw = {
  gameVersion: "sod",
  report: { code: "bZX7VqdwpcmyrGzN", title: "AQ40" },
  fight: { id: 1, name: "Skeram" },
  actors: [],
  events: [{ timestamp: 1, type: "cast" }],
} as unknown as RawReplay;

test("multiple plans on the same map persist independently across store instances", async () => {
  const factory = new IDBFactory();
  const first = new IndexedProjectStore(factory);
  const a = newProject({ ...emptyPlan(531, "sod"), name: "Safe route" });
  const b = newProject({ ...emptyPlan(531, "sod"), name: "Fast route" });
  await first.put(a);
  await first.put(b);
  const reopened = new IndexedProjectStore(factory);
  assert.equal((await reopened.list()).length, 2);
  assert.equal((await reopened.get(a.id))?.plan.name, "Safe route");
  assert.equal((await reopened.get(b.id))?.plan.name, "Fast route");
  await reopened.put({ ...a, deletedAt: Date.now() });
  assert.notEqual((await first.get(a.id))?.deletedAt, null);
  await reopened.put({ ...a, deletedAt: null });
  assert.equal((await first.get(a.id))?.deletedAt, null);
});
test("cached source snapshots are immutable and independently readable without network", async () => {
  const store = new IndexedProjectStore(new IDBFactory());
  const source = replaySource(raw, 531);
  await store.putReplay(source.cacheKey, raw);
  await store.putReplay(source.cacheKey, { ...raw, events: [] });
  assert.deepEqual(
    (await store.getReplay(source.cacheKey))?.events,
    raw.events,
  );
  const nextSource = replaySource(raw, 531);
  assert.notEqual(source.cacheKey, nextSource.cacheKey);
  assert.equal(await store.getReplay(nextSource.cacheKey), null);
});
test("project backup creates an independent plan and preserves its source and edits", () => {
  const source = replaySource(raw, 531);
  const original = newProject(
    { ...emptyPlan(531, "sod"), name: "Boss plan" },
    source,
  );
  const text = JSON.stringify({
    format: "pullfiction.project",
    version: 1,
    project: original,
    replay: raw,
  });
  const imported = parseProjectBackup(text);
  assert.notEqual(imported.project.id, original.id);
  assert.deepEqual(imported.project.plan, original.plan);
  assert.deepEqual(imported.replay, raw);
  assert.equal(imported.project.source?.code, source.code);
  const wrong = JSON.parse(text);
  wrong.replay.report.code = "DyN7vF94QR8aj1Lc";
  assert.throws(() => parseProjectBackup(JSON.stringify(wrong)), /mismatched/);
  const legacy = parseProjectBackup(JSON.stringify(emptyPlan(409, "vanilla")));
  assert.equal(legacy.project.plan.mapId, 409);
  assert.equal(legacy.replay, null);
});
test("cross-version sources and invalid local records cannot enter saved projects", async () => {
  const p = newProject(emptyPlan(409, "vanilla"));
  assert.throws(
    () => validateProject({ ...p, source: replaySource(raw, 409) }),
    /source/,
  );
  assert.throws(() => validateProject({ ...p, updatedAt: -1 }), /Invalid/);
  const store = new IndexedProjectStore(new IDBFactory());
  await assert.rejects(store.put({ ...p, time: NaN }), /Invalid/);
  assert.equal((await store.list()).length, 0);
});

test("a large source never produces a backup that the project importer cannot reopen", async () => {
  const { encodeProjectBackup } = await import("./project-store");
  const project = newProject(emptyPlan(531, "sod"), replaySource(raw, 531));
  const source = { ...raw, events: [{ extra: "x".repeat(10000) }] };
  const limit = new Blob([encodeProjectBackup(project, null).text]).size + 10;
  const encoded = encodeProjectBackup(project, source, limit);
  assert.equal(encoded.includesReplay, false);
  assert.deepEqual(parseProjectBackup(encoded.text).project.plan, project.plan);
  assert.equal(
    parseProjectBackup(encoded.text).project.source?.code,
    raw.report.code,
  );
});
