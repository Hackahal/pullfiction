import test from "node:test";
import assert from "node:assert/strict";
import { ReplayFrameTransport } from "./replay-frame-transport";

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
