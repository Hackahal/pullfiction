# Work on the engine

The retained Benilla/Wenilla sources provide formats, rendering, animation, collision, Lua and native game UI. Pull Fiction hosts those systems in a browser-local viewer. The original standalone client and realm launchers are retired.

Read [contribution guidance](CONTRIBUTING.md) for the current build and source boundaries, [the engine map](MAP.md) for implementation references, and [upstream maintenance](UPSTREAM.md) before an engine sync.

Trace a visible problem through the installed asset, adapter, native decoder, renderer and actual pixels. Keep log reconstruction separate from renderer behavior. Unsupported data must remain explicit; a fallback is not proof of fidelity.

Prefer changes in project-owned integration files or small existing browser hooks. Preserve the recorded upstream source baseline, established native UI behavior and third-party attribution. Use source facts and focused regression checks rather than hardcoded per-boss or per-spell guesses.

Reproduce reported bugs, change their cause, and close the loop on the observed result. Decoder success, compile success, rendered output and comparison against a reference are separate checks. The renderer workbench records those boundaries.
