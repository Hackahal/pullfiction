# Check the browser renderer

Production packages exclude the workbench and diagnostic WASM exports. Build a separate local diagnostic runtime, then run Vite against it:

```sh
bash scripts/renderer-lab-build.sh .agent/work/renderer-lab/runtime-1
python3 -m http.server 8101 --bind 127.0.0.1 --directory .agent/work/renderer-lab/runtime-1
```

In another terminal:

```sh
PULLFICTION_RENDERER_LAB_NO_HMR=1 PULLFICTION_RUNTIME_ORIGIN=http://127.0.0.1:8101 npm run dev --prefix web/editor -- --port 8100 --strictPort
```

Open `http://127.0.0.1:8100/?renderer-lab=1`. Confirm that the page says **Renderer workbench**. The root URL opens the normal editor. Both servers are development tools and serve application code only. Keep the normal editor tab and its saved projects separate. Each build needs a new output path; point the runtime server at that path and reload the workbench after a rebuild. Production packaging still rejects diagnostic exports and lab entries. HMR is disabled for this batch server so a source edit cannot reload the page and discard an in-progress run. Reload deliberately after applying changes.

For repeated development batches, start the optional local asset source once:

```sh
web/editor/node_modules/.bin/tsx scripts/renderer-local-source.mts \
  --client "/path/to/World of Warcraft" \
  --archive .agent/work/renderer-lab/runtime-1/archive
```

Open the workbench URL printed by that command. It reconnects automatically after reloads, so uncached assets do not require folder-picker intervention. This explicit source bypasses the browser’s prepared-asset cache, ensuring startup catalogs and later files come from the same selected converter build. The Node source keeps its own local conversion cache for the process lifetime. The source reads only the selected installation through the existing archive worker and converters. It binds to `127.0.0.1:8102`, permits only the exact diagnostic origin `http://127.0.0.1:8100`, and does not upload assets or launch the official client. Use `--port` and `--origin` when choosing different local diagnostic ports. Keep this development process separate from the hosted application; the WASM renderer, actor inputs and spell pipeline remain unchanged.

The regular folder-picker workflow remains available:

1. Choose the installed World of Warcraft root folder. The workbench uses the normal browser asset reader and converter; it does not start or inspect the official game.
2. If the workbench restored cached assets, click **Connect client source** and choose the installation before an uncached batch. The runner pauses readiness deadlines while the folder is needed. Run the smoke fixtures. Check that the synthetic subject, creature and spell appear before running a large batch.
3. Import a JSON array of 1–256 `RendererCase` records, or use **Paste fixture JSON**. The paste option does not require extension file-upload permissions. Start with batches of 24–32 cases to bound browser memory and review effort.
4. Run the batch with duplicate frozen captures enabled, then export the evidence JSON.
5. Extract the actual GPU images and contact sheets:

   ```sh
   python3 scripts/renderer-evidence.py REPORT.json --output NEW_OUTPUT_DIRECTORY --sheet
   ```

   `--sheet` requires Pillow. Without it, extraction still produces individual PNGs, an HTML contact sheet and a summary. Existing evidence directories are never overwritten.

6. Inspect each subject or room. Record visible defects separately from unsupported assets, unavailable data and unsuitable cameras. A loaded mesh, successful capture or matching frozen hash does not establish visual correctness.
7. Fix a shared cause, rebuild into a new output directory, and rerun the affected cases plus nearby control cases. Keep the earlier evidence.

## Generate coverage

Use `scripts/renderer-coverage.py --help` to generate catalog and dependency manifests. Use `scripts/renderer-model-audit.py --help` for read-only model adaptation checks and `scripts/renderer-world-audit.py --help` for terrain/WMO checks and floor-camera candidates. Use `scripts/renderer-world-cameras.py --help` to refine those candidates against static placed WMO triangles; this step requires NumPy and still needs browser visibility approval. Supply catalogs from the same product, version and build key. Store output under an ignored local work directory, outside the installation.

Metadata enumeration, conversion, GPU rendering, visual approval and regression evidence are separate dimensions. Preserve that distinction when resuming a manifest. A camera generated from a walkable floor still needs a visibility check. The evidence extractor also compares the configured, rendered and portal-culling camera poses when the native report includes them. A different culling camera can create false missing-room reports even when the renderer is correct.

