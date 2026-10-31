"""Explicit replay presentation rules, separate from recorded or server behavior.

Frozen Orb's logged summon (440802) creates invisible NPC 220064. The client
contains its visible state on spell 440804, but no DB2 trigger edge joins them.
The owner authorized a brief authored launch cue when motion is unrecorded.
This mapping chooses that cue's visual and host display, never an NPC trajectory
or an aura to apply permanently to the caster. Placements/scales stay authored.
"""

SUMMON_CUES = {
    440802: {
        'displayID': 114765,
        'visualSpellID': 440804,
        'presentation': 'illustrative',
    },
}
