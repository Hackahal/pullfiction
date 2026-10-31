import test from "node:test";
import assert from "node:assert/strict";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Actor, Cast } from "./types";
import {
  timelineCastHandlers,
  type TimelineHover,
} from "./timeline-cast-handlers";
import { castLabel } from "./timeline-model";
const actor = { key: "1:1", name: "Mage" } as Actor;
const cast = { spell: 10, name: "Fireball", start: 1000, end: 3000 } as Cast;
const event = (pointer: boolean) =>
  ({
    cancelBubble: false,
    evt: { clientX: 101, clientY: 202 },
    target: {
      getStage: () => ({
        getPointerPosition: () => (pointer ? { x: 20, y: 30 } : null),
      }),
    },
  }) as unknown as KonvaEventObject<MouseEvent>;

test("cast hover and click retain exact payload, propagation and pointer guard", () => {
  const calls: unknown[] = [],
    hovers: (TimelineHover | null)[] = [];
  const handlers = timelineCastHandlers(
    { inspectCast: (...args) => calls.push(args) },
    actor,
    cast,
    3,
    (h) => hovers.push(h),
  );
  const down = event(true);
  handlers.onMouseDown(down);
  assert.equal(down.cancelBubble, true);
  handlers.onMouseEnter(event(false));
  assert.equal(hovers.length, 0);
  handlers.onMouseEnter(event(true));
  assert.deepEqual(hovers.at(-1), {
    x: 101,
    y: 202,
    text: castLabel(cast),
    actor,
    cast,
    spell: 10,
  });
  handlers.onMouseLeave();
  assert.equal(hovers.at(-1), null);
  const click = event(true);
  handlers.onClick(click);
  assert.equal(click.cancelBubble, true);
  assert.deepEqual(calls, [[actor.key, 3]]);
  assert.equal(hovers.at(-1), null);
});

test("replacement cast context uses the new controller, actor, cast, index and hover callback", () => {
  const calls: unknown[] = [],
    oldHovers: unknown[] = [],
    newHovers: unknown[] = [];
  const old = timelineCastHandlers(
    { inspectCast: (...a) => calls.push(["old", ...a]) },
    actor,
    cast,
    3,
    (h) => oldHovers.push(h),
  );
  const nextActor = { ...actor, key: "2:1" },
    nextCast = { ...cast, name: "Frostbolt", spell: 20 };
  const next = timelineCastHandlers(
    { inspectCast: (...a) => calls.push(["next", ...a]) },
    nextActor,
    nextCast,
    4,
    (h) => newHovers.push(h),
  );
  assert.equal(next.onMouseDown, old.onMouseDown);
  next.onMouseEnter(event(true));
  next.onClick(event(true));
  assert.deepEqual(newHovers, [
    {
      x: 101,
      y: 202,
      text: castLabel(nextCast),
      actor: nextActor,
      cast: nextCast,
      spell: 20,
    },
    null,
  ]);
  assert.deepEqual(calls, [["next", "2:1", 4]]);
  assert.deepEqual(oldHovers, []);
});
