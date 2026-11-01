# Check a boss encounter replay

Use a complete recorded pull to inventory mechanics, generate diagnostic cases,
and check replay state. Repeat this procedure for kills and wipes from different
reports. One pull covers only the mechanics observed in that pull.

## Establish expected behavior first

Research the exact ruleset and encounter before inspecting its observed spell
list. Record source URLs, patch dates and limitations. Check original gameplay
and official changes against authored encounter guides. A guide supplies an
expectation to test; it does not establish exact coordinates or visual timing.

For each mechanic, specify its trigger, state, lifecycle, placement, animation
and named acceptance check. Include phase transitions, moving hazards, elevation,
objects, adds, cancellation and post-kill activity. Preserve disagreement between
sources and logs. Keep unobserved mechanics on the checklist without inventing
their execution in a fast kill.

Supply one research JSON per encounter with `ruleset`, `encounterId`, `sources`
and `expectedMechanics`. Sources need at least one HTTP(S) URL. Each mechanic
needs `mechanic` (or `name`), `trigger`, `state`, `lifecycle`, `placement`,
`animation` and a unique `acceptanceCheck`. Add `sources` references to each
mechanic; otherwise the audit flags its attribution as unresolved. Other boss
research fields can remain in the file.

The [research library](encounters/README.md) separates raw game/addon encounter
IDs from verified report IDs. Resolve an entry's null `encounterId` against the
actual report before using that entry as audit input. A familiar boss name or a
numeric offset does not establish the provider's identity.

Use `spellIds` only for verified mechanic-to-spell mappings. These IDs also
include important player-sourced encounter effects in the inventory. Keep
name-matched client candidates separate. A mapped aura found only in
`combatantinfo` earns a snapshot observation; its caster and application time
remain unknown. Neither a listed ID nor a snapshot proves the complete mechanic.

Repeat `--expectations /path/to/boss-research.json` in the audit command below
for each researched boss. The ledger matches ruleset and encounter ID, preserves
the research checklist and marks every contract unverified. Existing probe
results in a research file grant no automatic verification credit. Without a
matching specification, the ledger explicitly remains an observed-event inventory.

## Prepare the inputs

The local workflow requires Python 3 and Node.js. The Python inventory calls the
shared JavaScript encounter-boundary resolver when recorded boundary events and
report chapters are available; the CPU checker independently uses that resolver.

Keep the report, event export, client assets and generated evidence local.
Select the encounter's ruleset and retain the report revision. Export a fresh
client graph through the current production converter. Retain its product,
version, build key and graph hash. Two exports from the same client build can
contain different metadata when the converter changes.

Check the active product as well as its version. If the installation has changed
to another product, keep retained evidence tied to its original build and graph
hash. Do not bypass the exporter guard or claim a fresh asset validation against
the replacement product.
See [renderer coverage](RENDERER-COVERAGE.md) for graph generation.

Use either a portable replay JSON with `report`, `fight`, `gameVersion`, `actors`,
`abilities` and `events`, or the three retained WCL cache files:

- The report JSON supplies encounter boundaries, revision and ruleset.
- The events JSON supplies the complete event array, including resources.
- The details JSON supplies `masterData.actors` and `masterData.abilities`.

Check detailed-event coverage before using `--coverage complete`. This flag
records your declaration. It does not independently query WCL or prove that
pagination finished. A state-only export cannot establish detailed coverage.
The audit refuses to certify a streamed portable replay as complete.

Retain report-wide recorded `encounterstart` and `encounterend` events. A provider
boss chapter can omit an opening phase that belongs to the preceding chapter.
The importer and audit pair raw start/end records by their own encounter identity
and link the observed end to the selected provider chapter. Only an unambiguous
match expands the start. The audit records both reported and resolved bounds;
the checker rejects disagreement. It does not invent missing events or certify
pagination. Previously saved imports that lack the prelude require a fresh
import or another complete event export to recover those observations.

## Generate the encounter ledger

Run from the repository root. Choose a new output directory for each run.

```sh
python3 scripts/encounter-audit.py \
	--report /path/to/report.json \
	--events /path/to/events.json \
	--details /path/to/details.json \
	--graph /path/to/spell-effects.json \
	--map-id 2856 \
	--coverage complete \
	--output .agent/work/encounter-audit/scarlet-1
```

For a portable replay, replace `--report`, `--events` and `--details` with
`--replay /path/to/replay.json`. `--map-id` selects the report's `gameZone.id`.
Omit it to audit all recorded bosses. The Scarlet Enclave report zone is 2856.

