import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalClientBlob } from "./renderer-local-client.mjs";

test("local Blob reads only its requested range, including nested and negative slices", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-client-blob-"));
  try {
    const file = path.join(dir, "fixture.bin");
    fs.writeFileSync(file, Buffer.from("0123456789"));
    const blob = new LocalClientBlob(file);
    assert.equal(blob.size, 10);
    assert.equal(await blob.slice(2, 8).slice(1, -1).text(), "3456");
    assert.deepEqual(
      new Uint8Array(await blob.slice(-3).arrayBuffer()),
      new Uint8Array([55, 56, 57]),
    );
    assert.equal(await blob.slice(8, 2).text(), "");
    assert.equal(await blob.slice(1.9, 4.9).text(), "123");
    assert.equal(await blob.slice(-100, Infinity).text(), "0123456789");
    // A slice must not return unrelated bytes from its parent's Buffer allocation.
    assert.equal((await blob.slice(4, 5).arrayBuffer()).byteLength, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "0123456789");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
