# Renderer audit checkpoint

This checkpoint covers the retained Classic Era/SoD **1.15.9.70576** client,
build key `5604ce35a8644bdcf0e26c1daf979c15`, audited on 2026-10-31.
It records automated coverage and shared repairs. Visual acceptance is pending.

| Content | Enumerated or processed | Nonvisual result |
|---|---:|---|
| Spells | 31,249 | 15,157 have implemented declared required modes; 4,469 retain an unsupported or unknown required mode; 11,623 have no enumerated required mode. These counts do not certify every metadata field or appearance. |
| Spell dependencies | 4,339 visuals, 4,569 kits, 1,605 effects | Full declared graph audited, including 884 referenced records across 15 additional definition tables. Three source chain definitions remain absent. |
| Global M2 model closure | 7,553 | 7,509 adapted and accepted by production native readers; 19 guarded; 25 source-unavailable; zero native reader failures. |
| Character customization recipes | 3,978 | 3,974 resolved; four explicit Orc recipe failures. All 16 available body profiles inventoried. |
| Single-item/body/slot recipes | 236,368 | 223,113 resolved; 13,255 partial. This is not every possible simultaneous outfit. |
| Texture resource union | 31,126 | 31,122 decoded; four unavailable. All 30,852 distinct readable content hashes passed both native-block parsing and CPU RGBA decoding. |
| Item effects | 118 visuals, 2,158 enchantments | All source mappings checked, including 853 intrinsic item displays and 119 enchant visual bindings. |
| Instance geometry | 45 map rows attempted | All 862 available terrain tiles, 380 distinct WMO roots and 2,486 unique base groups passed native decoding, covering 5,100 placed group units. No budget skips. |
| NPC display references | 359/505 Era, 224/233 SoD | Every published reference resolves against this client. Remaining provider gaps and unknown server/template scales are explicit. |

The spell-mode counts overlap with **17,183 records containing unclassified
metadata** and **17,418 containing conditional requirements**. Implemented
declared modes do not mean the entire spell is understood. A further 11,581
spells have no positive visual choice in this source; that differs from the
11,623 records with no enumerated required operation.

The repeatable pipeline reuses production catalog exporters, format adapters,
Rust readers and WGSL helpers. Model, texture and world probes preserve their
source, binary and linked-library identities. Source inventory, reference
closure, implementation support, native decode, GPU execution and visual
approval remain separate. See [the coverage workflow](RENDERER-COVERAGE.md)
and [renderer workbench](../web/editor/src/renderer-lab/README.md).

Shared repairs cover modern material operations and animated texture weights,
bounded external skeletons, per-display particle palettes, recursive particle
references, item/enchant visual loading, authored effect animation phases,
modern weapon trails, WMO material/asset routing, exact terrain holes, terrain
vertex tint and numeric skybox references. They preserve legacy controls and
use source-defined mechanisms rather than per-spell appearance patches.

Known incomplete paths include 14 guarded animated particle-coordinate models,
five unresolved runtime texture bindings, child models that need their own
animated emitter lifecycle, advanced positioner/motion/animation-kit semantics,
some procedural modes, modern interior/underwater lighting details and unknown
NPC server scales. Missing source assets and source-orphan definitions are not
replaced with invented data. Frozen Orb retains its documented illustrative
launch cue; this checkpoint does not implement its server mechanic.

The local validation passed 135 distinct focused native tests and 45 analytical
GPU helper readbacks. The actual diagnostic WASM also exercised representative
spells with travel/cleanup samples, equipment effects, weighted materials and
Scarlet/Naxxramas room consumers. Stable frozen repeats and visible sample
output are integration evidence, not official-client parity or visual approval
for the whole inventory. No game assets or generated captures accompany this
source checkpoint, and it does not deploy the site.
