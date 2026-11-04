import test from "node:test";
import assert from "node:assert/strict";
import { ReplayFrameTransport } from "./replay-frame-transport";

test("an actor returning under the same source is sent as a complete row", () => {
  const encoder = new ReplayFrameTransport();
  let rows = new Map<string, Record<string, unknown>>();
  const packets: any[] = [];
  const publish = (json: string) => {
    const packet = JSON.parse(json);
    packets.push(packet);
    if (packet.reset) rows.clear();
    for (const row of packet.updates)
      rows.set(row.key, { ...rows.get(row.key), ...row });
    rows = new Map(packet.order.map((key: string) => [key, rows.get(key)!]));
  };
  const mage = { key: "a", name: "Mage", player: true };
  const boss = {
    key: "b",
    name: "Boss",
    position: [4, 5, 6],
    floor_hint: 6,
    trajectory: { content: "two", source: "source", component: "route" },
    gear: [{ slot: 1, display: 42 }],
    auras: [{ spell: 123, stacks: 2 }],
  };
  // Reuse the actor and all its fields; absence alone must discard its baseline.
  for (const frame of [[mage, boss], [mage], [mage, boss]]) {
    encoder.send("source", frame, publish);
    assert.deepEqual([...rows.values()], frame);
  }
  assert.deepEqual(packets[1].order, ["a"]);
  assert.deepEqual(packets[1].updates, []);
  assert.equal(packets[2].reset, false);
  assert.deepEqual(packets[2].updates, [boss]);
  encoder.send("source", [mage, boss], publish);
  assert.deepEqual(packets[3].updates, []);
});

test("field deltas reconstruct complete frames across changes, removals, reordering and source replacement", () => {
  const encoder = new ReplayFrameTransport();
  let rows = new Map<string, Record<string, unknown>>();
  let last: any;
  const publish = (json: string) => {
    last = JSON.parse(json);
    if (last.reset) rows.clear();
    for (const row of last.updates)
      rows.set(row.key, { ...rows.get(row.key), ...row });
    rows = new Map(last.order.map((key: string) => [key, rows.get(key)!]));
  };
  const frames: ({ key: string } & Record<string, unknown>)[][] = [
    [
      {
        key: "a",
        name: "Mage",
        position: [1, 2, 3],
        trajectory: { content: "one" },
      },
      { key: "b", name: "Boss", position: null },
    ],
    [
      { key: "b", name: "Boss", position: [4, 5, 6] },
      { key: "a", name: "Mage", position: [2, 2, 3], trajectory: null },
    ],
    [{ key: "a", name: "Mage", position: null, trajectory: null }],
  ];
  for (const frame of frames) {
    encoder.send("source", frame, publish);
    assert.deepEqual([...rows.values()], frame);
  }
  encoder.send("source", frames[2], publish);
  assert.deepEqual(last.updates, []);
  encoder.send("replacement", frames[2], publish);
  assert.equal(last.reset, true);
  assert.equal(last.updates.length, 1);
});

test("failed sends do not advance the baseline; omitted optional fields clear old native values", () => {
  const encoder = new ReplayFrameTransport();
  const sent: any[] = [];
  const publish = (json: string) => sent.push(JSON.parse(json));
  encoder.send(
    "source",
    [{ key: "a", trajectory: { content: "one" }, position: [1, 2, 3] }],
    publish,
  );
  assert.throws(() =>
    encoder.send("source", [{ key: "a", position: [2, 2, 3] }], () => {
      throw new Error("failed");
    }),
  );
  encoder.send("source", [{ key: "a", position: [2, 2, 3] }], publish);
  assert.deepEqual(sent[1].updates, [
    { key: "a", trajectory: null, position: [2, 2, 3] },
  ]);
  encoder.reset();
  encoder.send("source", [{ key: "a", position: null }], publish);
  assert.equal(sent[2].reset, true);
});

test("scalar reuse still detects mutations inside reused objects and arrays", () => {
  const encoder = new ReplayFrameTransport();
  const actor = {
    key: "mage",
    name: "Mage",
    position: [1, 2, 3],
    gear: [{ display: 42 }],
    health: 100,
  };
  const packets: any[] = [];
  const publish = (json: string) => packets.push(JSON.parse(json));
  encoder.send("source", [actor], publish);
  actor.position[0] = 4;
  actor.gear[0].display = 99;
  actor.health = 80;
  encoder.send("source", [actor], publish);
  assert.deepEqual(packets[1].updates, [
    { key: "mage", position: [4, 2, 3], gear: [{ display: 99 }], health: 80 },
  ]);
  encoder.send("source", [actor], publish);
  assert.deepEqual(packets[2].updates, []);
});

