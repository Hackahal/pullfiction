import test from "node:test";
import assert from "node:assert/strict";
import { openFiles, prepareClientFiles } from "./client.mjs";

const metadata =
  "Active!DEC:1|Build Key!HEX:16|Version!STRING:0|Product!STRING:0\n1|2417084b8b041ee120d02d4adf31b0bc|1.15.9.70003|wow_classic_era\n";
function files() {
  return [
    Object.assign(new File([metadata], ".build.info"), {
      webkitRelativePath: "WoW/.build.info",
    }),
    Object.assign(new File([""], "data.000"), {
      webkitRelativePath: "WoW/Data/data/data.000",
    }),
  ];
}

test("an explicit Forever request never substitutes retained Classic data", async () => {
  const forever = metadata
    .replace("wow_classic_era", "wowf")
    .replace("1.15.9.70003", "1.60.1.70658");
  const selected = [{ name: ".build.info", file: new Blob([forever]) }];
  const actual = await prepareClientFiles(
    selected,
    () => {},
    undefined,
    "wowf",
  );
  assert.equal(actual.build.product, "wowf");
  assert.equal(actual.files, selected);
  await assert.rejects(
    prepareClientFiles(
      [{ name: ".build.info", file: new Blob([metadata]) }],
      () => {},
      undefined,
      "wowf",
    ),
    /Forever/,
  );
});

test("cancelling while CASC is opening terminates its worker and rejects promptly", async (t) => {
  const previous = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  };
  t.after(() => {
    globalThis.Worker = previous;
  });
  const controller = new AbortController(),
    opening = openFiles(files(), () => {}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(worker);
  controller.abort();
  await assert.rejects(opening, { name: "AbortError" });
  assert.equal(worker.terminated, true);
});

test("cancelling a live reader rejects in-flight requests and prevents new ones", async (t) => {
  const previous = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage(message) {
      if (message.type === "open")
        queueMicrotask(() =>
          this.onmessage({
            data: { id: message.id, type: "result", value: { openMs: 1 } },
          }),
        );
    }
    terminate() {
      this.terminated = true;
    }
  };
  t.after(() => {
    globalThis.Worker = previous;
  });
  const controller = new AbortController(),
    reader = await openFiles(files(), () => {}, { signal: controller.signal });
  const pending = [
    reader.read("id:123"),
    reader.world("__classic/108286.wmo"),
    reader.map(409, "MoltenCore"),
  ];
  controller.abort();
  for (const request of pending)
    await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(reader.read("id:123"), /closed/);
  assert.equal(worker.terminated, true);
});

test("world and selected-map requests use the same selected-client worker", async (t) => {
  const previous = globalThis.Worker;
  const requests = [];
  globalThis.Worker = class {
    postMessage(message) {
      requests.push(message);
      queueMicrotask(() =>
        this.onmessage({
          data: {
            id: message.id,
            type: "result",
            value:
              message.type === "map"
                ? { map: message.mapId }
                : { bytes: new ArrayBuffer(8) },
          },
        }),
      );
    }
    terminate() {}
  };
  t.after(() => {
    globalThis.Worker = previous;
  });
  const reader = await openFiles(files());
  assert.equal(
    (await reader.world("__classic/108286_000.wmo")).bytes.byteLength,
    8,
  );
  assert.deepEqual(await reader.map(409, "MoltenCore"), { map: 409 });
  assert.deepEqual(
    requests.slice(1).map(({ id, ...request }) => request),
    [
      { type: "world", resource: "__classic/108286_000.wmo" },
      { type: "map", mapId: 409, directory: "MoltenCore" },
    ],
  );
  reader.close();
});

test("an already cancelled selection never starts a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openFiles(files(), () => {}, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("installing Forever retains an independently selected Classic archive generation", async () => {
  const current =
    "Active!DEC:1|Build Key!HEX:16|Version!STRING:0|Product!STRING:0|CDN Key!HEX:16\n1|" +
    "a".repeat(32) +
    "|1.60.1.70634|wowf|" +
    "b".repeat(32) +
    "\n";
  const key = "5604ce35a8644bdcf0e26c1daf979c15";
  const original = new Blob([current]);
  const config = new Blob([
    "root = " +
      "c".repeat(32) +
      "\nencoding = " +
      "d".repeat(32) +
      " " +
      "e".repeat(32) +
      "\nbuild-name = WOW-70576patch1.15.9_ClassicRetail\n",
  ]);
  const files = [
    { name: ".build.info", file: original },
    { name: `Data/config/56/04/${key}`, file: config },
  ];
  const prepared = await prepareClientFiles(files);
  assert.deepEqual(prepared.build, {
    product: "wow_classic_era",
    version: "1.15.9.70576",
    buildKey: key,
  });
  assert.equal(
    await original.text(),
    current,
    "the selected installation metadata is never changed",
  );
  assert.match(
    await prepared.files[0].file.text(),
    /1\.15\.9\.70576\|wow_classic_era/,
  );
  assert.equal(
    prepared.files[1].file,
    config,
    "archive/configuration File objects stay read-only and shared",
  );
});

test("retained selection rejects missing data and does not hide ambiguous active Classic installs", async () => {
  const current =
    "Active|Build Key|Version|Product|CDN Key\n1|" +
    "a".repeat(32) +
    "|1.60.1.70634|wowf|" +
    "b".repeat(32) +
    "\n";
  await assert.rejects(
    prepareClientFiles([{ name: ".build.info", file: new Blob([current]) }]),
    /no supported Classic/,
  );
  await assert.rejects(
    prepareClientFiles([
      {
        name: ".build.info",
        file: new Blob([metadata + metadata.split("\n")[1]]),
      },
    ]),
    /one active/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    prepareClientFiles([], () => {}, abort.signal),
    { name: "AbortError" },
  );
});
