import test from "node:test";
import assert from "node:assert/strict";
import {
  loadNpcIndex,
  resolveNpcModels,
  replayNpcModels,
  NPC_MODELS_URL,
} from "./npc-models";

const entry = (npc: number, displayID: number, displayIDs = [displayID]) => ({
  name: `NPC ${npc}`,
  displayID,
  displayIDs,
  templateScale: 0,
  sourceURL: `https://www.wowhead.com/classic/npc=${npc}`,
  sourceSHA256: "a".repeat(64),
  retrievedAt: "2026-10-27T00:00:00Z",
});
const creatures = {
  displays: {
    "13031": { modelID: 1, scale: 2 },
    "13032": { modelID: 1, scale: 3 },
    "900": { modelID: 2, scale: 1 },
  },
  models: { "1": { fileDataID: 123, scale: 1.5 } },
};

test("NPC reference display IDs are checked against the selected client's model and kept within their ruleset", () => {
  const index = {
    schema: 1,
    provider: "Wowhead",
    versions: {
      vanilla: {
        creatures: {
          "12118": entry(12118, 13031),
          "100": entry(100, 404, [404, 13032]),
          "101": entry(101, 900),
        },
      },
      sod: {
        creatures: { "12118": entry(12118, 13032), "200": entry(200, 404) },
      },
    },
  };
  const models = resolveNpcModels(index, creatures);
  assert.equal(models.vanilla["12118"].displayID, 13031);
  assert.equal(models.sod["12118"].displayID, 13032);
  assert.equal(models.vanilla["100"].displayID, 13032);
  assert.equal(models.vanilla["12118"].scale, 3);
  assert.equal(models.sod["12118"].scale, 4.5);
  assert.equal(models.vanilla["101"], undefined);
  assert.equal(models.sod["100"], undefined);
  assert.equal(models.sod["200"], undefined);
});

test("Unverified or malformed mappings never become renderable NPCs", () => {
  const valid = entry(12118, 13031);
  for (const record of [
    { ...valid, sourceURL: "https://other.example/classic/npc=12118" },
    { ...valid, sourceURL: "https://www.wowhead.com/classic/npc=999" },
    { ...valid, sourceSHA256: "missing" },
    { ...valid, displayIDs: [13032] },
    { ...valid, displayID: "13031" },
    { ...valid, templateScale: 7 },
  ]) {
    const models = resolveNpcModels(
      {
        schema: 1,
        provider: "Wowhead",
        versions: { vanilla: { creatures: { "12118": record } } },
      },
      creatures,
    );
    assert.deepEqual(models.vanilla, {});
  }
  assert.throws(
    () =>
      resolveNpcModels(
        { schema: 1, provider: "Other", versions: {} },
        creatures,
      ),
    /Invalid bundled/,
  );
});

test("Cached zone references retain the exact source document and reject unrelated documents", () => {
  const record = {
    ...entry(12118, 13031),
    sourceDocumentURL: "https://www.wowhead.com/classic/zone=2717",
  };
  const resolve = (value: unknown) =>
    resolveNpcModels(
      {
        schema: 1,
        provider: "Wowhead",
        versions: { vanilla: { creatures: { "12118": value } } },
      },
      creatures,
    );
  assert.equal(
    resolve(record).vanilla["12118"].displaySource,
    record.sourceDocumentURL,
  );
  for (const sourceDocumentURL of [
    "https://other.example/classic/zone=2717",
    "https://www.wowhead.com/classic/zone=999",
    "https://www.wowhead.com/classic/zone=2717?token=anything",
    [],
  ]) {
    assert.deepEqual(resolve({ ...record, sourceDocumentURL }).vanilla, {});
  }
});

test("Raw Ragnaros and large-mob final object scales reach the original client unchanged", () => {
  const raw = Object.freeze({
    "11502": Object.freeze({ name: "Ragnaros", displayID: 13032, scale: 3 }),
    "123": Object.freeze({ name: "Large mob", displayID: 13031, scale: 6 }),
  });
  const base = {
    "11502": { displayID: 13031, scale: 1, displaySource: "reference" },
  };
  const models = replayNpcModels(base, raw, creatures) as Record<string, any>;
  assert.equal(models["11502"].displayID, 13032);
  assert.equal(models["11502"].scale, 3);
  assert.equal(models["123"].scale, 6);
  assert.equal(raw["11502"].scale, 3);
  assert.equal(raw["123"].scale, 6);
  assert.equal(base["11502"].displayID, 13031);
  assert.notEqual(models["11502"], raw["11502"]);
});

test("A raw display override without object scale uses the new display's authored fold", () => {
  const models = replayNpcModels(
    { "7": { displayID: 13031, scale: 3 } },
    { "7": { displayID: 13032 } },
    creatures,
  ) as Record<string, any>;
  assert.equal(models["7"].scale, 4.5);
});

test("NPC metadata loads from the bundled application resource without a runtime Wowhead request", async () => {
  const value = { schema: 1, provider: "Wowhead", versions: {} };
  const signal = new AbortController().signal;
  assert.deepEqual(
    await loadNpcIndex(signal, (async (url, options) => {
      assert.equal(url, NPC_MODELS_URL);
      assert.equal(options?.signal, signal);
      assert.equal(options?.credentials, "omit");
      return Response.json(value);
    }) as typeof fetch),
    value,
  );
  await assert.rejects(
    loadNpcIndex(
      undefined,
      (async () => new Response(null, { status: 404 })) as typeof fetch,
    ),
    /unavailable/,
  );
});