test("metadata generations reuse object encodings and recheck edits at the next generation", () => {
  const encoder = new ReplayFrameTransport();
  let encodes = 0;
  const gear = {
    display: 42,
    toJSON() {
      encodes++;
      return { display: this.display };
    },
  };
  const packets: any[] = [];
  const publish = (json: string) => packets.push(JSON.parse(json));
  const first = {};
  encoder.send(
    "source",
    [{ key: "a", gear, position: [1, 2, 3] }],
    publish,
    first,
  );
  encoder.send(
    "source",
    [{ key: "a", gear, position: [2, 2, 3] }],
    publish,
    first,
  );
  assert.equal(encodes, 1);
  assert.deepEqual(packets[1].updates, [{ key: "a", position: [2, 2, 3] }]);
  gear.display = 99;
  encoder.send("source", [{ key: "a", gear }], publish, {});
  assert.equal(encodes, 2);
  assert.deepEqual(packets[2].updates, [
    { key: "a", gear: { display: 99 }, position: null },
  ]);
  encoder.reset();
  encoder.send("source", [{ key: "a", gear }], publish, first);
  assert.equal(encodes, 3);
});

test("failed publication cannot commit a metadata generation", () => {
  const encoder = new ReplayFrameTransport();
  const gear = [{ display: 42 }];
  const publish = () => {};
  encoder.send("source", [{ key: "a", gear }], publish, {});
  const next = {};
  assert.throws(() =>
    encoder.send(
      "source",
      [{ key: "a", gear }],
      () => {
        throw Error("failed");
      },
      next,
    ),
  );
  gear[0].display = 99;
  let packet: any;
  encoder.send(
    "source",
    [{ key: "a", gear }],
    (json) => {
      packet = JSON.parse(json);
    },
    next,
  );
  assert.deepEqual(packet.updates, [{ key: "a", gear: [{ display: 99 }] }]);
  encoder.send(
    "replacement",
    [{ key: "a", gear }],
    (json) => {
      packet = JSON.parse(json);
    },
    next,
  );
  assert.equal(packet.reset, true);
  assert.deepEqual(packet.updates, [{ key: "a", gear: [{ display: 99 }] }]);
});

test("a serialization failure after staged updates cannot edit retained rows", () => {
  const encoder = new ReplayFrameTransport();
  const packets: any[] = [];
  const publish = (json: string) => packets.push(JSON.parse(json));
  const original = [
    { key: "a", health: 100, target: "b" },
    { key: "b", health: 90 },
  ];
  encoder.send("source", original, publish);
  assert.throws(
    () =>
      encoder.send(
        "source",
        [
          { key: "a", health: 50 },
          { key: "b", health: 80, invalid: 1n },
        ],
        publish,
      ),
    /BigInt/,
  );
  encoder.send("source", original, publish);
  assert.deepEqual(packets[1].updates, []);
  assert.throws(() =>
    encoder.send(
      "source",
      [
        { key: "a", health: 50 },
        { key: "b", health: 80 },
      ],
      () => {
        throw Error("failed");
      },
    ),
  );
  encoder.send(
    "source",
    [
      { key: "a", health: 50 },
      { key: "b", health: 80 },
    ],
    publish,
  );
  assert.deepEqual(packets[2].updates, [
    { key: "a", health: 50, target: null },
    { key: "b", health: 80 },
  ]);
});

test("undefined values clear retained fields and returning actors discard old patches", () => {
  const encoder = new ReplayFrameTransport();
  let packet: any;
  const publish = (json: string) => {
    packet = JSON.parse(json);
  };
  encoder.send("source", [{ key: "a", target: "b", health: 100 }], publish);
  encoder.send(
    "source",
    [{ key: "a", target: undefined, health: 100 }],
    publish,
  );
  assert.deepEqual(packet.updates, [{ key: "a", target: null }]);
  encoder.send("source", [{ key: "a", health: 100 }], publish);
  assert.deepEqual(packet.updates, []);
  encoder.send("source", [], publish);
  encoder.send("source", [{ key: "a", health: 75 }], publish);
  assert.deepEqual(packet.updates, [{ key: "a", health: 75 }]);
});

test("plain frame rows still clear omitted keys when another field replaces them", () => {
  const encoder = new ReplayFrameTransport();
  const packets: string[] = [];
  const publish = (json: string) => packets.push(json);
  const first = { key: "mage", trajectory: { component: "old" }, display: 42 };
  encoder.send("source", [first], publish, {}, true);
  const next = { key: "mage", movement: { fraction: 0.5 }, display: undefined };
  assert.throws(() =>
    encoder.send(
      "source",
      [next],
      () => {
        throw new Error("failed");
      },
      {},
      true,
    ),
  );
  encoder.send("source", [next], publish, {}, true);
  assert.deepEqual(JSON.parse(packets[1]).updates, [
    { key: "mage", movement: { fraction: 0.5 }, display: null, trajectory: null },
  ]);
});