Open `report.md` for the encounter and spell inventory. Use `report.json` for
original event indices, actor-instance identities, recorded lifecycles, authored
visual routes and capability gaps. Input hashes, client identity and consumer
source hashes identify the audited state.

Inspect every important mechanic, including adds, NPC auras on players and
environment effects. The inventory excludes ordinary player attacks on bosses.
Negative provider ability IDs stay outside the client spell-ID namespace.
Positive IDs can also collide: provider `Falling` damage can use ID 3, which is
an unrelated client spell. The audit and replay preserve that environmental
damage separately when its provider metadata establishes the distinction.
An ability with no declared visual can still create a visible actor or trigger
a scripted mechanic. Inspect those paths separately.

## Check recorded state through the replay

```sh
node scripts/encounter-replay-check.mjs \
	--audit .agent/work/encounter-audit/scarlet-1/report.json \
	--output .agent/work/encounter-audit/scarlet-1/replay-check.json
```

The checker verifies input and source hashes before it runs the production
normalization, pose and indexed aura-state functions. It checks recorded NPC
creation and destruction, cast preservation, and sampled aura stacks, ownership
and removal through forward and backward queries. Inspect the per-encounter
assertion counts and failures. A CPU state pass does not establish browser
rendering or effect appearance.

Archive access is a separate gate. Public report metadata can be readable while
the archived events are inaccessible to the current API client. Retain the
archive response and mark the unit data-unavailable; metadata and a guide do not
earn observed-event or runtime credit. Record the pull date when comparing a
historical log with current client assets and versioned encounter changes.

Re-run the audit after changing an input or consumer. The checker rejects stale
source hashes. Keep each result beside its original report.

## Exercise the native renderer

Follow the [renderer workbench guide](../web/editor/src/renderer-lab/README.md)
to build a diagnostic runtime and connect the matching local client source.
Import the generated `batch-*.json` files. The cases use recorded spell IDs and
NPC hosts with diagnostic positions and durations. They exercise supported cast,
aura and channel inputs. They do not reconstruct encounter geometry or summon
scripts, and a generated case has no execution credit until it runs.

Inspect the retained events around encounter boundaries too. A provider's kill
boundary can precede a boss's escape, roleplay cast, charm application or add
cleanup. Keep those observations distinct from the selected pull and test the
full-run replay. Do not force every actor dead or erase surviving adds when a
boss chapter ends.

Inspect the subject and effect at start, hold, end and cleanup. Check readiness,
asset failures, animation, attachments and camera visibility. Retain the
workbench report, runtime identity and screenshots with the audit. A stable
frozen image can still contain an occluded or incorrectly placed effect.

For Caster-owned aura kits, the replay enables the extra route only when the log
identifies the affected actor instance as the aura source. Other or unknown
sources remain unresolved. Do not remap every Caster aura onto the victim.

## Check the complete fight

Load the same pull through the normal editor. Inspect important mechanics in
their room and with surrounding actors. Compare uninterrupted playback with
direct seeks into active mechanics, backward seeks, pause and resume, and a
cold asset load. Confirm that adds appear at recorded creation, effects end on
removal, and state restoration does not duplicate launches.

Separate actor resource positions from spell destinations. A damage recipient's
position does not establish a ground effect's center, radius or orientation.
Do not invent hazard footprints or server animations to close an audit gap.

For effects that touch or fill the floor, verify vertical placement with the
encounter geometry enabled. Compare the selected walkable surface, the owner's
rendered height, its attachment point, and each authored effect offset. Inspect
the full footprint from a player-height camera and an elevated camera. Check
that the room does not bury part of the effect. An isolated capture cannot pass
this placement check, and a capture with a hidden subject or no visible effect
remains unverified. Preserve deliberate below-ground layers when investigating
the cause. A successful raised-anchor experiment is not evidence for a global
height correction.

If placement, animation or appearance remains ambiguous, compare a recording
from the same ruleset and patch, ideally the same pull. Align the recording with
logged casts or hits. Check footprint, silhouette, timing and cleanup. A
screenshot from the current renderer cannot serve as the real-game reference.

Retain separate observed, catalogued, native-executed, replay-verified and
visually-matched states for each mechanic. Keep unresolved mechanics visible in
the ledger, and repeat the checks on a different pull before treating a rule as
general encounter behavior.
