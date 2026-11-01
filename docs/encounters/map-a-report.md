# Map research to a report

Use this procedure before supplying an unresolved research file to `scripts/encounter-audit.py --expectations`. Keep the published file unchanged. Prepare a report-specific copy in your own working directory.

1. Read the provider's report metadata. Confirm an explicit `gameVersion` or equivalent value that matches the research file's `ruleset` (`sod` or `vanilla`). A report title, realm name, spell name or map number alone does not establish the ruleset.
2. Select the actual fight or full-run chapter. Record its provider encounter ID, map, boss identities, time bounds and relevant difficulty selections. Obtain the required event coverage, including any postkill continuation in later chapters.
3. Compare the selected fight with the research's `rawEncounterId`, source identity limits, NPC declarations and optional variants. Raw boundary IDs and provider chapter IDs can differ. Do not add a fixed numeric offset or reuse an Era, Wrath or Retail identity without evidence.
4. Resolve grouped cases. In SoD, supply Ebonroc and Flamegor once through their combined specification. Vanilla keeps the drakes separate. For Edge of Madness, select the actual variant and its relevant contracts. Do not apply Hazza'rah's addon declaration to Gri'lek, Renataki or Wushoolay by name alone.
5. Establish the active modifier and patch scope. Examples include BWL trials, Molten Core heat, AQ optional difficulty, Naxxramas quarter Empowerment, and Seal of Dawn rank or role. A provider difficulty label can be insufficient. Do not turn a source timer into a cast or create an unobserved mechanic.
6. In the working copy, set `encounterId` to the selected provider ID. Preserve `rawEncounterId`, source conflicts and source IDs. Record the mapping's report, selected fight, ruleset, map and identity basis in `providerMapping`. Keep `verification` and every mechanic's `verification` set to `unverified`.
7. Verify associated spell IDs against their source role and the actual retained events. Preserve the original `spellIds`, candidate separation and uncertainty until evidence supports a report-specific revision. A same-name client record is insufficient. Keep creation, destruction, death, revival, interruption, aura removal and player/self event attribution intact.
8. Supply only the mapped files needed for that audit. Each `ruleset` and provider `encounterId` pair must occur once. Do not pass the complete library with a file glob: unresolved entries intentionally have null provider IDs.

The audit importer requires a positive provider `encounterId`, nonempty source URLs, and complete mechanic fields. It intentionally rejects unresolved provider IDs and duplicate encounter specifications. Those rejections protect the boundary between a source catalogue and a report-specific audit.

The mapped SoD and Vanilla entries record specific qualified reports' identities. Still verify that identity against the report you are auditing. The historical mapping does not establish active modifiers, full data coverage or present implementation behavior for another pull. SoD modifier examples do not automatically apply to a Vanilla report.

After identity mapping, separate the remaining acceptance work. Compare actual state and event ownership first. Then verify placement, height, cast-to-impact timing, animation, object cleanup and repeated or random seeks through the relevant consumers. A successful static audit, CPU check or stable blank view does not establish native visual fidelity.


Archived report metadata can establish identity while event acquisition remains blocked. Preserve `providerMapping.metadataReceipt` and `sourceContextUpdate` in any working copy. A metadata-only mapping does not turn a source-only mechanics specification into an event audit.
