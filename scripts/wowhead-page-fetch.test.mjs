import assert from "node:assert/strict";
import test from "node:test";
import { fetchPage } from "./wowhead-page-fetch.mjs";

test("developer fetch allows only numeric metadata pages and bounds decoded response bodies", async () => {
  const request = async (url, options) => {
    assert.equal(url.href, "https://www.wowhead.com/classic/npc=12118");
    assert.equal(options.redirect, "manual");
    return new Response("numeric metadata", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  const result = await fetchPage("https://www.wowhead.com/classic/npc=12118", request);
  assert.equal(Buffer.from(result.body, "base64").toString(), "numeric metadata");
  for (const value of ["https://wow.zamimg.com/model.m2", "http://www.wowhead.com/classic/npc=1",
    "https://www.wowhead.com/classic/npc=1?token=anything"]) {
    await assert.rejects(fetchPage(value, () => { throw new Error("Network must not run"); }), /Only numeric/);
  }
  await assert.rejects(fetchPage("https://www.wowhead.com/classic/npc=1", async () =>
    new Response("x".repeat(3 * 1024 * 1024 + 1), { headers: { "Content-Type": "text/html" } })), /size bound/);
  assert.deepEqual(await fetchPage("https://www.wowhead.com/classic/npc=1", async () =>
    new Response("rate limited", { status: 429 })), { status: 429 });
});

test("numeric page redirects may reach only the same NPC or zone on the source host", async () => {
  let count = 0;
  const result = await fetchPage("https://www.wowhead.com/classic/npc=12118", async (url) => {
    count++;
    return count === 1
      ? new Response(null, { status: 301, headers: { Location: "/classic/npc=12118/lucifron" } })
      : new Response("metadata", { headers: { "Content-Type": "text/html" } });
  });
  assert.equal(count, 2);
  assert.equal(Buffer.from(result.body, "base64").toString(), "metadata");
  await assert.rejects(fetchPage("https://www.wowhead.com/classic/npc=1", async () =>
    new Response(null, { status: 301, headers: { Location: "https://wow.zamimg.com/model.m2" } })), /Unexpected metadata source redirect/);
});
