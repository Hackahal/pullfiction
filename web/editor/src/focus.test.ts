import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Focus } from "./Focus";
import { GearIcon } from "./FocusWidgets";
import { EditorController } from "./controller";
import { clampFocus, itemIcon, itemIconName } from "./focus-model";
import type { Actor, Snapshot } from "./types";
const actor = {
  key: "1:1",
  id: 1,
  name: "Mage",
  type: "Player",
  class: "Mage",
  gear: [
    {
      id: 19375,
      slot: 0,
      name: "Recorded circlet",
      icon: "INV_Helmet_52.jpg",
      quality: 4,
    },
  ],
  health: [[0, { current: 800, max: 1000, percent: 0.8 }]],
  power: [[0, { current: 300, max: 500, type: 0 }]],
  casts: [],
  auras: [
    [0, { spell: 1459, name: "Intellect", stack: 1, debuff: false }],
    [0, { spell: 19716, name: "Curse", stack: 2, debuff: true }],
  ],
  initialAuras: [],
  deaths: [],
} as unknown as Actor;
function markup(a = actor, t = 100) {
  const c = new EditorController(),
    state = { ...c.getSnapshot(), time: t };
  return renderToString(
    createElement(Focus, {
      state: state as Snapshot,
      actor: a,
      controller: c,
      close: () => {},
    }),
  );
}
test("Compact Focus keeps unit bars and auras above them, with gear behind Inspect", () => {
  const html = markup();
  assert.match(html, /aria-label="Focus"/);
  assert.match(html, /aria-label="Health"[^>]*aria-valuenow="800"/);
  assert.match(html, /aria-label="Mana"[^>]*aria-valuenow="300"/);
  assert.match(html, /Debuffs/);
  assert.match(html, /Buffs/);
  assert.match(html, /aria-label="Intellect"/);
  assert.match(html, /aria-label="Curse"/);
  assert.doesNotMatch(
    html,
    /classic\/item=19375|focus-gear|focus-loadout-column/,
  );
  assert.match(html, /Inspect equipment and talents/);
  assert.ok(
    html.indexOf('aria-label="Buffs"') < html.indexOf('aria-label="Health"'),
  );
  assert.doesNotMatch(
    html,
    /Appearance|Select actor|<select|Body|<h3>Actors|cast-list/,
  );
});
test("Focus preserves missing power as unknown and displays death at the current playhead", () => {
  const html = markup({ ...actor, power: [], deaths: [[50, true]] });
  assert.match(html, /aria-label="Health"[^>]*aria-valuenow="0"/);
  assert.doesNotMatch(html, /aria-label="Mana"/);
  assert.match(html, /Dead/);
});
test("Focus position stays inside gameplay across resize and invalid persisted coordinates", () => {
  assert.deepEqual(clampFocus(900, 700, 800, 600, 280, 350), {
    x: 520,
    y: 250,
  });
  assert.deepEqual(clampFocus(-10, -10, 200, 100, 280, 350), { x: 0, y: 0 });
  assert.deepEqual(clampFocus(NaN, Infinity, 800, 600, 280, 350), {
    x: 0,
    y: 0,
  });
});
test("Wowhead item icon source accepts only icon names", () => {
  assert.equal(
    itemIcon("inv_helmet_52"),
    "https://wow.zamimg.com/images/wow/icons/medium/inv_helmet_52.jpg",
  );
  assert.equal(itemIcon("INV_Helmet_52.jpg"), itemIcon("inv_helmet_52"));
  assert.equal(itemIconName("inv_helmet_52.blp"), "inv_helmet_52");
  assert.equal(itemIconName("inv_helmet_52.png"), "inv_helmet_52");
  assert.equal(itemIcon("inv_helmet_52.jpg.exe"), null);
  assert.equal(itemIcon("https://bad.example/x"), null);
  assert.equal(itemIcon("../foo"), null);
  assert.equal(itemIcon(), null);
});

