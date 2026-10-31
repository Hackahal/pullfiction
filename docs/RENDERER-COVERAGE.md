# Renderer coverage workflow

Use this workflow to find shared rendering defects across a selected client. It
checks the same adapters, Rust readers and shader code that the browser uses.
Log reconstruction and official-client visual parity are separate tasks.
The [retained-client checkpoint](RENDERER-STATUS.md) records the current measured
denominators and remaining implementation gaps.

Keep the installation read-only. Store reports under an ignored local directory;
never commit extracted tables, models, textures or screenshots. The tools do not
launch or attach to the game, execute client motion scripts, decrypt inaccessible
resources or contact a game server.

## Record independent results

For each category, retain its denominator and these separate states:

| State | Evidence required |
|---|---|
| Enumerated | Source records and exact client identity retained |
| References resolved | The declared dependency scope has no missing references |
| Semantics mapped | Required operations and their meanings are established |
| Implemented | The production consumer supports those required operations |
| Decoded | Production adapters and readers accept the actual assets |
| Executed | A named test ran against the recorded source/build identity |
| Visually inspected | A person inspected visible output in the relevant context |

Resolved metadata is not implemented behavior. A model can decode while one of
its particle or material modes remains unsupported. A passing representative
does not approve every member of its family. Missing source assets, unknown
metadata, optional audio and conditional requirements need distinct labels.

## Snapshot and enumerate

Use `scripts/renderer-catalogs.py --help` to snapshot the spell, creature, item,
character and world catalogs from one installation. The snapshot records client
product, version, build key, table hashes and layout provenance. Spell model
formats use deduplicated header reads rather than loading every model at startup.
Run separate campaigns for different products or builds.

Pass those snapshots to `scripts/renderer-coverage.py`. For a large inventory,
use `--max-cases 0 --representatives --representative-limit 64 --case-limit 64`.
This retains all records and dependency fingerprints while bounding capture
fixtures. Increase batch size only after the small smoke batch succeeds.

The graph includes spell visual choices, kits, attachments, procedures, chains,
effect models and typed model dependencies. It also includes item displays,
intrinsic item visuals, enchantments and ranged visuals. Sparse referenced
curves, positioners, motion and animation-kit records retain source/layout hashes
and unresolved semantics. Ownership backreferences are not recursive render
loads. Raw items without a default appearance remain in the denominator.

## Decode in large batches

Use the tools' `--help` output for current input arguments:

- `renderer-model-audit.py`: recursive M2 roots and children, skeletons,
  animation/material/particle modes, textures and character/equipment recipes.
- `renderer-texture-audit.py`: union typed model/world texture dependencies,
  deduplicate identical content, then run native-block and full RGBA decoding.
- `renderer-world-audit.py`: `--all-instances --no-camera-seeds` covers installed
  dungeon/raid Map rows, including unavailable/test entries. Increase time, tile
  and group budgets explicitly for an exhaustive run; report every skip.
- `renderer-spell-audit.py`: classify the actual spell graph and its required,
  optional, conditional and unknown operations. Retain affected record IDs.

The framed native probes are `renderer-model-audit-native.rs` and
`renderer-world-audit-native.rs`. Compile them against fresh compatible
`benilla_formats` and `serde_json` libraries; the model probe also uses
`benilla_blp`. Retain exact library paths/hashes, probe source snapshot/hash and
binary hash. Supply both model and world probe build manifests through
`--native-reader-identity`; the texture audit uses `--native-identity`. Their
validators check preserved source and every declared linked library before
source access. A later source edit does not establish what an older probe
tested. Native success does not establish GPU binding or pixels.

Character/equipment assembly is a recipe matrix across available bodies and
legal slots, not a Cartesian product of every possible outfit. Keep partial
optional armor variants and unsupported mandatory body data distinguishable.
Likewise, a whole-instance geometry sweep is not a claim that every camera,
portal transition, shadow or lighting context was visually accepted.

## Verify shared implementations

Run focused Rust and Python regressions for each repair. Confirm filtered Rust
commands selected a nonzero number of tests. Keep the selected count, exit code,
executable hash and any installed-data fixture identity.

`renderer-effects-gpu-check.py` and `renderer-model-gpu-check.py` execute current
production shader helpers against independent analytical expectations on a
native GPU. They cover math, not complete scene bindings. Use the diagnostic
browser workbench for a small integration batch spanning affected consumers,
travel samples, appearance/cleanup and frozen frames. The development local
source can supply installation bytes without repeated folder selection; it is
excluded from the hosted product. See [the workbench guide](../web/editor/src/renderer-lab/README.md).

## Link the results

`renderer-readiness.py` combines a coverage manifest and domain audit documents:

```sh
python3 scripts/renderer-readiness.py \
  --coverage .agent/work/campaign/coverage/manifest.json \
  --domain spells=.agent/work/campaign/spells-report.json \
  --domain gear=.agent/work/campaign/gear-report.json \
  --domain world=.agent/work/campaign/world-report.json \
  --verification-id EXACT_LOCAL_BUILD_ID \
  --checks .agent/work/campaign/checks.json \
  --output .agent/work/campaign/readiness
```

Domain documents supply `source`, `categories`, a `capabilityLedger` and optional
per-record requirements. Check records use the same client and verification
identity, a positive integer `testCount`, `result: "pass"`, and explicit
`covers: ["domain:capability-id"]` associations. Assertions such as
`automaticallyTested: true` do not grant execution credit. The output retains
input hashes and separates reference closure, implementation assessments and
recorded execution. It never infers visual approval.

For a future client, rerun the snapshots and audits before adding format
assumptions. Fix a shared supported mechanism when its contract is known. Keep
inaccessible data and unresolved runtime semantics visible instead of assigning
plausible effects or guessed defaults to individual IDs.
