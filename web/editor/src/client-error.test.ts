import test from "node:test";
import assert from "node:assert/strict";
import { mapLoadProblem } from "./client-error";

test("Expired local-file tracebacks become a recovery message while retaining diagnostic detail", () => {
  const trace =
    'Traceback (most recent call last): File "/app/classic_world.py" pyodide.ffi.JsException: NotReadableError: permission problems';
  const result = mapLoadProblem(trace);
  assert.equal(result.title, "Client files unavailable");
  assert.match(result.message, /Reload.*choose/);
  assert.doesNotMatch(result.message, /Traceback|pyodide|classic_world/);
  assert.equal(result.detail, trace);
});
