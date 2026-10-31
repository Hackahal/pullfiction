import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssetRoot } from "./asset-source";

test("Native assets use the same source generation as the boot probe", async () => {
  const root = await resolveAssetRoot((async (url, options) => {
    assert.equal(url, "/data/__source");
    assert.equal(options?.cache, "no-store");
    return Response.json({
      revision: "classic-abc123",
      dataRoot: "/assets/classic-abc123",
    });
  }) as typeof fetch);
  assert.equal(root, "/assets/classic-abc123");
});

test("Only an older host's missing endpoint falls back to unversioned assets", async () => {
  assert.equal(
    await resolveAssetRoot(
      (async () => new Response(null, { status: 404 })) as typeof fetch,
    ),
    "/data",
  );
  await assert.rejects(
    resolveAssetRoot(
      (async () => new Response(null, { status: 500 })) as typeof fetch,
    ),
    /unavailable/,
  );
  for (const data of [
    null,
    {},
    { revision: "x", dataRoot: "https://other/data" },
    { revision: "../x", dataRoot: "/assets/../x" },
    { revision: "new", dataRoot: "/assets/old" },
  ]) {
    await assert.rejects(
      resolveAssetRoot((async () => Response.json(data)) as typeof fetch),
      /Invalid local asset source/,
    );
  }
});
