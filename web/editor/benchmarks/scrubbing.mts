import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { EditorController } from "../src/controller";
import { enrichCombat, normalizeReplay } from "../../planner/replay.mjs";
const fixture = process.argv[2];
if (!fixture)
  throw new Error(
    "Pass the absolute path to a representative replay JSON fixture",
  );
const raw = JSON.parse(readFileSync(fixture, "utf8"));
const replay = enrichCombat(normalizeReplay(raw));
function run(coalesced: boolean) {
  const replay = enrichCombat(normalizeReplay(raw));
  const c: any = new EditorController(
    { getItem: () => null, setItem: () => {} },
    { projectStore: null, clientFolders: null },
  );
  let publications = 0,
    frames = 0;
  let last = "";
  c.state = { ...c.getSnapshot(), replay, playing: false };
  c.engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    configure_replay_camera: () => {},
    set_replay_camera: () => {},
    focus_replay: () => {},
    set_replay_frame: (json: string) => {
      frames++;
      last = json;
    },
    replay_clock: () => {},
    replay_events: () => {},
  };
  c.subscribe(() => publications++);
  const times = [];
  for (let frame = 0; frame < 40; frame++) {
    const start = performance.now();
    for (let event = 0; event < 8; event++) {
      const t = replay.duration * (0.2 + ((frame * 8 + event) / 320) * 0.6);
      if (coalesced) c.scrub(t);
      else c.seek(t);
    }
    if (coalesced) c.flushScrub();
    times.push(performance.now() - start);
  }
  const time = c.getSnapshot().time;
  c.stop();
  times.sort((a, b) => a - b);
  return {
    medianMs: times[20],
    p95Ms: times[37],
    totalMs: times.reduce((a, b) => a + b, 0),
    publications,
    frames,
    time,
    finalFrameHash: createHash("sha256").update(last).digest("hex"),
  };
}
const direct = run(false),
  coalesced = run(true);
assert.equal(direct.finalFrameHash, coalesced.finalFrameHash);
assert.equal(direct.time, coalesced.time);
const result = {
  fixture,
  events: raw.events.length,
  actors: replay.actors.length,
  scenario:
    "40 displayed frames, 8 drag events per frame, 20%-80% replay, stub native engine, no React/GPU",
  direct,
  coalesced,
};
console.log(JSON.stringify(result, null, 2));
