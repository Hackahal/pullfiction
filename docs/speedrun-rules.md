# Speedrun rules coverage

The Analyse workspace's **Speedrun timer** panel shows the replay clock, cumulative boss splits, and observed trash kills. Splits seek to the corresponding pull. The panel loads missing combat chunks from the beginning through the replay cursor. Backward seeks recompute the displayed counts.

The rules catalog is `web/editor/src/speedrun-rules.ts`. Its keys are the replay's game version and client map ID. It covers the two game versions supported by Pull Fiction, Classic Era and Season of Discovery. Fresh Anniversary, Season of Mastery, and expansion raids have separate WCL rules and are not imported as Era rules.

## Published requirement tables

Sources were checked on October 31, 2026. Direct HTTP fetches returned 403 for some articles. Research used indexed WCL/Archon article contents, with the complete legacy article and Era Naxxramas page also read in a browser.

| Version | Raid | WCL source |
| --- | --- | --- |
| Classic Era | Temple of Ahn'Qiraj | [Vanilla speedrun rules, Classic Era section](https://www.archon.gg/classic-mop/articles/help/vanilla-speed-run-rules#classic-era) |
| Classic Era | Naxxramas | [Vanilla speedrun rules](https://www.archon.gg/classic-mop/articles/help/vanilla-speed-run-rules#naxxramas-era), [original Naxxramas rules](https://vanilla.warcraftlogs.com/help/naxxramas) |
| Season of Discovery | Blackfathom Deeps | [BFD speedrun rules](https://www.archon.gg/classic-sod/articles/help/blackfathom-deeps-speedrun-rules) |
| Season of Discovery | Gnomeregan | [Gnomeregan speedrun rules](https://www.archon.gg/classic-sod/articles/help/gnomeregan-speedrun-rules) |
| Season of Discovery | Sunken Temple | [Sunken Temple speedrun rules](https://www.archon.gg/classic-sod/articles/help/sunken-temple-speedrun-rules) |
| Season of Discovery | Molten Core | [Molten Core speedrun rules](https://www.archon.gg/classic-sod/articles/help/molten-core-speedrun-rules) |
| Season of Discovery | Blackwing Lair | [Blackwing Lair speedrun rules](https://www.archon.gg/classic-sod/articles/help/sod-blackwing-lair-speedrun-rules) |
| Season of Discovery | Temple of Ahn'Qiraj | [AQ speedrun rules](https://www.archon.gg/classic-sod/articles/help/temple-of-ahn-qiraj-speedrun-rules) |
| Season of Discovery | Naxxramas | [Naxxramas speedrun rules](https://www.archon.gg/classic-sod/articles/help/sod-naxxramas-speedrun-rules) |
| Season of Discovery | Scarlet Enclave | [Scarlet Enclave rules](https://www.archon.gg/classic-sod/articles/news/scarlet-enclave-parsing-and-speedrun-rules) |

## Unverified coverage

Era Molten Core and Blackwing Lair have explicit unverified entries. The accessible legacy article places their requirement tables under **Season of Mastery**. The later Fresh articles apply different rules. Neither establishes current Era requirements.

Onyxia's Lair, Zul'Gurub, and Ruins of Ahn'Qiraj have explicit unverified entries in both versions. No raid-specific requirement table was found in the checked WCL articles. An unverified entry does not mean that no requirements exist. The panel still shows recorded boss splits and labels its clock as estimated.

For trash-start rules, WCL pull metadata supplies the start when the required NPC is listed in a chapter. Without that metadata, the first observed hostile event supplies an estimated start.

Era AQ and Naxxramas have published trash tables, but their cited articles do not specify the start pull. Their clocks use the first recorded combat event and remain labeled as estimated.

## Calculation boundaries

Counts use confirmed NPC deaths by creature ID and recorded actor instance. Alternative creature IDs share one requirement. Scarlet Enclave's lieutenant requirement counts different creature types. Repeated death events for one actor instance count once. Kills at the final boss timestamp count, and later kills do not count.

SoD missing-trash penalties use `missing / required * 300 seconds` for each group. BFD's 68-mob group uses a 1,200-second pool. The BFD article also calls this 20 seconds per missing mob, which differs from `1200 / 68`. The panel follows the published formula and discloses the discrepancy. SoD Naxxramas adds five minutes if fewer than 12 Deathknight Captains die before Razuvious dies.

SoD Molten Core requires explicit heat selection. Heat 1 and 2 stop at Ragnaros. Heat 3 stops at The Molten Core. A matching giant pull cannot establish its entrance location, so the entrance requirement still needs review.

A partial stream shows observed counts and a provisional penalty. The panel requires continuous downloaded combat coverage from replay time zero through the cutoff before showing the completed trash penalty. Individual encounter replays show a preview and a prompt to open the full run.

The displayed adjusted time includes trash and the Naxxramas captain deadline only. Roster swaps are not inferred from player counts. WCL adds one minute per SoD swap and five minutes per Era Naxxramas swap. Buffs, items, roster eligibility, preclearing, instance resets, video evidence, and Naxxramas hardmode requirements need separate review. The panel does not certify WCL leaderboard eligibility.

## World-record comparison

When Warcraft Logs is connected, opening the panel looks up the selected raid's Complete Raids leaderboard through the existing authenticated API adapter. WCL's shared zone catalogue supplies the zone and encounter IDs. Era categories exclude Hardcore, SoM, and Discovery partitions. SoD uses Discovery partitions. Partition, difficulty, and raid size remain visible and selectable. Era also exposes the trash-skip category. SoD uses time penalties instead.

The initial difficulty and size come from the replay when all recorded boss kills agree. SoD Molten Core's recorded difficulty also selects the timer's heat. Older imported files without that metadata retain a heat selector. A known difficulty, size, or heat mismatch disables split deltas.

The first entry on the current speed leaderboard is the reference. The panel requests its report's encounter metadata without downloading its combat events. Explicit ranking start/end bounds or the exact complete-raid fight identify the reference run. Without those bounds, the WR total and log link remain available, but split comparison is unavailable. The reference's report and leaderboard links identify the source; the fetch time is in the reference link's tooltip. Refresh performs a new lookup.

Boss stages match by WCL encounter ID. Deltas and the projected finish require a verified local start, complete combat coverage through the cursor, a full-run replay, and the same completed boss order. The previous segment compares elapsed time between consecutive boss completions. Projection adds the latest completed split delta to the WR total and never projects a finish before the current clock. The panel does not calculate a sum of best segments from a single reference run.

The transport follows WCL's [Encounter ranking schema](https://www.warcraftlogs.com/v2-api-docs/warcraft/encounter.doc.html), [zone metadata](https://www.warcraftlogs.com/v2-api-docs/warcraft/zone.doc.html), and [report fight metadata](https://www.warcraftlogs.com/v2-api-docs/warcraft/reportfight.doc.html). Contract tests and a mounted browser fixture cover lookup, category changes, streaming, disconnect, and retry states. Live OAuth acceptance of the new ranking query remains unverified. The API's ranking JSON is not a frozen typed contract; a malformed response becomes an explicit error instead of an invented record.
