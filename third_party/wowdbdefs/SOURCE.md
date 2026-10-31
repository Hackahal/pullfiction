WoWDBDefs by the WoWDBDefs contributors.

Source: https://github.com/wowdev/WoWDBDefs/tree/12ce70d5fef13370f0edf08889f01c05321d2e28

Selected unmodified data definitions and enums, reused under CC BY-SA 4.0. See LICENSE.md. Runtime extraction and renderer code are maintained separately by Pull Fiction. No Blizzard client data is included here.

Talent.dbd, TalentTab.dbd and ChrClasses.dbd are selected unmodified definitions from the same pinned revision. Their file data IDs come from its manifest.json. Only local client rows and local icon references are used by the optional talent catalog.

SpellProceduralEffect.dbd and SpellChainEffects.dbd are selected unmodified definitions from the same pinned revision, used to resolve authored procedural beam effects from the local client.

ParticleColor.dbd is an unmodified definition from the same revision. Palette extraction keeps display-selected slot RGB values separate from model lifetime timestamps and alpha.

ItemVisuals.dbd and SpellItemEnchantment.dbd are unmodified definitions from the
same revision. The modern item catalog preserves the five authored visual model
slots, enchant visual references, flags and localized names without synthesizing
legacy DBC tables.

Curve/CurvePoint, Positioner/PositionerState/PositionerStateEntry/TransformMatrix, SpellMissileMotion and AnimKit family definitions are selected unmodified files from the same pinned revision. Sparse spell metadata export follows declared referenced rows and child entries, retaining table/source/definition provenance separately from renderer semantics. No client rows or motion scripts are included in this source package.
