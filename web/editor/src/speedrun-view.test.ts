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

test("Naxx panel renders actual same-boss WR plus/minus despite a different wing order", async () => {
  const { patchwerkFirstReplay, praxisCategory, praxisWinner, praxisReport } =
    await import("./speedrun-wr-live-fixture");
  const { fetchSpeedWorldRecord, defaultSpeedSelection } =
    await import("./speedrun-world-record");
  const selection = defaultSpeedSelection(praxisCategory);
  const record = await fetchSpeedWorldRecord(
    async (q) =>
      q.includes("fightRankings")
        ? {
            worldData: {
              encounter: { fightRankings: { rankings: [praxisWinner] } },
            },
          }
        : praxisReport,
    "sod",
    533,
    praxisCategory,
    selection,
  );
  const html = renderToStaticMarkup(
    createElement(SpeedrunTimer, {
      replay: patchwerkFirstReplay(),
      time: 600000,
      seek() {},
      recordState: {
        record,
        category: praxisCategory,
        selection,
        loading: false,
        error: null,
        select() {},
        retry() {},
        refresh() {},
      } as any,
    }),
  );
  assert.match(html, /−22:04.5/);
  assert.match(html, /−21:26.5/);
  assert.match(html, /−21:17.9/);
  assert.match(html, /is-ahead/);
  assert.doesNotMatch(
    html,
    /Boss order differs|exact start\/end|split comparison is unavailable/,
  );
});
