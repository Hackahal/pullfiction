import test from "node:test";
import assert from "node:assert/strict";
import { readReplayFile, type ReplayFileResponse } from "./replay-file";

const big = { size: 17 * 1024 * 1024 } as File;

function mockWorker() {
  const sent: unknown[] = [];
  const mock = {
    onmessage: null as ((e: { data: ReplayFileResponse }) => void) | null,
    onerror: null,
    onmessageerror: null,
    terminated: 0,
    postMessage(data: unknown) {
      sent.push(data);
    },
    terminate() {
      this.terminated++;
    },
  };
  return { mock, sent, make: () => mock as unknown as Worker };
}

test("large replay assembly acknowledges one batch and preserves ordering and header", async () => {
  const { mock, sent, make } = mockWorker();
  const counts: number[][] = [];
  const pending = readReplayFile(
    big,
    new AbortController().signal,
    (n, total) => counts.push([n, total]),
    make,
  );
  const header = { report: { code: "test" } } as unknown as Extract<
    ReplayFileResponse,
    { kind: "header" }
  >["header"];
  const first = [{ timestamp: 3 }] as Extract<
    ReplayFileResponse,
    { kind: "events" }
  >["events"];
  const second = [{ timestamp: 1 }, { timestamp: 1 }] as typeof first;
  mock.onmessage!({ data: { kind: "header", header, total: 3 } });
  mock.onmessage!({
    data: { kind: "events", target: "events", events: first },
  });
  mock.onmessage!({
    data: { kind: "events", target: "events", events: second },
  });
  mock.onmessage!({ data: { kind: "done" } });
  assert.deepEqual(await pending, {
    ...header,
    events: [...first, ...second],
  });
  assert.deepEqual(counts, [
    [0, 3],
    [1, 3],
    [3, 3],
  ]);
  assert.deepEqual(sent, [big, "next", "next", "next"]);
  assert.equal(mock.terminated, 1);
});

test("cancelling a large replay terminates the worker and detaches handlers", async () => {
  const { mock, sent, make } = mockWorker();
  const controller = new AbortController();
  const pending = readReplayFile(
    big,
    controller.signal,
    () => assert.fail("cancelled worker"),
    make,
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(sent, [big]);
  assert.equal(mock.terminated, 1);
  assert.equal(mock.onmessage, null);
});

test("partial replay event batches keep state and context separate and count both", async () => {
  const { mock, make } = mockWorker();
  const counts: number[][] = [];
  const pending = readReplayFile(
    big,
    new AbortController().signal,
    (n, total) => counts.push([n, total]),
    make,
  );
  const header = {
    stream: { stateEvents: [], contextEvents: [] },
  } as unknown as Extract<ReplayFileResponse, { kind: "header" }>["header"];
  mock.onmessage!({ data: { kind: "header", header, total: 3 } });
  mock.onmessage!({
    data: { kind: "events", target: "events", events: [{ timestamp: 20 }] },
  });
  mock.onmessage!({
    data: {
      kind: "events",
      target: "stateEvents",
      events: [{ timestamp: 10 }],
    },
  });
  mock.onmessage!({
    data: {
      kind: "events",
      target: "contextEvents",
      events: [{ timestamp: 5 }],
    },
  });
  mock.onmessage!({ data: { kind: "done" } });
  assert.deepEqual(await pending, {
    events: [{ timestamp: 20 }],
    stream: {
      stateEvents: [{ timestamp: 10 }],
      contextEvents: [{ timestamp: 5 }],
    },
  });
  assert.deepEqual(counts, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("worker parse errors terminate without installing a partial replay", async () => {
  const { mock, make } = mockWorker();
  const pending = readReplayFile(
    big,
    new AbortController().signal,
    () => assert.fail("invalid replay"),
    make,
  );
  mock.onmessage!({ data: { kind: "error", message: "Invalid JSON" } });
  await assert.rejects(pending, /Invalid JSON/);
  assert.equal(mock.terminated, 1);
});
