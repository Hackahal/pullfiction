import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeedrunTimer } from "./SpeedrunTimer";
import { fixture } from "./speedrun-test-fixture";

test("Timer renders green-clock semantics, stage links, requirements, provenance and coverage", () => {
  const html = renderToStaticMarkup(
    createElement(SpeedrunTimer, { replay: fixture(), time: 10000, seek() {} }),
  );
  assert.match(html, /aria-label="Elapsed speedrun time"/);
  assert.match(html, /0:09.00/);
  assert.match(html, /Seek to Baron Aquanis/);
  assert.match(html, /Mob requirements/);
  assert.match(html, /2\/4/);
  assert.match(html, /provisional/);
  assert.match(html, /blackfathom-deeps-speedrun-rules/);
});
test("Empty, unknown and encounter-only states stay explicit", () => {
  const render = (replay: ReturnType<typeof fixture> | null) =>
    renderToStaticMarkup(
      createElement(SpeedrunTimer, { replay, time: 20000, seek() {} }),
    );
  assert.match(render(null), /Load a full raid replay/);
  assert.match(render(fixture(409, "vanilla")), /requirements unverified/);
  const replay = fixture();
  replay.fight.completeRaid = false;
  assert.match(render(replay), /Encounter preview/);
  assert.doesNotMatch(render(replay), /Mob requirements/);
});
