//! One frame's last aura-alpha author for each followed anchor.
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hash},
};

pub(crate) struct CardAuthors<K, S = RandomState> {
    alphas: HashMap<K, f32, S>,
}
impl<K, S: BuildHasher + Default> Default for CardAuthors<K, S> {
    fn default() -> Self {
        Self {
            alphas: HashMap::with_hasher(S::default()),
        }
    }
}
impl<K: Eq + Hash, S: BuildHasher> CardAuthors<K, S> {
    pub(crate) fn clear(&mut self) {
        self.alphas.clear();
    }

    pub(crate) fn record(&mut self, anchors: impl IntoIterator<Item = K>, alpha: f32) {
        for anchor in anchors {
            self.alphas.insert(anchor, alpha);
        }
    }

    pub(crate) fn alpha(&self, followed: Option<&K>) -> Option<f32> {
        self.alphas.get(followed?).copied()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.alphas.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::CardAuthors;

    #[test]
    fn overlapping_authors_use_the_last_root_in_the_existing_iteration_order() {
        let mut authors = CardAuthors::<u64>::default();
        authors.record([1, 2, 3], 0.3);
        authors.record([2, 3], 0.5);
        assert_eq!(authors.alpha(Some(&1)), Some(0.3));
        assert_eq!(authors.alpha(Some(&2)), Some(0.5));
        authors.record([3], 1.0);
        assert_eq!(authors.alpha(Some(&3)), Some(1.0));
        authors.clear();
        authors.record([2, 3], 0.5);
        authors.record([1, 2, 3], 0.3);
        assert_eq!(authors.alpha(Some(&2)), Some(0.3));
    }

    #[test]
    fn unmatched_and_unfollowed_cards_keep_their_current_tag() {
        let mut authors = CardAuthors::<u64>::default();
        authors.record([1], 0.5);
        for follow in [None, Some(2)] {
            let current = 0.7125;
            let next = authors
                .alpha(follow.as_ref())
                .map_or(current, |alpha| 0.8 * alpha);
            assert_eq!(next, current);
        }
    }

    #[test]
    fn ghost_fade_and_opaque_release_keep_the_cards_own_animated_alpha() {
        let mut authors = CardAuthors::<u64>::default();
        for (owner_alpha, animated_alpha) in [(0.5, 0.8), (0.3, 0.25), (1.0, 0.4)] {
            authors.clear();
            authors.record([1], owner_alpha);
            let next = animated_alpha * authors.alpha(Some(&1)).unwrap();
            assert_eq!(next, animated_alpha * owner_alpha);
        }
        authors.clear();
        assert!(authors.is_empty());
        assert_eq!(authors.alpha(Some(&1)), None);
    }

    #[test]
    fn every_frame_rebuilds_ownership_for_new_reparented_and_recycled_anchors() {
        let mut authors = CardAuthors::<(u32, u32)>::default();
        let old = (8, 1);
        let recycled = (8, 2);
        authors.record([old], 0.5);
        assert_eq!(authors.alpha(Some(&old)), Some(0.5));
        // A card spawned after indexing still reads this frame's current anchor factor.
        let spawned_card_follow = old;
        assert_eq!(authors.alpha(Some(&spawned_card_follow)), Some(0.5));
        authors.clear();
        authors.record([recycled], 0.3);
        assert_eq!(authors.alpha(Some(&old)), None);
        assert_eq!(authors.alpha(Some(&recycled)), Some(0.3));
        authors.clear();
        authors.record([recycled], 1.0);
        assert_eq!(authors.alpha(Some(&recycled)), Some(1.0));
    }

    #[test]
    fn clearing_reuses_the_frame_workspace() {
        let mut authors = CardAuthors::<u64>::default();
        authors.record(0..4096, 0.5);
        let capacity = authors.alphas.capacity();
        authors.clear();
        authors.record(0..128, 0.3);
        assert_eq!(authors.alphas.capacity(), capacity);
    }

    #[test]
    fn indexed_output_matches_the_original_serial_root_by_card_loop() {
        let mut authors = CardAuthors::<u64>::default();
        for frame in 0..12u64 {
            let roots: Vec<_> = (0..24u64)
                .map(|root| {
                    let anchors: Vec<_> = (0..7).map(|i| (root * 3 + i + frame) % 51).collect();
                    (anchors, ((root + frame) % 5) as f32 * 0.25)
                })
                .collect();
            let cards: Vec<_> = (0..80u64)
                .map(|card| (Some(card % 61).filter(|_| card % 9 != 0), card as f32 / 80.))
                .collect();
            let mut original = vec![0.73; cards.len()];
            for (anchors, alpha) in &roots {
                for (tag, (follow, animated)) in original.iter_mut().zip(&cards) {
                    if follow.is_some_and(|anchor| anchors.contains(&anchor)) {
                        *tag = animated * alpha;
                    }
                }
            }
            authors.clear();
            for (anchors, alpha) in roots {
                authors.record(anchors, alpha);
            }
            let indexed: Vec<_> = cards
                .iter()
                .map(|(follow, animated)| {
                    authors
                        .alpha(follow.as_ref())
                        .map_or(0.73, |alpha| animated * alpha)
                })
                .collect();
            assert_eq!(
                indexed, original,
                "different author result on frame {frame}"
            );
        }
    }
}
