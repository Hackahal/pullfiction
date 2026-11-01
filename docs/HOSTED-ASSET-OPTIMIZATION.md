# Hosted asset optimization

The local optimizer keeps playable raid geometry and resources used by the current renderer. It does not simplify meshes or reduce texture resolution. See [Prepare and deploy hosted assets](HOSTED-ASSETS.md) for commands and release order.

## Raid geometry

| Raid | Terrain decision | Retained raid geometry |
| --- | --- | --- |
| Molten Core | Already has no terrain tiles | Complete original standalone building |
| Onyxia's Lair | Already has no terrain tiles | Complete original standalone building |
| Blackwing Lair | Remove 16 exterior terrain tiles | All 24 authored raid building groups, including Nefarian's Lair |
| Zul'Gurub | Keep all 25 terrain tiles | Original terrain and buildings |
| Ruins of Ahn'Qiraj | Keep all 40 terrain tiles | Original terrain and buildings |
| Temple of Ahn'Qiraj | Keep all 25 terrain tiles | Original terrain, entrance and buildings |
| Naxxramas | Remove 24 exterior terrain tiles | All 73 authored raid building groups |
| Blackfathom Deeps | Already has no terrain tiles | Complete original standalone building |
| Gnomeregan | Already has no terrain tiles | Complete original standalone building |
| Sunken Temple | Already has no terrain tiles | Complete original standalone building |
| Scarlet Enclave | Keep all 42 terrain tiles | Original terrain and buildings |

Blackwing Lair and Naxxramas each have one source placement for their raid building, repeated across terrain tiles. The optimizer requires that duplicate placement records agree. It preserves the source position, rotation, doodad set and name set when creating a standalone global-WMO map. The optimizer rejects unexpected root IDs or group counts. Distant scenery outside these buildings is omitted, including the mountain scenery beyond Blackwing Lair's balcony. The balcony itself remains in the raid building.

The four outdoor raids retain their full terrain inventories because their playable areas use terrain. The optimizer also retains any building shared with a surviving raid or used directly by a spell effect. It retains prepared models, textures, catalogs and appearance inputs, which runtime actors and effects can select dynamically.

## WMO group tables

The current native runtime readers build collision faces from `MOVT`, `MOVI` and `MOPY`. They do not use the source collision-search tables `MOBN` and `MOBR`, so the optimizer removes those two tables from prepared groups. Original client archives remain unchanged. Offline BSP comparison tools must use the original group bytes.

The optimizer also removes `MPY2` after verifying that its converted `MOPY` already matches. It rejects an unconverted or conflicting group. Every other group chunk remains byte-identical and in its original order, including repeated UV and color layers, unknown chunks, render batches, collision faces, doodad and light references, and liquids. Group headers, portal tables and root lighting data remain unchanged.

## Measured generation

For the audited Classic 1.15.9.70576 source, the original prepared pack contained 1,252,210,035 compressed bytes. The Naxxramas and conversion-input pass reduced that to 950,419,893 bytes. Adding Blackwing Lair extraction and group-table pruning reduced it to 922,874,522 bytes across 107 chunks, a total saving of 329,335,513 bytes or 26.3%.

The additional pass removed 24,014,346 uncompressed bytes of unused tables from 900 retained WMO groups. It preserved all 40,475 existing raw runtime, model and catalog resource keys with identical hashes. Ten tactical maps remained byte-identical to the previous optimized generation. Blackwing Lair retained all 24 raid floors and 29 minimap tiles, with identical triangle indices and a maximum coordinate difference of 0.000163 yards from float32 placement serialization.

These are storage and structural parity checks. They do not establish exhaustive visual acceptance of every encounter, item or spell effect. Generated inventories, parity reports and game bytes stay in ignored local directories.
