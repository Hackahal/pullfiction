import test from "node:test";
import assert from "node:assert/strict";
import {
  cameraEye,
  validateBatch,
  labError,
  smokeCases,
  resolveStage,
} from "./runner";
test("isolated fixtures translate together without mutating authored coordinates", () => {
  const source = smokeCases()[2],
    before = structuredClone(source);
  source.mapId = null;
  const staged = resolveStage(source, { mapId: 409, origin: [10, 20, 30] });
  assert.equal(staged.mapId, 409);
  assert.deepEqual(
    staged.camera.target,
    source.camera.target.map((v, i) => v + [10, 20, 30][i]),
  );
  assert.deepEqual(
    staged.actors[0].position,
    source.actors[0].position.map((v, i) => v + [10, 20, 30][i]),
  );
  assert.deepEqual(source.actors, before.actors);
  const world = smokeCases()[3];
  assert.deepEqual(resolveStage(world), world);
});
import { EditorController } from "../controller";
test("fixture validation bounds batches and rejects duplicates before native calls", () => {
  const cases = smokeCases();
  assert.equal(validateBatch(cases).length, 4);
  assert.throws(() => validateBatch([]));
  assert.throws(() => validateBatch([cases[0], cases[0]]), /Duplicate/);
  assert.throws(() =>
    validateBatch([
      { ...cases[0], camera: { ...cases[0].camera, distance: NaN } },
    ]),
  );
});
test("camera places a known diagnostic viewpoint in native world units", () => {
  const c = smokeCases()[0];
  c.camera = { target: [10, 20, 30], yaw: 0, pitch: 0, distance: 5 };
  assert.deepEqual(cameraEye(c), [15, 20, 30]);
});
test("unsupported and unavailable assets remain distinct from renderer failures", () => {
  const e = new Error("capability");
  e.name = "ClientUnsupportedError";
  assert.equal(labError(e), "unsupported");
  e.name = "NotFoundError";
  assert.equal(labError(e), "unavailable");
  e.name = "Error";
  assert.equal(labError(e), "failed");
});
test("renderer workbench boot does not initialize project or WCL services", async () => {
  let touched = false;
  const store = {
    list: async () => {
      touched = true;
      throw Error("must not touch projects");
    },
  };
  const c = new EditorController(undefined, {
    rendererLab: true,
    browserAssets: true,
    projectStore: store as any,
    clientCache: null,
    clientFolders: null,
  });
  await c.boot();
  assert.equal(touched, false);
  assert.equal(c.getSnapshot().wclConnected, false);
  assert.equal(c.getSnapshot().projects.length, 0);
  assert.equal(c.rendererLabResources().engine, null);
  c.stop();
  const normal = new EditorController();
  assert.throws(() => normal.rendererLabResources(), /not enabled/);
  normal.stop();
});
