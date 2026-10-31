# Raid reference placement coverage

The no-log scene selects reference data by raid and ruleset. Log playback uses
only report actors and their observed positions. No reference placements,
reference deaths, or model guesses from a Classic baseline are added to a SoD
log.

## SoD coverage

The catalog provides a planning reference on every supported SoD map. The
reference type matters: a Classic baseline is not verification of an unchanged
SoD layout. Counts exclude two friendly Gnomeregan records.

| Raid | Native map | Displayed references | Reference type | Remaining limitation |
| --- | ---: | ---: | --- | --- |
| Blackfathom Deeps | 48 | 212 | Seven current SoD guide bosses and 205 Classic trash references | Boss pins are approximate; SoD trash changes are not fully mapped |
| Gnomeregan | 90 | 292 | Explicit SoD mapping 304 with checked map registration | Hand-authored map pins are approximate; eight are within 2.25 yards of a structural edge |
| Sunken Temple | 109 | 230 | Classic dungeon baseline | SoD bosses, removed lower rooms, and changed packs need corrections |
| Onyxia's Lair | 249 | 5 | Classic baseline | SoD encounter changes and script-only summons are not mapped |
| Zul'Gurub | 309 | 620 | Classic baseline | SoD additions and changed packs need corrections |
| Molten Core | 409 | 233 | Classic baseline | Heat-level additions and changed entities need corrections |
| Blackwing Lair | 469 | 311 | Classic baseline | SoD trial changes and added entities need corrections |
| Ruins of Ahn'Qiraj | 509 | 316 | Classic baseline | The explicit SoD mapping export contains zero placements |
| Temple of Ahn'Qiraj | 531 | 164 | Explicit SoD mapping 442 | Source map coverage does not establish live patrol phases |
| Naxxramas | 533 | 852 | Classic baseline | SoD changes need corrections; the separate WotLK-derived mapping is not used |
| Scarlet Enclave | 2856 | 662 | 374 exterior references, 220 portal approximations, and 68 room-map approximations | Map registrations are approximate; four chapel pins lie within 1.7 yards of a room edge |

Classic BFD boss identities and patrol alternatives are removed before adding
the seven SoD boss references. Data from an explicit SoD mapping replaces the
Classic baseline for that map. The application does not stack both layouts.

Reference identities remain stable across preparation, and editing a reference
actor replaces its default slot rather than duplicating it. Existing saved
snapshots retain their own edits. The scene labels inherited baselines and
approximate guide references.

## Classic database source

`vanilla.json` contains 2,763 references across the seven Vanilla raids.
`classic-dungeons.json` supplies the pre-SoD BFD, Gnomeregan, and Sunken Temple
baselines. Gnomeregan's old positions supply approximate height context only;
its displayed SoD actors come from the SoD mapping.