For a complete local audit, follow [the renderer coverage workflow](../../../../docs/RENDERER-COVERAGE.md). It includes catalog snapshots, recursive model and texture decoding, instance geometry, sparse spell-definition closure and a linked readiness report. These tools use the production adapters, format readers and shader helpers; they do not introduce another renderer.

### Check shared rendering paths

Use rendering families to find a common cause and choose regression cases. The spell graph supplies lifecycle stages, targets, attachments, missiles and procedural paths. Optional decoded model-audit rows refine those paths with mesh shaders, texture-stage counts, particle flags and shapes. The tool keeps content fingerprints, which include IDs and authored values, separate from rendering signatures, which describe shared mechanisms. Different ranks or model files can share a rendering signature while retaining their own fingerprints, dependencies and verification status.

```sh
python3 scripts/renderer-coverage.py \
  --spells .agent/work/modern-local-catalogs/spell-effects.json \
  --model-features .agent/work/model-audit/models.jsonl \
  --representatives --representative-limit 64 --case-limit 64 --batch-size 24 \
  --verification-id LOCAL_RENDERER_AND_CONVERTER_ID \
  --output .agent/work/path-coverage-1
```

`--model-features` accepts the existing model-audit JSONL rows, a single audit row, a JSON array, or an object containing `models` and an optional client `source`. An explicit source must match the catalog product, version and build key. Rows without that wrapper retain their source hashes but have no verified client-profile association. Existing audit rows are not rewritten or given additional fidelity credit. Missing model summaries, missing references, opaque primitives and absent UV/gravity classifications stay explicit coverage gaps. To refine an audit row after decoding those properties, optional `renderFeatures` can contain `meshUvSources`, `meshBlendModes`, `particleUvModes` and `particleGravityModes`; these are decoded mode labels or stage selectors, not guessed defaults. Shader, UV and gravity differences separate rendering signatures when that evidence is available. `drawExpectation: potential-draw` means authored geometry, emitters or host animation may draw; it is not runtime or pixel evidence.

The manifest's `renderFamilies` select new executable lifecycle stages first, then executable paths with new known capabilities, shared member count and stable signature ties. Unknown references or opaque primitive IDs do not earn novelty. Within each chosen family, selection keeps the lowest spell ID plus a stable edge ordered by maximum decoded particle count, vertex count, authored scale, duration, cast time and speed, bounded by `--representative-limit`. Optional `--case-limit` separately bounds actual captures, preferring uncovered stages and capabilities while recording omitted cases as budget gaps. `lifecycleRecipes` and `representativeCases` use the existing native `cast`, `flight`, `channel`, `aura` and explicitly mapped illustrative `summon` inputs. Their samples cover start, hold or travel, end and cleanup at diagnostic ages. Import the generated `batch-*.json` files. Actual arrival times, host appearance and camera visibility still need inspection. Kit-only paths and server-dependent or unmapped states appear in `ungeneratedRecipes` or recipe gaps. Without `--representatives`, the existing complete inventory cases remain the output, including kit-only inventory records that cannot run through native spell routing.

`--max-cases 0` enumerates every content record while retaining no inventory fixtures. Use it with a bounded representative batch for a large client: the content denominator stays complete, and omitted fixture counts remain explicit. Typed dependencies distinguish model/texture files from race, sex and attachment selectors. Item visual slots preserve their positions, enchants join through ItemVisuals, and sparse spell definitions retain ownership/backreferences without inventing recursive render loads. A change in any reachable definition invalidates the corresponding content fingerprint.

A representative earns evidence for its own case and consumer context. It does not visually approve the other family members. Family status counts retain the individual `decode`, `render`, `visual` and `regression` states; no pass is propagated. `consumerCoverage` separately lists spell FX, placed doodads, UI models and cutout/depth/fade twins as unverified, even when a spell-FX recipe exists or an asset decoded successfully. Preserve `consumerContext` on evidence when recording a result. A model intentionally containing no mesh, particles or ribbons can expect no effect draw; verify readiness and teardown without requiring invented geometry or treating a blank effect as a failed visible spell. An unknown or opaque model cannot earn that expectation.

## Fixture limits

