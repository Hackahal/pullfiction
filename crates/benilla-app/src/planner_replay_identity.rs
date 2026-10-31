//! Keep recorded player identity current when another report reuses actor keys.
use crate::{names::NameCache, query_cache::Ask};

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
