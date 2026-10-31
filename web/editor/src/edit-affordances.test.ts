import test from "node:test";
import assert from "node:assert/strict";
import { editControls, handleCursor } from "./edit-affordances";
import { newAnnotation } from "./domain";
test("Selected circle exposes a move handle and eight visible radius grips", () => {
  const edit = newAnnotation("circle", [10, 20, 3], { size: 20 }),
    c = editControls(edit);
  assert.equal(c.handles.length, 9);
  assert.equal(c.handleKinds[0], "move");
  for (let i = 1; i < c.handles.length; i++) {
    assert.equal(c.handleKinds[i], "resize");
    assert.ok(
      Math.abs(Math.hypot(c.handles[i][0] - 10, c.handles[i][1] - 20) - 20) <
        1e-6,
    );
  }
  assert.equal(editControls({ ...edit, locked: true }).handles.length, 0);
  assert.ok(
    editControls({ ...edit, actor: "healer" }).handleKinds.every(
      (k) => k === "resize",
    ),
  );
});
test("Directional edits expose rotation and size handles with distinct cursors", () => {
  const edit = {
    ...newAnnotation("arrow", [0, 0, 0]),
    points: [
      [0, 0, 0],
      [10, 0, 0],
    ] as [number, number, number][],
  };
  const c = editControls(edit);
  assert.deepEqual(c.handleKinds, ["point", "point", "rotate", "scale"]);
  assert.equal(handleCursor("rotate"), "rotate");
  assert.equal(handleCursor("move"), "move");
  assert.equal(handleCursor("resize", 10, 0), "ew-resize");
  assert.equal(handleCursor("resize", 0, 10), "ns-resize");
  assert.equal(handleCursor("resize", 10, 10), "nwse-resize");
  assert.equal(handleCursor("resize", 10, -10), "nesw-resize");
});
