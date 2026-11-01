# Encounter fidelity research

The SoD library defines **88 encounters representing 89 boss research units**, with 549 mechanic contracts. Retained combat evidence is now available for 55 canonical encounters, representing 56 boss units; the remaining 33 have source-only expectations. There are 85 mapped provider identities and 3 unresolved identities. The original 17 retained examples were supplemented by later MC, BWL, Naxx and AQ20 audits. Evidence availability grants no mechanic acceptance.

**Every contract is unverified.** Research, an available client spell record, and a proposed acceptance check grant no native execution, visual, geometry or seek credit. Retained evidence availability also does not establish current implementation acceptance. The library contains no raw logs, client assets, copied addon source code or local test receipts.

Browse the [boss index](index.md), read the [machine-readable index](index.json), or use the [encounter schema](encounter.schema.json). Before using a source-only file with `--expectations`, [map its identity against an actual report](map-a-report.md).

The [Vanilla index](vanilla/index.md) keeps baseline expectations separate from SoD. Its retained caches have independently qualified rulesets but unknown event completeness. See [known gaps](KNOWN-GAPS.md) for unresolved presentation and data requirements, and the [repeatable audit workflow](../ENCOUNTER-FIDELITY.md) for current-code checks.

The complete library contains **148 boss research units and 871 mechanic contracts** across the two rulesets. Vanilla contributes 59 units and 322 contracts: 51 have retained combat evidence and 8 remain source-only. Its AQ20 bosses, Onyxia and Edge of Madness have no qualified retained pull in the available inputs. All four Edge of Madness variants remain distinct.

## SoD coverage and grouping

| Raid | Encounter files | Boss research units |
| --- | ---: | ---: |
| Blackfathom Deeps | 7 | 7 |
| Gnomeregan | 6 | 6 |
| Sunken Temple | 8 | 8 |
| Scarlet Enclave | 8 | 8 |
| Molten Core | 11 | 11 |
| Blackwing Lair | 7 | 8 |
| Onyxia's Lair | 1 | 1 |
| Zul'Gurub | 10 | 10 |
| Ruins of Ahn'Qiraj | 6 | 6 |
| Temple of Ahn'Qiraj | 9 | 9 |
| Naxxramas | 15 | 15 |
| **Total** | **88** | **89** |

[Ebonroc and Flamegor](sod/sod-bwl-ebonroc-and-flamegor.json) share one SoD encounter specification. Both boss unit links point to that file. The combined specification is group metadata, not an extra boss unit. Import it once.

[Edge of Madness](sod/sod-zg-edge-of-madness.json) contains Gri'lek, Hazza'rah, Renataki and Wushoolay within one unit. Its raw addon declaration does not establish a common provider ID for all four variants. Select the actual variant when mapping a report.

## Fields and proof boundaries

| Field | Meaning |
| --- | --- |
| `ruleset` | Exact research scope, always `sod`. An older cache without an explicit ruleset does not qualify. |
| `encounterId` | Provider audit identity. Populated for the 17 retained research entries and 68 later metadata-only mappings. Three unresolved entries use `null`. A populated identity grants no mechanic credit. |
| `rawEncounterId` | A game or addon identity from research. It is not a provider mapping. The source's scope and alternative candidates remain in `researchContext` or `group`. |
| `providerMapping` | Mapping availability and its basis. Metadata-only mappings retain report code, revision, selected map and fights, matching NPC templates, archive state and SHA-256 metadata receipts. No universal offset is assumed. |
| `researchEvidence` | Whether qualified retained combat evidence is available, with its scope. Later acquisition does not turn source expectations into accepted mechanics. Evidence itself is not distributed here. |
| `sources` | Exact source IDs and URLs, with available author, revision, date, patch scope and quality limits. Local-only references retain descriptive availability instead of machine paths. An absent date means the research did not supply one. |
| `expectedMechanics` | Trigger, state, lifetime, placement, animation, acceptance criteria and source references for each mechanic. |
| `spellIds` | IDs associated with the mechanic in the upstream research, after excluding explicitly labelled client candidates. These are not aliases and do not establish occurrence, exact SoD variant applicability or runtime support. |
| `clientCandidateSpellIds` | Client name or inventory candidates with an unresolved mechanic association. They never earn an observed cast or replace another ID. The top-level array contains encounter-level unassigned candidates. |
| `spellIdEvidence` | Preserved mapping qualifications. Where available, `guideLinkedSpellIds` identifies resolved guide links and `addonReferencedSpellIds` identifies source-code references. Addon references can be warnings, comments or unit-event logic rather than registered combat casts. |
| `sourceRefs` | Source IDs directly attributed by the research. Empty references with `bibliographyRefs` mean that only an encounter bibliography was supplied; claim-level attribution remains unresolved. |
| `acceptanceCheck` | A stable, encounter-prefixed identifier. `acceptanceCriteria` describes the proposed scenario. Neither field is a test result. |
| `verification` | Always `unverified`, including entries with retained research evidence. |
| `unresolved` | Original research data needs and conflicts. A later `sourceContextUpdate` can resolve provider identity while leaving mechanic questions unverified. |
| `sourceContextUpdate` | A later identity-only mapping. It retains archive or acquisition availability and explicitly records that mechanics were not reaudited. |

The original research did not supply a per-contract spell array for 110 mechanic rows. Those rows retain an explicit unresolved mapping instead of acquiring an ID through a matching name. Some state, object and lifecycle contracts correctly have no associated spell ID.

Retained-sample actor numbers and elapsed times in contract text describe that research example. They are not portable identity bindings, fixed schedules or proof that every pull follows the same death order. Source code comments and addon timers likewise do not authorize generated combat events.

## Metadata identity updates

Metadata can establish a provider identity even when a report is archived and its events are inaccessible. Every new mapping requires the selected map, an explicit fight-name match, matching NPC templates, and Discovery provenance. Its receipt identifies the exact report revision and metadata bytes without distributing player records or raw report payloads.

The paired BWL fight is named “Flamegor” in the selected report but contains both NPC 14601 and NPC 11981 and provider ID 100631. The raw addon candidates 614, 615 and 2566 are preserved separately. This is why a numeric offset is not an identity rule.

The Molten Core secret encounter, Gahz’ranka and Edge of Madness remain unresolved. No selected metadata establishes their provider identity. All four Edge of Madness variants remain available as research contracts; no unselected variant inherits another variant’s ID.

## Version and evidence limits

Each encounter retains source conflicts and patch limitations. Examples include the Gnomeregan chain-recipient disagreement, Menagerie repair timing, SoD stack-based Burning Adrenaline, BWL's paired drakes and trial changes, and Seal of Dawn's rank cap superseding an earlier plan. Keep those qualifications when reusing a contract.

Client record identity, authored visual availability, server behavior and visible replay output are separate facts. A client duration does not establish an observed channel end or object lifetime. A target aura does not establish a ground destination. Missing position Z remains unknown. A boss death does not automatically end independently surviving adds, hazards, or an encounter with a resurrection phase.

Further acceptance needs an explicitly identified report, complete relevant event coverage, actual actor instances and lifecycle markers, and evidence for geometry and animation that the provider does not retain. Some mechanics also need object, unit-event, raid-warning, transport or time-aligned gameplay evidence. Tests must preserve player-sourced and self-sourced encounter mechanics.

## Validate the library

Run the dependency-free validator from the repository root:

```sh
python3 docs/encounters/validate.py
```

The validator checks the published JSON schema profile, counts, grouping, source references, IDs, verification markers and prohibited local data. It does not validate the truth of a source, run a replay or grant visual credit. Generation inputs and compilation receipts remain outside this published directory.
