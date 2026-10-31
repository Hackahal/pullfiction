import assert from "node:assert/strict";
import { assetBridge, type ClientReader } from "./browser-assets";
import { afterEach, test } from "node:test";
import {
  loadLocalTalents,
  setLocalTalentsProvider,
  type TalentCatalog,
} from "./local-talents";

const catalog = (version = "1.15.9.70003"): TalentCatalog => ({
  schema: 1,
  source: { product: "wow_classic_era", version, buildKey: "a".repeat(32) },
  layouts: {},
  trees: [
    {
      id: 41,
      classId: 8,
      name: "Fire",
      icon: "id:135810",
      order: 1,
      nodes: [],
    },
  ],
  classes: [{ id: 8, name: "Mage" }],
  readable: true,
  partial: false,
  reason: "",
  coverage: { complete: true, tables: {}, unavailableTables: [] },
});
afterEach(() => setLocalTalentsProvider(null));

test("talents are lazy, deduplicated and cached only for the selected provider", async () => {
  assert.equal(await loadLocalTalents(), null);
  let calls = 0;
  setLocalTalentsProvider(async () => {
    calls++;
    return catalog();
  });
  assert.equal(calls, 0);
  const a = loadLocalTalents(),
    b = loadLocalTalents();
  assert.equal(a, b);
  assert.equal((await a)?.trees[0].name, "Fire");
  await loadLocalTalents();
  assert.equal(calls, 1);
});

test("provider failures and partial metadata are optional and retryable", async () => {
  let calls = 0;
  setLocalTalentsProvider(async () => {
    calls++;
    if (calls === 1) throw new Error("encrypted table");
    return { ...catalog(), partial: calls === 2 };
  });
  assert.equal(await loadLocalTalents(), null);
  assert.equal((await loadLocalTalents())?.partial, true);
  assert.equal((await loadLocalTalents())?.partial, false);
  await loadLocalTalents();
  assert.equal(calls, 3);
});

test("changing or removing providers rejects stale completions without clearing a new request", async () => {
  let finish!: (value: TalentCatalog) => void;
  setLocalTalentsProvider(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = loadLocalTalents();
  await Promise.resolve();
  setLocalTalentsProvider(async () => catalog("new"));
  const current = loadLocalTalents();
  finish(catalog("old"));
  assert.equal(await old, null);
  assert.equal((await current)?.source.version, "new");
  assert.equal((await loadLocalTalents())?.source.version, "new");
  setLocalTalentsProvider(null);
  assert.equal(await loadLocalTalents(), null);
});

test("asset bridge deduplicates partial talent reads and permits a later complete read", async () => {
  let calls = 0;
  const reader: ClientReader = {
    build: catalog().source,
    read: async () => ({ bytes: new ArrayBuffer(0) }),
    model: async () => ({ bytes: new ArrayBuffer(0) }),
    appearance: async () => ({}),
    close() {},
    catalog: async () => ({ ...catalog(), partial: ++calls === 1 }),
  };
  const bridge = assetBridge(reader);
  const first = bridge.catalog("talents");
  assert.equal(first, bridge.catalog("talents"));
  assert.equal((await first).partial, true);
  assert.equal((await bridge.catalog("talents")).partial, false);
  await bridge.catalog("talents");
  assert.equal(calls, 2);
});
