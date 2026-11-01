import test from "node:test";
import assert from "node:assert/strict";
import { mapLoadProblem } from "./client-error";

test("Map failures offer download recovery while retaining diagnostic detail", () => {
  const trace =
    'Traceback (most recent call last): File "/app/classic_world.py" pyodide.ffi.JsException: NotReadableError: permission problems';
  const result = mapLoadProblem(trace);
  assert.equal(result.title, "Could not load this map");
  assert.match(result.message, /connection and retry/);
  assert.doesNotMatch(result.message, /folder|client/);
  assert.doesNotMatch(result.message, /Traceback|pyodide|classic_world/);
  assert.equal(result.detail, trace);
});
