//! Descriptor data required by the native UI even when the planner has no avatar.
use benilla_protocol::ObjectFields;

pub(crate) fn fields(guid: u64) -> ObjectFields {
    ObjectFields::from_pairs(&[
        (0, guid as u32),
        (2, 0x19),
        (4, 1.0f32.to_bits()),
        (22, 3000),
        (23, 3000),
        (28, 3000),
        (29, 3000),
        (34, 60),
        // Hidden FrameXML still runs its XP-bar callbacks on world entry.
        // PLAYER_BYTES_2 byte 3 must name Exhaustion.dbc's normal state;
        // zero makes GetRestState() return nil in MainMenuBar.lua:25.
        (194, 2 << 24),
        (716, 0), // PLAYER_XP
        (717, 1), // PLAYER_NEXT_LEVEL_XP, a valid denominator at the level cap
    ])
}