`cases.ts` defines native WoW XYZ coordinates, radians, requested sample ages and coverage identifiers. `runner.ts` resolves isolated fixtures into a known Molten Core entry stage and records the translated case. Diagnostic world isolation removes surrounding geometry while retaining the production lighting and subject assembly. World fixtures retain their authored map and camera. A future client profile needs its own available stage; the current default is for the retained Era/SoD client.

Subjects pass through the production creature, character/equipment and spell-effect paths. The runner clears previous actors and advances the normal appearance/teardown fades before sampling. After reaching each requested age it freezes simulation and waits for child model draws and resource counts to settle before readback. Both capture statuses are retained for frozen-repeat diagnosis. Character fixtures can set all five `look` dials and permanent/temporary equipment `enchant`/`temporary` IDs. Both enchant slots pass through the production equipment payload rather than being reset by the fixture. Raw model fixtures can request an animation. Character/creature samples do not implement arbitrary actor animation IDs.

Spell fixtures use native unit and event inputs:

- `cast` starts a windup at `startMs` and releases after `durationMs`. A zero duration releases immediately.
- `flight` releases at `startMs`. The production renderer controls the flight and impact.
- `aura` changes the target's active-aura snapshot. `channel` changes the caster's channel field. A positive `durationMs` ends either state.
- `summon` tests the existing short illustrative cue. It does not spawn or simulate a summoned creature.

Spell stages require native character or creature hosts. Channel holds do not synthesize periodic spell ticks. Raw effect models test the asset, rather than a server mechanic; they support only `model` at time zero, without a simultaneous `spellId`. Unimplemented kit/visual/stage routing earns no render credit. The report includes synchronous preparation misses to help distinguish missing body textures from GPU failures.

Simulation and the production replay clock advance together on every fixed step, then freeze for readback. Flight cases should include multiple samples between release and arrival; release/impact snapshots alone do not prove travel. Seed 1 resets the shared animation RNG. Persistent world timestamp origins, asynchronous loading and draw order prevent a claim of complete scene determinism. Frozen-repeat identity is reported separately; differing second images are retained for diagnosis.

The exported report records the client identity, loaded WASM SHA-256, resolved fixtures, native readiness, model/emitter counts, GPU backend, PNG hashes and repeat results. Converter revisions are retained in the corresponding static build log. The native status explicitly marks unknown asset-queue/GPU readiness fields and isolation limits. Keep the package audit and build log with the report.

Keep extracted game assets and screenshots local. The static package contains application code and approved numeric metadata only. Do not create goldens from blank, occluded or unverified frames, and do not label current-build screenshots as official-client references.

## Asset memory during long batches

The native asynchronous loader uses `LocalClientFiles.readStreaming()` for transient source buffers. Bevy and the audio path retain their own decoded or copied resources. Explicit `prepare()` and synchronous `readSync()` dependencies still use the bounded preparation cache. Do not put every asynchronously streamed world texture or mesh into that cache: a successful short fixture can otherwise hide exhaustion when a later map loads. Record `localPreparedBytes` across a multi-map batch as well as native loading failures. This number measures retained raw preparation buffers, not total browser or GPU memory.

## Check effect fragments without game assets

Run `python3 scripts/renderer-effects-gpu-check.py --output NEW_OUTPUT_DIRECTORY` after a native build has produced compatible `wgpu` and `futures-lite` rlibs under `target/debug/deps`. Explicit dependency paths are available through `--help`. This tool uses `rustc`, a native GPU adapter, current production policy functions and complete production WGSL fragments with self-authored pixels. It does not invoke Cargo, download dependencies or access a game installation. It refuses an existing output directory.

Keep its source-policy and analytical GPU results separate from the browser batches. Passing a one-pixel blend test does not prove BC texture decoding, Bevy specialization, model assembly, world lighting or whole-spell appearance.

For packed model materials and independent texture animation, run `python3 scripts/renderer-model-gpu-check.py --output NEW_OUTPUT_DIRECTORY`. It uses the same native dependency setup and tests the current production WGSL helper functions against independent analytical expectations. These checks cover combiner operations, alpha handling, reflection terms and separate UV transforms. They do not exercise complete model bindings, texture decoding, lighting/fog integration or whole-model appearance; retain the browser model and spell captures alongside them.
