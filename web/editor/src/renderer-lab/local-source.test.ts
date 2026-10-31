import test from "node:test";
import assert from "node:assert/strict";
import { localRendererSource } from "./local-source";

test("local renderer source preserves binary appearances and worker error categories", async () => {
  const prior = globalThis.fetch;
  const signal = new AbortController().signal;
  globalThis.fetch = async (input, options) => {
    assert.equal(options?.signal, signal);
    if (String(input).endsWith("/meta"))
      return Response.json({
        build: {
          product: "wow_classic_era",
          version: "1.15.9.70576",
          buildKey: "a".repeat(32),
        },
      });
    const { method } = JSON.parse(String(options?.body));
    if (method === "appearance")
      return Response.json({
        textures: [{ pixels: { rendererBytes: "AQID/w==" } }],
      });
    if (method === "read")
      return new Response(new Uint8Array([77, 68, 50, 48]));
    return Response.json(
      { name: "ClientEncryptedError", message: "Encrypted local record" },
      { status: 422 },
    );
  };
  try {
    const reader = await localRendererSource("http://127.0.0.1:8102", signal);
    assert.deepEqual(
      [...new Uint8Array((await reader.appearance({})).textures[0].pixels)],
      [1, 2, 3, 255],
    );
    assert.deepEqual(
      [...new Uint8Array((await reader.read("__classic/1.m2")).bytes)],
      [77, 68, 50, 48],
    );
    await assert.rejects(reader.model("__classic/1.m2"), {
      name: "ClientEncryptedError",
      message: "Encrypted local record",
    });
  } finally {
    globalThis.fetch = prior;
  }
});
test("local renderer source rejects nonlocal and non-origin endpoints before fetching", async () => {
  for (const endpoint of [
    "https://127.0.0.1:8102",
    "http://example.com",
    "http://127.0.0.1:8102/path",
    "http://user:pass@127.0.0.1:8102",
  ])
    await assert.rejects(
      localRendererSource(endpoint, new AbortController().signal),
      /exact loopback/,
    );
});
