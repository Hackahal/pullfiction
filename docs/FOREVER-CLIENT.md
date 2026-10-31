# Forever client readiness

Pull Fiction's shared browser archive reader supports explicit selection of
WoW Forever 1.60.1 patch builds. The main editor still starts with Classic data.
Full Forever scene, character, equipment and effect support remains unfinished.
The original renderer and UI remain unchanged.

## Select the actual product

The reader's `openFiles`, `openDirectory` and `selectClient` methods accept
`{ product: "wowf", signal }`. The default remains `wow_classic_era`.
Forever selection requires one matching active installation in `.build.info`.
It never substitutes retained Classic data. Classic selection retains its existing
recovery path when Battle.net has replaced the root product registration.

Cache identities contain the selected product, version, build key and converter
revision. A new patch build receives a new converted-asset cache. Profile versions
are explicit; a new minor format requires compatibility checks before acceptance.

## Read available table sections

`await reader.table("Map")` returns `fileDataID`, `layout`, `sha256`, `rows` and
mandatory `coverage`. Supported inspection names are Map, AreaTable,
CreatureDisplayInfo, CreatureModelData, SpellName, Item, WMOAreaTable, ChrRaces,
ChrCustomizationConversion, WMOMinimapTexture and LiquidType.

The table reader uses exact offline CASC ranges and pinned named schemas. Only
an encryption-key error can omit a protected section. Missing files, corrupted
archives, unknown layouts, invalid strings and unresolved copy references fail.
Records retain their authored IDs and copy relationships. Relative strings use
the WDC5 logical record/string address space, including across sections.

Coverage records source and included base-record counts, included copies,
source and included section counts, and omitted section key names and counts.
Key names identify unavailable sections; they are not decryption keys.
`complete: false` means consumers must treat absent rows as unavailable.
No encrypted bytes are decrypted, guessed or zero-filled by this path.

Table inspection does not persist a partial catalog or a negative lookup. Each
request retries the actual ranges. If a later client exposes a protected section,
the same reader includes it and rebases its strings automatically. Synthetic
checks cover an unavailable middle section becoming readable without code changes.

## Measured coverage

The following records were decoded from the installed `wowf` 1.60.1.70658 build
through the actual browser File/Blob, worker, CascLib WASM and Python converter.
The five partial-table hashes match independent native reads.

| Table | Included base records | Source base records | Resolved rows with copies |
| --- | ---: | ---: | ---: |
| Map | 73 | 81 | 73 |
| AreaTable | 1,375 | 1,421 | 1,375 |
| CreatureDisplayInfo | 14,204 | 14,229 | 14,204 |
| SpellName | 17,365 | 17,988 | 31,948 |
| Item | 9,034 | 9,114 | 31,850 |
| WMOAreaTable | 52,737 | 52,737 | 52,737 |
| CreatureModelData | 1,171 | 1,171 | 1,193 |
| ChrRaces | 58 | 58 | 58 |
| ChrCustomizationConversion | 2,803 | 2,803 | 2,815 |

These are metadata counts, not promises of complete rendered content. Spell names
do not establish spell-visual graph coverage, and item rows do not establish
complete equipment textures or attachments.

## Discover dungeons from metadata

The readable Map records include 50 dungeon/raid instance entries. No new-dungeon
allowlist is required to discover them. Entries retain their instance type,
name, directory, player count and WDT FileDataID. A zero WDT ID remains unavailable.

Inspecting Map registers its actual WDT references with the shared world converter.
Subsequent `reader.world("world/maps/3065/3065.wdt")` and
`reader.map(3065, "3065")` use those numeric references. This handles clients that
omit filename lookups. The four leveling dungeon WDT files were converted in the
browser. World and tactical geometry conversion reuse the original adapters.

| Instance | Map ID | WDT FileDataID |
| --- | ---: | ---: |
| The Hall of Thanes | 3065 | 7713294 |
| Ruins of Lordaeron | 2999 | 7255103 |
| Excavation Site: Wetlands | 2998 | 7252920 |
| City of Dalaran | 2959 | 6982267 |

The actual browser prepared floor geometry and map tile references for all four
dungeons. Floor triangle counts matched the independent native conversion:
177,993 for Hall of Thanes, 68,118 for Ruins of Lordaeron, 97,562 for Excavation
Site, and 159,870 for Dalaran. This verifies data conversion, not rendered scenes.

The world adapter accepts identical minimap copy references and limits true tile
conflicts to the affected WMO cell. Floor extraction accepts repeated UV/color
layers while rejecting duplicate geometry chunks. These checks preserve the
renderer's existing asset contracts.

## Remaining main-editor work

The readiness API is separate from the editor's required catalog bootstrap.
The next integration must preserve partial coverage through the typed creature,
item, spell, lighting and appearance adapters. It must distinguish unsupported
formats from unavailable records. Current Classic-only catalog gates must be
extended using actual observed Forever layouts, rather than relabeling the source.

Instance selection must consume the discovered client maps and infer a valid
camera entry from actual geometry or replay positions. The current editor's
curated Classic/SoD selector has not been replaced. Log ruleset and asset product
remain independent; no Forever Warcraft Logs endpoint has been assumed.

Version-272 embedded model cameras are supported and three actual models pass
the original WASM decoder. External skeleton/animation references and unvalidated
version-272 particles still need adapter work. New readable data alone will not
remove these format limitations.

After integration, verify a leveling dungeon in the original 3D and tactical views,
plus actors, equipment, spell animations and native nameplates/raid frames. A table
or geometry conversion check is not rendered-scene acceptance.
