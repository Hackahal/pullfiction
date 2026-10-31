# Floor calibration references

`vanilla.json` is the exact pinned numeric projection shared with the raid-reference feature. Its provider, source URL and compressed input SHA-256 are recorded in the file. The source is CMaNGOS Classic DB commit `28ef6259c782928b08a8dc9cacf6bc02e64f2b29`, `Full_DB/ClassicDB_1_12_1_z2815.sql.gz`. Upstream licence and copyright notices accompany it.

Replay navigation uses these coordinates and the shared `classic-dungeons.json` baseline as candidate floor calibration points. Each candidate must agree with a walkable surface in the selected local client's geometry before use. They do not create logged actors, establish that an NPC was present, or establish a Season of Discovery spawn layout. Missing log altitude remains inferred. Maps without matching calibration data retain geometry-only fallback. Approximate unlogged reference pins retain their separate room and nearby-edge grounding behavior.