test("Cap-only power displays unknown current with a real maximum and recent recorded gains", () => {
  const html = markup({
    ...actor,
    power: [[0, { current: null, max: 7982, type: 0 }]],
    resourceChanges: [
      [
        50,
        {
          type: 0,
          gain: 325,
          waste: 25,
          max: 7982,
          spell: 20272,
          name: "Illumination",
        },
      ],
    ],
  });
  assert.match(html, /\? \/ 7,982/);
  assert.match(html.replace(/<!--.*?-->/g, ""), /Current mana not recorded/);
  assert.match(html, /Illumination/);
  assert.match(html.replace(/<!--.*?-->/g, ""), /\+325/);
  assert.match(html, /25 wasted/);
  assert.doesNotMatch(html, /aria-label="Mana"[^>]*aria-valuenow="0"/);
});

test("Focus target follows recorded actions, ignores periodic/AoE side targets and rewinds without future leakage", async () => {
  const { focusTargetAt } = await import("./focus-model");
  const boss = {
      ...actor,
      key: "2:1",
      id: 2,
      name: "Boss",
      type: "NPC",
      class: "",
      instance: 1,
    },
    add = { ...boss, key: "2:2", instance: 2 };
  const r = {
    actors: [actor, boss, add],
    duration: 10000,
    fight: { startTime: 1000 },
    raw: {
      events: [
        { timestamp: 2000, type: "cast", sourceID: 1, targetID: 2 },
        {
          timestamp: 3000,
          type: "damage",
          sourceID: 1,
          targetID: 2,
          targetInstance: 2,
          tick: true,
        },
        {
          timestamp: 3500,
          type: "damage",
          sourceID: 1,
          targetID: 2,
          targetInstance: 2,
          isAoE: true,
        },
        {
          timestamp: 4000,
          type: "cast",
          sourceID: 1,
          targetID: 2,
          targetInstance: 2,
        },
      ],
    },
  } as unknown as import("./types").Replay;
  assert.equal(focusTargetAt(r, actor, 999), null);
  assert.equal(focusTargetAt(r, actor, 1000)?.target.key, "2:1");
  assert.equal(focusTargetAt(r, actor, 2500)?.target.key, "2:1");
  assert.equal(focusTargetAt(r, actor, 3000)?.target.key, "2:2");
  assert.equal(focusTargetAt(r, actor, 1000)?.target.key, "2:1");
});
test("Focus renders target name, health, evidence age and a selection action", () => {
  const boss = {
    ...actor,
    key: "2:1",
    id: 2,
    name: "Lucifron",
    type: "NPC",
    class: "",
    instance: 1,
    health: [[0, { current: 500, max: 1000, percent: 0.5 }]],
  } as Actor;
  const c = new EditorController(),
    state = {
      ...c.getSnapshot(),
      time: 2000,
      replay: {
        actors: [actor, boss],
        abilities: new Map(),
        duration: 10000,
        fight: { startTime: 1000 },
        raw: {
          events: [{ timestamp: 2000, type: "cast", sourceID: 1, targetID: 2 }],
        },
      },
    } as unknown as Snapshot;
  const html = renderToString(
    createElement(Focus, { state, actor, controller: c, close: () => {} }),
  );
  assert.match(html, /Focus target: Lucifron/);
  assert.match(html, /aria-label="Target health"[^>]*aria-valuenow="500"/);
  assert.match(html.replace(/<!--.*?-->/g, ""), /Recorded cast · 1.0s ago/);
  c.stop();
});

test("Recorded gear icons and quality render before any Wowhead lookup completes", () => {
  // Server rendering never runs effects or metadata requests.
  const gear = renderToString(createElement(GearIcon, { gear: actor.gear[0] }));
  assert.match(gear, /src="\/game-ui\/icons\/inv_helmet_52.png"/);
  assert.match(gear, /border-color:#a335ee/);
  assert.match(gear, /aria-label="Recorded circlet"/);
  assert.doesNotMatch(gear, /inv_misc_questionmark/);
});
