# Raid spawn reference

`vanilla.json` projects numeric placements and NPC identifiers from the
[CMaNGOS Classic DB snapshot](https://github.com/cmangos/classic-db/blob/28ef6259c782928b08a8dc9cacf6bc02e64f2b29/Full_DB/ClassicDB_1_12_1_z2815.sql.gz).
The compressed input's SHA-256 is recorded in the JSON. Its Git blob is
`0a77f5230a3d5d6db968678203dfe3b30c34b8a9`, verified against the public source.

The regeneration command is:

```sh
python3 scripts/raid-spawns.py \
	--source ClassicDB_1_12_1_z2815.sql.gz \
	--source-url https://github.com/cmangos/classic-db/blob/28ef6259c782928b08a8dc9cacf6bc02e64f2b29/Full_DB/ClassicDB_1_12_1_z2815.sql.gz \
	--output third_party/raid-spawns/vanilla.json
```
The generator reads declared SQL columns; it does not execute SQL.

Coordinates use native WoW world X/Y/Z in yards and orientation in radians.
Every placed combat NPC slot in the seven Vanilla raid maps is considered.
Critters, invisible or nonselectable triggers and ordinary friendly NPCs are
excluded. Bosses that start neutral are retained. Random-entry slots use one
stable representative, the lowest available entry, rather than overlapping
all alternatives. Script-only summons without a database placement are absent.
These are reference spawn points, not live patrol positions or exact retail
layouts. All combat and death data in log mode comes solely from the log.

No verified SoD placement source is bundled. The application reports this gap
for every SoD raid, including raids sharing a Vanilla map. It never silently
substitutes the Vanilla layout. Adding a verified SoD source is still required
before complete no-log SoD support can be claimed.

NPC display identifiers are checked against the user's local client before
rendering. NPCs without an available local model remain in the map as reference
positions. Names and numeric metadata are included; no geometry, textures,
icons, client tables, logs or source SQL are included. Upstream licensing and
copyright notices are retained alongside this projection.
