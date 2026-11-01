import test from "node:test";
import assert from "node:assert/strict";
import {
  ShareClient,
  shareId,
  shareLink,
  shareSnapshot,
  ownedShares,
  saveOwnedShares,
} from "./share-client";
import { newProject } from "./project-store";
import { emptyPlan } from "./domain";
const id = "a".repeat(32),
  token = "b".repeat(43);
test("links keep read IDs in the fragment and exclude other URL state", () => {
  const url = shareLink(
    id,
    "https://pullfiction.com/?code=private&state=oauth#old",
  );
  assert.equal(url, `https://pullfiction.com/#share=${id}`);
  assert.equal(shareId(new URL(url).hash), id);
  assert.equal(shareId("#other=value"), null);
  assert.equal(shareId("#share=invalid"), "");
});
test("publishing reconstructs only edits and WCL reference", async () => {
  const project = newProject(emptyPlan());
  const snapshot = shareSnapshot(project);
  const client = new ShareClient(async (path, init) => {
    assert.equal(path, "/api/shares");
    assert.equal(init?.credentials, "omit");
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.snapshot, snapshot);
    assert.equal(payload.turnstileToken, "challenge");
    assert.equal(payload.snapshot.id, undefined);
    assert.equal(payload.snapshot.replay, undefined);
    return Response.json({ id, deleteToken: token }, { status: 201 });
  });
  assert.deepEqual(await client.publish(snapshot, "challenge"), {
    id,
    deleteToken: token,
  });
});
test("read and delete keep deletion credentials out of links and GET responses", async () => {
  const snapshot = shareSnapshot(newProject(emptyPlan()));
  const client = new ShareClient(async (path, init) => {
    assert.equal(path, `/api/shares/${id}`);
    if (init?.method === "DELETE") {
      assert.deepEqual(init.headers, { Authorization: `Bearer ${token}` });
      return Response.json({ deleted: true });
    }
    assert.equal(init?.headers, undefined);
    return Response.json({ snapshot });
  });
  assert.deepEqual(await client.read(id), snapshot);
  await client.remove(id, token);
  await assert.rejects(client.read("../private"), /Invalid sharing link/);
});
test("HTTP failures and unavailable deployments produce actionable messages", async () => {
  const missing = new ShareClient(async () =>
    Response.json({ error: "Shared plan not found." }, { status: 404 }),
  );
  await assert.rejects(missing.read(id), /not found/);
  const staticFallback = new ShareClient(
    async () => new Response("<html>App</html>"),
  );
  await assert.rejects(staticFallback.config(), /unavailable/);
  const invalid = new ShareClient(async () =>
    Response.json({ snapshot: { version: 999 } }),
  );
  await assert.rejects(invalid.read(id));
});
test("deletion records handle unavailable or corrupt storage without losing existing records", () => {
  assert.deepEqual(ownedShares(), []);
  assert.deepEqual(
    ownedShares({
      getItem() {
        throw new Error();
      },
    }),
    [],
  );
  assert.deepEqual(
    ownedShares({
      getItem() {
        return "{}";
      },
    }),
    [],
  );
  let saved = "";
  saveOwnedShares([{ id, deleteToken: token, name: "Raid plan" }], {
    setItem(_key, value) {
      saved = value;
    },
  });
  assert.deepEqual(
    ownedShares({
      getItem() {
        return saved;
      },
    }),
    [{ id, deleteToken: token, name: "Raid plan" }],
  );
  assert.throws(
    () =>
      saveOwnedShares([], {
        setItem() {
          throw new Error("full");
        },
      }),
    /full/,
  );
});
