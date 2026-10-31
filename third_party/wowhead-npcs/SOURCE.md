# Wowhead NPC display references

`npc-models.json` is a narrow metadata projection fetched by
`scripts/wowhead-npc-metadata.py`. Its records contain NPC entry IDs, names,
numeric display references, and source provenance. Each record includes the
NPC page URL, retrieval time, and SHA-256 of the fetched source document.
If the reference was recovered from an already fetched raid zone page, the
optional `sourceDocumentURL` identifies that exact document. Its retrieval time
and hash apply to the zone page. The NPC URL remains an individual reference link.

The prepared snapshot is partial. It resolves 205 of 505 requested `vanilla`
NPC identifiers and 224 of 233 requested `sod` identifiers. The remaining
300 vanilla and nine SoD identifiers have no bundled reference. The 2026-10-31
Temple of Ahn'Qiraj pass added 72 SoD references from validated individual NPC
pages, including every boss in the retained full-run replay. All 81 mapped
NPC and pet identifiers in that replay resolve to display and model file
identifiers with positive authored scales in the retained 1.15.9.70576 catalog. Nine other valid
NPC identifiers in that replay remain unresolved after source requests timed
out. Three report identifiers exceed the supported NPC entry range.

The 2026-10-28 Scarlet Enclave pass added 146 references, including every boss.
The earlier snapshot also includes references recovered offline from validated
cached zone pages. Missing references remain explicit; no other source supplies
missing values.

The developer generator discovers NPC IDs through the NPC Listview on these
public Classic raid pages:

- [Molten Core](https://www.wowhead.com/classic/zone=2717)
- [Onyxia's Lair](https://www.wowhead.com/classic/zone=2159)
- [Blackwing Lair](https://www.wowhead.com/classic/zone=2677)
- [Zul'Gurub](https://www.wowhead.com/classic/zone=1977)
- [Ruins of Ahn'Qiraj](https://www.wowhead.com/classic/zone=3429)
- [Temple of Ahn'Qiraj](https://www.wowhead.com/classic/zone=3428)
- [Naxxramas](https://www.wowhead.com/classic/zone=3456)

It also accepts NPC and pet entry IDs from locally retained Warcraft Logs
reports. Report contents, player identities, and report codes are excluded from
the generated index. No SQL dump is an input.

`ids.json` preserves the numeric input checklist without report contents, names,
or imported model mappings. It allows the same NPC requests to be regenerated
on a machine without the original report cache. The generator unions this
checklist with current zone lists and optional local report NPC identifiers.

Onyxia's zone page omits the NPC table. For that raid, the identifier checklist
contains Onyxia, Onyxian Warder, and Onyxian Whelp, as described in
[Wowhead's Onyxia strategy](https://www.wowhead.com/classic/guide/onyxia-onyxias-lair-strategy-wow-classic).
Their individual NPC pages still supply every published name and display value.

The `vanilla` namespace uses canonical Classic NPC page URLs. The `sod`
namespace uses separate requests with `env=4` for NPC IDs observed in SoD reports.
Wowhead's Classic pages form a shared reference source and may list both Era and
SoD NPCs. These namespaces preserve request and input provenance. They do not
establish historical appearance for a specific patch. Consumers select only the
requested namespace and check every display reference against the user's local
modern client. Imported report model references keep precedence.

`templateScale` is always zero, meaning unknown. The reference provides no scale
override. The renderer inherits display and model scale from the selected local
client. Unknown or unavailable NPC display references remain explicit gaps in
the developer coverage report.

The generator uses a two-request pool, bounded retries, and an ignored local
page cache. It uses the project's Node runtime for bounded HTTP fetches and
automatic response decompression. A standard-library `--transport urllib`
option is available for development diagnostics. The application package includes only this projection and notices.
It excludes source pages, tooltip HTML, models, textures, icons, map data,
coordinates, and spawns. Application builds copy the reviewed JSON and make no
Wowhead requests. End users' client bytes stay local.

To regenerate from the repository root:

```bash
	python3 scripts/wowhead-npc-metadata.py
```

The developer cache and coverage report are under `.agent/work/npc-metadata/`.
Use `--refresh` to request new pages. Refreshes may change the numeric references
and provenance, so review the generated diff before preparing a new release.
Use `--offline` to regenerate exclusively from the validated local cache.
HTTP 401 or 403 stops further requests by both workers. Cached data remains
available, and a partial result is labeled explicitly in the command output
and coverage report.

See `NOTICE.md` for attribution and the rights boundary.
