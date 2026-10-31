import test from "node:test";
import assert from "node:assert/strict";
import {
  drawsOnRelease,
  pointReleaseActor,
  sceneGesture,
} from "./interaction-policy";
import type { Tool } from "./types";
test("Right-drag camera and middle-drag pan keep priority over every tool, handle and modifier", () => {
  for (const tool of [
    "explore",
    "move",
    "marker",
    "circle",
    "cone",
    "arrow",
    "route",
    "polygon",
    "label",
    "drawing",
  ] as Tool[])
    for (const modifier of [false, true])
      for (const target of [false, true]) {
        assert.equal(sceneGesture(2, modifier, tool, target), "camera");
        assert.equal(sceneGesture(1, modifier, tool, target), "pan");
      }
});
test("A chosen drawing tool draws without a modifier; selection modifier temporarily selects", () => {
  for (const tool of [
    "marker",
    "circle",
    "cone",
    "arrow",
    "route",
    "polygon",
    "label",
    "drawing",
  ] as Tool[]) {
    assert.equal(sceneGesture(0, false, tool, false), "draw");
    assert.equal(sceneGesture(0, true, tool, false), "select");
    assert.equal(sceneGesture(0, false, tool, true), "transform");
    assert.equal(sceneGesture(0, true, tool, true), "select");
  }
});
test("Select tool works without a modifier and extra mouse buttons pass through", () => {
  assert.equal(sceneGesture(0, false, "explore", false), "select");
  for (const button of [3, 4])
    assert.equal(sceneGesture(button, true, "circle", true), "native");
});

test("Tiny pointer movement remains a click; sized shapes and transforms wait for a real drag", async () => {
  const { startsDrag } = await import("./interaction-policy");
  assert.equal(startsDrag([10, 10], [11, 12]), false);
  assert.equal(startsDrag([10, 10], [14, 10]), true);
  assert.equal(startsDrag([10, 10], [10, 16]), true);
});

test("Free-camera right-drag keeps native look regardless of where assets are loaded", async () => {
  const { usesNativeMouseLook } = await import("./interaction-policy");
  assert.equal(usesNativeMouseLook("camera", "free", true), true);
  assert.equal(usesNativeMouseLook("camera", "free", false), true);
  assert.equal(usesNativeMouseLook("camera", "orbit", true), false);
  assert.equal(usesNativeMouseLook("camera", "orbit", false), false);
  assert.equal(usesNativeMouseLook("pan", "free", false), false);
});

test("Marker clicks place without movement while drag-only tools still require movement", () => {
  assert.equal(drawsOnRelease("marker", false), true);
  assert.equal(drawsOnRelease("marker", true), true);
  for (const tool of [
    "circle",
    "cone",
    "arrow",
    "drawing",
    "label",
  ] as Tool[]) {
    assert.equal(drawsOnRelease(tool, false), false);
    assert.equal(drawsOnRelease(tool, true), true);
  }
});

test("Dragging a point marking off an actor discards the pointer-down attachment", () => {
  assert.equal(
    pointReleaseActor("hovered-actor", null, false),
    "hovered-actor",
  );
  assert.equal(pointReleaseActor("hovered-actor", null, true), null);
  assert.equal(pointReleaseActor(null, null, false), null);
  assert.equal(pointReleaseActor(null, null, true), null);
});

test("Explicitly selected actors remain the point marking origin after movement", () => {
  assert.equal(
    pointReleaseActor("selected-actor", "selected-actor", false),
    "selected-actor",
  );
  assert.equal(
    pointReleaseActor("selected-actor", "selected-actor", true),
    "selected-actor",
  );
  assert.equal(
    pointReleaseActor("hovered-actor", "selected-actor", true),
    "selected-actor",
  );
});
