import test from "node:test";
import assert from "node:assert/strict";
import { hitMapLabel, mapLabelLayout } from "./map-label-layout";
test("Map labels avoid actor tokens, earlier labels and viewport edges", () => {
  const layout = mapLabelLayout(400, 220);
  layout.block({ x: 140, y: 75, width: 90, height: 50 });
  const first = layout.place({ x: 150, y: 90, width: 80, height: 21 })!;
  assert.ok(
    first.y + first.height <= 75 ||
      first.y >= 125 ||
      first.x + first.width <= 140 ||
      first.x >= 230,
  );
  const second = layout.place(first)!;
  assert.notDeepEqual(first, second);
  const edge = layout.place({ x: -50, y: -40, width: 90, height: 21 })!;
  assert.ok(edge.x >= 6 && edge.y >= 6);
});
test("An authored text label remains visible when the scene is crowded", () => {
  const layout = mapLabelLayout(100, 100);
  layout.block({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(layout.place({ x: 20, y: 20, width: 70, height: 21 }), null);
  assert.ok(layout.place({ x: 20, y: 20, width: 70, height: 21 }, true));
});
test("Panning a mark offscreen does not pin its label to the viewport edge", () => {
  const layout = mapLabelLayout(400, 220);
  assert.equal(
    layout.place({ x: 850, y: 20, width: 80, height: 21 }, true, [900, 50]),
    null,
  );
  assert.equal(
    layout.place({ x: 10, y: -300, width: 80, height: 21 }, true, [50, -280]),
    null,
  );
  assert.ok(
    layout.place({ x: -10, y: 20, width: 80, height: 21 }, true, [30, 50]),
  );
});
test("Displaced label boxes remain selectable at their painted position", () => {
  const layout = mapLabelLayout(400, 220);
  layout.block({ x: 100, y: 70, width: 120, height: 60 });
  const box = layout.place(
    { x: 120, y: 90, width: 80, height: 21 },
    true,
    [160, 100],
  )!;
  assert.notEqual(box.y, 90);
  const labels = [{ ...box, id: "healer-range" }];
  assert.equal(hitMapLabel(labels, [box.x + 20, box.y + 10]), "healer-range");
  assert.equal(hitMapLabel(labels, [5, 5]), undefined);
});
