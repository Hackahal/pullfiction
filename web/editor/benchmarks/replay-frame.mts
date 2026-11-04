import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { EditorController } from "../src/controller";
import { enrichCombat, normalizeReplay } from "../src/domain";
import type { Engine, RawReplay, Replay, Snapshot } from "../src/types";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    trials: { type: "string", default: "5" },
    "expect-packets": { type: "string" },
  },
});
const [fixture] = positionals;
const trials = Number(values.trials);
if (
  positionals.length !== 1 ||
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 25
)
  throw new Error(
    "Usage: npm run bench:frame -- <replay.json> [--trials 1–25] [--expect-packets SHA256]",
  );

const input = readFileSync(fixture);
const raw = JSON.parse(input.toString("utf8")) as RawReplay;
if (raw.stream)
  throw new Error("Use a whole-file replay without stream state.");

const replay = enrichCombat(normalizeReplay(raw, {}), {});
// Keep recorded slots and item IDs, using deterministic display placeholders.
// Real client files, geometry, rendering and the browser are outside this probe.
for (const actor of replay.actors)
  for (const gear of actor.gear) gear.model = { display: gear.id };

const windows = [0.2, 0.5, 0.8].map((fraction) => replay.duration * fraction);
const playback = windows.flatMap((start) =>
  Array.from({ length: 40 }, (_, i) =>
    Math.min(replay.duration, start + (i * 1000) / 60),
  ),
);
const seeks = Array.from(
  { length: 20 },
  (_, i) => (replay.duration * ((i * 73 + 11) % 101)) / 100,
);
const times = [...playback, ...seeks];

function summarize(elapsed: number[]) {
  elapsed.sort((a, b) => a - b);
  const percentile = (p: number) => elapsed[Math.ceil(p * elapsed.length) - 1];
  return {
    totalMs: elapsed.reduce((a, b) => a + b, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs: elapsed[elapsed.length - 1],
  };
}

function run(replay: Replay, checkPackets = false) {
  const controller = new EditorController(undefined, {
    projectStore: null,
    clientCache: null,
    clientFolders: null,
  });
  // Set the fixture clock directly so setup, user input and RAF never enter timings.
  const harness = controller as unknown as {
    state: Snapshot;
    engine: Partial<Engine>;
    clockTime: number;
    resetEvents: boolean;
  };
  const hash = checkPackets ? createHash("sha256") : undefined;
  let packets = 0,
    seeking = false;
  harness.state = { ...controller.getSnapshot(), replay, playing: true };
  harness.engine = {
    set_annotations: () => {},
    focus_replay: () => {},
    replay_events: (_, reset) => {
      if (seeking && !reset) throw new Error("A seek replayed skipped events");
    },
    set_replay_frame_delta: (json) => {
      packets++;
      hash?.update(json);
    },
  };

  const elapsed: number[] = [];
  try {
    for (let i = 0; i < playback.length; i++) {
      harness.clockTime = playback[i];
      // The separate playback windows must not play every skipped spell event.
      if (i % 40 === 0) harness.resetEvents = true;
      const start = performance.now();
      controller.render();
      elapsed.push(performance.now() - start);
    }
    seeking = true;
    for (const time of seeks) {
      const start = performance.now();
      controller.seek(time);
      elapsed.push(performance.now() - start);
    }
  } finally {
    controller.stop();
  }
  if (packets !== times.length)
    throw new Error(
      `Expected ${times.length} frame packets, received ${packets}`,
    );

  return {
    playback: summarize(elapsed.slice(0, playback.length)),
    seeks: summarize(elapsed.slice(playback.length)),
    packetsSha256: hash?.digest("hex"),
  };
}

// Untimed parity run also warms replay indexes. Hashing stays out of trials.
const { packetsSha256 } = run(replay, true);
if (values["expect-packets"] && values["expect-packets"] !== packetsSha256)
  throw new Error(`Frame packet checksum changed: ${packetsSha256}`);

const samples = Array.from({ length: trials }, () => run(replay));
function median(phase: "playback" | "seeks") {
  const keys = ["totalMs", "p50Ms", "p95Ms", "p99Ms", "worstMs"] as const;
  return Object.fromEntries(
    keys.map((key) => {
      const ordered = samples
        .map((sample) => sample[phase][key])
        .sort((a, b) => a - b);
      const mid = Math.floor(ordered.length / 2);
      return [
        key,
        ordered.length % 2
          ? ordered[mid]
          : (ordered[mid - 1] + ordered[mid]) / 2,
      ];
    }),
  );
}
console.log(
  JSON.stringify(
    {
      workload: "Warmed editor frame preparation with stub native transport",
      node: process.version,
      fixtureSha256: createHash("sha256").update(input).digest("hex"),
      events: raw.events.length,
      actors: replay.actors.length,
      playbackWindowStartsMs: windows,
      playbackFrames: playback.length,
      seekFrames: seeks.length,
      packetsSha256,
      median: { playback: median("playback"), seeks: median("seeks") },
      trials: samples,
    },
    null,
    2,
  ),
);
