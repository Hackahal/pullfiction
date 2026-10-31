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

When Warcraft Logs is connected, opening the panel looks up the selected raid's Complete Raids leaderboard through the existing authenticated API adapter. WCL's shared zone catalogue supplies the raid zone, partition, difficulty, and size. Complete-raid encounters live in separate API zones, so the adapter queries those catalogues and matches their encounter names to the selected raid. The verified catalogue IDs are 2500 for Era; 2501–2505 and 2508–2510 for SoD. SoD AQ20's website exposes a leaderboard, but its complete-raid API catalogue returns null. Onyxia and Zul'Gurub have no Complete Raids entry on the checked leaderboards. Era categories exclude Hardcore, SoM, and Discovery partitions. SoD uses Discovery partitions. Partition, difficulty, and raid size remain visible and selectable. Era defaults to Without skips. Selecting With skips produces an explicit unavailable message: WCL's API ignores the website's allowskips parameter in its advanced filter and returns the no-skips winner. The panel must not label that result as a skips record. SoD uses time penalties instead.

The initial difficulty and size come from the replay when all recorded boss kills agree. SoD Molten Core's recorded difficulty also selects the timer's heat. Older imported files without that metadata retain a heat selector. A known difficulty, size, or heat mismatch disables split deltas. Full-run imports preserve an explicit mixed-category flag when boss kills contain conflicting known difficulties or raid sizes; that flag survives JSON save/reopen and disables all WR deltas and projections.

The first entry on the current speed leaderboard is the reference. The panel requests its report's encounter metadata without downloading its combat events. Explicit ranking start/end bounds or the exact complete-raid fight identify the reference run. Epoch ranking bounds remain in the report URL and are converted with the report start time before comparing them with report-relative fight bounds. Missing origins or invalid converted ranges leave the total-only fallback intact. When v2 omits the synthetic raid fight, the adapter can instead match the ranking's actual epoch start to a recorded pull and use the selected raid's documented terminal boss kill, provided it is unique after that start. It verifies report identity and origin, raid and known category metadata. Missing or ambiguous evidence retains the WR total and log link without inventing splits; penalty-adjusted duration is never used to calculate a finish timestamp. The reference's report and leaderboard links identify the source; the fetch time is in the reference link's tooltip. Refresh performs a new lookup.

Boss stages match by WCL encounter ID even when the raid takes a different route. Route order does not suppress cumulative or per-boss deltas, the previous segment, or projection. Each value compares the same boss timestamps from raid start, so a different wing order can produce large or negative segment differences. Deltas and the projected finish require a verified local start, complete combat coverage through the cursor, a full-run replay, and a matching WCL boss encounter ID. The previous segment compares elapsed time between consecutive boss completions. Projection adds the latest completed split delta to the WR total and never projects a finish before the current clock. The panel does not calculate a sum of best segments from a single reference run.

The transport follows WCL's [Encounter ranking schema](https://www.warcraftlogs.com/v2-api-docs/warcraft/encounter.doc.html), [zone metadata](https://www.warcraftlogs.com/v2-api-docs/warcraft/zone.doc.html), and [report fight metadata](https://www.warcraftlogs.com/v2-api-docs/warcraft/reportfight.doc.html). Contract tests and a mounted browser fixture cover lookup, category changes, streaming, disconnect, and retry states. Authenticated live verification on 31 October 2026 confirmed the catalogue and speed-ranking queries for SoD AQ40 and Era BWL. SoD AQ40 returned Fake Fresh at 2,044,745 ms and Era BWL returned five sunders please at 1,104,657 ms, matching their selected website categories. WCL's ranking JSON supplies epoch start times, while report fights use relative times; the inspected report had no synthetic complete-raid fight and no exact end bound. The adapter retained its total-only fallback rather than guessing split bounds. This verifies the service queries and observed payloads, not every raid/partition or the complete production timer UI. The API's ranking JSON is not a frozen typed contract; a malformed response becomes an explicit error instead of an invented record.


A later authenticated check reproduced the missing-splits problem on [Praxis's Naxxramas record](https://sod.warcraftlogs.com/reports/4aMcj6kb7TwAN9vq?fight=10000). The ranking's actual start minus the report origin is 6,097,280 ms; the unique recorded Kel'Thuzad kill ends at 9,409,000 ms. Both match the official website's separate complete-raid record. The adapter recovers all 14 reported boss encounters from that evidence, including WCL's combined Razuvious/Gothik encounter. The website's full-raid object and API boss metadata are retained as minimal public regression fixtures, with controls for ambiguous or mismatched runs.
