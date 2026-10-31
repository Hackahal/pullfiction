import test from "node:test";
import assert from "node:assert/strict";
import { emptyPlan, newStep, newAnnotation } from "./domain";
import { activePages, selectedPeriod } from "./layer-model";
test("Timed pages on independent named rows compose at the same playhead", () => {
  const p = emptyPlan();
  p.layers.push({ id: "cooldowns", name: "Cooldowns", hidden: false });
  p.steps = [
    {
      ...newStep("Positions"),
      layerId: p.layers[0].id,
      start: 1000,
      end: 5000,
    },
    { ...newStep("Healing"), layerId: "cooldowns", start: 3000, end: 8000 },
  ];
  assert.deepEqual(
    activePages(p, 4000, p.steps[0].id, true).map((s) => s.name),
    ["Positions", "Healing"],
  );
  assert.deepEqual(
    activePages(p, 5000, p.steps[0].id, true).map((s) => s.name),
    ["Healing"],
  );
  assert.equal(activePages(p, 8000, p.steps[0].id, true).length, 0);
  p.layers[1].hidden = true;
  assert.equal(activePages(p, 6000, p.steps[0].id, true).length, 0);
});
test("Untimed content stays visible with a log, while no-log pages follow explicit step selection", () => {
  const p = emptyPlan();
  const first = p.steps[0];
  first.annotations.push(newAnnotation("marker", [1, 2, 3]));
  p.steps.push({
    ...newStep("Second page"),
    layerId: p.layers[0].id,
    start: 3000,
    end: 8000,
  });
  assert.equal(activePages(p, 2000, first.id, true).length, 1);
  assert.equal(activePages(p, 4000, first.id, true).length, 2);
  assert.deepEqual(
    activePages(p, 4000, first.id, false).map((s) => s.id),
    [first.id],
  );
  assert.deepEqual(
    activePages(p, 0, p.steps[1].id, false).map((s) => s.id),
    [p.steps[1].id],
  );
});
test("Period selection accepts reverse drags, clamps run bounds and rejects clicks", () => {
  assert.deepEqual(selectedPeriod(8000, 2000, 10000), {
    start: 2000,
    end: 8000,
  });
  assert.deepEqual(selectedPeriod(-500, 20000, 10000), {
    start: 0,
    end: 10000,
  });
  assert.equal(selectedPeriod(1000, 1050, 10000), null);
});
