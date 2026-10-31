import test from "node:test";
import assert from "node:assert/strict";
import { newAnnotation, newStep, emptyPlan } from "./domain";
import {
  annotationGeometry,
  triangulate,
  stepAtTime,
  visibleMarks,
  markHit,
} from "./annotation-model";
import { mapActorToken } from "./map-model";
test("Circle and cone dimensions use yards and share exact world geometry with native rendering", () => {
  const circle = annotationGeometry(
    newAnnotation("circle", [10, 20, -100], { size: 12 }),
  );
  assert.equal(circle.paths[0].length, 49);
  assert.equal(circle.triangles.length, 138);
  for (const p of circle.fill) {
    assert.ok(Math.abs(Math.hypot(p[0] - 10, p[1] - 20) - 12) < 1e-8);
    assert.equal(p[2], -100);
  }
  const cone = annotationGeometry({
    ...newAnnotation("cone", [0, 0, 0], { size: 10 }),
    points: [
      [0, 0, 0],
      [10, 0, 0],
    ],
  });
  assert.ok(
    cone.fill
      .slice(1)
      .every((p) => Math.abs(Math.hypot(p[0], p[1]) - 10) < 1e-8),
  );
  assert.ok(Math.abs(cone.fill[1][1] + 5) < 1e-8);
  assert.ok(Math.abs(cone.fill.at(-1)![1] - 5) < 1e-8);
});
test("Concave area triangles preserve the polygon area instead of filling across the cutout", () => {
  const polygon: [number, number, number][] = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 1, 0],
    [1, 1, 0],
    [1, 4, 0],
    [0, 4, 0],
  ];
  const ts = triangulate(polygon);
  let area = 0;
  for (let i = 0; i < ts.length; i += 3) {
    const [a, b, c] = ts.slice(i, i + 3);
    area +=
      Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) /
      2;
  }
  assert.equal(area, 7);
  assert.equal(ts.length, 12);
});
test("Arrow heads terminate at the recorded endpoint and path picking avoids selecting an entire filled area", () => {
  const g = annotationGeometry({
    ...newAnnotation("arrow", [0, 0, 0]),
    points: [
      [0, 0, 0],
      [20, 0, 0],
    ],
  });
  assert.deepEqual(g.paths[1][1], [20, 0, 0]);
  assert.equal(
    markHit(g, [10, 3], (p) => [p[0], p[1]], 4),
    true,
  );
  assert.equal(
    markHit(g, [10, 20], (p) => [p[0], p[1]], 4),
    false,
  );
  const circle = annotationGeometry(
    newAnnotation("circle", [0, 0, 0], { size: 50 }),
  );
  assert.equal(
    markHit(circle, [0, 0], (p) => [p[0], p[1]]),
    false,
  );
});
test("Steps follow half-open replay intervals, preserve manual gaps and filter hidden markings", () => {
  const p = emptyPlan();
  p.steps[0].start = 0;
  p.steps[0].end = 1000;
  p.steps[0].annotations = [
    newAnnotation("marker", [0, 0, 0]),
    newAnnotation("marker", [1, 1, 1], { hidden: true }),
  ];
  const next = {
    ...newStep("Boss", "boss"),
    start: 2000,
    end: 3000,
    annotations: [newAnnotation("marker", [3, 4, 5])],
  };
  p.steps.push(next);
  assert.equal(stepAtTime(p.steps, 999)?.id, p.steps[0].id);
  assert.equal(stepAtTime(p.steps, 1000), undefined);
  assert.equal(stepAtTime(p.steps, 2000)?.id, next.id);
  assert.equal(visibleMarks(p, p.steps[0].id).length, 1);
  assert.equal(visibleMarks(p, p.steps[0].id, true).length, 2);
});
test("Map icons and health bar scale factors increase with zoom and remain bounded", () => {
  const actor = { type: "NPC", class: "NPC", icon: null };
  const normal = mapActorToken(actor, 1),
    near = mapActorToken(actor, 4),
    far = mapActorToken(actor, 0.01);
  assert.equal(near.radius, normal.radius * 2);
  assert.equal(far.radius, normal.radius * 0.75);
  assert.equal(mapActorToken(actor, 10000).radius, near.radius);
  assert.ok(mapActorToken({ ...actor, class: "Boss" }, 4).radius > near.radius);
  assert.equal(near.factor, 2);
});

test("Radial control handles follow the edited radius without changing stored anchors", () => {
  const mark = {
    ...newAnnotation("circle", [10, 20, 30], { size: 12 }),
    points: [
      [10, 20, 30],
      [11, 20, 30],
    ] as [number, number, number][],
  };
  const geometry = annotationGeometry(mark, true);
  assert.deepEqual(geometry.handles, [
    [10, 20, 30],
    [22, 20, 30],
  ]);
  assert.deepEqual(mark.points, [
    [10, 20, 30],
    [11, 20, 30],
  ]);
});
