import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EditorController } from "./controller";
import { BrowserNameplates } from "./BrowserNameplates";
import { actorNameplateEnabled, nameplateShortcut } from "./nameplate-model";
import type { Engine, RawReplay, NativeFrame } from "./types";

test("V toggles enemy plates and Shift+V toggles friendly plates without stealing modified shortcuts", () => {
  const event = {
    key: "v",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  assert.equal(nameplateShortcut(event), "enemyNameplates");
  assert.equal(
    nameplateShortcut({ ...event, key: "V", shiftKey: true }),
    "friendlyNameplates",
  );
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    assert.equal(nameplateShortcut({ ...event, [modifier]: true }), null);
  }
  assert.equal(nameplateShortcut({ ...event, key: "f" }), null);
});

test("Trash and boss preferences independently reach native frames and browser plates", () => {
  const c = new EditorController(undefined, { browserAssets: true });
  const raw: RawReplay = {
    report: { code: "fixture", title: "Nameplates" },
    fight: {
      id: 1,
      name: "Raid",
      gameZone: { name: "Molten Core" },
      startTime: 0,
      endTime: 1000,
      friendlyPlayers: [1],
    },
    actors: [
      { id: 1, name: "Friendly", type: "Player", subType: "Mage" },
      { id: 2, name: "Boss", type: "NPC", subType: "Boss" },
      { id: 3, name: "Trash", type: "NPC" },
    ],
    events: [1, 2, 3].map((id) => ({
      timestamp: 0,
      type: "damage",
      sourceID: id,
      targetID: 1,
      resourceActor: 1,
      x: id * 100,
      y: 200,
      hitPoints: 50,
      maxHitPoints: 100,
      amount: 1,
    })),
  };
  c.installReplay(raw);
  let frame: NativeFrame[] = [];
  c.attachEngine({
    focus_replay() {},
    set_annotations() {},
    set_replay_nameplate_filters() {},
    set_replay_raid_frames() {},
    set_replay_frame(json: string) {
      frame = JSON.parse(json);
    },
    replay_events() {},
  } as unknown as Engine);
  c.receive(
    "plates",
    JSON.stringify(
      c.getSnapshot().replay!.actors.map((a) => ({
        key: a.key,
        name: a.name,
        x: 100,
        y: 100,
        class: 1,
        friendly: a.type === "Player",
        health: 50,
        maxHealth: 100,
      })),
    ),
  );
  const markup = () =>
    renderToString(
      createElement(BrowserNameplates, {
        state: c.getSnapshot(),
        controller: c,
      }),
    );
  c.setOption("trashNameplates", false);
  assert.match(markup(), /Select Boss/);
  assert.doesNotMatch(markup(), /Select Trash/);
  assert.equal(frame.find((a) => a.name === "Boss")?.nameplate, true);
  assert.equal(frame.find((a) => a.name === "Trash")?.nameplate, false);
  c.setOption("bossNameplates", false);
  c.setOption("trashNameplates", true);
  assert.doesNotMatch(markup(), /Select Boss/);
  assert.match(markup(), /Select Trash/);
  assert.equal(frame.find((a) => a.name === "Boss")?.nameplate, false);
  assert.equal(frame.find((a) => a.name === "Trash")?.nameplate, true);
  c.setOption("friendlyNameplates", false);
  assert.match(markup(), /Select Friendly/);
  assert.doesNotMatch(markup(), /Friendly health/);
  c.setOption("friendlyNameplates", true);
  assert.match(markup(), /Friendly health/);
  c.setOption("enemyNameplates", false);
  assert.doesNotMatch(markup(), /Select Boss|Select Trash/);
  c.setOption("enemyNameplates", true);
  assert.match(markup(), /Select Trash/);
  assert.doesNotMatch(markup(), /Select Boss/);
  assert.equal(
    actorNameplateEnabled(
      { class: "NPC", icon: "Boss" },
      c.getSnapshot().options,
    ),
    false,
  );
  c.stop();
});
