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
