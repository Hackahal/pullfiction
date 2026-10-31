import test from "node:test";
import assert from "node:assert/strict";
import { selectionMode, inSelectionBox } from "./selection-model";
import { annotationGeometry } from "./annotation-model";
import { newAnnotation } from "./domain";
test("Selection modifiers match across platforms and Ctrl/Cmd takes precedence", () => {
  assert.equal(
    selectionMode({ ctrlKey: false, metaKey: false, shiftKey: false }),
    "replace",
  );
  assert.equal(
    selectionMode({ ctrlKey: false, metaKey: false, shiftKey: true }),
    "add",
  );
  assert.equal(
    selectionMode({ ctrlKey: true, metaKey: false, shiftKey: true }),
    "toggle",
  );
  assert.equal(
    selectionMode({ ctrlKey: false, metaKey: true, shiftKey: false }),
    "toggle",
  );
});
test("Marquee selection detects a crossing segment with both endpoints outside and supports reverse dragging", () => {
  const line = annotationGeometry({
    ...newAnnotation("route", [-10, 5, 0]),
    points: [
      [-10, 5, 0],
      [20, 5, 0],
    ],
  });
  assert.equal(
    inSelectionBox(line, [0, 0], [10, 10], (p) => p),
    true,
  );
  assert.equal(
    inSelectionBox(line, [10, 10], [0, 0], (p) => p),
    true,
  );
  assert.equal(
    inSelectionBox(line, [0, 20], [10, 30], (p) => p),
    false,
  );
  const icon = annotationGeometry(newAnnotation("marker", [5, 5, 0]));
  assert.equal(
    inSelectionBox(icon, [0, 0], [10, 10], (p) => p),
    true,
  );
});
