//! Keep recorded player identity current when another report reuses actor keys.
use crate::{names::NameCache, query_cache::Ask};
use benilla_protocol::{messages::ObjectType, ObjectFields};

/// Synthetic actors still need a typed create, just like wire-backed units.
/// Without it `net::write_fields` merges later snapshots without notifying the
/// native aura, appearance and other field watchers.
pub(crate) fn initial_fields(player: bool, fields: &[(u16, u32)]) -> ObjectFields {
    ObjectFields::from_pairs(fields).into_created(if player {
        ObjectType::Player
    } else {
        ObjectType::Unit
    })
}

pub(crate) fn channel_target_fields(target: Option<u64>) -> ObjectFields {
    let guid = target.unwrap_or(0);
    ObjectFields::from_pairs(&[(20, guid as u32), (21, (guid >> 32) as u32)])
}

pub(crate) struct ActorIdentity {
    player: bool,
    entry: u32,
    name: String,
}

impl ActorIdentity {
    pub(crate) fn new(player: bool, entry: u32, name: &str) -> Self {
        Self {
            player,
            entry,
            name: name.to_owned(),
        }
    }

    pub(crate) fn matches(&self, player: bool, entry: u32, name: &str) -> bool {
        self.player == player && self.entry == entry && self.name == name
    }
}

pub(crate) fn refresh_player(names: &mut NameCache, guid: u64, name: &str, traits: (u8, u8, u8)) {
    if names.resolve_player(guid, Ask::Read) != Some(name)
        || names.player_traits(guid) != Some(traits)
    {
        names.insert_player(guid, name.to_owned(), Some(traits));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_object_descriptor_preserves_guid_and_clears_without_target_evidence() {
        let guid = 0xf130_0001_0034_5678;
        let mut fields = initial_fields(true, &[(144, 689)]);
        crate::net::write_fields(&mut fields, channel_target_fields(Some(guid)));
        assert_eq!(fields.unit_channel_object(), Some(guid));
        crate::net::write_fields(&mut fields, channel_target_fields(None));
        assert_eq!(fields.unit_channel_object(), None);
        assert_eq!(fields.unit_channel_spell(), 689);
    }

    #[test]
    fn synthetic_actor_updates_notify_native_aura_channel_and_appearance_watchers() {
        for player in [false, true] {
            let mut fields = initial_fields(
                player,
                &[(22, 100), (47, 0), (95, 0), (131, 49), (144, 0), (193, 0)],
            );
            assert_eq!(
                fields.created_as(),
                Some(if player {
                    ObjectType::Player
                } else {
                    ObjectType::Unit
                })
            );
            let delta = [
                (22, 50),
                (47, 17),
                (95, 2),
                (131, 10045),
                (144, 5143),
                (193, 1),
            ];
            let edges = crate::net::write_fields(&mut fields, ObjectFields::from_pairs(&delta));
            let mut changed: Vec<_> = edges.iter().map(|&(index, _, _)| index).collect();
            changed.sort_unstable();
            assert_eq!(changed, [22, 47, 95, 131, 144, 193]);
            assert_eq!(
                fields.unit_auras().map(|a| a.spell_id).collect::<Vec<_>>(),
                [17]
            );
            assert_eq!(fields.unit_channel_spell(), 5143);
            assert!(
                crate::net::write_fields(&mut fields, ObjectFields::from_pairs(&delta)).is_empty()
            );
        }
    }

    #[test]
    fn reused_report_actor_updates_the_original_name_cache() {
        let mut names = NameCache::default();
        names.insert_player(7, "First report player".into(), Some((1, 1, 0)));
        refresh_player(&mut names, 7, "Second report player", (7, 8, 1));
        assert_eq!(
            names.resolve_player(7, Ask::Read),
            Some("Second report player")
        );
        assert_eq!(names.player_traits(7), Some((7, 8, 1)));
    }

    #[test]
    fn identical_snapshots_do_not_invalidate_native_name_consumers() {
        let mut names = NameCache::default();
        refresh_player(&mut names, 7, "Recorded player", (1, 1, 0));
        let generation = names.generation();
        for _ in 0..30 {
            refresh_player(&mut names, 7, "Recorded player", (1, 1, 0));
        }
        assert_eq!(names.generation(), generation);
    }

    #[test]
    fn changed_traits_with_the_same_name_are_refreshed() {
        let mut names = NameCache::default();
        refresh_player(&mut names, 7, "Shared name", (1, 1, 0));
        refresh_player(&mut names, 7, "Shared name", (7, 8, 1));
        assert_eq!(names.player_traits(7), Some((7, 8, 1)));
    }

    #[test]
    fn another_report_cannot_reuse_a_players_or_creatures_entity_identity() {
        let identity = ActorIdentity::new(true, 123, "Player one");
        assert!(identity.matches(true, 123, "Player one"));
        assert!(!identity.matches(true, 123, "Player two"));
        assert!(!identity.matches(true, 456, "Player one"));
        assert!(!identity.matches(false, 123, "Player one"));
        let npc = ActorIdentity::new(false, 11382, "Bloodlord Mandokir");
        assert!(!npc.matches(false, 11982, "Magmadar"));
        assert!(npc.matches(false, 11382, "Bloodlord Mandokir"));
    }
}