Both files project names and numeric placements from the pinned
[CMaNGOS Classic DB snapshot](https://github.com/cmangos/classic-db/blob/28ef6259c782928b08a8dc9cacf6bc02e64f2b29/Full_DB/ClassicDB_1_12_1_z2815.sql.gz).
The compressed input's SHA-256 is recorded in each JSON. Its Git blob is
`0a77f5230a3d5d6db968678203dfe3b30c34b8a9`, verified against the public source.

The projection excludes critters, invisible or nonselectable triggers, and
ordinary friendly NPCs. Neutral raid bosses are retained. Random-entry slots
use the lowest available entry as one stable representative. Script-only
summons without a placed database record are absent. Upstream license and
copyright notices accompany the projection.

The regeneration commands are:

```sh
python3 scripts/raid-spawns.py \
	--source ClassicDB_1_12_1_z2815.sql.gz \
	--source-url https://github.com/cmangos/classic-db/blob/28ef6259c782928b08a8dc9cacf6bc02e64f2b29/Full_DB/ClassicDB_1_12_1_z2815.sql.gz \
	--output third_party/raid-spawns/vanilla.json
python3 scripts/raid-spawns.py \
	--source ClassicDB_1_12_1_z2815.sql.gz \
	--source-url https://github.com/cmangos/classic-db/blob/28ef6259c782928b08a8dc9cacf6bc02e64f2b29/Full_DB/ClassicDB_1_12_1_z2815.sql.gz \
	--maps 48,90,109 \
	--output third_party/raid-spawns/classic-dungeons.json
```

The generator reads declared SQL columns as UTF-8. It does not execute SQL.

## Direct SoD mapping source

`sod.json` projects the public numeric mapping exports from
[Keystone.guru](https://github.com/RaiderIO/keystone.guru/tree/9046aea1a824fa8f8a5caa9c651cad088b826a73/database/seeders/dungeondata),
pinned to `9046aea1a824fa8f8a5caa9c651cad088b826a73`.
The source explicitly identifies SoD as game-version 10 and Classic as version
2. Only SoD mappings 304, 442, and 539 supply direct SoD placements. The
projection retains source identities and file hashes. Numeric NPC display
references come from each NPC's source record.

Keystone uses a 384 by 256 map plane. Native registration follows its published
floor bounds and coordinate conversion, with independently checked map axes.
AQ40 and Scarlet's exterior use `[calculatedY, -calculatedX]`. Bounds may
descend and must not be sorted. Gnomeregan's bounds instead describe native
X/Y directly, with the map's vertical component mapped to native X and its
horizontal component mapped to native Y:

```text
nativeX = x0 + (x1 - x0) * (1 + latitude / 256)
nativeY = y0 + (y1 - y0) * (1 - longitude / 384)
```

Unique native room outlines, central structures and exits were checked against
the authored artwork on every Gnomeregan floor. Nearby matches among repeated
NPC types do not establish map orientation. The checked conversion places the
first four references on their upper tunnel floor rather than lower rooms at
the same region. Eight hand-authored pins lie within 2.247 yards of a structural
edge; their original XY remains unchanged and local grounding may use a nearby
edge within three yards. They are approximate map references, not server spawn
measurements. AQ40 Emperor Vek'lor is within 0.01 yards of its independent
Classic room reference; that check does not establish live patrol accuracy.

Scarlet's Forbidding Expanse has no published native bounds. Its approximate
registration pairs public portal markers 2027 with 2028 and 2029 with 2026.
This uses authored reference points, not combat-log positions. The three boss
regions agree with independently exported local terrain and WMO landmarks.
Mason's reference lies on a beach between two ship complexes, consistent with
his own SoD guide. Of 220 references, 37 have unresolved exported-floor
ambiguities. The local floor export omits general M2 collision, so those
references are approximate planning points rather than certified walkable
spawn locations.

The monastery and chapel maps have no native bounds and only one transition
anchor each. Their 53 and 15 references use independent room-map registration.
`scarlet-registration.json` contains reviewed numeric landmarks, the retained
client build and WMO identities, and URLs and hashes for 32 public floor-map
tiles. Each registration fits four room or pillar landmarks and checks two
additional landmarks excluded from the fit. Maximum holdout errors are 1.363
yards for the monastery and 0.578 yards for the chapel. Native boundary overlays
also match the maps' rooms, pillars, stairs and connecting corridors. The
three-yard acceptance tolerance measures map alignment, not server spawn
accuracy. No NPC positions or combat-log observations are fit anchors.

All 53 monastery pins and 11 chapel pins intersect the exported native WMO at
their transformed XY. Four chapel pins lie 0.091–1.694 yards outside a WMO edge.
The catalog preserves those XY coordinates without snapping and keeps source Z
and facing null. For approximate map references, runtime grounding can
use a structural edge within three yards when the exact column has no walkable
structure. That inferred height passes through the existing native frame
without a second terrain snap. Exact room intersections, other reference types
and log actors keep their existing grounding behavior. User edits retain the
same treatment near an edge. Overlapping room levels remain an approximation
where the authored map does not distinguish their altitude.

The upstream project publishes no attached software license. This package
contains a factual numeric reference projection with attribution, not its
maps, art, application code, or a claim of an upstream license grant.

Regenerate from a checkout of the pinned source revision:

```sh
python3 scripts/sod-raid-spawns.py \
	--source-dir keystone.guru \
	--output third_party/raid-spawns/sod.json
```

The generator validates pinned input hashes before parsing, including the
reviewed registration facts. Regeneration requires the public numeric source
checkout and the included facts file; images and client geometry are not build
or generation inputs. A downloaded cache
may also contain a source manifest, which is checked when present. Builds use
the reviewed JSON and do not fetch external data.

## BFD guide references

`sod-guides.json` preserves seven boss pins from the
[SoD BFD overview](https://www.wowhead.com/classic/guide/season-of-discovery/blackfathom-deeps-level-up-raid-overview).
Each SoD NPC ID and display was independently checked on its own strategy guide
and canonical `env=4` NPC page. Per-record source URLs and hashes remain in the
projection.

An affine fit registers map-image zone 719 against five shared Classic room
anchors. The maximum anchor residual is 29.038420 yards and the median is
12.529246 yards. These residuals are not bounds on actual SoD placement error.
The result is an approximate guide-icon reference, not exact server spawn XYZ.
The old Classic bosses are removed before applying these seven current IDs.

Original percentage pins and registration anchors are retained, so a fresh
checkout can reproduce the projection without an ignored research cache:

```sh
python3 scripts/sod-guide-spawns.py \
	--source-catalog third_party/raid-spawns/sod-guides.json \
	--baseline third_party/raid-spawns/classic-dungeons.json \
	--output regenerated-sod-guides.json
```

## Height, facing, and remaining source gaps

The SoD maps and guide pins supply XY but no world Z or facing. Both stay null
in source metadata. Runtime grounding uses the selected client's walkable
geometry. Nearby Classic positions may supply a floor hint, and source-floor
context may supply a median hint. A hint is not measured altitude. If geometry
is not available, the scene uses an approximate level context. Unknown facing
uses a neutral renderer orientation.

Wowhead NPC pages for one boss in each supported SoD raid were fetched
successfully, but their instance mapper arrays were empty or absent. The
nonempty Scarlet Footman points describe exterior Eastern Plaguelands zone
139, not raid map 2856. The current Sunken Temple overview embeds a copied
Gnomeregan zone-721 map; those pins are rejected. Questie's 223 audited SoD
addition records provide identity and membership but no valid raid coordinate
pairs. The retained Era client has empty journal-location tables, and its
DungeonEncounter records contain no placement fields. These source gaps are
tracked separately from the useful inherited baseline.

NPC models, textures, icons, geometry, client tables, combat logs, and source
HTML or SQL are not bundled. Every numeric display reference is validated
against the selected local client before rendering.
